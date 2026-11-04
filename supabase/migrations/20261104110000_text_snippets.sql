-- Sprint 5 · H-048a · Textos listos para usar (tabla y funciones)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261104110000_text_snippets.down.sql
-- Especificación: docs/arquitectura/sprint-5-h-048-textos.md §2 (tabla y funciones), §6 (variables) y §7 (permisos).
--
-- Qué agrega:
--   · `public.text_snippets`: los textos con nombre que una organización guarda para reutilizar. Cuatro tipos
--     (`email_body` texto del correo, `conditions`, `exclusions`, `footer_note`). Todo miembro de la organización
--     activa los LEE; NADIE escribe directo (ni un permiso de escritura ni una política): escriben solo las tres
--     funciones de abajo, que deciden con `app.can('settings.manage')` (matriz de H-011a; no se agrega ninguna acción).
--   · Tres funciones con el pase de la persona, con estas firmas exactas (la organización sale SIEMPRE de
--     `app.current_tenant_id()`, nunca de un argumento):
--       public.create_text_snippet(p_snippet_id uuid, p_kind text, p_name text, p_body text, p_is_default boolean)
--         → {result: 'created' | 'exists', id, revision}          (repetir el mismo id en la misma organización
--                                                                   devuelve 'exists' y no cambia nada)
--       public.update_text_snippet(p_snippet_id uuid, p_expected_revision integer, p_name text, p_body text,
--                                  p_is_default boolean)
--         → {result: 'updated' | 'unchanged', id, revision}       (el tipo NO se cambia nunca; el cambio es
--                                                                   completo: nombre, texto y «texto inicial»)
--       public.delete_text_snippet(p_snippet_id uuid)
--         → {result: 'deleted'}                                   (borrar es de verdad: nada apunta a un texto guardado)
--   · Constantes con nombre (`app.snippet*`) y las revisiones de variables (`app.snippet_variables_problem`), gemelas
--     de `src/lib/snippets/model.ts`. `tests/db/text-snippets.test.ts` falla si alguna se separa de su gemela.
--
-- Reglas:
--   · Nombre 1 a 80 caracteres y texto 1 a 4.000, sin espacios, tabuladores ni saltos de línea en los bordes (los
--     saltos de Windows pasan a uno solo), sin caracteres de control ni invisibles (`app.intake_text_unsafe`).
--   · Hasta 50 textos por organización. Nombre único por tipo, sin distinguir mayúsculas.
--   · Variables (`{{cliente}}`, `{{numero}}`, `{{remitente}}`, `{{organizacion}}`): solo en `email_body`, solo esas
--     cuatro escritas exactamente, hasta 10 en total, y ninguna llave suelta. En los otros tres tipos no se acepta
--     ningún `{{` ni `}}`.
--   · `is_default` («texto inicial del correo»): solo `email_body`, uno por organización. Marcar uno desmarca el
--     anterior en el mismo paso (el anterior sube su revisión y queda en la auditoría).
--   · `revision`: sube en 1 con cada cambio. `update_text_snippet` recibe la que vio quien edita; si otra persona
--     guardó antes, responde CP409 sin cambiar nada.
--   · Auditoría `text_snippet.created / updated / deleted` con tipo, nombre y campos cambiados, SIN el texto. No se
--     usa `app.audit_row_change('diff')`: guardaría el texto completo y el detalle de la auditoría tiene un tope.
--
-- Códigos de error propios (SQLSTATE) y su motivo (el mensaje del error):
--   42501 forbidden · CP404 not_found (sin organización activa propia), snippet_not_found · CP409 revision_conflict ·
--   CP422 invalid_arguments, invalid_kind, invalid_name, invalid_body, default_only_email, variables_not_allowed,
--         unknown_variable, too_many_variables, too_many_snippets, name_taken, id_in_use.
--
-- Orden de revisiones (para no revelar nada a quien no corresponde):
--   create_text_snippet: 1) ¿es miembro de la organización activa? no → CP404 · 2) ¿tiene el permiso? no → 42501 ·
--     3) forma de los argumentos y reglas del texto (nombre, texto, variables, texto inicial) → CP422 ·
--     4) candado por organización · 5) ¿ya existe ese id? · 6) tope de textos y nombre repetido → CP422.
--   update_text_snippet: 1) y 2) igual · 3) forma de los argumentos → CP422 · 4) candado por organización ·
--     5) existencia (CP404) y revisión (CP409) · 6) reglas del texto y nombre repetido → CP422.
--   delete_text_snippet: 1) y 2) igual · 3) forma del argumento · 4) candado · 5) existencia (CP404).

