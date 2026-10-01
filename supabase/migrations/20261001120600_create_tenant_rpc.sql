-- Migración 6 — RPC create_tenant
-- Crea, en una sola transacción: organización, membresía de Dueño, numeración por defecto y
-- auditoría (esta última la escriben los triggers de las tablas). NO recibe un tenant_id.
-- Especificación: docs/arquitectura/modelo-datos.md §4.4 (H-005, H-001).

create function public.create_tenant(
  p_name          text,
  p_rut           text,
  p_industry      text default null,
  p_contact_email text default null,
  p_contact_phone text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid       uuid := auth.uid();
  v_confirmed boolean;
  v_rut       text;
  v_owned     integer;
  v_tenant    uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- H-001: el correo debe estar verificado, comprobado aquí y no solo en la pantalla.
  select (u.email_confirmed_at is not null) into v_confirmed from auth.users u where u.id = v_uid;
  if not coalesce(v_confirmed, false) then
    raise exception 'Verifica tu correo antes de crear una organización' using errcode = '42501';
  end if;

  v_rut := app.normalize_rut(p_rut);
  if not app.is_valid_rut(v_rut) then
    raise exception 'El RUT no es válido' using errcode = '22023';
  end if;

  -- Tope por persona, contra el abuso del registro abierto. El candado evita que dos
  -- peticiones simultáneas pasen el tope a la vez.
  perform pg_advisory_xact_lock(hashtextextended('create_tenant:' || v_uid::text, 0));
  select count(*) into v_owned
  from public.members m
  join public.tenants t on t.tenant_id = m.tenant_id and t.kind = 'organization'
  where m.user_id = v_uid and m.role = 'owner' and m.status = 'active';
  if v_owned >= app.max_tenants_per_user() then
    raise exception 'Alcanzaste el máximo de % organizaciones', app.max_tenants_per_user()
      using errcode = '53400';
  end if;

  insert into public.tenants (name, rut, industry, contact_email, contact_phone, created_by)
  values (btrim(p_name), v_rut, p_industry, p_contact_email, p_contact_phone, v_uid)
  returning tenant_id into v_tenant;

  insert into public.members (tenant_id, user_id, role) values (v_tenant, v_uid, 'owner');
  insert into public.numbering_settings (tenant_id, updated_by) values (v_tenant, v_uid);
  update public.profiles set last_tenant_id = v_tenant where user_id = v_uid;

  return v_tenant;
end $$;

revoke all on function public.create_tenant(text, text, text, text, text) from public, anon;
grant execute on function public.create_tenant(text, text, text, text, text) to authenticated;
