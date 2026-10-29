-- Sprint 5 · H-011a · La matriz de permisos también vive en UN solo lugar de la base de datos.
--
-- Hasta ahora cada función repetía su lista de roles dentro de `has_role('owner', 'admin', ...)` (19
-- funciones, más las políticas de unas pocas tablas). Esta migración agrega la fuente única y deja que
-- lo ya escrito la herede sin reescribirlo:
--
--   app.role_can(rol, acción, es_suyo)  la tabla fija de la matriz (docs/PROYECTO.md §5.2). Una acción o un
--                                       rol desconocidos dan «no». Es la gemela de `src/lib/permissions/matrix.ts`;
--                                       `tests/db/permissions-parity.test.ts` comprueba que digan lo mismo.
--   app.effective_role()                el rol con el que la persona puede actuar HOY. Por ahora es el rol
--                                       tal cual; H-004 (verificación en dos pasos) le sumará su regla aquí.
--   app.can(acción, es_suyo)            effective_role() + role_can(): lo que usan las políticas.
--   app.has_role(...)                   pasa a leer effective_role(): las 19 funciones que aún lo usan directo
--                                       heredan cualquier cambio futuro sin tocarlas (la guardia de
--                                       `tests/db/schema-guards.test.ts` congela esa lista; solo puede achicarse).
--
-- Cambios de comportamiento (supuestos aprobados del sprint 5):
--   · Registro de actividad (`audit_select`): ahora SOLO el Dueño lee `audit_log`. La pantalla ya era solo del
--     Dueño; la base dejaba leerlo también al Administrador y eso se cerró (supuesto 13).
--   Todo lo demás (catálogo, clientes, empresa, logo, aperturas del enlace, contadores del formulario) conserva
--   exactamente a los mismos roles de antes.
--
-- Lo de «suyo» (ser el autor, tener la solicitud asignada) sigue dentro de cada función, como hoy.

-- 1. La tabla fija ---------------------------------------------------------------------------------
-- Una fila por acción: quién puede sobre cualquier recurso y quién solo sobre uno suyo. Mismos nombres y
-- mismo orden que PERMISSIONS en src/lib/permissions/matrix.ts.
create function app.role_can(p_role text, p_action text, p_own boolean default false) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select coalesce((
    select p_role = any (m.any_roles) or (coalesce(p_own, false) and p_role = any (m.own_roles))
      from (values
        ('org.view',                    array['owner','admin','approver','sales','viewer']::text[], array[]::text[]),
        ('quote.create',                array['owner','admin','sales']::text[],                     array[]::text[]),
        ('quote.edit',                  array[]::text[],                                            array['owner','admin','sales']::text[]),
        ('quote.send',                  array[]::text[],                                            array['owner','admin','sales']::text[]),
        ('quote.resend',                array['owner','admin']::text[],                             array['sales']::text[]),
        ('quote.link.revoke',           array['owner','admin']::text[],                             array['sales']::text[]),
        ('quote.link_views.read',       array['owner','admin']::text[],                             array[]::text[]),
        ('quote.approval.request',      array[]::text[],                                            array['owner','admin','sales']::text[]),
        ('quote.approve',               array['owner','admin','approver']::text[],                  array[]::text[]),
        ('bank_account.manage',         array['owner','admin']::text[],                             array[]::text[]),
        ('payment.confirm',             array['owner','admin']::text[],                             array[]::text[]),
        ('payment.second.request',      array['owner','admin']::text[],                             array['sales']::text[]),
        ('customer.write',              array['owner','admin','sales']::text[],                     array[]::text[]),
        ('catalog.manage',              array['owner','admin']::text[],                             array[]::text[]),
        ('catalog.price_lock.override', array['owner','admin']::text[],                             array[]::text[]),
        ('settings.manage',             array['owner','admin']::text[],                             array[]::text[]),
        ('team.manage',                 array['owner','admin']::text[],                             array[]::text[]),
        ('intake.forms.manage',         array['owner','admin']::text[],                             array[]::text[]),
        ('intake.protection.read',      array['owner','admin']::text[],                             array[]::text[]),
        ('intake.requests.assign',      array['owner','admin']::text[],                             array[]::text[]),
        ('intake.requests.anonymize',   array['owner','admin']::text[],                             array[]::text[]),
        ('intake.requests.discard',     array['owner','admin']::text[],                             array['sales']::text[]),
        ('intake.requests.restore',     array['owner','admin']::text[],                             array['sales']::text[]),
        ('intake.requests.convert',     array['owner','admin']::text[],                             array['sales']::text[]),
        ('audit.read',                  array['owner']::text[],                                     array[]::text[]),
        ('tenant.billing.manage',       array['owner']::text[],                                     array[]::text[]),
        ('tenant.delete',               array['owner']::text[],                                     array[]::text[]),
        ('tenant.transfer',             array['owner']::text[],                                     array[]::text[])
      ) as m(action, any_roles, own_roles)
     where m.action = p_action), false)
$$;

-- 2. El rol con el que se puede actuar -------------------------------------------------------------
-- HOY devuelve el rol tal cual (el de la organización activa, solo si la persona es miembro activa).
-- H-004c le sumará aquí la regla de los dos pasos (sin ellos, Dueño y Administrador actúan como Observador).
create function app.effective_role() returns text
language sql stable security definer set search_path = '' as $$
  select app.current_member_role()
$$;

-- 3. Lo que usan las políticas ---------------------------------------------------------------------
create function app.can(p_action text, p_own boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.role_can(app.effective_role(), p_action, p_own)
$$;

-- 4. has_role hereda el rol efectivo ----------------------------------------------------------------
create or replace function app.has_role(variadic p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app.effective_role() = any (p_roles), false)
$$;

revoke all on function app.role_can(text, text, boolean), app.effective_role(), app.can(text, boolean)
  from public, anon;
grant execute on function app.role_can(text, text, boolean), app.effective_role(), app.can(text, boolean)
  to authenticated;

-- 5. Las políticas simples pasan a la matriz -------------------------------------------------------
alter policy catalog_items_insert on public.catalog_items
  with check (tenant_id = (select app.current_tenant_id()) and (select app.can('catalog.manage')));
alter policy catalog_items_update on public.catalog_items
  using (tenant_id = (select app.current_tenant_id()) and (select app.can('catalog.manage')));

alter policy customers_insert on public.customers
  with check (tenant_id = (select app.current_tenant_id()) and (select app.can('customer.write')));
alter policy customers_update on public.customers
  using (tenant_id = (select app.current_tenant_id()) and (select app.can('customer.write')));

alter policy tenants_update on public.tenants
  using (tenant_id = (select app.current_tenant_id()) and (select app.can('settings.manage')));

-- Marca: borrar el logo de la propia organización.
alter policy tenant_logos_delete on storage.objects
  using (
    bucket_id = 'tenant-logos'
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
    and (select app.can('settings.manage'))
  );

alter policy share_link_views_select on public.share_link_views
  using (tenant_id = (select app.current_tenant_id()) and (select app.can('quote.link_views.read')));
alter policy intake_daily_counters_select on public.intake_daily_counters
  using (tenant_id = (select app.current_tenant_id()) and (select app.can('intake.protection.read')));

-- Registro de actividad: solo el Dueño (antes: Dueño y Administrador).
alter policy audit_select on public.audit_log
  using (tenant_id = (select app.current_tenant_id()) and (select app.can('audit.read')));