-- 0. Constantes con nombre -------------------------------------------------------------------------
create function app.snippets_max_per_tenant()          returns integer language sql immutable as $$ select 50 $$;
create function app.snippet_name_max_length()          returns integer language sql immutable as $$ select 80 $$;
create function app.snippet_body_max_length()          returns integer language sql immutable as $$ select 4000 $$;
create function app.snippet_max_variables()            returns integer language sql immutable as $$ select 10 $$;
create function app.snippet_variable_value_max_length() returns integer language sql immutable as $$ select 100 $$;
create function app.snippet_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['email_body', 'conditions', 'exclusions', 'footer_note']
$$;
create function app.snippet_variable_names() returns text[]
language sql immutable set search_path = '' as $$
  select array['cliente', 'numero', 'remitente', 'organizacion']
$$;

-- Nombre y texto listos para guardar. Gemelas de `normalizeSnippetName` y `normalizeSnippetBody`: pasan a forma
-- NFC (una tilde separada de su letra queda unida: «Condición» se escribe de una sola manera), se quitan espacios,
-- tabuladores y saltos de línea de los bordes, y los saltos de Windows pasan a uno solo.
create function app.snippet_normalize_name(p text) returns text
language sql immutable set search_path = '' as $$
  select btrim(normalize(p, nfc), E' \t\n')
$$;
create function app.snippet_normalize_body(p text) returns text
language sql immutable set search_path = '' as $$
  select btrim(replace(replace(normalize(p, nfc), E'\r\n', E'\n'), E'\r', E'\n'), E' \t\n')
$$;

