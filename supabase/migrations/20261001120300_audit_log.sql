-- Migración 3 — Registro de auditoría (solo agregar)
-- Más el trigger genérico app.audit_row_change y su conexión a las tablas de la migración 2.
-- Especificación: docs/arquitectura/modelo-datos.md §3.6.

create table public.audit_log (
  id             bigint generated always as identity primary key,   -- interno; ordena; nunca público
  tenant_id      uuid not null references public.tenants (tenant_id) on update cascade,
  occurred_at    timestamptz not null default now(),
  actor_type     text not null check (actor_type in ('user', 'service', 'system', 'public')),
  actor_user_id  uuid,                                              -- sin FK: el registro sobrevive a la cuenta
  action         text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  resource_type  text,
  resource_id    uuid,
  result         text not null check (result in ('success', 'failure', 'denied')),
  origin_ip      inet,
  user_agent     text check (user_agent is null or char_length(user_agent) <= 300),
  correlation_id uuid,
  details        jsonb not null default '{}' check (pg_column_size(details) <= 8192)
);
create index audit_tenant_time   on public.audit_log (tenant_id, occurred_at desc);
create index audit_tenant_actor  on public.audit_log (tenant_id, actor_user_id, occurred_at desc);
create index audit_tenant_action on public.audit_log (tenant_id, action, occurred_at desc);

-- Solo agregar. El borrado por plazo (retención, H-108) solo lo hace la función de retención,
-- fijando app.retention_purge = 'on' dentro de su transacción, y solo sobre filas vencidas.
create function app.forbid_audit_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('app.retention_purge', true) is not distinct from 'on'
     and old.occurred_at <= now() - make_interval(months => app.audit_retention_months()) then
    return old;
  end if;
  raise exception 'audit_log is append-only' using errcode = '42501';
end $$;

create trigger audit_log_no_update   before update   on public.audit_log for each row       execute function app.forbid_mutation();
create trigger audit_log_no_delete   before delete   on public.audit_log for each row       execute function app.forbid_audit_delete();
create trigger audit_log_no_truncate before truncate on public.audit_log for each statement execute function app.forbid_mutation();
create trigger audit_log_forbid_tenant_change before update on public.audit_log for each row execute function app.forbid_tenant_change();

alter table public.audit_log enable row level security;
create policy audit_select on public.audit_log for select to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin')));
grant select on public.audit_log to authenticated;   -- nada más: escriben los triggers y el servidor

-- Trigger genérico de auditoría de cambios de datos -----------------------------------------
-- Argumentos: modo ('keys_only' = solo nombres de campos, para datos personales; 'diff' = valor
-- anterior y nuevo) y tipo de recurso ('customer', 'catalog_item', ...).
-- SECURITY DEFINER porque quien edita no tiene permiso de escribir en audit_log.
create function app.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mode     text  := tg_argv[0];
  v_resource text  := tg_argv[1];
  v_new      jsonb := to_jsonb(new);
  v_old      jsonb;
  v_ignored  text[] := array['created_at', 'updated_at', 'created_by', 'updated_by'];
  v_changed  text[];
  v_details  jsonb := '{}'::jsonb;
  v_action   text;
  v_headers  json  := nullif(current_setting('request.headers', true), '')::json;
  v_ip       inet;
  v_corr     uuid;
  v_agent    text;
  v_uid      uuid  := auth.uid();
begin
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    select array_agg(n.key order by n.key) into v_changed
    from jsonb_each(v_new) n
    where n.value is distinct from v_old -> n.key and n.key <> all (v_ignored);
    if v_changed is null then
      return null;   -- no cambió nada relevante
    end if;
    v_action := v_resource || '.updated';
    if v_resource = 'catalog_item' and 'unit_price_clp' = any (v_changed) then
      v_action := 'catalog_item.price_changed';
    end if;
    if v_mode = 'diff' then
      v_details := jsonb_build_object(
        'old', (select jsonb_object_agg(k, v_old -> k) from unnest(v_changed) k),
        'new', (select jsonb_object_agg(k, v_new -> k) from unnest(v_changed) k)
      );
    else
      v_details := jsonb_build_object('changed', to_jsonb(v_changed));
    end if;
  else
    v_action := v_resource || '.created';
  end if;

  -- Origen y correlación vienen de cabeceras que reenvía la aplicación: son orientativos.
  begin v_ip := nullif(v_headers ->> 'x-cp-client-ip', '')::inet;
  exception when others then v_ip := null; end;
  begin v_corr := nullif(v_headers ->> 'x-cp-request-id', '')::uuid;
  exception when others then v_corr := null; end;
  v_agent := left(nullif(v_headers ->> 'user-agent', ''), 300);

  insert into public.audit_log
    (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id,
     result, origin_ip, user_agent, correlation_id, details)
  values
    ((v_new ->> 'tenant_id')::uuid,
     case when v_uid is null then 'system' else 'user' end,
     v_uid, v_action, v_resource,
     coalesce((v_new ->> 'id')::uuid, (v_new ->> 'tenant_id')::uuid),
     'success', v_ip, v_agent, v_corr, v_details);
  return null;
end $$;

-- Conexión a las tablas de la migración 2 (las de las migraciones siguientes lo hacen en la suya)
create trigger tenants_audit after insert or update on public.tenants
  for each row when (new.kind = 'organization') execute function app.audit_row_change('diff', 'tenant');
create trigger members_audit after insert or update on public.members
  for each row execute function app.audit_row_change('diff', 'member');
