-- Sprint 5 · H-040a · Cuándo se exige aprobación: la regla, la función que decide y la que la cambia
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261110110000_approval_rules.down.sql
-- Especificación: docs/arquitectura/sprint-5-h-040-aprobaciones.md §2 (cómo se guarda), §3 (la función que decide) y §6
-- (permisos). La mitad que APLICA la regla al enviar es la migración siguiente, 20261110120000_approval_send_gate (H-040b);
-- las dos entran juntas a `main`.
--
-- Qué agrega:
--   · `public.approval_rules`: la regla de aprobación de cada organización, con historial. Cada cambio es una FILA NUEVA
--     (versión 1, 2, 3…); nunca se edita ni se borra una anterior, ni siquiera con la llave maestra (`app.forbid_mutation`),
--     porque cada envío apunta a la versión exacta que lo rigió (migración siguiente). Todo miembro de la organización activa
--     LEE la regla (el Comercial necesita saber por qué su cotización queda bloqueada); NADIE escribe directo: ni un permiso
--     de escritura ni una política. Escribe solo `public.set_approval_rule`.
--   · La regla es POR ORGANIZACIÓN y aplica a todos los que envían, también al Dueño y a los Administradores (decisión 15,
--     resuelta por Aarón). Para no cerrarle el paso a la excepción por persona que vendrá después, la tabla NO tiene
--     columnas de rol ni de persona: esa excepción será una tabla aparte y la leerá `app.quote_approval_check`, el ÚNICO
--     punto que decide a quién se le aplica la regla.
--   · Una versión 1 «Nunca» (`mode = 'never'`) para cada organización que ya existe, y un disparador en `public.tenants`
--     que la crea para las nuevas sin reescribir `create_tenant`. «Nunca» mantiene el comportamiento de hoy: nada cambia
--     mientras nadie toque la regla.
--   · Tres funciones internas del esquema `app` (sin permiso de ejecución para nadie con sesión): `app.approval_discount_bp`
--     y `app.approval_rule_reasons` (puras) y `app.quote_approval_check(tenant, cotización)`, que lee los totales de la base
--     (nunca del navegador) y responde `{required, reasons, rule_id, rule_version, mode, metrics}`. Son la gemela en SQL de
--     `src/lib/approvals/rule.ts`; `tests/db/approval-rule-parity.test.ts` exige que respondan igual con la tabla de casos
--     compartida `src/lib/approvals/rule-cases.ts`.
--   · `public.set_approval_rule(p_expected_version, p_mode, p_amount_threshold_clp, p_discount_threshold_bp)`: la única
--     que escribe. Decide con `app.can('settings.manage')` (Dueño y Administrador; la matriz de H-011a: no se agrega ninguna
--     acción, ver decisión D9 del diseño).
--
-- Reglas de la regla:
--   · `mode`: `never` (nunca), `always` (siempre) o `conditional` (según monto o descuento).
--   · `conditional` exige al menos un umbral; `never` y `always`, ninguno.
--   · `amount_threshold_clp`: de 1 a 999.999.999.999 (pesos; se compara con el TOTAL CON IVA, decisión D3).
--   · `discount_threshold_bp`: de 0 a 9.999 (1.000 = 10 %). Con 0 pide aprobación cualquier descuento (D5).
--
-- Códigos de error propios (SQLSTATE) y su motivo (el mensaje del error):
--   42501 forbidden · CP404 not_found (sin organización activa propia) · CP409 rule_changed (otra persona cambió la regla
--   antes) · CP422 invalid_arguments, invalid_mode, amount_out_of_range, discount_out_of_range, missing_condition,
--   unexpected_threshold.
--
-- Orden de revisiones de `set_approval_rule` (para no revelar nada a quien no corresponde):
--   1) ¿es miembro de la organización activa? no → CP404 · 2) ¿tiene el permiso? no → 42501 · 3) forma de los argumentos →
--   CP422 · 4) candado por organización · 5) ¿lo pedido ya es la regla vigente? sí → `changed:false`, nada se escribe (así
--   un doble clic no falla) · 6) ¿la versión que vio quien edita sigue siendo la vigente? no → CP409 · 7) se agrega la versión
--   siguiente y queda la auditoría `approval_rule.updated` con la regla anterior y la nueva.
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia `set local lock_timeout = '3s'` y, justo después, la
-- verificación de que el valor quedó puesto (si la herramienta que aplica el archivo no lo respetara, se detiene).
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261110110000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

