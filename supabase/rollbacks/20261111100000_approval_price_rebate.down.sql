-- Deshace 20261111100000_approval_price_rebate.sql
-- Devuelve `app.quote_approval_check` a su definición de 20261110110000_approval_rules.sql (mismas firma, lenguaje y permisos):
-- vuelve a contar solo los descuentos de línea y el general, sin la rebaja de precio, y `metrics` pierde `price_rebate_clp`. No
-- toca datos ni tablas. Se NIEGA a correr si la función vigente ya no nombra la rebaja (otra migración la redefinió o ya se
-- deshizo): la versión que este archivo repone no la conocería.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer 20261111100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

do $$ begin
  if not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname = 'quote_approval_check' and p.prosrc ~ '\mprice_rebate_clp\M') then
    raise exception 'no se puede deshacer 20261111100000_approval_price_rebate: la funcion app.quote_approval_check vigente ya no nombra la rebaja de precio: otra migracion la redefinio o ya se deshizo; revise el orden de los deshacer';
  end if;
end $$;

create or replace function app.quote_approval_check(p_tenant uuid, p_quote_id uuid) returns jsonb
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

revoke all on function app.quote_approval_check(uuid, uuid) from public, anon, authenticated;
