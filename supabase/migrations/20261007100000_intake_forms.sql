-- Migración 29 — Formularios públicos y sus servicios (sprint 4, M29)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261007100000_intake_forms.down.sql
-- Especificación: docs/arquitectura/sprint-4-formulario-publico.md §1 (M29) y §6.
--
-- Ninguna de las dos tablas se escribe directo: no hay permisos de insert/update/delete para
-- `authenticated`. Escriben solo las cuatro funciones de esta migración, que son SECURITY DEFINER con
-- search_path vacío, sacan la organización de app.current_tenant_id() (nunca de un argumento) y exigen
-- rol Dueño o Administrador. Las ejecuta el servidor con el pase de la persona.
--
-- Códigos de error propios (SQLSTATE): CP404 no encontrado · CP409 choque de revisión (otra pestaña
-- guardó antes) · CP422 dato inválido (el motivo va en el mensaje) · CP423 el estado ya no lo permite ·
-- 42501 sin permiso.
--
-- Desviaciones del plan, justificadas:
--  * El tope de servicios por formulario (50) no está en el plan: se agrega para acotar el tamaño de lo
--    que lee la parte pública.
--  * El tope de 20 formularios por organización cuenta solo los no archivados (los archivados no se
--    borran nunca; contarlos dejaría a una organización sin salida).
--  * Un formulario archivado es definitivo (no vuelve a borrador ni a publicado).
--  * Cada guardado de save_intake_form sube `revision`; publicar, pausar o regenerar el enlace no.

-- 0. Constantes con nombre y ayudas puras -----------------------------------------------------
create function app.intake_max_forms_per_tenant() returns integer language sql immutable as $$ select 20 $$;
create function app.intake_max_items_per_form()   returns integer language sql immutable as $$ select 50 $$;
create function app.intake_embed_origins_max()    returns integer language sql immutable as $$ select 10 $$;
create function app.intake_default_daily_cap()    returns integer language sql immutable as $$ select 50 $$;
create function app.intake_max_daily_cap()        returns integer language sql immutable as $$ select 200 $$;
-- Cantidad máxima y mínima de un servicio (en milésimas; igual que parseQuantity de la aplicación).
create function app.intake_qty_min_milli()        returns bigint  language sql immutable as $$ select 1 $$;
create function app.intake_qty_max_milli()        returns bigint  language sql immutable as $$ select 1000000000 $$;
revoke all on function
  app.intake_max_forms_per_tenant(), app.intake_max_items_per_form(), app.intake_embed_origins_max(),
  app.intake_default_daily_cap(), app.intake_max_daily_cap(), app.intake_qty_min_milli(),
  app.intake_qty_max_milli()
  from public, anon, authenticated;

-- Cómo se pide cada dato. Nombre y correo son siempre obligatorios y no se configuran; no existe un
-- campo RUT ni preguntas libres: la lista de claves es cerrada.
create function app.intake_default_fields() returns jsonb language sql immutable as $$
  select '{"phone":"optional","company":"off","comuna":"off","serviceAddress":"optional","desiredDate":"optional","message":"optional"}'::jsonb
