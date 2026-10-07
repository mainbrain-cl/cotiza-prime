-- Migración 32 — Asignar, descartar, restaurar y convertir una solicitud (sprint 4, M32)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261007130000_intake_request_rpcs.down.sql
-- Especificación: docs/arquitectura/sprint-4-formulario-publico.md §1 (M32), §4 y §6.
--
-- Cuatro funciones para miembros: SECURITY DEFINER con search_path vacío; la organización sale solo de
-- app.current_tenant_id() (nunca de un argumento); el permiso de cada rol se verifica aquí, en la base
-- (que la pantalla oculte un botón no es seguridad). Las ejecuta el servidor con el pase de la persona.
--
-- Códigos de error propios (SQLSTATE): CP404 no encontrada · CP422 dato inválido · CP423 el estado ya no lo
-- permite · 42501 sin permiso.
--
-- Quién puede qué (plan §6):
--   asignar            Dueño y Administrador.
--   descartar/restaurar Dueño, Administrador, o el Comercial al que está asignada.
--   convertir          Dueño, Administrador, o el Comercial si es suya o no tiene responsable.
--
-- Desviación del plan, justificada: si quien convierte es Dueño o Administrador y la solicitud no tenía
-- responsable, también queda a su cargo (el plan lo dice del Comercial; así toda solicitud convertida
-- tiene responsable y la regla es una sola).

-- 1. quotes.source_request_id -------------------------------------------------------------------
-- De qué solicitud nació la cotización (para mostrar «Solicitud original» en el editor). Solo la escribe
-- convert_intake_request; es una relación compuesta, así que no puede apuntar a una solicitud ajena.
alter table public.quotes
  add column source_request_id uuid,
  add foreign key (tenant_id, source_request_id) references public.intake_requests (tenant_id, id);
create unique index quotes_source_request on public.quotes (tenant_id, source_request_id)
  where source_request_id is not null;

