-- Sprint 5 · H-042 · Servicios por comercial (PR 1: la base, sin pantallas)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261124110000_member_catalog_scope.down.sql
-- Diseño: docs/arquitectura/h-042-servicios-por-comercial.md (§2, §3, §4 y «Puesta al día del 2026-11-19»; decisiones D2, D3, D4, D6, D11 y D13).
--
-- Qué agrega:
--   · `public.member_catalog_scopes` (una fila por miembro que tiene una regla; sin fila = «todos los servicios») y
--     `public.member_catalog_scope_items` (la lista cerrada de servicios). Ambas con `tenant_id`, RLS (las leen el Dueño y el Administrador:
--     `team.manage`), sin permisos de escritura directa y relaciones compuestas con `members` y `catalog_items`. La regla cuelga de la
--     MEMBRESÍA, no de la persona: Mixta puede tener reglas distintas en A y en B.
--   · `public.set_member_catalog_scope(miembro, modo, servicios, versión esperada)`: la ÚNICA que escribe. Exige `team.manage`, busca al miembro
--     SIEMPRE dentro de la organización activa, solo deja limitar a quien puede cotizar y no maneja el catálogo (sin nombrar roles), repite lo
--     pedido sin error («unchanged»), protege contra dos Administradores que se pisan (`revision`) y audita `member.catalog_scope_changed`.
--   · `app.catalog_scope_limited()`, `app.my_catalog_scope_item_ids()` y `app.can_quote_catalog_item(uuid)`: el predicado único (el gancho y lo que
--     ofrece el cotizador salen de la misma lista de servicios permitidos). `app.can_quote_catalog_item` REEMPLAZA el
--     gancho que dejó H-041 (que respondía siempre «sí») con `create or replace`: `save_quote_draft` ya lo llama para cada línea NUEVA del
--     catálogo y no se toca. Mantiene el nombre del parámetro y `security definer set search_path = ''`. Ante la duda responde «no»: sin
--     organización activa o sin sesión, o con un servicio que no es de esta organización. NUNCA toma la organización de un parámetro.
--   · `public.quotable_catalog_items(búsqueda, ids)`: lo que el cotizador ofrece. Corre con los permisos de quien llama (la RLS de
--     `catalog_items` sigue como segunda capa) y solo usa el predicado para decidir. Devuelve también `price_locked` (H-041).
--   · `public.my_catalog_scope()`: dos datos sobre quien llama (si tiene límite y cuántos servicios activos puede cotizar), para el aviso del editor.
--   · `app.member_catalog_scope_max_items()`: el tope de la lista (500, D11).
--
-- Permiso del gancho (riesgo 1 de la «Puesta al día»): `quotable_catalog_items` corre con los permisos de quien llama, así que necesita ejecutar
-- el predicado. H-041 le había quitado a `authenticated` el permiso de ejecutar el gancho y `tests/db/price-locks.test.ts` lo exigía; aquí se
-- da (opción (a) del diseño): el gancho solo responde sobre quien pregunta y la API solo expone `public`. El deshacer vuelve a quitarlo.
--
-- Quién queda limitado: toda persona con una fila `list` que no maneja el catálogo (hoy, solo el Comercial; D4: si pasa a Dueño o Administrador
-- la fila se conserva pero no aplica). Las líneas libres escritas a mano NO se limitan (D2): H-042 ordena la lista del Comercial y no controla.
-- Las líneas que la cotización ya tenía no se revisan (el gancho solo se llama para líneas nuevas), así un borrador viejo se sigue guardando y
-- enviando. No hay migración de datos y no se toca ninguna cotización.
--
-- Orden de bloqueos de `set_member_catalog_scope`: filas de `members` de quien actúa y del miembro (por orden de id, `for share`, el mismo orden que
-- `change_member_role` y `remove_member`), un candado por miembro (`pg_advisory_xact_lock`, solo para ordenar a quienes escriben su regla, también cuando todavía
-- no tiene fila) y después la fila de `member_catalog_scopes`. Un cambio de rol o una quitada concurrentes esperan o
-- se ven, y no se cruzan.
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia `set local lock_timeout = '3s'` y, justo después, la verificación de que el valor
-- quedó puesto.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261124110000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