-- 0. Constantes con nombre -------------------------------------------------------------------------
create function app.approval_amount_max_clp() returns bigint language sql immutable as $$ select 999999999999::bigint $$;
create function app.approval_discount_max_bp() returns integer language sql immutable as $$ select 9999 $$;
-- Centésimas de punto: 10.000 = 100 % (el porcentaje de descuento se guarda y se compara en estas unidades).
create function app.approval_bp_scale() returns integer language sql immutable as $$ select 10000 $$;
create function app.approval_modes() returns text[]
language sql immutable set search_path = '' as $$
  select array['never', 'always', 'conditional']
$$;
revoke all on function
  app.approval_amount_max_clp(), app.approval_discount_max_bp(), app.approval_bp_scale(), app.approval_modes()
  from public, anon, authenticated;

-- 1. La tabla ----------------------------------------------------------------------------------------
create table public.approval_rules (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (tenant_id) on update cascade,
  version              integer not null check (version >= 1),
  mode                 text not null check (mode = any (app.approval_modes())),
  amount_threshold_clp bigint check (amount_threshold_clp is null
                                     or amount_threshold_clp between 1 and app.approval_amount_max_clp()),
  discount_threshold_bp integer check (discount_threshold_bp is null
                                       or discount_threshold_bp between 0 and app.approval_discount_max_bp()),
  -- Vacío solo en la versión 1, que crea el sistema.
  created_by           uuid references auth.users (id),
  created_at           timestamptz not null default now(),
  unique (tenant_id, id),
  -- Sirve también de índice para leer la última versión de una organización.
  unique (tenant_id, version),
  constraint approval_rules_thresholds_by_mode check (
    case mode
      when 'conditional' then amount_threshold_clp is not null or discount_threshold_bp is not null
      else amount_threshold_clp is null and discount_threshold_bp is null
    end),
  constraint approval_rules_author_after_first check (created_by is not null or version = 1)
);

-- Solo agregar: no se edita ni se borra una versión (ni con la llave maestra), ni se vacía la tabla.
create trigger approval_rules_no_update   before update   on public.approval_rules for each row       execute function app.forbid_mutation();
create trigger approval_rules_no_delete   before delete   on public.approval_rules for each row       execute function app.forbid_mutation();
create trigger approval_rules_no_truncate before truncate on public.approval_rules for each statement execute function app.forbid_mutation();
create trigger approval_rules_forbid_tenant_change before update on public.approval_rules
  for each row execute function app.forbid_tenant_change();

alter table public.approval_rules enable row level security;
-- Todo miembro de la organización activa lee su regla. Sin políticas ni permisos de escritura: solo la función.
create policy approval_rules_select on public.approval_rules for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
grant select on public.approval_rules to authenticated;

-- 2. La regla inicial: «Nunca» ----------------------------------------------------------------------
-- Las organizaciones que ya existen (la de «plataforma» no cotiza).
insert into public.approval_rules (tenant_id, version, mode)
select t.tenant_id, 1, 'never' from public.tenants t where t.kind = 'organization';

-- Las nuevas: sin reescribir `create_tenant` (ni ninguna otra forma de crear una organización).
create function app.tenants_create_default_approval_rule() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.approval_rules (tenant_id, version, mode) values (new.tenant_id, 1, 'never');
  return new;
end $$;
revoke all on function app.tenants_create_default_approval_rule() from public, anon, authenticated;
create trigger tenants_default_approval_rule after insert on public.tenants
  for each row when (new.kind = 'organization') execute function app.tenants_create_default_approval_rule();

