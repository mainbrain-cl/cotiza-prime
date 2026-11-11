-- Deshace 20261110120000_approval_send_gate.sql
-- Quita el disparador del envío y su función, y la columna `quote_packages.approval_rule_id` (con su relación y su índice).
-- Se NIEGA a correr si algún paquete apunta a una versión de la regla creada por una persona: perder esa referencia
-- elimina la prueba de qué regla regía ese envío. (Los paquetes que apuntan a la versión 1 «Nunca» del sistema no pierden
-- nada que importe.) Va ANTES del deshacer de 20261110110000_approval_rules.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer 20261110120000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

do $$ begin
  if exists (
       select 1 from public.quote_packages p
         join public.approval_rules r on r.tenant_id = p.tenant_id and r.id = p.approval_rule_id
        where r.created_by is not null) then
    raise exception 'no se puede deshacer 20261110120000_approval_send_gate: hay envios que apuntan a una version de la regla creada por una persona; perder esa referencia elimina la prueba de que regla regia cada envio';
  end if;
end $$;

drop trigger if exists quote_packages_approval_gate on public.quote_packages;
drop function if exists app.quote_packages_approval_gate();
drop index if exists public.quote_packages_approval_rule;
alter table public.quote_packages
  drop constraint if exists quote_packages_approval_rule_fkey,
  drop column if exists approval_rule_id;