-- Revisión de variables de un texto YA normalizado. Devuelve el motivo del problema o null si está bien.
-- Gemela de `checkSnippetVariables` (src/lib/snippets/model.ts): mismo orden, mismas reglas.
create function app.snippet_variables_problem(p_kind text, p_body text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_name  text;
  v_count integer := 0;
  v_rest  text;
begin
  if p_kind <> 'email_body' then
    if position('{{' in p_body) > 0 or position('}}' in p_body) > 0 then
      return 'variables_not_allowed';
    end if;
    return null;
  end if;
  for v_name in
    select r.m[1] from regexp_matches(p_body, '\{\{([^{}]*)\}\}', 'g') as r(m)
  loop
    v_count := v_count + 1;
    if v_name <> all (app.snippet_variable_names()) then
      return 'unknown_variable';
    end if;
  end loop;
  -- Fuera de las variables completas no puede quedar ninguna llave: así lo que se inserte después en el lugar
  -- de una variable jamás puede formar una variable nueva.
  v_rest := regexp_replace(p_body, '\{\{[^{}]*\}\}', '', 'g');
  if position('{' in v_rest) > 0 or position('}' in v_rest) > 0 then
    return 'unknown_variable';
  end if;
  if v_count > app.snippet_max_variables() then
    return 'too_many_variables';
  end if;
  return null;
end $$;

revoke all on function
  app.snippets_max_per_tenant(), app.snippet_name_max_length(), app.snippet_body_max_length(),
  app.snippet_max_variables(), app.snippet_variable_value_max_length(), app.snippet_kinds(),
  app.snippet_variable_names(), app.snippet_normalize_name(text), app.snippet_normalize_body(text),
  app.snippet_variables_problem(text, text)
  from public, anon, authenticated;

-- 1. La tabla ----------------------------------------------------------------------------------------
create table public.text_snippets (
  id         uuid primary key,   -- lo genera la aplicación (así un doble clic no crea dos textos)
  tenant_id  uuid not null references public.tenants (tenant_id) on update cascade,
  kind       text not null check (kind = any (app.snippet_kinds())),
  name       text not null check (char_length(name) between 1 and app.snippet_name_max_length()
                                  and not app.intake_text_unsafe(name)),
  body       text not null check (char_length(body) between 1 and app.snippet_body_max_length()
                                  and not app.intake_text_unsafe(body, true)),
  is_default boolean not null default false,
  revision   integer not null default 1 check (revision >= 1),
  created_by uuid references auth.users (id),
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  constraint text_snippets_default_only_email check (not is_default or kind = 'email_body')
);
-- Un nombre por tipo, sin distinguir mayúsculas. Sirve también para listar por tipo y nombre.
create unique index text_snippets_name_per_kind on public.text_snippets (tenant_id, kind, lower(name));
-- Un solo texto inicial por organización.
create unique index text_snippets_one_default on public.text_snippets (tenant_id) where is_default;

create trigger text_snippets_meta before insert or update on public.text_snippets
  for each row execute function app.set_row_meta_by();
create trigger text_snippets_forbid_tenant_change before update on public.text_snippets
  for each row execute function app.forbid_tenant_change();
-- Sin disparador de auditoría de filas (`audit_row_change`): guardaría el texto completo. Auditan las funciones.

alter table public.text_snippets enable row level security;
-- Todo miembro de la organización activa lee sus textos. Sin políticas ni permisos de escritura: solo las funciones.
create policy text_snippets_select on public.text_snippets for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
grant select on public.text_snippets to authenticated;

-- 2. create_text_snippet ----------------------------------------------------------------------------
create function public.create_text_snippet(
  p_snippet_id uuid, p_kind text, p_name text, p_body text, p_is_default boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant   uuid := app.current_tenant_id();
  v_uid      uuid := auth.uid();
  v_name     text;
  v_body     text;
  v_problem  text;
  v_existing public.text_snippets;
  v_prev     record;
begin
  -- 1. ¿es miembro de la organización activa?
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  -- 2. ¿puede administrar los textos?
  if not app.can('settings.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 3. forma de lo recibido
  if p_snippet_id is null or p_kind is null or p_name is null or p_body is null or p_is_default is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if p_kind <> all (app.snippet_kinds()) then
    raise exception 'invalid_kind' using errcode = 'CP422';
  end if;
  v_name := app.snippet_normalize_name(p_name);
  v_body := app.snippet_normalize_body(p_body);
  if char_length(v_name) not between 1 and app.snippet_name_max_length() or app.intake_text_unsafe(v_name) then
    raise exception 'invalid_name' using errcode = 'CP422';
  end if;
  if char_length(v_body) not between 1 and app.snippet_body_max_length() or app.intake_text_unsafe(v_body, true) then
    raise exception 'invalid_body' using errcode = 'CP422';
  end if;
  if p_is_default and p_kind <> 'email_body' then
    raise exception 'default_only_email' using errcode = 'CP422';
  end if;
  v_problem := app.snippet_variables_problem(p_kind, v_body);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = 'CP422';
  end if;

  -- 4. candado por organización: dos creaciones a la vez no pasan el tope ni repiten el nombre.
  perform pg_advisory_xact_lock(hashtextextended('text_snippets:' || v_tenant::text, 0));

  -- 5. el mismo identificador otra vez (doble clic): se devuelve el que ya existe, sin cambiar nada.
  select * into v_existing from public.text_snippets s where s.id = p_snippet_id;
  if found then
    if v_existing.tenant_id <> v_tenant then
      raise exception 'id_in_use' using errcode = 'CP422';
    end if;
    return jsonb_build_object('result', 'exists', 'id', v_existing.id, 'revision', v_existing.revision);
  end if;

  -- 6. topes y nombre repetido
  if (select count(*) from public.text_snippets s where s.tenant_id = v_tenant) >= app.snippets_max_per_tenant() then
    raise exception 'too_many_snippets' using errcode = 'CP422';
  end if;
  if exists (select 1 from public.text_snippets s
              where s.tenant_id = v_tenant and s.kind = p_kind and lower(s.name) = lower(v_name)) then
    raise exception 'name_taken' using errcode = 'CP422';
  end if;

  -- El texto inicial anterior se desmarca en el mismo paso (el índice permite uno solo).
  if p_is_default then
    for v_prev in
      update public.text_snippets s set is_default = false, revision = s.revision + 1
       where s.tenant_id = v_tenant and s.is_default
      returning s.id, s.kind, s.name
    loop
      perform app.write_audit(v_tenant, 'user', v_uid, 'text_snippet.updated', 'text_snippet', v_prev.id, 'success',
        jsonb_build_object('kind', v_prev.kind, 'name', v_prev.name, 'changed', jsonb_build_array('is_default')));
    end loop;
  end if;

  begin
    insert into public.text_snippets (id, tenant_id, kind, name, body, is_default)
    values (p_snippet_id, v_tenant, p_kind, v_name, v_body, p_is_default);
  exception when unique_violation then
    -- Otra organización usó el mismo identificador justo ahora; si no, el nombre se repitió.
    if exists (select 1 from public.text_snippets s where s.id = p_snippet_id) then
      raise exception 'id_in_use' using errcode = 'CP422';
    end if;
    raise exception 'name_taken' using errcode = 'CP422';
  end;
  perform app.write_audit(v_tenant, 'user', v_uid, 'text_snippet.created', 'text_snippet', p_snippet_id, 'success',
    jsonb_build_object('kind', p_kind, 'name', v_name, 'is_default', p_is_default));
  return jsonb_build_object('result', 'created', 'id', p_snippet_id, 'revision', 1);
end $$;
revoke all on function public.create_text_snippet(uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.create_text_snippet(uuid, text, text, text, boolean) to authenticated;

-- 3. update_text_snippet ----------------------------------------------------------------------------
-- Cambio completo: nombre, texto y «texto inicial». El tipo no cambia nunca (para otro tipo: se crea uno nuevo).
create function public.update_text_snippet(
  p_snippet_id uuid, p_expected_revision integer, p_name text, p_body text, p_is_default boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant  uuid := app.current_tenant_id();
  v_uid     uuid := auth.uid();
  v_row     public.text_snippets;
  v_name    text;
  v_body    text;
  v_problem text;
  v_changed text[] := array[]::text[];
  v_prev    record;
begin
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  if not app.can('settings.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_snippet_id is null or p_expected_revision is null or p_expected_revision < 1
     or p_name is null or p_body is null or p_is_default is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('text_snippets:' || v_tenant::text, 0));
  select * into v_row from public.text_snippets s
   where s.tenant_id = v_tenant and s.id = p_snippet_id for update;
  if not found then
    raise exception 'snippet_not_found' using errcode = 'CP404';
  end if;
  -- Otra persona (u otra pestaña) guardó antes: no se pisa su cambio.
  if v_row.revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = 'CP409';
  end if;

  v_name := app.snippet_normalize_name(p_name);
  v_body := app.snippet_normalize_body(p_body);
  if char_length(v_name) not between 1 and app.snippet_name_max_length() or app.intake_text_unsafe(v_name) then
    raise exception 'invalid_name' using errcode = 'CP422';
  end if;
  if char_length(v_body) not between 1 and app.snippet_body_max_length() or app.intake_text_unsafe(v_body, true) then
    raise exception 'invalid_body' using errcode = 'CP422';
  end if;
  if p_is_default and v_row.kind <> 'email_body' then
    raise exception 'default_only_email' using errcode = 'CP422';
  end if;
  v_problem := app.snippet_variables_problem(v_row.kind, v_body);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = 'CP422';
  end if;
  if exists (select 1 from public.text_snippets s
              where s.tenant_id = v_tenant and s.kind = v_row.kind and s.id <> v_row.id
                and lower(s.name) = lower(v_name)) then
    raise exception 'name_taken' using errcode = 'CP422';
  end if;

  if v_name is distinct from v_row.name then v_changed := array_append(v_changed, 'name'); end if;
  if v_body is distinct from v_row.body then v_changed := array_append(v_changed, 'body'); end if;
  if p_is_default is distinct from v_row.is_default then v_changed := array_append(v_changed, 'is_default'); end if;
  if cardinality(v_changed) = 0 then
    return jsonb_build_object('result', 'unchanged', 'id', v_row.id, 'revision', v_row.revision);
  end if;

  if p_is_default and not v_row.is_default then
    for v_prev in
      update public.text_snippets s set is_default = false, revision = s.revision + 1
       where s.tenant_id = v_tenant and s.is_default and s.id <> v_row.id
      returning s.id, s.kind, s.name
    loop
      perform app.write_audit(v_tenant, 'user', v_uid, 'text_snippet.updated', 'text_snippet', v_prev.id, 'success',
        jsonb_build_object('kind', v_prev.kind, 'name', v_prev.name, 'changed', jsonb_build_array('is_default')));
    end loop;
  end if;
  update public.text_snippets s
     set name = v_name, body = v_body, is_default = p_is_default, revision = s.revision + 1
   where s.tenant_id = v_tenant and s.id = v_row.id;
  perform app.write_audit(v_tenant, 'user', v_uid, 'text_snippet.updated', 'text_snippet', v_row.id, 'success',
    jsonb_build_object('kind', v_row.kind, 'name', v_name, 'changed', to_jsonb(v_changed)));
  return jsonb_build_object('result', 'updated', 'id', v_row.id, 'revision', v_row.revision + 1);
end $$;
revoke all on function public.update_text_snippet(uuid, integer, text, text, boolean) from public, anon, authenticated;
grant execute on function public.update_text_snippet(uuid, integer, text, text, boolean) to authenticated;

-- 4. delete_text_snippet ----------------------------------------------------------------------------
-- Borrar es de verdad: ninguna cotización apunta a un texto guardado (cada una guarda su copia).
create function public.delete_text_snippet(p_snippet_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  v_row    public.text_snippets;
begin
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  if not app.can('settings.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_snippet_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('text_snippets:' || v_tenant::text, 0));
  select * into v_row from public.text_snippets s
   where s.tenant_id = v_tenant and s.id = p_snippet_id for update;
  if not found then
    raise exception 'snippet_not_found' using errcode = 'CP404';
  end if;
  delete from public.text_snippets s where s.tenant_id = v_tenant and s.id = v_row.id;
  perform app.write_audit(v_tenant, 'user', v_uid, 'text_snippet.deleted', 'text_snippet', v_row.id, 'success',
    jsonb_build_object('kind', v_row.kind, 'name', v_row.name, 'was_default', v_row.is_default));
  return jsonb_build_object('result', 'deleted');
end $$;
revoke all on function public.delete_text_snippet(uuid) from public, anon, authenticated;
grant execute on function public.delete_text_snippet(uuid) to authenticated;