$$;
create function app.intake_fields_valid(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p) is distinct from 'object' then false
    when (select count(*) from jsonb_object_keys(p)) <> 6 then false
    when not (p ?& array['phone', 'company', 'comuna', 'serviceAddress', 'desiredDate', 'message']) then false
    else not exists (
      select 1 from jsonb_each(p) e
       where jsonb_typeof(e.value) <> 'string' or (e.value #>> '{}') not in ('off', 'optional', 'required'))
  end
$$;

-- Sitios autorizados a mostrar el formulario dentro de su página: solo https, en minúsculas, con al
-- menos un punto, sin comodines, rutas, usuarios, espacios, saltos de línea ni `;`. Máximo 10.
create function app.embed_origins_valid(p text[]) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when p is null then false
    when cardinality(p) > app.intake_embed_origins_max() then false
    else not exists (
      select 1 from unnest(p) o
       where case
         when o is null then true
         when char_length(o) > 255 then true
         when o !~ '^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::[1-9][0-9]{0,4})?$' then true
         else coalesce(substring(o from ':([0-9]+)$')::integer, 1) > 65535
       end)
  end
$$;

-- Dirección de la política de privacidad de la organización: solo https, sin espacios ni caracteres
-- que rompan un atributo HTML.
create function app.intake_policy_url_valid(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p is null or (
    char_length(p) <= 500
    and p ~* '^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::[0-9]{1,5})?(?:[/?#][^[:space:]"''<>\\^`{|};]*)?$')
$$;

-- ¿El texto lleva caracteres de control, invisibles o de dirección invertida? (lo que escribe el
-- administrador se muestra a desconocidos: no puede disfrazar texto.) `p_multiline` permite saltos de línea.
create function app.intake_text_unsafe(p text, p_multiline boolean default false) returns boolean
language sql immutable set search_path = '' as $$
  select case when p_multiline
    then p ~ '[\u0001-\u0008\u000b-\u001f\u007f-\u009f­͏ᅟᅠ᠎​-‏ -‮⁠-⁤⁦-⁩ㅤ﻿ﾠ￹-￻\U000e0000-\U000e007f]'
    else p ~ '[\u0001-\u001f\u007f-\u009f­͏ᅟᅠ᠎​-‏ -‮⁠-⁤⁦-⁩ㅤ﻿ﾠ￹-￻\U000e0000-\U000e007f]'
  end
$$;

-- Identificador público del formulario: 128 bits al azar en base64url (22 caracteres). No es un secreto
-- (va impreso en el código QR), pero no se puede adivinar ni recorrer.
create function app.new_intake_public_id() returns text
language sql volatile set search_path = '' as $$
  select rtrim(translate(encode(extensions.gen_random_bytes(16), 'base64'), '+/', '-_'), '=')
$$;
revoke all on function app.new_intake_public_id() from public, anon, authenticated;

grant execute on function
  app.intake_default_fields(), app.intake_fields_valid(jsonb), app.embed_origins_valid(text[]),
  app.intake_policy_url_valid(text), app.intake_text_unsafe(text, boolean)
  to authenticated, service_role;

-- 1. intake_forms ------------------------------------------------------------------------------
create table public.intake_forms (
  id                 uuid primary key,   -- lo genera la aplicación
  tenant_id          uuid not null references public.tenants (tenant_id) on update cascade,
  public_id          text not null default app.new_intake_public_id()
                     check (public_id ~ '^[A-Za-z0-9_-]{22}$'),
  name               text not null check (char_length(name) between 1 and 120),    -- interno
  title              text not null check (char_length(title) between 1 and 120),   -- público
  intro              text not null default '' check (char_length(intro) <= 1000),
  success_message    text not null default '' check (char_length(success_message) <= 500),
  status             text not null default 'draft' check (status in ('draft', 'published', 'paused', 'archived')),
  published_at       timestamptz,
  paused_at          timestamptz,
  revision           integer not null default 1 check (revision >= 1),
  fields             jsonb not null default app.intake_default_fields()
                     check (app.intake_fields_valid(fields)),
  embed_origins      text[] not null default '{}' check (app.embed_origins_valid(embed_origins)),
  daily_cap          integer not null default app.intake_default_daily_cap()
                     check (daily_cap between 1 and 200),
  privacy_policy_url text check (app.intake_policy_url_valid(privacy_policy_url)),
  created_by         uuid references auth.users (id),
  updated_by         uuid references auth.users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint intake_forms_published_shape check (status not in ('published', 'paused') or published_at is not null),
  unique (tenant_id, id)
);
-- Único en toda la plataforma: la parte pública busca por este identificador sin saber la organización.
create unique index intake_forms_public_id on public.intake_forms (public_id);
create index intake_forms_tenant_status on public.intake_forms (tenant_id, status);

create trigger intake_forms_meta before insert or update on public.intake_forms
  for each row execute function app.set_row_meta_by();
create trigger intake_forms_forbid_tenant_change before update on public.intake_forms
  for each row execute function app.forbid_tenant_change();

-- 2. intake_form_items -------------------------------------------------------------------------
-- Lo que se puede pedir en el formulario. SIN ninguna columna de precio: al elegir un servicio del
-- catálogo la aplicación COPIA nombre, descripción y unidad; lo que lee el público nunca se cruza con
-- `catalog_items`.
create table public.intake_form_items (
  id                 uuid primary key,   -- lo genera la aplicación; conserva su identidad entre guardados
  tenant_id          uuid not null references public.tenants (tenant_id) on update cascade,
  form_id            uuid not null,
  position           integer not null check (position >= 0),
  kind               text not null check (kind in ('catalog', 'free', 'calc_model')),   -- calc_model: reservado (M16)
  catalog_item_id    uuid,
  public_name        text not null check (char_length(public_name) between 1 and 150),
  public_description text check (public_description is null or char_length(public_description) <= 500),
  unit               text not null check (unit in ('service', 'hour', 'km', 'm2', 'day', 'unit')),
  quantity_mode      text not null default 'optional' check (quantity_mode in ('none', 'optional', 'required')),
  min_qty_milli      bigint check (min_qty_milli is null or min_qty_milli between 1 and 1000000000),
  max_qty_milli      bigint check (max_qty_milli is null or max_qty_milli between 1 and 1000000000),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint intake_form_items_catalog_shape check ((kind = 'catalog') = (catalog_item_id is not null)),
  constraint intake_form_items_qty_order check (min_qty_milli is null or max_qty_milli is null or min_qty_milli <= max_qty_milli),
  unique (tenant_id, id),
  foreign key (tenant_id, form_id)         references public.intake_forms (tenant_id, id),
  foreign key (tenant_id, catalog_item_id) references public.catalog_items (tenant_id, id)
);
create index intake_form_items_form on public.intake_form_items (tenant_id, form_id, position);
create index intake_form_items_catalog on public.intake_form_items (tenant_id, catalog_item_id)
  where catalog_item_id is not null;

create trigger intake_form_items_meta before insert or update on public.intake_form_items
  for each row execute function app.set_row_meta();
create trigger intake_form_items_forbid_tenant_change before update on public.intake_form_items
  for each row execute function app.forbid_tenant_change();

-- 3. RLS y permisos ----------------------------------------------------------------------------
alter table public.intake_forms      enable row level security;
alter table public.intake_form_items enable row level security;

-- Todos los miembros ven los formularios de su organización; nadie con pase escribe directo.
create policy intake_forms_select on public.intake_forms for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
create policy intake_form_items_select on public.intake_form_items for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));

grant select on public.intake_forms, public.intake_form_items to authenticated;

-- 4. create_intake_form ------------------------------------------------------------------------
-- Crea un formulario en borrador. Idempotente: el mismo `p_form_id` devuelve el mismo formulario.
create function public.create_intake_form(p_form_id uuid, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  v_name   text;
  f        public.intake_forms;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_form_id is null or p_name is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  v_name := btrim(p_name);
  if char_length(v_name) not between 1 and 120 or app.intake_text_unsafe(v_name) then
    raise exception 'invalid_name' using errcode = 'CP422';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('create_intake_form:' || v_tenant::text, 0));
  select * into f from public.intake_forms where id = p_form_id;
  if found then
    if f.tenant_id <> v_tenant then
      raise exception 'form_id_taken' using errcode = 'CP422';
    end if;
    return jsonb_build_object('id', f.id, 'public_id', f.public_id, 'revision', f.revision, 'created', false);
  end if;
  if (select count(*) from public.intake_forms
       where tenant_id = v_tenant and status <> 'archived') >= app.intake_max_forms_per_tenant() then
    raise exception 'too_many_forms' using errcode = 'CP422';
  end if;

  insert into public.intake_forms (id, tenant_id, name, title)
  values (p_form_id, v_tenant, v_name, v_name)
  returning * into f;
  perform app.write_audit(v_tenant, 'user', v_uid, 'intake_form.created', 'intake_form', f.id, 'success',
    jsonb_build_object('name', f.name));
  return jsonb_build_object('id', f.id, 'public_id', f.public_id, 'revision', f.revision, 'created', true);
end $$;
revoke all on function public.create_intake_form(uuid, text) from public, anon, authenticated;
grant execute on function public.create_intake_form(uuid, text) to authenticated;

-- 5. save_intake_form --------------------------------------------------------------------------
-- p_form:  {name?, title?, intro?, success_message?, fields?, embed_origins?, daily_cap?, privacy_policy_url?}
--          Lo que falta no cambia. Claves desconocidas se rechazan.
-- p_items: null = los servicios no cambian; arreglo = la lista completa, en el orden de la pantalla
--          [{id, kind, catalog_item_id?, public_name, public_description?, unit, quantity_mode?,
--            min_qty_milli?, max_qty_milli?, is_active?}]. Los que no vienen se quitan. No existe
--          ninguna clave de precio: cualquier clave desconocida se rechaza.
-- Si otra pestaña guardó antes (revisión distinta) responde CP409 sin guardar nada.
create function public.save_intake_form(
  p_form_id uuid, p_expected_revision integer, p_form jsonb, p_items jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_form_keys constant text[] :=
    array['name', 'title', 'intro', 'success_message', 'fields', 'embed_origins', 'daily_cap', 'privacy_policy_url'];
  c_item_keys constant text[] :=
    array['id', 'kind', 'catalog_item_id', 'public_name', 'public_description', 'unit', 'quantity_mode',
          'min_qty_milli', 'max_qty_milli', 'is_active'];
  c_units constant text[] := array['service', 'hour', 'km', 'm2', 'day', 'unit'];
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  f        public.intake_forms;
  v_form   jsonb := coalesce(p_form, '{}'::jsonb);
  v_key    text;
  v_name   text;
  v_title  text;
  v_intro  text;
  v_success text;
  v_fields jsonb;
  v_origins text[];
  v_old_origins text[];
  v_cap    integer;
  v_url    text;
  v_changed text[] := array[]::text[];
  v_ids    uuid[] := array[]::uuid[];
  v_item   jsonb;
  v_pos    integer;
  v_id     uuid;
  v_kind   text;
  v_cat    uuid;
  v_pname  text;
  v_pdesc  text;
  v_unit   text;
  v_qmode  text;
  v_min    bigint;
  v_max    bigint;
  v_active boolean;
  v_active_items integer;
  v_items_changed boolean := false;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_form_id is null or p_expected_revision is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if jsonb_typeof(v_form) <> 'object' or (p_items is not null and jsonb_typeof(p_items) <> 'array') then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;

  select * into f from public.intake_forms where tenant_id = v_tenant and id = p_form_id for update;
  if not found then
    raise exception 'form_not_found' using errcode = 'CP404';
  end if;
  if f.revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = 'CP409';
  end if;
  if f.status = 'archived' then
    raise exception 'archived' using errcode = 'CP423';
  end if;

  -- (1) Datos del formulario. Claves desconocidas fuera; cada valor con su tipo.
  for v_key in select k from jsonb_object_keys(v_form) k loop
    if v_key <> all (c_form_keys) then
      raise exception 'unknown_form_key' using errcode = 'CP422';
    end if;
  end loop;

  v_name := f.name; v_title := f.title; v_intro := f.intro; v_success := f.success_message;
  v_old_origins := f.embed_origins;
  v_fields := f.fields; v_origins := f.embed_origins; v_cap := f.daily_cap; v_url := f.privacy_policy_url;

  if v_form ? 'name' then
    if jsonb_typeof(v_form -> 'name') <> 'string' then raise exception 'invalid_name' using errcode = 'CP422'; end if;
    v_name := btrim(v_form ->> 'name');
    if char_length(v_name) not between 1 and 120 or app.intake_text_unsafe(v_name) then
      raise exception 'invalid_name' using errcode = 'CP422';
    end if;
  end if;
  if v_form ? 'title' then
    if jsonb_typeof(v_form -> 'title') <> 'string' then raise exception 'invalid_title' using errcode = 'CP422'; end if;
    v_title := btrim(v_form ->> 'title');
    if char_length(v_title) not between 1 and 120 or app.intake_text_unsafe(v_title) then
      raise exception 'invalid_title' using errcode = 'CP422';
    end if;
  end if;
  if v_form ? 'intro' then
    if jsonb_typeof(v_form -> 'intro') <> 'string' then raise exception 'invalid_intro' using errcode = 'CP422'; end if;
    v_intro := btrim(replace(v_form ->> 'intro', E'\r', ''));
    if char_length(v_intro) > 1000 or app.intake_text_unsafe(v_intro, true) then
      raise exception 'invalid_intro' using errcode = 'CP422';
    end if;
  end if;
  if v_form ? 'success_message' then
    if jsonb_typeof(v_form -> 'success_message') <> 'string' then
      raise exception 'invalid_success_message' using errcode = 'CP422';
    end if;
    v_success := btrim(replace(v_form ->> 'success_message', E'\r', ''));
    if char_length(v_success) > 500 or app.intake_text_unsafe(v_success, true) then
      raise exception 'invalid_success_message' using errcode = 'CP422';
    end if;
  end if;
  if v_form ? 'fields' then
    if not app.intake_fields_valid(v_form -> 'fields') then
      raise exception 'invalid_fields' using errcode = 'CP422';
    end if;
    v_fields := v_form -> 'fields';
  end if;
  if v_form ? 'embed_origins' then
    if jsonb_typeof(v_form -> 'embed_origins') <> 'array'
       or exists (select 1 from jsonb_array_elements(v_form -> 'embed_origins') e where jsonb_typeof(e) <> 'string') then
      raise exception 'invalid_embed_origins' using errcode = 'CP422';
    end if;
    select coalesce(array_agg(distinct e #>> '{}' order by e #>> '{}'), array[]::text[])
      into v_origins from jsonb_array_elements(v_form -> 'embed_origins') e;
    if not app.embed_origins_valid(v_origins) then
      raise exception 'invalid_embed_origins' using errcode = 'CP422';
    end if;
  end if;
  if v_form ? 'daily_cap' then
    if not app.calc_jsonb_int_in_range(v_form -> 'daily_cap', 1, app.intake_max_daily_cap()) then
      raise exception 'invalid_daily_cap' using errcode = 'CP422';
    end if;
    v_cap := (v_form ->> 'daily_cap')::integer;
  end if;
  if v_form ? 'privacy_policy_url' then
    if jsonb_typeof(v_form -> 'privacy_policy_url') = 'null' then
      v_url := null;
    elsif jsonb_typeof(v_form -> 'privacy_policy_url') = 'string' then
      v_url := nullif(btrim(v_form ->> 'privacy_policy_url'), '');
      if not app.intake_policy_url_valid(v_url) then
        raise exception 'invalid_privacy_policy_url' using errcode = 'CP422';
      end if;
    else
      raise exception 'invalid_privacy_policy_url' using errcode = 'CP422';
    end if;
  end if;

  if v_name is distinct from f.name then v_changed := array_append(v_changed, 'name'); end if;
  if v_title is distinct from f.title then v_changed := array_append(v_changed, 'title'); end if;
  if v_intro is distinct from f.intro then v_changed := array_append(v_changed, 'intro'); end if;
  if v_success is distinct from f.success_message then v_changed := array_append(v_changed, 'success_message'); end if;
  if v_fields is distinct from f.fields then v_changed := array_append(v_changed, 'fields'); end if;
  if v_origins is distinct from f.embed_origins then v_changed := array_append(v_changed, 'embed_origins'); end if;
  if v_cap is distinct from f.daily_cap then v_changed := array_append(v_changed, 'daily_cap'); end if;
  if v_url is distinct from f.privacy_policy_url then v_changed := array_append(v_changed, 'privacy_policy_url'); end if;

  -- (2) Servicios: se valida toda la lista antes de tocar nada.
  if p_items is not null then
    if jsonb_array_length(p_items) > app.intake_max_items_per_form() then
      raise exception 'too_many_items' using errcode = 'CP422';
    end if;
    for v_item in select e from jsonb_array_elements(p_items) e loop
      if jsonb_typeof(v_item) <> 'object' then
        raise exception 'invalid_item' using errcode = 'CP422';
      end if;
      for v_key in select k from jsonb_object_keys(v_item) k loop
        if v_key <> all (c_item_keys) then
          raise exception 'unknown_item_key' using errcode = 'CP422';
        end if;
      end loop;
      if jsonb_typeof(v_item -> 'id') is distinct from 'string' or not app.is_uuid_text(v_item ->> 'id') then
        raise exception 'invalid_item_id' using errcode = 'CP422';
      end if;
      v_id := (v_item ->> 'id')::uuid;
      if v_id = any (v_ids) then
        raise exception 'duplicate_item_id' using errcode = 'CP422';
      end if;
      v_ids := v_ids || v_id;
      -- Un identificador que ya es de otro formulario u otra organización no se reutiliza.
      if exists (select 1 from public.intake_form_items i
                  where i.id = v_id and (i.tenant_id <> v_tenant or i.form_id <> p_form_id)) then
        raise exception 'item_id_taken' using errcode = 'CP422';
      end if;
      v_kind := v_item ->> 'kind';
      if jsonb_typeof(v_item -> 'kind') is distinct from 'string' or v_kind not in ('catalog', 'free') then
        raise exception 'invalid_item_kind' using errcode = 'CP422';
      end if;
      if v_kind = 'catalog' then
        if jsonb_typeof(v_item -> 'catalog_item_id') is distinct from 'string'
           or not app.is_uuid_text(v_item ->> 'catalog_item_id') then
          raise exception 'invalid_catalog_item' using errcode = 'CP422';
        end if;
        if not exists (select 1 from public.catalog_items c
                        where c.tenant_id = v_tenant and c.id = (v_item ->> 'catalog_item_id')::uuid) then
          raise exception 'catalog_item_not_found' using errcode = 'CP404';
        end if;
      elsif coalesce(jsonb_typeof(v_item -> 'catalog_item_id'), 'null') <> 'null' then
        raise exception 'invalid_catalog_item' using errcode = 'CP422';
      end if;
      if jsonb_typeof(v_item -> 'public_name') is distinct from 'string'
         or char_length(btrim(v_item ->> 'public_name')) not between 1 and 150
         or app.intake_text_unsafe(btrim(v_item ->> 'public_name')) then
        raise exception 'invalid_item_name' using errcode = 'CP422';
      end if;
      if coalesce(jsonb_typeof(v_item -> 'public_description'), 'null') not in ('null', 'string')
         or (jsonb_typeof(v_item -> 'public_description') = 'string'
             and (char_length(btrim(v_item ->> 'public_description')) > 500
                  or app.intake_text_unsafe(btrim(v_item ->> 'public_description'), true))) then
        raise exception 'invalid_item_description' using errcode = 'CP422';
      end if;
      if jsonb_typeof(v_item -> 'unit') is distinct from 'string' or (v_item ->> 'unit') <> all (c_units) then
        raise exception 'invalid_item_unit' using errcode = 'CP422';
      end if;
      if v_item ? 'quantity_mode'
         and (jsonb_typeof(v_item -> 'quantity_mode') is distinct from 'string'
              or (v_item ->> 'quantity_mode') not in ('none', 'optional', 'required')) then
        raise exception 'invalid_quantity_mode' using errcode = 'CP422';
      end if;
      foreach v_key in array array['min_qty_milli', 'max_qty_milli'] loop
        if coalesce(jsonb_typeof(v_item -> v_key), 'null') <> 'null'
           and not app.calc_jsonb_int_in_range(v_item -> v_key, app.intake_qty_min_milli(), app.intake_qty_max_milli()) then
          raise exception 'invalid_quantity_limit' using errcode = 'CP422';
        end if;
      end loop;
      if coalesce(jsonb_typeof(v_item -> 'min_qty_milli'), 'null') <> 'null'
         and coalesce(jsonb_typeof(v_item -> 'max_qty_milli'), 'null') <> 'null'
         and (v_item ->> 'min_qty_milli')::bigint > (v_item ->> 'max_qty_milli')::bigint then
        raise exception 'invalid_quantity_limit' using errcode = 'CP422';
      end if;
      if v_item ? 'is_active' and jsonb_typeof(v_item -> 'is_active') <> 'boolean' then
        raise exception 'invalid_item_active' using errcode = 'CP422';
      end if;
    end loop;

    -- (3) Se aplican: los que no vienen se quitan; los demás se agregan o se actualizan por su id.
    delete from public.intake_form_items
     where tenant_id = v_tenant and form_id = p_form_id and id <> all (v_ids);
    v_pos := 0;
    for v_item in select e from jsonb_array_elements(p_items) e loop
      v_kind := v_item ->> 'kind';
      v_cat := case when v_kind = 'catalog' then (v_item ->> 'catalog_item_id')::uuid end;
      v_pname := btrim(v_item ->> 'public_name');
      v_pdesc := case when jsonb_typeof(v_item -> 'public_description') = 'string'
                      then nullif(btrim(replace(v_item ->> 'public_description', E'\r', '')), '') end;
      v_unit := v_item ->> 'unit';
      v_qmode := coalesce(v_item ->> 'quantity_mode', 'optional');
      v_min := case when coalesce(jsonb_typeof(v_item -> 'min_qty_milli'), 'null') <> 'null'
                    then (v_item ->> 'min_qty_milli')::bigint end;
      v_max := case when coalesce(jsonb_typeof(v_item -> 'max_qty_milli'), 'null') <> 'null'
                    then (v_item ->> 'max_qty_milli')::bigint end;
      v_active := coalesce((v_item ->> 'is_active')::boolean, true);
      insert into public.intake_form_items as i
        (id, tenant_id, form_id, position, kind, catalog_item_id, public_name, public_description, unit,
         quantity_mode, min_qty_milli, max_qty_milli, is_active)
      values
        ((v_item ->> 'id')::uuid, v_tenant, p_form_id, v_pos, v_kind, v_cat, v_pname, v_pdesc, v_unit,
         v_qmode, v_min, v_max, v_active)
      on conflict (id) do update set
        position = excluded.position, kind = excluded.kind, catalog_item_id = excluded.catalog_item_id,
        public_name = excluded.public_name, public_description = excluded.public_description,
        unit = excluded.unit, quantity_mode = excluded.quantity_mode, min_qty_milli = excluded.min_qty_milli,
        max_qty_milli = excluded.max_qty_milli, is_active = excluded.is_active
       where i.tenant_id = excluded.tenant_id and i.form_id = excluded.form_id
         and (i.position, i.kind, i.catalog_item_id, i.public_name, i.public_description, i.unit,
              i.quantity_mode, i.min_qty_milli, i.max_qty_milli, i.is_active)
             is distinct from
             (excluded.position, excluded.kind, excluded.catalog_item_id, excluded.public_name,
              excluded.public_description, excluded.unit, excluded.quantity_mode, excluded.min_qty_milli,
              excluded.max_qty_milli, excluded.is_active);
      v_pos := v_pos + 1;
    end loop;
    v_items_changed := true;
  end if;

  -- (4) Un formulario publicado nunca se queda sin nada que pedir.
  select count(*) into v_active_items from public.intake_form_items
   where tenant_id = v_tenant and form_id = p_form_id and is_active;
  if f.status in ('published', 'paused') and v_active_items < 1 then
    raise exception 'needs_item' using errcode = 'CP422';
  end if;

  update public.intake_forms
     set name = v_name, title = v_title, intro = v_intro, success_message = v_success, fields = v_fields,
         embed_origins = v_origins, daily_cap = v_cap, privacy_policy_url = v_url, revision = f.revision + 1
   where tenant_id = v_tenant and id = p_form_id
  returning * into f;

  -- (5) Auditoría: qué se tocó (nunca el contenido), y la lista de sitios con su valor anterior y nuevo.
  if v_items_changed then
    v_changed := array_append(v_changed, 'items');
  end if;
  perform app.write_audit(v_tenant, 'user', v_uid, 'intake_form.updated', 'intake_form', f.id, 'success',
    jsonb_build_object('changed', to_jsonb(v_changed), 'revision', f.revision));
  if 'embed_origins' = any (v_changed) then
    perform app.write_audit(v_tenant, 'user', v_uid, 'intake_form.embed_origins_changed', 'intake_form', f.id,
      'success', jsonb_build_object('old', to_jsonb(v_old_origins), 'new', to_jsonb(f.embed_origins)));
  end if;
  return jsonb_build_object('id', f.id, 'public_id', f.public_id, 'revision', f.revision, 'status', f.status);
end $$;
revoke all on function public.save_intake_form(uuid, integer, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_intake_form(uuid, integer, jsonb, jsonb) to authenticated;

-- 6. set_intake_form_status --------------------------------------------------------------------
-- Cambios permitidos: borrador → publicado | archivado; publicado → pausado | archivado;
-- pausado → publicado | archivado. Publicar exige al menos un servicio activo y el correo de contacto
-- de la organización. Repetir el mismo estado no hace nada.
create function public.set_intake_form_status(p_form_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  f        public.intake_forms;
  v_old    text;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_form_id is null or p_status is null or p_status not in ('published', 'paused', 'archived') then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into f from public.intake_forms where tenant_id = v_tenant and id = p_form_id for update;
  if not found then
    raise exception 'form_not_found' using errcode = 'CP404';
  end if;
  if f.status = p_status then
    return jsonb_build_object('status', f.status, 'changed', false);
  end if;
  v_old := f.status;
  if not (
       (f.status = 'draft'     and p_status in ('published', 'archived'))
    or (f.status = 'published' and p_status in ('paused', 'archived'))
    or (f.status = 'paused'    and p_status in ('published', 'archived'))) then
    raise exception 'invalid_status_change' using errcode = 'CP423';
  end if;

  if p_status = 'published' then
    if not exists (select 1 from public.intake_form_items i
                    where i.tenant_id = v_tenant and i.form_id = f.id and i.is_active) then
      raise exception 'needs_item' using errcode = 'CP422';
    end if;
    if not exists (select 1 from public.tenants t
                    where t.tenant_id = v_tenant and nullif(btrim(t.contact_email), '') is not null) then
      raise exception 'needs_contact_email' using errcode = 'CP422';
    end if;
    update public.intake_forms
       set status = 'published', published_at = coalesce(published_at, now()), paused_at = null
     where tenant_id = v_tenant and id = f.id;
  elsif p_status = 'paused' then
    update public.intake_forms set status = 'paused', paused_at = now()
     where tenant_id = v_tenant and id = f.id;
  else
    update public.intake_forms set status = 'archived'
     where tenant_id = v_tenant and id = f.id;
  end if;

  perform app.write_audit(v_tenant, 'user', v_uid,
    case p_status when 'published' then 'intake_form.published'
                  when 'paused' then 'intake_form.paused' else 'intake_form.archived' end,
    'intake_form', f.id, 'success', jsonb_build_object('from', v_old));
  return jsonb_build_object('status', p_status, 'changed', true);
end $$;
revoke all on function public.set_intake_form_status(uuid, text) from public, anon, authenticated;
grant execute on function public.set_intake_form_status(uuid, text) to authenticated;

-- 7. regenerate_intake_form_public_id ----------------------------------------------------------
-- Genera otro identificador público. El anterior (impreso en un QR o pegado en una página) deja de
-- funcionar de inmediato. Sirve cuando alguien llena el formulario de basura.
create function public.regenerate_intake_form_public_id(p_form_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  f        public.intake_forms;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_form_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into f from public.intake_forms where tenant_id = v_tenant and id = p_form_id for update;
  if not found then
    raise exception 'form_not_found' using errcode = 'CP404';
  end if;
  if f.status = 'archived' then
    raise exception 'archived' using errcode = 'CP423';
  end if;
  update public.intake_forms set public_id = app.new_intake_public_id()
   where tenant_id = v_tenant and id = f.id
  returning * into f;
  perform app.write_audit(v_tenant, 'user', v_uid, 'intake_form.link_regenerated', 'intake_form', f.id, 'success');
  return jsonb_build_object('public_id', f.public_id);
end $$;
revoke all on function public.regenerate_intake_form_public_id(uuid) from public, anon, authenticated;
grant execute on function public.regenerate_intake_form_public_id(uuid) to authenticated;
