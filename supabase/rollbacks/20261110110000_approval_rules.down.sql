-- Deshace 20261110110000_approval_rules.sql
-- Quita, en orden: el disparador de `tenants` y su función, `set_approval_rule`, las funciones internas, la tabla
-- `approval_rules` (con sus disparadores, su política y su índice) y las constantes. Los registros de auditoría
-- `approval_rule.updated` se conservan (la auditoría es de solo agregar).
-- Se NIEGA a correr en dos casos, a propósito:
--   (1) si ya hay versiones creadas por personas (`created_by` no vacío): borrarlas elimina la prueba de qué regla regía cada
--       envío. La versión 1 que crea el sistema sí se puede perder (es «Nunca», igual que no tener tabla);
--   (2) si todavía existe `quote_packages.approval_rule_id` (20261110120000): primero se deshace esa migración.
set local lock_timeout = '3s';

do $$ begin
  if exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'quote_packages' and column_name = 'approval_rule_id') then
    raise exception 'no se puede deshacer 20261110110000_approval_rules: quote_packages.approval_rule_id todavia existe; deshaga antes 20261110120000_approval_send_gate';
  end if;
  if exists (select 1 from public.approval_rules where created_by is not null) then
    raise exception 'no se puede deshacer 20261110110000_approval_rules: hay versiones de la regla creadas por personas; borrarlas elimina la prueba de que regla regia cada envio';
  end if;
end $$;

-- Disparador de las organizaciones nuevas
drop trigger if exists tenants_default_approval_rule on public.tenants;
drop function if exists app.tenants_create_default_approval_rule();

-- Función que escribe
drop function if exists public.set_approval_rule(integer, text, bigint, integer);

-- Funciones internas
drop function if exists app.quote_approval_check(uuid, uuid);
drop function if exists app.approval_rule_reasons(text, bigint, integer, bigint, bigint, integer);
drop function if exists app.approval_discount_bp(bigint, bigint);

-- La tabla (con sus disparadores, índices y política). `drop table` no dispara `truncate` ni `delete`.
drop table if exists public.approval_rules;

-- Constantes (la tabla las usaba en sus revisiones: por eso van después)
drop function if exists app.approval_modes();
drop function if exists app.approval_bp_scale();
drop function if exists app.approval_discount_max_bp();
drop function if exists app.approval_amount_max_clp();