-- 2. assign_intake_request ----------------------------------------------------------------------
-- Asigna (o reasigna) una solicitud nueva o ya asignada a un miembro ACTIVO de esta organización con rol
-- Dueño, Administrador o Comercial. Repetir la misma asignación no hace nada (`changed: false`).
create function public.assign_intake_request(p_request_id uuid, p_assignee_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  r        public.intake_requests;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_request_id is null or p_assignee_user_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into r from public.intake_requests where tenant_id = v_tenant and id = p_request_id for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'CP404';
  end if;
  if r.status not in ('new', 'assigned') then
    raise exception 'not_assignable' using errcode = 'CP423';
  end if;
  -- Miembro activo de ESTA organización y con un rol que cotiza (quien se quitó o es de otra, no).
  if not exists (select 1 from public.members m
                  where m.tenant_id = v_tenant and m.user_id = p_assignee_user_id
                    and m.status = 'active' and m.role in ('owner', 'admin', 'sales')) then
    raise exception 'assignee_not_eligible' using errcode = 'CP422';
  end if;
  if r.status = 'assigned' and r.assigned_to = p_assignee_user_id then
    return jsonb_build_object('status', r.status, 'assigned_to', r.assigned_to, 'changed', false);
  end if;
  update public.intake_requests
     set status = 'assigned', assigned_to = p_assignee_user_id, assigned_at = now(), assigned_by = v_uid
   where tenant_id = v_tenant and id = r.id;
  perform app.write_audit(v_tenant, 'user', v_uid, 'intake_request.assigned', 'intake_request', r.id, 'success',
    jsonb_build_object('assigned_to', p_assignee_user_id, 'previous', r.assigned_to));
  return jsonb_build_object('status', 'assigned', 'assigned_to', p_assignee_user_id, 'changed', true);
end $$;
revoke all on function public.assign_intake_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_intake_request(uuid, uuid) to authenticated;

-- 3. discard_intake_request ----------------------------------------------------------------------
-- Descarta una solicitud nueva o asignada, con un motivo de una lista cerrada y una nota breve opcional.
-- El Comercial solo descarta las que tiene asignadas. Una convertida no se descarta.
create function public.discard_intake_request(p_request_id uuid, p_reason text, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  v_note   text;
  r        public.intake_requests;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin', 'sales') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_request_id is null or p_reason is null or p_reason not in ('spam', 'duplicate', 'out_of_scope', 'other') then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and (char_length(v_note) > 200 or app.intake_text_unsafe(v_note)) then
    raise exception 'invalid_note' using errcode = 'CP422';
  end if;
  select * into r from public.intake_requests where tenant_id = v_tenant and id = p_request_id for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'CP404';
  end if;
  if app.has_role('sales') and r.assigned_to is distinct from v_uid then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if r.status = 'discarded' then
    return jsonb_build_object('status', 'discarded', 'changed', false);
  end if;
  if r.status not in ('new', 'assigned') then
    raise exception 'not_discardable' using errcode = 'CP423';
  end if;
  update public.intake_requests
     set status = 'discarded', discard_reason = p_reason, discard_note = v_note,
         discarded_by = v_uid, discarded_at = now()
   where tenant_id = v_tenant and id = r.id;
  perform app.write_audit(v_tenant, 'user', v_uid, 'intake_request.discarded', 'intake_request', r.id, 'success',
    jsonb_build_object('reason', p_reason));
  return jsonb_build_object('status', 'discarded', 'changed', true);
end $$;
revoke all on function public.discard_intake_request(uuid, text, text) from public, anon, authenticated;
grant execute on function public.discard_intake_request(uuid, text, text) to authenticated;

-- 4. restore_intake_request ----------------------------------------------------------------------
-- Devuelve una solicitud descartada a «nueva» (sin responsable ni motivo; la historia queda en la
-- auditoría). El Comercial solo restaura las que tenía asignadas cuando las descartó.
create function public.restore_intake_request(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  r        public.intake_requests;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin', 'sales') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into r from public.intake_requests where tenant_id = v_tenant and id = p_request_id for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'CP404';
  end if;
  if app.has_role('sales') and r.assigned_to is distinct from v_uid then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if r.status = 'new' then
    return jsonb_build_object('status', 'new', 'changed', false);
  end if;
  if r.status <> 'discarded' then
    raise exception 'not_restorable' using errcode = 'CP423';
  end if;
  update public.intake_requests
     set status = 'new', assigned_to = null, assigned_at = null, assigned_by = null,
         discard_reason = null, discard_note = null, discarded_by = null, discarded_at = null
   where tenant_id = v_tenant and id = r.id;
  perform app.write_audit(v_tenant, 'user', v_uid, 'intake_request.restored', 'intake_request', r.id, 'success',
    jsonb_build_object('previous_reason', r.discard_reason));
  return jsonb_build_object('status', 'new', 'changed', true);
end $$;
revoke all on function public.restore_intake_request(uuid) from public, anon, authenticated;
grant execute on function public.restore_intake_request(uuid) to authenticated;

-- 5. convert_intake_request ----------------------------------------------------------------------
-- Crea la cotización (borrador) de una solicitud para un cliente de ESTA organización y marca la solicitud
-- como convertida. Con la fila bloqueada, diez conversiones a la vez dejan UNA cotización: las demás
-- reciben la misma. Una descartada no se convierte (CP423). Si la solicitud no tenía responsable, queda a
-- cargo de quien la convierte. Las líneas de la cotización las arma después la aplicación (con el precio
-- ACTUAL del catálogo, que revisa la base); aquí solo nace el borrador y su vínculo.
-- Devuelve {quote_id, number_display, converted}: `converted` es falso si ya estaba convertida.
create function public.convert_intake_request(p_request_id uuid, p_customer_id uuid, p_creation_key uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  r        public.intake_requests;
  v_quote  uuid;
  v_number text;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin', 'sales') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_request_id is null or p_customer_id is null or p_creation_key is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into r from public.intake_requests where tenant_id = v_tenant and id = p_request_id for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'CP404';
  end if;
  -- El Comercial solo convierte las suyas o las que no tienen responsable.
  if app.has_role('sales') and r.assigned_to is not null and r.assigned_to <> v_uid then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Ya convertida (otro clic, otra pestaña): la misma cotización, sin gastar otro número.
  if r.status = 'converted' then
    select q.number_display into v_number from public.quotes q where q.tenant_id = v_tenant and q.id = r.quote_id;
    return jsonb_build_object('quote_id', r.quote_id, 'number_display', v_number, 'converted', false);
  end if;
  if r.status = 'discarded' then
    raise exception 'discarded' using errcode = 'CP423';
  end if;

  -- El cliente tiene que ser de esta organización: create_quote lo revisa (CP404) con la misma sesión.
  select c.quote_id, c.number_display into v_quote, v_number from public.create_quote(p_customer_id, p_creation_key) c;

  update public.intake_requests
     set status = 'converted', quote_id = v_quote, converted_by = v_uid, converted_at = now(),
         assigned_to = coalesce(r.assigned_to, v_uid),
         assigned_at = case when r.assigned_to is null then now() else r.assigned_at end,
         assigned_by = case when r.assigned_to is null then v_uid else r.assigned_by end
   where tenant_id = v_tenant and id = r.id;
  update public.quotes set source_request_id = r.id where tenant_id = v_tenant and id = v_quote;
  perform app.write_quote_event(v_tenant, v_quote, 'created_from_request', 'user', v_uid,
    jsonb_build_object('request_id', r.id));
  perform app.write_audit(v_tenant, 'user', v_uid, 'intake_request.converted', 'intake_request', r.id, 'success',
    jsonb_build_object('quote_id', v_quote));
  return jsonb_build_object('quote_id', v_quote, 'number_display', v_number, 'converted', true);
end $$;
revoke all on function public.convert_intake_request(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.convert_intake_request(uuid, uuid, uuid) to authenticated;
