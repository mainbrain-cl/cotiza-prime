-- Deshace 20261007160000_intake_embed_paused_and_fixes.sql: las tres funciones vuelven a sus definiciones anteriores (migraciones 31, 32 y 34).
-- No toca datos, así que no necesita protección.
create or replace function public.intake_form_read(p_public_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f      public.intake_forms;
  t      public.tenants;
  v_org  jsonb;
  v_base jsonb;
begin
  if p_public_id is null or p_public_id !~ '^[A-Za-z0-9_-]{22}$' then
    return jsonb_build_object('state', 'not_found');
  end if;
  select * into f from public.intake_forms where public_id = p_public_id;
  if not found or f.status not in ('published', 'paused') then
    return jsonb_build_object('state', 'not_found');
  end if;
  select * into t from public.tenants where tenant_id = f.tenant_id;
  if not found or t.status <> 'active' or t.kind <> 'organization' then
    return jsonb_build_object('state', 'not_found');
  end if;

  v_org := jsonb_build_object(
    'name', t.name,
    'contact_email', t.contact_email,
    'contact_phone', t.contact_phone);
  v_base := jsonb_build_object(
    'tenant_id', t.tenant_id,
    'form_id', f.id,
    'title', f.title,
    'org', v_org,
    'brand', jsonb_build_object('primary_color', t.brand_primary_color, 'secondary_color', t.brand_secondary_color),
    'logo_path', t.logo_path);
  if f.status = 'paused' then
    return v_base || jsonb_build_object('state', 'paused');
  end if;

  return v_base || jsonb_build_object(
    'state', 'ok',
    'revision', f.revision,
    'intro', f.intro,
    'success_message', f.success_message,
    'fields', f.fields,
    'privacy_policy_url', f.privacy_policy_url,
    'embed_origins', to_jsonb(f.embed_origins),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'name', i.public_name, 'description', i.public_description, 'unit', i.unit,
               'quantity_mode', i.quantity_mode, 'min_qty_milli', i.min_qty_milli, 'max_qty_milli', i.max_qty_milli)
             order by i.position, i.id)
        from public.intake_form_items i
       where i.tenant_id = f.tenant_id and i.form_id = f.id and i.is_active), '[]'::jsonb));
end $$;
create or replace function public.assign_intake_request(p_request_id uuid, p_assignee_user_id uuid) returns jsonb
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
create or replace function public.convert_intake_request(p_request_id uuid, p_customer_id uuid, p_creation_key uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  r        public.intake_requests;
  v_quote  uuid;
  v_number text;
  v_qstatus text;
  v_qsource uuid;
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

  -- create_quote devuelve la MISMA cotización si esa clave ya la usó esta persona. Esa cotización no puede ser
  -- una que ya avanzó ni una que ya nació de otra solicitud: no se amarra a esta.
  select q.status, q.source_request_id into v_qstatus, v_qsource
    from public.quotes q where q.tenant_id = v_tenant and q.id = v_quote;
  if v_qstatus is distinct from 'draft' or v_qsource is not null then
    raise exception 'creation_key_reused' using errcode = 'CP422';
  end if;

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

revoke all on function public.intake_form_read(text) from public, anon, authenticated;
grant execute on function public.intake_form_read(text) to service_role;
revoke all on function public.assign_intake_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_intake_request(uuid, uuid) to authenticated;
revoke all on function public.convert_intake_request(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.convert_intake_request(uuid, uuid, uuid) to authenticated;