-- 1. La constante ------------------------------------------------------------------------------------
create function app.member_catalog_scope_max_items() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 500 $$;
revoke all on function app.member_catalog_scope_max_items() from public, anon, authenticated;

-- 2. Las tablas -------------------------------------------------------------------------------------
create table public.member_catalog_scopes (
  tenant_id  uuid not null references public.tenants (tenant_id) on update cascade,
  member_id  uuid not null,
  mode       text not null check (mode in ('all', 'list')),
  revision   integer not null default 1 check (revision >= 1),
  created_by uuid references auth.users (id),
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, member_id),
  foreign key (tenant_id, member_id) references public.members (tenant_id, id)
);
create trigger member_catalog_scopes_meta before insert or update on public.member_catalog_scopes
  for each row execute function app.set_row_meta_by();
create trigger member_catalog_scopes_forbid_tenant_change before update on public.member_catalog_scopes
  for each row execute function app.forbid_tenant_change();

create table public.member_catalog_scope_items (
  tenant_id       uuid not null,
  member_id       uuid not null,
  catalog_item_id uuid not null,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  primary key (tenant_id, member_id, catalog_item_id),
  foreign key (tenant_id, member_id) references public.member_catalog_scopes (tenant_id, member_id) on delete cascade,
  foreign key (tenant_id, catalog_item_id) references public.catalog_items (tenant_id, id) on delete cascade
);
create index member_catalog_scope_items_by_item on public.member_catalog_scope_items (tenant_id, catalog_item_id);
create trigger member_catalog_scope_items_forbid_tenant_change before update on public.member_catalog_scope_items
  for each row execute function app.forbid_tenant_change();
-- Sin disparador de auditoría de filas (`audit_row_change`): `set_member_catalog_scope` audita con el detalle que corresponde.

-- RLS: solo el Dueño y el Administrador leen estas tablas; el Comercial sabe lo suyo por las funciones que solo hablan de él. Sin permisos
-- de escritura: solo `set_member_catalog_scope`.
alter table public.member_catalog_scopes enable row level security;
alter table public.member_catalog_scope_items enable row level security;
create policy member_catalog_scopes_select on public.member_catalog_scopes for select to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.can('team.manage')));
create policy member_catalog_scope_items_select on public.member_catalog_scope_items for select to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.can('team.manage')));
grant select on public.member_catalog_scopes, public.member_catalog_scope_items to authenticated;

-- 3. El predicado único ----------------------------------------------------------------------------------
-- ¿Tengo límite? Sí solo si NO manejo el catálogo y mi membresía ACTIVA en la organización activa tiene una fila `list`.
create function app.catalog_scope_limited() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    app.current_tenant_id() is not null
    and auth.uid() is not null
    and not app.can('catalog.manage')
    and exists (
      select 1
        from public.members m
        join public.member_catalog_scopes s on s.tenant_id = m.tenant_id and s.member_id = m.id
       where m.tenant_id = app.current_tenant_id()
         and m.user_id = auth.uid()
         and m.status = 'active'
         and s.mode = 'list'),
    false)
$$;
revoke all on function app.catalog_scope_limited() from public, anon, authenticated;
grant execute on function app.catalog_scope_limited() to authenticated;

-- Los servicios que MI regla permite (membresía activa en la organización activa), de una vez. La usan el gancho y `quotable_catalog_items`: así
-- «¿puedo cotizar este servicio?» y «qué se me ofrece» salen de la MISMA lista y la lista se calcula una vez por consulta (no por fila: con
-- 2.000 servicios, calcular el predicado fila por fila tardaba ~940 ms para un Comercial limitado). Solo lee lo de quien llama.
create function app.my_catalog_scope_item_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select i.catalog_item_id
    from public.members m
    join public.member_catalog_scope_items i on i.tenant_id = m.tenant_id and i.member_id = m.id
   where m.tenant_id = app.current_tenant_id()
     and m.user_id = auth.uid()
     and m.status = 'active'
$$;
revoke all on function app.my_catalog_scope_item_ids() from public, anon, authenticated;
grant execute on function app.my_catalog_scope_item_ids() to authenticated;

