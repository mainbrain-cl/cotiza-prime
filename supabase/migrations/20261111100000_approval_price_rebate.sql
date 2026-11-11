-- Sprint 5 · H-040 · Decisión de Aarón (2026-11-11): bajar el precio a mano también cuenta como descuento
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261111100000_approval_price_rebate.down.sql
-- Especificación: docs/arquitectura/sprint-5-h-040-aprobaciones.md §3 y §12 (decisión de Aarón del 2026-11-11 y ajuste de José).
--
-- Qué cambia (solo redefine `app.quote_approval_check`; misma firma, mismo lenguaje, mismos permisos; no toca tablas):
--   Antes, la regla miraba los descuentos de cada línea y el general. Quien armaba la cotización podía esquivarla escribiendo un
--   precio menor al del catálogo con descuento 0. Ahora el «descuento» de la regla suma además la REBAJA DE PRECIO:
--     rebaja de una línea = max(0, cantidad × precio de lista − bruto de la línea), con
--     precio de lista = el MENOR entre el precio de catálogo congelado en la línea (`quote_items.catalog_unit_price_clp`) y el
--     precio de hoy del servicio en `catalog_items` (solo si sigue ACTIVO y es de la misma organización; si no, el guardado). Así,
--     si el catálogo bajó después de agregar la línea y la persona iguala el precio nuevo, no hay rebaja falsa; si el catálogo
--     subió, el menor sigue siendo el guardado y no se abre un hueco. (Un servicio con líneas no se puede borrar: la relación lo
--     impide; solo se desactiva.)
--     El bruto es `gross_clp` (cantidad × precio puesto, redondeo mitad hacia arriba, sin descuento de línea ni IVA).
--     Rebaja total = suma de las rebajas de cada línea (nunca una rebaja «negativa» que compense otra; una línea libre, sin
--     precio de catálogo, no suma nada).
--   discount_clp = descuentos de línea + descuento general + rebaja total.
--   Valor de lista (la base del porcentaje) = subtotal + descuentos de línea + rebaja total. Redondeo (D6) y umbral 0 (D5) no cambian.
--   La rebaja SOLO se calcula si la regla mira el descuento (`conditional` con umbral de descuento): con «Nunca», «Siempre» o
--   solo monto vale 0 y no se lee `quote_items`. Todo en `numeric`, porque cantidad × precio llega a 10^21 (más que `bigint`);
--   una rebaja enorme da un descuento de 100 % (bloquea con motivo `discount`), nunca un error de desborde (22003).
--   `metrics` suma `price_rebate_clp`, para que la pantalla distinga el descuento declarado de la rebaja de precio.
--
-- Por qué el precio de catálogo no se puede falsear: `save_quote_draft` lo copia desde `catalog_items` al agregar la línea («del
-- catálogo, nunca del navegador»), lo conserva en las líneas existentes (y rechaza cambiar su servicio), ignora cualquier valor que
-- mande el navegador, y `quote_items` no tiene permisos de escritura para nadie con sesión.
--
-- LO QUE QUEDA FUERA (riesgo aceptado; ver el diseño §12): no hay forma de saber que la persona cobra menos por el MISMO servicio si
--   (a) lo escribe a mano como línea libre, (b) RENOMBRA una línea de catálogo más barata (el navegador puede editar su nombre; el
--   `catalog_item_id` sigue siendo el del servicio barato) o (c) baja la cantidad (horas, km). H-042 NO lo cubre (solo ordena la
--   lista); H-041 debe fijar también el nombre de las líneas de catálogo. Otro borde: si el Administrador SUBE el precio del
--   catálogo entre que se abre el editor y se guarda, la línea queda con una rebaja fantasma (con umbral 0 se bloquea); es raro.
--
-- Rendimiento y bloqueos: `quote_items` por el índice único (tenant_id, quote_id, position) y `catalog_items` por (tenant_id, id); el
-- disparador del envío corre dentro de `prepare_quote_send`, que ya tiene la cotización bloqueada (nadie guarda líneas a la vez).
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
  c_milli     constant numeric := 1000;       -- milésimas por unidad (como `c_milli` de quote_calc_v1)
  c_bp_scale  constant numeric := 10000;      -- centésimas de punto en un 100 %
  c_bigint_cap constant numeric := 9000000000000000000;   -- tope para pasar un monto a bigint (solo se usa para «hay descuento»)
  q          record;
  r          public.approval_rules;
  v_gross    numeric;
  v_discount numeric;
  v_rebate   numeric := 0;
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

  -- Rebaja de precio (decisión de Aarón, 2026-11-11, con el ajuste de José): solo si la regla mira el descuento. Por línea con
  -- catálogo: max(0, cantidad × MENOR(precio de catálogo congelado en la línea, precio de hoy del servicio si sigue activo) −
  -- bruto de la línea). Todo en `numeric`: cantidad × precio llega a 10^21, más que `bigint`.
  if r.mode = 'conditional' and r.discount_threshold_bp is not null then
    select coalesce(sum(greatest(0::numeric,
             app.round_half_up_div(
               qi.quantity_milli::numeric
               * least(qi.catalog_unit_price_clp, coalesce(ci.unit_price_clp, qi.catalog_unit_price_clp))::numeric,
               c_milli)
             - qi.gross_clp::numeric)), 0)
      into v_rebate
      from public.quote_items qi
      left join public.catalog_items ci
        on ci.tenant_id = qi.tenant_id and ci.id = qi.catalog_item_id and ci.is_active
     where qi.tenant_id = p_tenant and qi.quote_id = p_quote_id and qi.catalog_unit_price_clp is not null;
  end if;

  v_gross    := q.subtotal_clp::numeric + q.line_discounts_clp::numeric + v_rebate;
  v_discount := q.line_discounts_clp::numeric + q.global_discount_clp::numeric + v_rebate;
  v_bp       := case when v_gross <= 0 then 0
                     else app.round_half_up_div(v_discount * c_bp_scale, v_gross)::integer end;
  v_reasons  := app.approval_rule_reasons(r.mode, r.amount_threshold_clp, r.discount_threshold_bp,
                                          q.total_clp, least(v_discount, c_bigint_cap)::bigint, v_bp);
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
