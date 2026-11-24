-- Deshace 20261124110000_member_catalog_scope.sql
-- Devuelve el gancho `app.can_quote_catalog_item` a lo que dejó H-041 (cuerpo exactamente `select true`, sin permiso de ejecución para `authenticated`)
-- y borra las funciones de H-042 (`set_member_catalog_scope`, `my_catalog_scope`, `quotable_catalog_items`, `app.catalog_scope_limited`,
-- `app.my_catalog_scope_item_ids` y `app.member_catalog_scope_max_items`) y las dos tablas. NUNCA borra el gancho: `save_quote_draft` lo llama en cada línea nueva del catálogo y, sin él,
-- fallaría cada guardado.
-- SE PIERDE SOLO CONFIGURACIÓN: qué servicios puede cotizar cada Comercial. Las cotizaciones, líneas y paquetes no se tocan, y la auditoría
-- `member.catalog_scope_changed` se conserva. Sin la regla, todos los Comerciales vuelven a poder cotizar todo el catálogo.
-- Se NIEGA a correr (y no cambia nada) si: (a) el gancho vigente no es EXACTAMENTE el de esta migración (se compara el md5 de su cuerpo con el del archivo;
-- la prueba lo recalcula): otra migración lo redefinió, o ya se deshizo; o (b) ALGUNA OTRA función de `public` o `app` nombra lo que se va a quitar
-- (borrarlo la rompería: H-069 y H-070 deben consultar el gancho, no las tablas).
-- Va ANTES del deshacer de 20261123100000_quote_text_fields y del de 20261118100000_price_locks (que se niega si el gancho ya no es `select true`).
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer 20261124110000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

do $$
declare
  c_known constant regprocedure[] := array[
    to_regprocedure('app.member_catalog_scope_max_items()'), to_regprocedure('app.catalog_scope_limited()'),
    to_regprocedure('app.my_catalog_scope_item_ids()'),
    to_regprocedure('app.can_quote_catalog_item(uuid)'), to_regprocedure('public.quotable_catalog_items(text, uuid[])'),
    to_regprocedure('public.my_catalog_scope()'), to_regprocedure('public.set_member_catalog_scope(uuid, text, uuid[], integer)')];
begin
  -- (a) el gancho es el de esta migración
  if not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.can_quote_catalog_item(uuid)')::oid
                    and md5(p.prosrc) = '978da55ffff51632da507242df5b8bb8') then
    raise exception 'no se puede deshacer 20261124110000_member_catalog_scope: el gancho app.can_quote_catalog_item vigente ya no es el de esta migracion: otra migracion lo redefinio o ya se deshizo; revise el orden de los deshacer';
  end if;
  -- (b) nadie más nombra lo que se va a quitar
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('public', 'app')
                and p.oid <> all (c_known::oid[])
                and p.oid <> to_regprocedure('app.can_quote_catalog_item(uuid)')::oid
                and p.prosrc ~ '(member_catalog_scope|catalog_scope_limited|quotable_catalog_items|my_catalog_scope|set_member_catalog_scope)') then
    raise exception 'no se puede deshacer 20261124110000_member_catalog_scope: otra funcion nombra las tablas o las funciones de los servicios por comercial; la romperia; revise el orden de los deshacer';
  end if;
end $$;

-- El gancho, primero: exactamente lo que dejó H-041.
create or replace function app.can_quote_catalog_item(p_catalog_item_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select true $$;
revoke all on function app.can_quote_catalog_item(uuid) from public, anon, authenticated;

drop function public.set_member_catalog_scope(uuid, text, uuid[], integer);
drop function public.my_catalog_scope();
drop function public.quotable_catalog_items(text, uuid[]);
drop function app.my_catalog_scope_item_ids();
drop function app.catalog_scope_limited();
drop table public.member_catalog_scope_items;
drop table public.member_catalog_scopes;
drop function app.member_catalog_scope_max_items();