-- 3. La función que decide (gemela de src/lib/approvals/rule.ts) --------------------------------------
-- Porcentaje de descuento en centésimas de punto, sobre el valor ANTES de todo descuento y sin IVA; mitad hacia arriba
-- (D6: se redondea a dos decimales antes de comparar). Bruto 0 → 0.
create function app.approval_discount_bp(p_gross_clp bigint, p_discount_clp bigint) returns integer
language sql immutable parallel safe set search_path = '' as $$
  select case
    when p_gross_clp <= 0 then 0
    else app.round_half_up_div(p_discount_clp::numeric * app.approval_bp_scale()::numeric, p_gross_clp::numeric)::integer
  end
$$;

-- Los motivos por los que una cotización necesita aprobación, siempre en este orden: `always`, `amount`, `discount`.
-- Basta uno: monto O descuento. El monto es el TOTAL CON IVA y se pide si lo supera ESTRICTAMENTE (D3). Con umbral de
-- descuento 0 se pide ante cualquier descuento en pesos; con otro umbral, si el porcentaje redondeado lo supera (D5).
create function app.approval_rule_reasons(
  p_mode text, p_amount_threshold_clp bigint, p_discount_threshold_bp integer,
  p_total_clp bigint, p_discount_clp bigint, p_discount_bp integer
) returns text[]
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v_reasons text[] := array[]::text[];
begin
  if p_mode = 'always' then
    return array['always'];
  end if;
  if p_mode <> 'conditional' then
    return v_reasons;
  end if;
  if p_amount_threshold_clp is not null and p_total_clp > p_amount_threshold_clp then
    v_reasons := array_append(v_reasons, 'amount');
  end if;
  if p_discount_threshold_bp is not null
     and ((p_discount_threshold_bp = 0 and p_discount_clp > 0)
          or (p_discount_threshold_bp > 0 and p_discount_bp > p_discount_threshold_bp)) then
    v_reasons := array_append(v_reasons, 'discount');
  end if;
  return v_reasons;
end $$;

