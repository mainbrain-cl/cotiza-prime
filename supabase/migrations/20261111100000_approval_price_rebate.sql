-- Sprint 5 · H-040 · Decisión de Aarón (2026-11-11): bajar el precio a mano también cuenta como descuento
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261111100000_approval_price_rebate.down.sql
-- Especificación: docs/arquitectura/sprint-5-h-040-aprobaciones.md §3 y §12 (decisión de Aarón del 2026-11-11).
--
-- Qué cambia (solo redefine `app.quote_approval_check`; misma firma, mismo lenguaje, mismos permisos; no toca tablas):
--   Antes, la regla miraba los descuentos de cada línea y el general. Quien armaba la cotización podía esquivarla escribiendo un
--   precio menor al del catálogo con descuento 0. Ahora el «descuento» de la regla suma además la REBAJA DE PRECIO:
--     rebaja de una línea = max(0, cantidad × catálogo − bruto de la línea), con el catálogo congelado en la línea
--     (`quote_items.catalog_unit_price_clp`) y el bruto guardado (`gross_clp`), en pesos y sin IVA;
--     rebaja total = suma de las rebajas de cada línea (nunca una rebaja «negativa» que compense otra línea; una línea libre, sin
--     precio de catálogo, no suma nada).
--   discount_clp = descuentos de línea + descuento general + rebaja total.
--   Valor de lista (la base del porcentaje) = subtotal + descuentos de línea + rebaja total: el valor antes de todo descuento,
--     contando cada línea al mayor entre su precio de catálogo y el que se le puso. Redondeo (D6) y umbral 0 (D5) no cambian.
--   `metrics` suma `price_rebate_clp`, para que la pantalla distinga el descuento declarado de la rebaja de precio.
--
-- Por qué no se puede falsear: `save_quote_draft` copia el precio de catálogo desde `catalog_items` al agregar la línea («del
-- catálogo, nunca del navegador»), lo conserva en las líneas existentes (y rechaza cambiar su servicio), y `quote_items` no tiene
-- permisos de escritura para nadie con sesión. Lo que SÍ queda fuera: escribir el servicio a mano como línea libre (sin catálogo)
-- con un precio menor; no hay cómo saber que era el mismo servicio (lo cubrirá H-041/H-042; ver el diseño §12).
--
-- Rendimiento y bloqueos: la lectura de `quote_items` usa el índice único (tenant_id, quote_id, position); el disparador del envío
-- corre dentro de `prepare_quote_send`, que ya tiene la cotización bloqueada (nadie guarda líneas a la vez).
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia `set local lock_timeout = '3s'` y, justo después, la
-- verificación de que el valor quedó puesto.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261111100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

create or replace function app.quote_approval_check(p_tenant uuid, p_quote_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q          record;
  r          public.approval_rules;
  v_gross    bigint;
  v_discount bigint;
  v_rebate   bigint;
  v_bp       integer;
  v_reasons  text[];
begin
  select qt.total_clp, qt.subtotal_clp, qt.line_discounts_clp, qt.global_discount_clp
    into q
    from public.quotes qt where qt.tenant_id = p_tenant and qt.id = p_quote_id;
  if not found then
    raise exception 'quote_not_found' using errcode = 'CP404';
  end if;
  select * into r from public.approval_rules ar
   where ar.tenant_id = p_tenant order by ar.version desc limit 1;
  if not found then
    raise exception 'approval_rule_missing' using errcode = 'CP423';
  end if;
  -- Rebaja de precio: lo que cuesta menos que el precio de catálogo que la línea congeló al agregarse (nunca viene del navegador:
  -- `save_quote_draft` lo copia de `catalog_items`). Por línea, solo si el catálogo es mayor que el precio puesto, y nunca se
  -- compensa con otra línea que cueste más. Las líneas libres (sin catálogo) no suman rebaja. El valor de lista de la línea es
  -- cantidad × catálogo (redondeo mitad hacia arriba, como el bruto de la línea) y su bruto ya está guardado en `gross_clp`.
  select coalesce(sum(greatest(0::numeric,
           app.round_half_up_div(qi.quantity_milli::numeric * qi.catalog_unit_price_clp::numeric, 1000::numeric)
           - qi.gross_clp::numeric)), 0)::bigint
    into v_rebate
    from public.quote_items qi
   where qi.tenant_id = p_tenant and qi.quote_id = p_quote_id and qi.catalog_unit_price_clp is not null;
  v_gross    := q.subtotal_clp + q.line_discounts_clp + v_rebate;
  v_discount := q.line_discounts_clp + q.global_discount_clp + v_rebate;
  v_bp       := app.approval_discount_bp(v_gross, v_discount);
  v_reasons  := app.approval_rule_reasons(r.mode, r.amount_threshold_clp, r.discount_threshold_bp,
                                          q.total_clp, v_discount, v_bp);
  return jsonb_build_object(
    'required', cardinality(v_reasons) > 0,
    'reasons', to_jsonb(v_reasons),
    'rule_id', r.id,
    'rule_version', r.version,
    'mode', r.mode,
    'metrics', jsonb_build_object('total_clp', q.total_clp, 'discount_clp', v_discount, 'discount_bp', v_bp,
                                  'price_rebate_clp', v_rebate));
end $$;
revoke all on function app.quote_approval_check(uuid, uuid) from public, anon, authenticated;