-- El gancho de H-041, ahora de verdad. Misma firma, mismo nombre de parámetro y mismos atributos que el que reemplaza.
create or replace function app.can_quote_catalog_item(p_catalog_item_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    app.current_tenant_id() is not null
    and auth.uid() is not null
    and p_catalog_item_id is not null
    and exists (
      select 1 from public.catalog_items ci
       where ci.tenant_id = app.current_tenant_id() and ci.id = p_catalog_item_id)
    and (
      not app.catalog_scope_limited()
      or p_catalog_item_id in (select app.my_catalog_scope_item_ids())),
    false)
$$;
revoke all on function app.can_quote_catalog_item(uuid) from public, anon, authenticated;
grant execute on function app.can_quote_catalog_item(uuid) to authenticated;

-- 4. Lo que el cotizador ofrece -------------------------------------------------------------------------------
-- Con los permisos de quien llama (`security invoker`): la RLS de `catalog_items` sigue como segunda capa. «¿Tengo límite?» se calcula UNA vez por
-- consulta. Con búsqueda, hasta 20 por nombre parcial (los comodines `%` y `_` se buscan tal cual); con `p_ids`, hasta 200 (convertir una solicitud).
create function public.quotable_catalog_items(p_search text default '', p_ids uuid[] default null)
returns table (
  id uuid, name text, description text, unit text, unit_price_clp bigint, tax_treatment text, price_locked boolean
)
language plpgsql stable security invoker set search_path = '' as $$
declare
  c_search_max constant integer := 100;
  c_search_limit constant integer := 20;
  c_ids_max constant integer := 200;
  v_limited boolean := app.catalog_scope_limited();
  v_search  text := left(btrim(coalesce(p_search, '')), c_search_max);
  v_pattern text := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  if p_ids is not null and cardinality(p_ids) > c_ids_max then
    raise exception 'too_many_ids' using errcode = 'CP422';
  end if;
  return query
    select ci.id, ci.name, ci.description, ci.unit, ci.unit_price_clp, ci.tax_treatment, ci.price_locked
      from public.catalog_items ci
     where ci.tenant_id = (select app.current_tenant_id())
       and ci.is_active
       and (p_ids is null or ci.id = any (p_ids))
       and (v_search = '' or ci.name ilike v_pattern)
       -- la lista permitida se calcula UNA vez (subconsulta sin relación con la fila), no el predicado completo por servicio
       and (not v_limited or ci.id in (select app.my_catalog_scope_item_ids()))
     order by ci.name
     limit case when p_ids is null then c_search_limit else c_ids_max end;
end $$;
revoke all on function public.quotable_catalog_items(text, uuid[]) from public, anon, authenticated;
grant execute on function public.quotable_catalog_items(text, uuid[]) to authenticated;

-- Dos datos sobre quien llama: si tiene límite y cuántos servicios ACTIVOS puede cotizar (uno desactivado en su lista no cuenta, para que «sin
-- servicios permitidos» del editor sea verdad). `allowed_count` es null cuando no tiene límite.
create function public.my_catalog_scope() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant  uuid := app.current_tenant_id();
  v_uid     uuid := auth.uid();
  v_limited boolean;
  v_count   integer;
begin
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  v_limited := app.catalog_scope_limited();
  if v_limited then
    select count(*)::integer into v_count
      from public.members m
      join public.member_catalog_scope_items i on i.tenant_id = m.tenant_id and i.member_id = m.id
      join public.catalog_items ci on ci.tenant_id = i.tenant_id and ci.id = i.catalog_item_id
     where m.tenant_id = v_tenant and m.user_id = v_uid and m.status = 'active' and ci.is_active;
  end if;
  return jsonb_build_object('limited', v_limited, 'allowed_count', v_count);
end $$;
revoke all on function public.my_catalog_scope() from public, anon, authenticated;
grant execute on function public.my_catalog_scope() to authenticated;

