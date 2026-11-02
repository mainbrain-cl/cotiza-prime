-- H-092 · pendiente m11 · El tope diario de un formulario lo leen solo quienes manejan formularios.
-- Hasta hoy la tabla daba lectura de TODAS las columnas de `intake_forms` a cualquier miembro, así que un
-- Comercial, un Aprobador o un Observador podían leer `daily_cap` por la API directa. El plan
-- (docs/arquitectura/sprint-4-formulario-publico.md §6) dice «solo Dueño y Administrador»; José lo decidió
-- el 2026-11-02 (se limita la columna).
--
-- Cómo: un permiso de tabla completo no se puede «descontar» una columna, así que se retira el SELECT de la
-- tabla y se vuelve a dar por columnas, todas menos `daily_cap` (mismo patrón que `profiles.last_tenant_id` y
-- `quote_items.unit_cost_clp`). Para quien sí puede leerlo hay una función nueva,
-- `public.intake_form_daily_caps`, que saca la organización de `app.current_tenant_id()` y pregunta a la matriz
-- (`intake.forms.manage`) en vez de escribir roles a mano.
--
-- Efecto lateral: `select=*` sobre `intake_forms` queda rechazado para todos (hay una columna privada) y una
-- columna nueva de la tabla NO queda legible hasta sumarla a la lista de abajo (es el comportamiento seguro).
-- Las funciones de la base (`save_intake_form`, `intake_form_read`, el envío de solicitudes) corren con los
-- permisos de su dueño y no cambian. No toca datos.
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261102100000_intake_daily_cap_column.down.sql

revoke select on public.intake_forms from authenticated;
grant select (id, tenant_id, public_id, name, title, intro, success_message, status, published_at, paused_at,
              revision, fields, embed_origins, privacy_policy_url, created_by, updated_by, created_at, updated_at)
  on public.intake_forms to authenticated;

-- El tope de uno o de todos los formularios de la organización activa. Solo lo ejecuta quien puede manejar
-- formularios (Dueño y Administrador). Sin `p_form_id` devuelve todos; con uno que no es de la organización
-- activa responde CP404 (igual que el resto de las funciones de formularios).
create function public.intake_form_daily_caps(p_form_id uuid default null)
returns table (form_id uuid, daily_cap integer)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
begin
  if v_tenant is null or auth.uid() is null or not app.can('intake.forms.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_form_id is not null and not exists (
    select 1 from public.intake_forms f where f.id = p_form_id and f.tenant_id = v_tenant
  ) then
    raise exception 'form_not_found' using errcode = 'CP404';
  end if;
  return query
    select f.id, f.daily_cap
      from public.intake_forms f
     where f.tenant_id = v_tenant and (p_form_id is null or f.id = p_form_id)
     order by f.created_at, f.id;
end
$$;
revoke all on function public.intake_form_daily_caps(uuid) from public, anon, authenticated;
grant execute on function public.intake_form_daily_caps(uuid) to authenticated;