-- ¿Esta cotización necesita aprobación? ES EL ÚNICO PUNTO que decide a quién se le aplica la regla y con qué totales. Los
-- totales salen de `quotes` (nunca del navegador). Hoy la regla es igual para todos los que envían; la excepción por persona
-- (una tabla aparte) se leerá aquí. Lo llama el disparador del envío (migración siguiente) y lo usará «Solicitar aprobación»
-- (sprint 6). Sin permiso de ejecución para nadie con sesión.
--   · CP404 quote_not_found · CP423 approval_rule_missing (la organización no tiene regla: se rechaza, no se deja pasar).
create function app.quote_approval_check(p_tenant uuid, p_quote_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q          record;
  r          public.approval_rules;
  v_gross    bigint;
  v_discount bigint;
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
  v_gross    := q.subtotal_clp + q.line_discounts_clp;
  v_discount := q.line_discounts_clp + q.global_discount_clp;
  v_bp       := app.approval_discount_bp(v_gross, v_discount);
  v_reasons  := app.approval_rule_reasons(r.mode, r.amount_threshold_clp, r.discount_threshold_bp,
                                          q.total_clp, v_discount, v_bp);
  return jsonb_build_object(
    'required', cardinality(v_reasons) > 0,
    'reasons', to_jsonb(v_reasons),
    'rule_id', r.id,
    'rule_version', r.version,
    'mode', r.mode,
    'metrics', jsonb_build_object('total_clp', q.total_clp, 'discount_clp', v_discount, 'discount_bp', v_bp));
end $$;

revoke all on function
  app.approval_discount_bp(bigint, bigint),
  app.approval_rule_reasons(text, bigint, integer, bigint, bigint, integer),
  app.quote_approval_check(uuid, uuid)
  from public, anon, authenticated;

-- 4. set_approval_rule ---------------------------------------------------------------------------------
create function public.set_approval_rule(
  p_expected_version integer, p_mode text, p_amount_threshold_clp bigint, p_discount_threshold_bp integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  v_cur    public.approval_rules;
  v_new_id uuid;
begin
  -- 1. ¿es miembro de la organización activa?
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  -- 2. ¿puede configurar la organización?
  if not app.can('settings.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 3. forma de lo recibido
  if p_expected_version is null or p_mode is null or p_expected_version < 1 then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if p_mode <> all (app.approval_modes()) then
    raise exception 'invalid_mode' using errcode = 'CP422';
  end if;
  if p_amount_threshold_clp is not null and p_mode = 'conditional'
     and p_amount_threshold_clp not between 1 and app.approval_amount_max_clp() then
    raise exception 'amount_out_of_range' using errcode = 'CP422';
  end if;
  if p_discount_threshold_bp is not null and p_mode = 'conditional'
     and p_discount_threshold_bp not between 0 and app.approval_discount_max_bp() then
    raise exception 'discount_out_of_range' using errcode = 'CP422';
  end if;
  if p_mode = 'conditional' and p_amount_threshold_clp is null and p_discount_threshold_bp is null then
    raise exception 'missing_condition' using errcode = 'CP422';
  end if;
  if p_mode <> 'conditional' and (p_amount_threshold_clp is not null or p_discount_threshold_bp is not null) then
    raise exception 'unexpected_threshold' using errcode = 'CP422';
  end if;

  -- 4. candado por organización: dos Administradores a la vez no se pisan, y un envío en curso (que toma el mismo
  --    candado, compartido) termina antes de que cambie la regla.
  perform pg_advisory_xact_lock(hashtextextended('approval_rule:' || v_tenant::text, 0));

  select * into v_cur from public.approval_rules ar
   where ar.tenant_id = v_tenant order by ar.version desc limit 1;
  if not found then
    -- Toda organización nace con su versión 1; que falte es un daño que no se tapa escribiendo la versión 2.
    raise exception 'approval_rule_missing' using errcode = 'CP404';
  end if;

  -- 5. el mismo contenido otra vez (doble clic): no se escribe nada
  if v_cur.mode = p_mode
     and v_cur.amount_threshold_clp is not distinct from p_amount_threshold_clp
     and v_cur.discount_threshold_bp is not distinct from p_discount_threshold_bp then
    return jsonb_build_object('changed', false, 'id', v_cur.id, 'version', v_cur.version);
  end if;

  -- 6. otra persona la cambió mientras se editaba
  if v_cur.version <> p_expected_version then
    raise exception 'rule_changed' using errcode = 'CP409';
  end if;

  -- 7. versión nueva + auditoría con la regla anterior y la nueva (montos y porcentajes: no hay datos personales)
  insert into public.approval_rules (tenant_id, version, mode, amount_threshold_clp, discount_threshold_bp, created_by)
  values (v_tenant, v_cur.version + 1, p_mode, p_amount_threshold_clp, p_discount_threshold_bp, v_uid)
  returning id into v_new_id;
  perform app.write_audit(v_tenant, 'user', v_uid, 'approval_rule.updated', 'approval_rule', v_new_id, 'success',
    jsonb_build_object(
      'version', v_cur.version + 1,
      'old', jsonb_build_object('mode', v_cur.mode, 'amount_threshold_clp', v_cur.amount_threshold_clp,
                                'discount_threshold_bp', v_cur.discount_threshold_bp),
      'new', jsonb_build_object('mode', p_mode, 'amount_threshold_clp', p_amount_threshold_clp,
                                'discount_threshold_bp', p_discount_threshold_bp)));
  return jsonb_build_object('changed', true, 'id', v_new_id, 'version', v_cur.version + 1);
end $$;
revoke all on function public.set_approval_rule(integer, text, bigint, integer) from public, anon, authenticated;
grant execute on function public.set_approval_rule(integer, text, bigint, integer) to authenticated;