-- 5. Quién escribe la regla ---------------------------------------------------------------------------------
-- `p_expected_revision`: la versión que la persona vio (0 si el miembro todavía no tiene fila). Resultados: `changed` y `unchanged` (lo pedido ya
-- estaba guardado: sin cambios ni auditoría, así un doble clic no da error). Códigos: 42501 · CP404 (`not_found`, `member_not_found`) · CP409
-- (`revision_changed`) · CP423 (`cannot_target_self`) · CP422 (`invalid_arguments`, `invalid_mode`, `empty_list`, `invalid_list`, `too_many_items`, `member_removed`,
-- `member_not_limitable`, `catalog_item_not_found`).
create function public.set_member_catalog_scope(
  p_member_id uuid, p_mode text, p_catalog_item_ids uuid[], p_expected_revision integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_audit_ids_max constant integer := 50;
  v_tenant     uuid := app.current_tenant_id();
  v_uid        uuid := auth.uid();
  v_ids        uuid[];
  v_actor_id   uuid;
  v_row        public.members;
  v_actor      public.members;
  v_target     public.members;
  v_scope      public.member_catalog_scopes;
  v_old_ids    uuid[];
  v_old_mode   text;
  v_added      uuid[];
  v_removed    uuid[];
  v_revision   integer;
begin
  -- 1. ¿es miembro de la organización activa?
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  -- 2. ¿maneja el equipo?
  if not app.can('team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 3. forma de lo recibido
  if p_member_id is null or p_mode is null or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if p_mode not in ('all', 'list') then
    raise exception 'invalid_mode' using errcode = 'CP422';
  end if;
  if p_mode = 'all' then
    if coalesce(cardinality(p_catalog_item_ids), 0) > 0 then
      raise exception 'invalid_arguments' using errcode = 'CP422';
    end if;
    v_ids := '{}';
  else
    if p_catalog_item_ids is null or cardinality(p_catalog_item_ids) = 0 then
      raise exception 'empty_list' using errcode = 'CP422';
    end if;
    -- el tope se mira PRIMERO, antes de recorrer o deduplicar: una lista enorme no se procesa
    if cardinality(p_catalog_item_ids) > app.member_catalog_scope_max_items() then
      raise exception 'too_many_items' using errcode = 'CP422';
    end if;
    -- un vacío dentro de la lista es un error; los repetidos se deduplican
    if exists (select 1 from unnest(p_catalog_item_ids) x where x is null) then
      raise exception 'invalid_list' using errcode = 'CP422';
    end if;
    select coalesce(array_agg(distinct x order by x), '{}') into v_ids from unnest(p_catalog_item_ids) x;
  end if;
  -- 4. el miembro se busca SIEMPRE dentro de la organización activa (uno de otra organización da lo mismo que uno inexistente)
  perform 1 from public.members m where m.tenant_id = v_tenant and m.id = p_member_id;
  if not found then
    raise exception 'member_not_found' using errcode = 'CP404';
  end if;
  -- 5. se bloquean las filas de quien actúa y del miembro, por orden de id, y se vuelve a comprobar todo sobre ellas
  select m.id into v_actor_id
    from public.members m where m.tenant_id = v_tenant and m.user_id = v_uid and m.status = 'active';
  for v_row in
    select * from public.members m
     where m.tenant_id = v_tenant and m.id in (p_member_id, v_actor_id)
     order by m.id
       for share
  loop
    if v_row.id = p_member_id then v_target := v_row; end if;
    if v_row.id = v_actor_id then v_actor := v_row; end if;
  end loop;
  if v_actor.id is null or v_actor.status <> 'active' or not app.role_can(v_actor.role, 'team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_target.id is null then
    raise exception 'member_not_found' using errcode = 'CP404';
  end if;
  -- nadie cambia su propia regla (hoy ya lo impide la matriz, porque quien maneja el equipo no se puede limitar; se deja explícito, como en
  -- H-010, por si algún día un rol maneja el equipo sin manejar el catálogo)
  if v_target.user_id = v_uid then
    raise exception 'cannot_target_self' using errcode = 'CP423';
  end if;
  if v_target.status <> 'active' then
    raise exception 'member_removed' using errcode = 'CP422';
  end if;
  -- 6. ¿se le puede limitar? Solo si su rol puede cotizar y no puede manejar el catálogo (sin nombrar roles).
  if not (app.role_can(v_target.role, 'quote.create') and not app.role_can(v_target.role, 'catalog.manage')) then
    raise exception 'member_not_limitable' using errcode = 'CP422';
  end if;
  -- 7. quienes escriben la regla de ESTE miembro se ordenan con un candado propio. Sin él, dos guardados a la vez sobre un miembro que todavía no
  --    tiene fila ven los dos «sin fila» (no hay nada que bloquear con `for update`), pasan la versión (0 = 0) y los dos intentan crearla: el segundo
  --    fallaba con un error crudo de llave duplicada. Con el candado el segundo espera, ve lo que guardó el primero y responde «unchanged» (lo mismo)
  --    o `CP409` (otra lista). Se toma DESPUÉS de las filas de `members` y nadie más lo usa: no puede formar un ciclo.
  perform pg_advisory_xact_lock(hashtextextended('member_catalog_scope:' || p_member_id::text, 0));
  -- 8. la regla actual del miembro, con su fila bloqueada
  select * into v_scope from public.member_catalog_scopes s where s.tenant_id = v_tenant and s.member_id = p_member_id for update;
  v_old_mode := coalesce(v_scope.mode, 'all');
  select coalesce(array_agg(i.catalog_item_id order by i.catalog_item_id), '{}') into v_old_ids
    from public.member_catalog_scope_items i where i.tenant_id = v_tenant and i.member_id = p_member_id;
  -- 9. lo pedido ya está guardado: se dice «listo» sin cambiar nada ni dejar registro (sin fila equivale a «todos»)
  if p_mode = v_old_mode and (p_mode = 'all' or v_ids = v_old_ids) then
    return jsonb_build_object('result', 'unchanged', 'revision', coalesce(v_scope.revision, 0), 'mode', v_old_mode,
                              'count', cardinality(v_old_ids));
  end if;
  -- 10. solo si la regla sigue siendo la que la persona vio
  if coalesce(v_scope.revision, 0) <> p_expected_revision then
    raise exception 'revision_changed' using errcode = 'CP409';
  end if;
  -- 11. todos los servicios existen en ESTA organización (uno desactivado también vale: sigue en la lista hasta que se quite)
  if p_mode = 'list' and (select count(*) from public.catalog_items ci
                           where ci.tenant_id = v_tenant and ci.id = any (v_ids)) <> cardinality(v_ids) then
    raise exception 'catalog_item_not_found' using errcode = 'CP422';
  end if;
  -- 12. guardar: la fila y la lista se reemplazan juntas
  if v_scope.member_id is null then
    insert into public.member_catalog_scopes (tenant_id, member_id, mode) values (v_tenant, p_member_id, p_mode)
      returning revision into v_revision;
  else
    update public.member_catalog_scopes set mode = p_mode, revision = revision + 1
     where tenant_id = v_tenant and member_id = p_member_id
     returning revision into v_revision;
  end if;
  delete from public.member_catalog_scope_items where tenant_id = v_tenant and member_id = p_member_id;
  insert into public.member_catalog_scope_items (tenant_id, member_id, catalog_item_id, created_by)
    select v_tenant, p_member_id, x, v_uid from unnest(v_ids) x;
  -- 13. historial: el miembro afectado es el recurso (su nombre se resuelve al leer); solo ids, nunca nombres; con tope de tamaño
  select coalesce(array_agg(x order by x), '{}') into v_added from unnest(v_ids) x where x <> all (v_old_ids);
  select coalesce(array_agg(x order by x), '{}') into v_removed from unnest(v_old_ids) x where x <> all (v_ids);
  perform app.write_audit(v_tenant, 'user', v_uid, 'member.catalog_scope_changed', 'member', p_member_id, 'success',
    jsonb_build_object(
      'old_mode', v_old_mode, 'new_mode', p_mode,
      'old_count', cardinality(v_old_ids), 'new_count', cardinality(v_ids),
      'added', to_jsonb(v_added[1:c_audit_ids_max]), 'removed', to_jsonb(v_removed[1:c_audit_ids_max]),
      'truncated', cardinality(v_added) > c_audit_ids_max or cardinality(v_removed) > c_audit_ids_max));
  return jsonb_build_object('result', 'changed', 'revision', v_revision, 'mode', p_mode, 'count', cardinality(v_ids));
end $$;
revoke all on function public.set_member_catalog_scope(uuid, text, uuid[], integer) from public, anon, authenticated;
grant execute on function public.set_member_catalog_scope(uuid, text, uuid[], integer) to authenticated;
