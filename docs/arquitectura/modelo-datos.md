# Cotiza Prime — Modelo de datos y reglas RLS

> **Estado: aprobado** por Aarón el 2026-10-01, con las respuestas por defecto de §12.
> Autor: subagente planificador (Opus) · Fecha: 2026-10-01
> Basado en: `PROYECTO.md` v1.0 · `HISTORIAS.md` v1.1 · sprint 1 · decisiones 008, 009, 010, 011 y 013
> Entorno de trabajo: **PRUEBAS**, con Supabase local en Docker. Este documento no toca ninguna base de datos.

## Resumen en una página

**Qué es.** Es el plano de la base de datos: qué tablas hay (cada tabla es una planilla con columnas fijas), qué guarda cada una y qué reglas impiden que una organización vea lo de otra.

**Las cinco decisiones que importan:**

1. **Cada fila sabe de qué organización es.** Toda tabla tiene una columna `tenant_id`. Es un identificador universal (UUID: un código largo y aleatorio, nunca 1, 2, 3) que dice a qué organización pertenece la fila. No hay excepciones. Lo que es de la persona y no de una empresa, como su perfil o su aceptación de los términos, se marca con una organización especial de la propia plataforma.
2. **La base de datos hace de guardia, no solo el código.** Se usa RLS (seguridad a nivel de fila): la propia base de datos filtra cada consulta, de modo que una pantalla mal programada tampoco puede mostrar datos ajenos.
3. **La organización activa viaja en cada petición y se comprueba siempre.** La organización activa es la que la persona eligió en el selector. Va en la dirección de la página (`/o/<organización>/...`) y, en cada consulta, la base de datos confirma que esa persona sigue siendo miembro. Si la sacaron de la organización, pierde el acceso en la consulta siguiente, aunque tenga la sesión abierta.
4. **Los datos personales se guardan cifrados.** Correo, teléfono, RUT y dirección se cifran en el servidor de la aplicación antes de llegar a la base de datos, que nunca tiene la clave. Para encontrar un cliente por RUT o correo se guarda además una **huella**: una especie de sello digital que permite buscar coincidencias exactas sin descifrar nada.
5. **Lo que es prueba no se puede editar.** El registro de auditoría (quién hizo qué) y la historia de cada cotización solo admiten agregar filas. Ni la aplicación ni un administrador pueden editarlas o borrarlas desde la plataforma.

**Lo que tiene que decidir Aarón** está en §12. Son 8 preguntas cortas y ninguna bloquea el inicio del sprint.

---

## 0. Términos que se usan en este documento

| Término | En simple |
|---|---|
| **Tabla** | Una planilla de la base de datos, con columnas fijas |
| **RLS** | Reglas que la base de datos aplica a cada fila antes de mostrarla o cambiarla |
| **Política** | Cada una de esas reglas, por tabla y por acción: leer, crear, editar o borrar |
| **Migración** | Un archivo que cambia la estructura de la base de datos y queda guardado en el repositorio para poder repetirlo |
| **Función RPC** | Un procedimiento guardado dentro de la base de datos que la aplicación llama por su nombre, por ejemplo "crear organización" |
| **`SECURITY DEFINER`** | Una función que corre con permisos elevados y se salta la RLS. Por eso cada una revisa los permisos a mano |
| **`service_role`** | La llave maestra de Supabase: se salta toda la RLS. Su uso está muy restringido (§4.6) |
| **Agrupación de conexiones** (pooling) | Varias peticiones comparten las mismas conexiones a la base de datos para ir más rápido. Si alguien deja un dato "pegado" en una conexión, la petición siguiente de otra persona lo hereda |
| **Índice** | El índice de un libro: permite encontrar filas sin leer la tabla entera |
| **Huella (HMAC)** | Un sello que siempre da el mismo resultado para el mismo dato y una clave secreta, y que no permite recuperar el dato original |

---

## 1. Principios

**En simple.** Son las reglas que cumplen todas las tablas, hoy y en los sprints siguientes. Si una tabla nueva no las cumple, la prueba automática falla.

| # | Principio | Cómo se cumple |
|---|---|---|
| P1 | `tenant_id uuid not null` en **toda** tabla, con ese nombre exacto y como columna propia | La prueba de estructura (§8.2) recorre todas las tablas y falla si falta |
| P2 | RLS activa en toda tabla, con políticas `to authenticated`. Las personas sin sesión (`anon`) no tocan tablas | Prueba de estructura; `revoke all ... from anon` |
| P3 | La organización activa se resuelve en **un solo punto** de la aplicación y en **una sola función** de la base de datos: `app.current_tenant_id()` | §2 |
| P4 | **Una fila nunca apunta a una fila de otra organización.** Las relaciones entre tablas incluyen el `tenant_id` (`foreign key (tenant_id, customer_id)`) | Toda tabla tiene `unique (tenant_id, id)`; las relaciones van compuestas |
| P5 | El `tenant_id` de una fila **no cambia nunca** | Trigger (una regla automática que corre en cada cambio) `app.forbid_tenant_change()` en todas las tablas |
| P6 | Las escrituras delicadas (crear organización, numeración, miembros, auditoría) pasan **solo** por funciones RPC que revisan permisos. No hay escritura directa sobre esas tablas | Permisos de escritura retirados de esas tablas |
| P7 | Dinero en **enteros** (`bigint`, pesos sin decimales) | Restricciones `check (... >= 0)` y nunca `float` ni `real` |
| P8 | Fechas con zona horaria (`timestamptz`). El año de la numeración se calcula con la hora de `America/Santiago` | Función de numeración (§6) |
| P9 | Datos personales cifrados en la aplicación y huella para buscar | §5 |
| P10 | Auditoría e historia de la cotización: solo agregar | §3.6 y trigger `app.forbid_mutation()` |
| P11 | Identificadores internos en UUID. El número visible (`COT-2026-0043`) es otra columna y nunca va en una dirección pública | §6 |
| P12 | Índices que **empiezan por `tenant_id`** | Revisión en cada migración |
| P13 | Nombres en inglés en el código y las tablas; textos en español en la interfaz | `STACK.md` §9 |

---

## 2. La organización activa: cómo se resuelve en un solo punto

**En simple.** Una persona puede estar en Negocio 1 y Negocio 2. El sistema tiene que saber en cuál está trabajando **ahora**, y la base de datos tiene que negarse a mostrar lo de la otra aunque el código se equivoque. La organización elegida viaja con cada petición en una **cabecera** (un dato que acompaña a la petición, como el remitente de un sobre). Una función de la base de datos lo comprueba siempre contra la lista de miembros.

### 2.1 Las alternativas que se compararon

| Opción | Cómo funciona | Problema |
|---|---|---|
| **A. Solo membresía** | La RLS deja ver las filas de todas las organizaciones de la persona; la pantalla filtra la activa | Si a una consulta se le olvida el filtro, quien está en dos organizaciones las ve **mezcladas**. Incumple el criterio 3 de H-012 a nivel de base de datos |
| **B. Organización activa dentro del pase de sesión** (JWT: el "carné" digital firmado que Supabase entrega al iniciar sesión) | Un "hook" (una función que Supabase llama al emitir el pase) agrega la organización activa al pase | El pase dura hasta 1 hora: si sacan a alguien, sigue entrando hasta que vence, salvo que igual se consulte la membresía. Cambiar de organización obliga a renovar el pase. Contradice §13.1 ("no sale del pase de sesión") |
| **C. Variable de sesión** (`set_config('app.tenant_id', ...)`) | Antes de cada consulta se "fija" la organización en la conexión | Con el cliente de Supabase no se puede fijar antes de cada consulta. Con conexiones agrupadas, si se fija sin `is_local = true`, **la variable queda pegada en la conexión y la siguiente persona que la use ve los datos de otra organización**. Es el peor error posible |
| **D. Cabecera validada contra `members`** (recomendada) | La aplicación manda `x-cp-tenant-id` en cada petición a Supabase. PostgREST, el servidor que traduce las peticiones web de Supabase en consultas, deja las cabeceras disponibles en `request.headers`, solo dentro de esa transacción. La función `app.current_tenant_id()` la lee y **confirma que la persona sea miembro activo** | Es una búsqueda extra por consulta, que es barata con el índice. Una cabecera inventada solo puede apuntar a una organización de la que la persona ya es miembro |

**Recomendación: D.** Las razones:

- **No importa la agrupación de conexiones.** PostgREST fija `request.headers` con alcance de transacción, así que nada queda pegado en la conexión.
- **Si algo falla, se cierra.** Sin cabecera, con una cabecera inválida o sin membresía, la función devuelve `null` y **no se ve ninguna fila**.
- **Sacar a alguien tiene efecto inmediato** (H-006 y H-010), porque la membresía se consulta en cada petición.

**Regla para siempre:** en la v1 la aplicación **no abre conexiones SQL directas** con herramientas como Drizzle o `pg`. Todo pasa por el cliente de Supabase. Si algún día se abren, cada transacción tiene que fijar la variable con `set local`, y esa excepción se registra como decisión.

### 2.2 De dónde sale la organización: de la dirección, no de una cookie

Si la organización activa viviera en una cookie (un dato que el navegador guarda y comparte entre pestañas), pasaría esto: en la pestaña 1 Aarón está en Negocio 1, en la pestaña 2 cambia a Negocio 2, vuelve a la pestaña 1, guarda un cliente… y **el cliente queda en Negocio 2**. No es una filtración entre empresas, pero es un error grave y silencioso.

Por eso:

- **Pantallas:** la organización va en la dirección: `/o/{tenantId}/clientes`. Cada pestaña sabe en qué organización está.
- **API `/api/v1/...` y acciones del servidor:** reciben la organización de forma explícita en la cabecera `x-cp-tenant-id`. Las acciones del servidor la reciben como argumento que la página ya conoce.
- **"Volver a donde estaba" al iniciar sesión:** se guarda en `profiles.last_tenant_id`. Solo sirve para redirigir y no tiene ningún peso de seguridad.

### 2.3 El único punto de la aplicación

```
src/lib/auth/session.ts            -> requireUser(): valida el pase de sesión. ÚNICO archivo que lo hace
src/lib/tenant/active-tenant.ts    -> requireActiveTenant(requestedTenantId): ÚNICO archivo que
                                      resuelve la organización. Comprueba la membresía, devuelve
                                      { tenantId, role } y entrega el cliente de Supabase con la
                                      cabecera x-cp-tenant-id ya puesta
src/lib/tenant/constants.ts        -> nombre de la cabecera y de la ruta /o/[tenantId]
```

Reglas de `requireActiveTenant`:

1. Llama a `requireUser()`.
2. Comprueba que `requestedTenantId` tenga forma de UUID.
3. Consulta `members` (`user_id = auth.uid()`, `status = 'active'`).
4. Si la persona no es miembro, responde **"No encontrado" (404)** y nunca "Prohibido" (403), para no revelar que la organización existe. Además deja un registro de auditoría `tenant.access_denied` (§3.6).
5. Devuelve el cliente de Supabase creado con `global.headers = { 'x-cp-tenant-id': tenantId, 'x-cp-request-id': ..., 'x-cp-client-ip': ... }`.

Ningún otro archivo arma esa cabecera. Una regla del linter (el revisor automático de código) prohíbe escribir la cadena `x-cp-tenant-id` fuera de `constants.ts`.

**La validación del pase de sesión:** se usa `supabase.auth.getUser()`, que verifica el pase con el servidor de Supabase, o `getClaims()` si el proyecto usa las llaves asimétricas nuevas. **Nunca** `getSession()` a secas en el servidor, porque no verifica la firma. *Al construir, verificar en la documentación vigente de `@supabase/ssr` cuál es la forma recomendada.*

### 2.4 La función de la base de datos

```sql
create schema if not exists app;   -- funciones internas; NO se expone por la API

-- Organización de la plataforma: dueña de los datos globales (perfiles, términos)
create or replace function app.platform_tenant_id() returns uuid
language sql immutable as $$ select '00000000-0000-4000-8000-000000000001'::uuid $$;

create or replace function app.current_tenant_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_raw text := nullif(current_setting('request.headers', true)::json ->> 'x-cp-tenant-id', '');
  v_tid uuid;
begin
  if v_raw is null or auth.uid() is null then
    return null;
  end if;
  begin
    v_tid := v_raw::uuid;
  exception when invalid_text_representation then
    return null;
  end;
  if exists (
    select 1
    from public.members m
    join public.tenants t on t.tenant_id = m.tenant_id
    where m.tenant_id = v_tid
      and m.user_id   = auth.uid()
      and m.status    = 'active'
      and t.status    = 'active'
      and t.kind      = 'organization'
  ) then
    return v_tid;
  end if;
  return null;
end $$;

create or replace function app.current_member_role() returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.members m
  where m.tenant_id = app.current_tenant_id()
    and m.user_id = auth.uid() and m.status = 'active'
$$;

create or replace function app.has_role(variadic p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app.current_member_role() = any (p_roles), false)
$$;

-- Organizaciones de la persona (para el selector). Evita que la política de members se llame a sí misma
create or replace function app.my_tenant_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.tenant_id from public.members m
  where m.user_id = auth.uid() and m.status = 'active'
$$;

grant usage on schema app to authenticated;
grant execute on function app.current_tenant_id(), app.current_member_role(),
  app.has_role(text[]), app.my_tenant_ids(), app.platform_tenant_id() to authenticated;
```

**Rendimiento:** en las políticas siempre se escribe `(select app.current_tenant_id())`, entre paréntesis y con `select`. Así Postgres la calcula **una vez por consulta** y no una vez por fila. El índice `members (user_id, tenant_id) where status = 'active'` hace que la comprobación sea inmediata.

---

## 3. Tablas del sprint 1 en detalle

**En simple.** Son ocho tablas: organizaciones, perfiles, miembros, auditoría, términos, numeración, catálogo y clientes. Todas tienen `tenant_id`. Las que pertenecen a la persona y no a una empresa usan el `tenant_id` de la organización de la plataforma.

### 3.0 Cómo se cumple "`tenant_id` en toda tabla" en los dos casos especiales

| Tabla | Decisión | Por qué |
|---|---|---|
| `tenants` | **El `tenant_id` es la llave primaria de la tabla.** No hay una columna `id` aparte | Es un solo valor, sin dos columnas que mantener iguales. Cuando toque acoplarse a un hub (`STACK.md` §5b), las relaciones usan `on update cascade`: cambiar el `tenant_id` de una organización se propaga solo a todas sus filas, de forma mecánica |
| `profiles`, `legal_documents`, `legal_acceptances` (globales a la persona) | `tenant_id not null` = **organización de la plataforma** (`app.platform_tenant_id()`, una fila de `tenants` con `kind = 'platform'`) | Se cumple la regla sin excepciones ni columnas vacías. La organización de la plataforma no tiene miembros, así que la RLS de empresa nunca la expone. También sirve para auditar lo que no pasa dentro de una empresa, como un inicio de sesión. **Pregunta 1 para Aarón** (§12) |

Funciones comunes que usan todas las tablas:

```sql
-- updated_at, created_by y updated_by los pone la base de datos, nunca el navegador
create function app.set_row_meta() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    if to_jsonb(new) ? 'created_by' then new.created_by := coalesce(auth.uid(), new.created_by); end if;
  end if;
  new.updated_at := now();
  if to_jsonb(new) ? 'updated_by' then new.updated_by := coalesce(auth.uid(), new.updated_by); end if;
  return new;
end $$;

create function app.forbid_tenant_change() returns trigger language plpgsql as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant_id is immutable' using errcode = '42501';
  end if;
  return new;
end $$;

create function app.forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;
```

**Nota sobre `set_row_meta`:** el `to_jsonb(new) ? 'created_by'` sirve para comprobar si la tabla tiene esa columna, pero en PL/pgSQL asignar `new.created_by` en una tabla que no la tiene falla al ejecutar. Al construir conviene hacer **una variante del trigger por familia de tablas** (con y sin `created_by`) en vez de una sola genérica.

### 3.1 `tenants` — organizaciones

```sql
create table public.tenants (
  tenant_id      uuid primary key default gen_random_uuid(),
  kind           text not null default 'organization' check (kind in ('organization','platform')),
  name           text not null check (char_length(name) between 2 and 120),
  rut            text,               -- normalizado '76123456-7'; validado en la app y aquí
  industry       text check (industry in ('logistics','services','products','construction','events','other')),
  contact_email  text check (contact_email is null or char_length(contact_email) <= 254),
  contact_phone  text check (contact_phone is null or char_length(contact_phone) <= 30),
  status         text not null default 'active' check (status in ('active','archived')),
  archived_at    timestamptz,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint tenants_rut_required check (kind = 'platform' or rut is not null),
  constraint tenants_rut_valid    check (rut is null or app.is_valid_rut(rut))
);
create unique index tenants_one_platform on public.tenants (kind) where kind = 'platform';
```

- `app.is_valid_rut(text)` comprueba el dígito verificador en SQL. La aplicación valida lo mismo con `src/lib/chile/rut.ts`, y una prueba compara las dos con los mismos casos.
- **El RUT de la organización no es único** en la plataforma: Negocio 1 y Negocio 2 pueden ser la misma empresa con dos marcas. Es la **pregunta 3**.
- El RUT y el contacto de la organización van **sin cifrar**: son datos de la empresa y salen impresos en cada PDF. Cuando la empresa es una persona natural con giro, su RUT es un dato personal. Es la **pregunta 2**.
- Los campos de marca (logo y colores, H-007) y de configuración (vigencia por defecto, condición de pago por defecto) se agregan en el sprint 2 como columnas nuevas. Agregar columnas que pueden quedar vacías es barato.

### 3.2 `profiles` — la persona (global)

```sql
create table public.profiles (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  tenant_id      uuid not null default app.platform_tenant_id()
                 references public.tenants(tenant_id) on update cascade
                 check (tenant_id = app.platform_tenant_id()),
  full_name      text not null check (char_length(full_name) between 1 and 120),
  last_tenant_id uuid,   -- solo para redirigir al iniciar sesión; sin valor de seguridad
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
```

- El correo **no se copia aquí**: ya vive en `auth.users`, la tabla de cuentas de Supabase. Guardarlo dos veces contradice la minimización.
- La fila se crea con un trigger sobre `auth.users` al registrarse (§3.7).

### 3.3 `members` — quién está en qué organización y con qué rol

```sql
create table public.members (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(tenant_id) on update cascade,
  user_id     uuid not null references auth.users(id),          -- restrict: no se borra una cuenta con membresías
  role        text not null check (role in ('owner','admin','approver','sales','viewer')),
  status      text not null default 'active' check (status in ('active','removed')),
  invited_by  uuid references auth.users(id),                   -- quien envió por última vez el enlace aceptado (D3, 2026-11-09); vacío para el Dueño que creó la organización; los que aceptaron antes del 2026-11-09 figuran con quien creó la invitación; no cambia si la persona ya era miembro activo
  joined_at   timestamptz not null default now(),
  removed_at  timestamptz,
  removed_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, user_id),
  unique (tenant_id, id),
  check ((status = 'removed') = (removed_at is not null))
);
create unique index members_one_owner   on public.members (tenant_id) where role = 'owner' and status = 'active';
create index        members_user_active on public.members (user_id, tenant_id) where status = 'active';
```

- Los cinco roles se definen desde ahora, aunque en el sprint 1 solo se use `owner` (Dueño). Así las políticas ya restringen por rol y H-011 (sprint 4) no tiene que reescribir la RLS.
- **Quitar a alguien no borra su fila: cambia `status`.** Así sus cotizaciones siguen mostrando su nombre como autor (H-010).
- La restricción `members_one_owner` garantiza que haya un solo Dueño activo (H-005).

### 3.4 `catalog_items` — servicios y productos

```sql
create table public.catalog_items (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default app.current_tenant_id()
                   references public.tenants(tenant_id) on update cascade,
  name             text not null check (char_length(name) between 1 and 150),
  description      text check (description is null or char_length(description) <= 2000),
  unit             text not null check (unit in ('service','hour','km','m2','day','unit')),
  unit_price_clp   bigint not null check (unit_price_clp >= 0),   -- neto, pesos enteros
  tax_treatment    text not null default 'taxable' check (tax_treatment in ('taxable','exempt')),
  is_active        boolean not null default true,                 -- H-021: desactivar, nunca borrar
  created_by       uuid references auth.users(id),
  updated_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id)
);
create index catalog_items_tenant_active_name on public.catalog_items (tenant_id, is_active, name);
create index catalog_items_name_trgm on public.catalog_items using gin (tenant_id, name gin_trgm_ops);
```

- El índice `gin_trgm_ops` (requiere las extensiones `pg_trgm` y `btree_gin`) permite buscar por parte del nombre ("flet" encuentra "Flete") sin recorrer la tabla entera.
- **Se agregan después**, como columnas que pueden quedar vacías: `category_id` (H-067), `price_locked` y `max_discount_bp` (H-041) y `unit_cost_clp` (M16).

### 3.5 `customers` — clientes, con datos personales cifrados

```sql
create table public.customers (
  id            uuid primary key,            -- lo genera la app ANTES de cifrar (va en el AAD, §5.3)
  tenant_id     uuid not null default app.current_tenant_id()
                references public.tenants(tenant_id) on update cascade,
  kind          text not null check (kind in ('person','company')),
  display_name  text not null check (char_length(display_name) between 1 and 200),  -- sin cifrar: se busca por partes
  email_enc     text,     -- 'v1.<iv>.<cifrado+etiqueta>' en base64url
  email_hash    text check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$'),
  phone_enc     text,
  rut_enc       text,
  rut_hash      text check (rut_hash is null or rut_hash ~ '^[0-9a-f]{64}$'),
  address_enc   text,
  anonymized_at timestamptz,                 -- H-107: supresión = anonimizar, no borrar
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  check ((email_enc is null) = (email_hash is null)),
  check ((rut_enc   is null) = (rut_hash   is null))
);
create index customers_tenant_name      on public.customers (tenant_id, display_name);
create index customers_name_trgm        on public.customers using gin (tenant_id, display_name gin_trgm_ops);
create index customers_tenant_email_hash on public.customers (tenant_id, email_hash) where email_hash is not null;
create index customers_tenant_rut_hash   on public.customers (tenant_id, rut_hash)   where rut_hash   is not null;
```

- **Duplicados (H-022):** antes de guardar, el servidor busca por `rut_hash` y por `email_hash`. Si hay coincidencia, avisa y ofrece abrir el cliente existente. El índice **no es único** porque el criterio pide avisar, no impedir (**pregunta 4**).
- El teléfono no lleva huella porque no se busca por él. La dirección tampoco.
- Los datos personales nunca aparecen en los mensajes de error, en los logs ni en la auditoría (§3.6).

### 3.6 `audit_log` — registro de auditoría (se graba desde el sprint 1)

```sql
create table public.audit_log (
  id             bigint generated always as identity primary key,  -- interno; ordena; nunca público
  tenant_id      uuid not null references public.tenants(tenant_id) on update cascade,
  occurred_at    timestamptz not null default now(),
  actor_type     text not null check (actor_type in ('user','service','system','public')),
  actor_user_id  uuid,                         -- sin FK: el registro sobrevive a la cuenta
  action         text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),   -- 'customer.updated'
  resource_type  text,
  resource_id    uuid,
  result         text not null check (result in ('success','failure','denied')),
  origin_ip      inet,
  user_agent     text check (user_agent is null or char_length(user_agent) <= 300),
  correlation_id uuid,
  details        jsonb not null default '{}' check (pg_column_size(details) <= 8192)
);
create index audit_tenant_time  on public.audit_log (tenant_id, occurred_at desc);
create index audit_tenant_actor on public.audit_log (tenant_id, actor_user_id, occurred_at desc);
create index audit_tenant_action on public.audit_log (tenant_id, action, occurred_at desc);

create trigger audit_log_no_update before update on public.audit_log
  for each row execute function app.forbid_mutation();
create trigger audit_log_no_delete before delete on public.audit_log
  for each row when (current_setting('app.retention_purge', true) is distinct from 'on'
                     or old.occurred_at > now() - interval '24 months')
  execute function app.forbid_mutation();
```

Cubre los campos de `SEGURIDAD.md` §9: actor, acción, recurso, cliente (`tenant_id`), origen, resultado, correlación y momento.

**Quién escribe en la auditoría (las personas, nunca directamente):**

| Origen | Cómo | Ejemplos del sprint 1 |
|---|---|---|
| **Cambios de datos** | Trigger `app.audit_row_change()` después de crear o editar en `tenants`, `members`, `numbering_settings`, `catalog_items` y `customers`. Toma al actor de `auth.uid()` y el origen y la correlación de las cabeceras `x-cp-client-ip` y `x-cp-request-id` | `tenant.created`, `numbering.updated`, `catalog_item.price_changed`, `customer.created`, `customer.updated` |
| **Eventos de la aplicación** | `src/lib/audit/log.ts`, en el servidor, con el cliente administrador (§4.6). Es el único uso de `service_role` en peticiones de usuarios | `session.login`, `session.logout`, `session.login_failed`, `tenant.access_denied` (con `tenant_id` = plataforma) |

**Convención de `actor_user_id` vacío con `actor_type = 'user'`** (corrección del 2026-11-09): es una persona con cuenta que no es ni fue de esta organización (hoy, quien probó el código de una invitación ajena: `invitation.accept_denied`). Su id, su IP y su navegador no quedan en el registro de esta organización, para que su Dueño no los lea; quedan solo en la copia que se escribe en la organización «plataforma», que no lee nadie que use la aplicación. Quien es o fue miembro conserva su id.

**Qué se guarda en `details`:**

- En `customers` (datos personales): **solo los nombres de los campos que cambiaron** (`{"changed":["email","phone"]}`), nunca los valores.
- En el catálogo y la numeración: valor anterior y nuevo.
- En los datos bancarios (sprint 5): solo los últimos 4 dígitos.

**Borrado por plazo:** solo la función de retención, que se construye en H-108, puede borrar filas de más de 24 meses. Lo hace fijando `app.retention_purge` dentro de su propia transacción.

**Advertencia:** el IP que reenvía la aplicación es confiable. Si alguien llama a la API de Supabase directamente, podría inventar esa cabecera. Por eso el IP de la auditoría es un dato orientativo, no una prueba.

### 3.7 `legal_documents` y `legal_acceptances` — términos y consentimiento (H-110, H-001)

```sql
create table public.legal_documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default app.platform_tenant_id() references public.tenants(tenant_id) on update cascade
               check (tenant_id = app.platform_tenant_id()),
  kind         text not null check (kind in ('terms','privacy')),
  version      text not null,                 -- '2026-10-01-preliminar'
  content_sha256 text not null,               -- huella del texto publicado (el texto vive en el repositorio)
  published_at timestamptz not null,
  is_current   boolean not null default false,
  unique (kind, version)
);
create unique index legal_one_current on public.legal_documents (kind) where is_current;

create table public.legal_acceptances (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default app.platform_tenant_id() references public.tenants(tenant_id) on update cascade
               check (tenant_id = app.platform_tenant_id()),
  user_id      uuid not null references auth.users(id) on delete cascade,
  document_id  uuid not null references public.legal_documents(id),
  accepted_at  timestamptz not null default now(),
  context      text not null check (context in ('signup','reaccept')),
  origin_ip    inet,
  user_agent   text check (user_agent is null or char_length(user_agent) <= 300),
  unique (user_id, document_id)
);
-- solo agregar
create trigger legal_acceptances_no_update before update on public.legal_acceptances
  for each row execute function app.forbid_mutation();
```

**Cómo funciona en el registro:**

1. El formulario de registro envía, como datos adjuntos a la cuenta nueva, las versiones que la persona aceptó.
2. Un trigger sobre `auth.users` (`app.handle_new_user()`, `SECURITY DEFINER`) crea el perfil y, **solo si esas versiones son las vigentes**, crea las aceptaciones con `context = 'signup'`.
3. **Puerta de entrada:** en cada inicio de sesión, `requireUser()` comprueba que exista una aceptación de **todos** los documentos vigentes. Si falta alguna, redirige a "Acepta la nueva versión" (criterio de H-110). Esa pantalla llama a la RPC `accept_current_legal_documents()`, que registra la aceptación con el IP.

Esta puerta también cubre el caso de que falle el paso 2: nadie queda dentro de la plataforma sin un consentimiento registrado.

### 3.8 Numeración

El detalle está en §6.

---

## 4. Políticas RLS por tabla

**En simple.** Para cada tabla se define quién puede leer, crear, editar y borrar. Lo que no se permite de forma explícita queda prohibido. Además se retiran los permisos de fondo que Supabase da por defecto, para tener dos capas de protección.

### 4.1 Permisos de fondo, antes de cualquier política

Supabase entrega por defecto todos los permisos a `anon` y `authenticated`, incluido `TRUNCATE`, que vacía una tabla entera y **no respeta la RLS**. Se retiran y se dan solo los necesarios:

```sql
-- En la primera migración
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
-- Cada migración da después, tabla por tabla, solo lo necesario (columna por columna en UPDATE)
```

*Al construir, verificar que estas sentencias apliquen a los roles que usa la versión instalada de Supabase local.*

### 4.2 Tabla resumen

| Tabla | Leer (`select`) | Crear (`insert`) | Editar (`update`) | Borrar |
|---|---|---|---|---|
| `tenants` | Las organizaciones donde la persona es miembro activo (para el selector) | Solo por la RPC `create_tenant` | Organización activa, Dueño o Administrador; solo `name`, `rut`, `industry`, `contact_*` | Nunca (H-112, por función) |
| `profiles` | La propia, más las de quienes tienen una fila en `members` de la organización activa, **activa o quitada** (H-010: el nombre de quien se fue sigue visible para que sus cotizaciones lo muestren como autor; solo `full_name`; de la tabla una persona con pase lee únicamente `user_id`, `tenant_id` y `full_name`: ni `created_at`, ni `updated_at`, ni `last_tenant_id`) | Solo el trigger de registro | La propia; solo `full_name` y `last_tenant_id` | Nunca |
| `members` | Las propias, más las **activas** de la organización activa; las de quien ya se fue (con `removed_at` y `removed_by`), solo para quien maneja el equipo (`team.manage`, H-010) | Solo por RPC: `create_tenant` (crea al Dueño) y `accept_invitation` (sprint 5, H-009: crea la membresía de quien acepta una invitación o reactiva la de quien fue quitado; desde la corrección D3 de 2026-11-09 escribe en `invited_by` a quien envió el enlace por última vez, `coalesce(resent_by, invited_by)` de la invitación, y no lo toca si la persona ya era miembro activa) | Solo por RPC: `accept_invitation` (reactivar), `change_member_role` y `remove_member` (H-010) | Nunca (`status = 'removed'`) |
| `catalog_items` | Organización activa | Organización activa, Dueño o Administrador | Igual | Nunca (se desactiva) |
| `customers` | Organización activa | Organización activa, Dueño, Administrador o Comercial | Igual | Nunca (se anonimiza) |
| `invitations` (sprint 5, H-008) | Organización activa, **solo quien maneja el equipo** (Dueño y Administrador, `team.manage`), **por columnas**: nadie lee `token_sha256`, `email_binding`, `email_hash` ni `resent_by` (al aceptar, ese valor se copia a `members.invited_by`, que sí lee cualquier miembro activo de la organización: es justo lo que busca D3) | Solo por la RPC `create_invitation` | Solo por `resend_invitation`, `revoke_invitation` y `accept_invitation` (H-009) | Solo la tarea de retención (30 días) |
| `numbering_settings` | Organización activa | Por `create_tenant` | Solo por la RPC `set_numbering` | Nunca |
| `numbering_sequences` | Organización activa | Solo por funciones | Solo por funciones; **nunca hacia atrás** (trigger) | Nunca |
| `audit_log` | Organización activa, Dueño o Administrador | Solo triggers y el servidor | Nunca (trigger) | Solo la función de retención |
| `legal_documents` | Todos, también sin sesión (`anon`) | Solo migraciones | Solo migraciones | Nunca |
| `legal_acceptances` | Las propias | Solo el trigger de registro y la RPC de aceptación | Nunca (trigger) | Nunca |

### 4.3 SQL de ejemplo

```sql
-- customers ---------------------------------------------------------------
alter table public.customers enable row level security;

create policy customers_select on public.customers for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));

create policy customers_insert on public.customers for insert to authenticated
  with check (tenant_id = (select app.current_tenant_id())
              and (select app.has_role('owner','admin','sales')));

create policy customers_update on public.customers for update to authenticated
  using      (tenant_id = (select app.current_tenant_id())
              and (select app.has_role('owner','admin','sales')))
  with check (tenant_id = (select app.current_tenant_id()));
-- sin política de delete

grant select, insert on public.customers to authenticated;
grant update (kind, display_name, email_enc, email_hash, phone_enc, rut_enc, rut_hash, address_enc)
  on public.customers to authenticated;

create trigger customers_meta   before insert or update on public.customers for each row execute function app.set_row_meta();
create trigger customers_tenant before update on public.customers for each row execute function app.forbid_tenant_change();
create trigger customers_audit  after insert or update on public.customers for each row execute function app.audit_row_change('keys_only');

-- tenants -----------------------------------------------------------------
alter table public.tenants enable row level security;
create policy tenants_select on public.tenants for select to authenticated
  using (tenant_id in (select app.my_tenant_ids()));
create policy tenants_update on public.tenants for update to authenticated
  using      (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner','admin')))
  with check (tenant_id = (select app.current_tenant_id()));
grant select on public.tenants to authenticated;
grant update (name, rut, industry, contact_email, contact_phone) on public.tenants to authenticated;

-- members -----------------------------------------------------------------
alter table public.members enable row level security;
create policy members_select on public.members for select to authenticated
  using (user_id = (select auth.uid())
         or (tenant_id = (select app.current_tenant_id())
             -- H-010: las filas de quien se fue, solo para quien maneja el equipo
             and (status = 'active' or (select app.can('team.manage')))));
grant select on public.members to authenticated;

-- profiles ----------------------------------------------------------------
alter table public.profiles enable row level security;
create policy profiles_select on public.profiles for select to authenticated
  -- H-010: activa o quitada; la ayuda es security definer porque members_select ya no muestra a todos las quitadas
  using (user_id = (select auth.uid())
         or user_id in (select app.current_tenant_people()));
create policy profiles_update on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- Lectura SOLO por columnas: last_tenant_id es privado de cada persona (migración 12, H-012).
-- Nunca "grant select on public.profiles" completo: los compañeros verían la otra organización.
grant select (user_id, tenant_id, full_name) on public.profiles to authenticated;   -- H-010 quitó created_at y updated_at (la migración 12 los concedía)
grant update (full_name, last_tenant_id) on public.profiles to authenticated;
-- La propia persona lee su última organización con la RPC public.my_last_tenant_id()
-- (security definer; solo devuelve una organización de la que sigue siendo miembro).

-- audit_log ---------------------------------------------------------------
alter table public.audit_log enable row level security;
create policy audit_select on public.audit_log for select to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.can('audit.read')));
grant select on public.audit_log to authenticated;     -- nada más
-- H-011a (supuesto 13, migración role_matrix): el registro de actividad lo lee solo el Dueño;
-- antes lo leían también los Administradores.
```

**Por qué la política de `update` tiene `using` y `with check`:** `using` decide qué filas se pueden tocar; `with check` decide cómo pueden quedar después del cambio. Sin el segundo, alguien podría editar una fila de su organización y "mudarla" a otra. El trigger `forbid_tenant_change` es la segunda capa contra eso.

**La lectura del selector** (`tenants_select`) muestra nombre y datos básicos de **todas** las organizaciones de la persona. Es intencional, porque el selector las necesita. Los datos de negocio (clientes, catálogo y, más adelante, cotizaciones) se filtran solo por la organización activa.

### 4.4 Funciones RPC expuestas en el sprint 1

Viven en `public` con `grant execute ... to authenticated` y ninguna a `anon`:

| Función | Tipo | Qué revisa |
|---|---|---|
| `create_tenant(p_name, p_rut, p_industry, p_contact_email, p_contact_phone)` | `SECURITY DEFINER` | Sesión iniciada; **correo verificado** (`auth.users.email_confirmed_at is not null`, H-001); RUT válido; tope de organizaciones por persona (constante `MAX_TENANTS_PER_USER`, **pregunta 6**). En una sola transacción crea la organización, la membresía de Dueño, `numbering_settings` por defecto y la auditoría. **No recibe un `tenant_id` como parámetro** |
| `set_numbering(p_prefix, p_mode, p_start_number)` | `SECURITY DEFINER` | Organización activa, Dueño o Administrador; regla de no retroceder (§6) |
| `preview_next_quote_number()` | `SECURITY INVOKER` | Solo lectura (H-024: "veo un ejemplo") |
| `accept_current_legal_documents()` | `SECURITY DEFINER` | Sesión iniciada; inserta las aceptaciones vigentes de la propia persona |

**Sprint 5 (H-008), invitaciones.** Tres funciones con el pase de la persona (`create_invitation`, `resend_invitation`, `revoke_invitation`; deciden con `app.can('team.manage')`) y una solo del servidor (`invitation_email_settle`, que cierra el registro del correo). El orden de las revisiones es parte del diseño: primero ser miembro (si no, «No encontrado»), luego el permiso («No tienes permiso para esto»), luego la forma de lo recibido y el rol, luego los topes y, recién entonces, si ya es miembro o ya hay una invitación pendiente. La respuesta es la misma tenga o no cuenta ese correo en Cotiza Prime: nunca se consulta un correo fuera de los miembros de la organización activa.

**Sprint 5 (H-009), aceptar una invitación.** Dos funciones **con sesión y sin organización activa** (la persona todavía no es miembro; la organización la define la invitación, nunca la petición): `invitation_preview(p_token_sha256)` y `accept_invitation(p_token_sha256)`. Solo `authenticated` las ejecuta (decisión 017: nada abierto a personas sin sesión); no tienen más argumentos, así que **no hay forma de mandar un rol ni una organización**. Los fallos esperados se **devuelven** como resultado (`not_found`, `wrong_email`, `revoked`, `inviter_inactive`, `expired`, `used`, `archived`, `unverified`, `rate_limited`) y no se lanzan como error, porque un error deshace la transacción y con ella el conteo de intentos fallidos; solo se lanza error sin sesión (42501), en una transacción de solo lectura como la de un GET de PostgREST (25006) o con un argumento que no es una huella (CP422). `accept_invitation` revisa en este orden: sesión · huella · correo de la cuenta verificado (`auth.users.email_confirmed_at`) · persona no bloqueada · busca la invitación por la huella del código y **la bloquea** · correo (sha256 de «huella del código | correo normalizado de la cuenta» contra `email_binding`; en una ya aceptada, que sea la cuenta que la aceptó) · estado (los dos en `app.invitation_state`, una sola definición para la vista previa y para aceptar; desde la corrección I1 el correo va ANTES que el estado) · membresía (ya activo: se marca aceptada **sin tocar su rol**; quitado antes: se reactiva su misma fila con el rol de la invitación; si no, se crea) · la invitación pasa a `accepted` con `accepted_at/by` y `member_id` y se vacían `email_enc`, `email_hash` y `email_binding`. No toca las filas `invitation_notice` de `email_messages` ni `owner_notice_*`. `invitation_preview` entrega organización, quién invitó, rol y vigencia **solo** si la invitación es para el correo de quien la mira; en cualquier otro caso devuelve solo el resultado. **Quién pregunta va primero** (corrección I1): una cuenta que no es la invitada (ni la que la aceptó) recibe `wrong_email` en cualquier estado de la invitación, en las dos funciones; el estado (`revoked`, `inviter_inactive`, `expired`, `used`, `archived`) solo se le dice a la persona invitada. **Aceptaciones fallidas:** alcance `invite_accept_user` de `auth_rate_limits` (clave: huella del id de la cuenta), 10 fallos en 10 minutos y bloqueo de 10 minutos, contados por la propia base **solo al intentar aceptar** (`accept_invitation`; la vista previa es de solo lectura desde la corrección I1 y nunca suma un fallo, solo lee el tope); cuentan `not_found` y `wrong_email` (las dos formas de probar códigos; `wrong_email` también con una invitación ya cancelada, vencida o usada, porque a una cuenta ajena no se le dice el estado); a la persona invitada, cancelada, vencida o usada no le cuentan. El alcance `invite_link_ip` cuenta las aperturas de `/invitacion/[código]` por IP (30 por minuto), lo cuenta el servidor. Auditoría: `invitation.accepted` (rol, si ya era miembro y si se reactivó; nunca el correo ni el código) e `invitation.accept_denied` (resultado `denied`, motivo `wrong_email`, en la organización de la invitación, sin el correo ni el código; solo cuando se intenta ACEPTAR un código real con otro correo; ver la pantalla no la escribe; **si la persona no es ni fue de esa organización la fila va sin autor** —sin id, IP, navegador ni correlación— y la copia completa queda en la organización «plataforma», ver §3.6), además de lo que registran los disparadores. **Nota de H-010:** la lista de miembros de «Tu equipo» la agrega H-010 (párrafo siguiente).

**Sprint 5 (H-010), cambiar el rol de un miembro o quitarlo.** Tres funciones con el pase de la persona, que deciden con `app.can('team.manage')` (Dueño y Administrador) y sacan la organización de `app.current_tenant_id()`, nunca de un argumento: `list_members()` (los miembros **activos**, con su correo de `auth.users`; solo para quien maneja el equipo), `change_member_role(p_member_id, p_new_role, p_expected_role)` y `remove_member(p_member_id, p_expected_role)`. **Solo el Dueño da o quita un rol que maneja el equipo** (decisión por defecto aplicada por Aarón el 2026-11-05): si el rol actual del miembro o el nuevo tiene `team.manage`, quien actúa tiene que tener `tenant.transfer`; si no, `42501 owner_only`. Revisan en este orden: miembro de la organización activa (`CP404 not_found`) · permiso (`42501 forbidden`) · argumentos y rol nuevo, que nunca es el del Dueño (`CP422 invalid_arguments` / `invalid_role`) · el miembro es de **esta** organización (`CP404 member_not_found`; uno de otra organización da lo mismo que uno inexistente) · no es la propia persona (`CP423 cannot_target_self`) · se bloquean las filas del miembro y de quien actúa **por orden de id** y se vuelve a comprobar que quien actúa sigue activo y sigue manejando el equipo (dos Administradores que se quitan a la vez: gana el primero, el otro recibe `42501`) · no es el Dueño (`CP423 cannot_target_owner`); esta revisión se hace también antes de bloquear, con una lectura simple, para que nadie pueda bloquear la fila del Dueño a repetición, y se repite sobre la fila bloqueada · ¿ya está hecho? (`unchanged` / `already_removed`, sin cambios ni auditoría; va antes de `owner_only` para que una pantalla vieja reciba el mensaje cierto) · si el rol actual o el nuevo maneja el equipo, quien actúa es el Dueño (`42501 owner_only`, sobre las filas ya bloqueadas) · el rol esperado coincide con el real (`CP409 role_changed`) · el tope de 30 cambios por persona, organización y hora, **sumando cambios de rol y quitadas**, contado en la auditoría (`CP429 limit_member_changes`, `app.member_change_max_per_hour()` y `app.member_changes_exhausted()`); **el Dueño no tiene tope**. Resultados: `changed`, `unchanged` (ya tenía ese rol: sin cambios ni auditoría), `removed` (con `cancelled_invitations` y `assigned_requests`: cuántas solicitudes siguen asignadas a esa persona, sin tocar), `already_removed`. **Efectos de quitar** (una sola transacción): `members.status = 'removed'` con `removed_at` y `removed_by` (la fila no se borra) y se cancelan las invitaciones **pendientes** que esa persona había creado o reenviado por última vez (`revoke_reason = 'inviter_removed'`, que `accept_invitation` ya entiende como `inviter_inactive`; una invitación cancelada saca su aviso al Dueño de la cola). Bajar a alguien de un rol que maneja el equipo a uno que no, hace lo mismo con sus invitaciones. No se toca nada de cotizaciones, borradores ni solicitudes: los borradores quedan en solo lectura (solo el autor edita, decisión 009) y las solicitudes asignadas a quien se fue siguen asignadas a él, visibles para el Dueño y los Administradores, que las reasignan. «Al instante» es en su siguiente petición: `app.current_tenant_id()` exige el estado activo en cada consulta. Auditoría: `member.role_changed` (`old_role`, `new_role`, `cancelled_invitations`) y `member.removed` (`role`, `cancelled_invitations`), sin correo ni nombre, además de `member.updated` que deja el disparador general. **`profiles_select`** deja leer el nombre de cualquier persona con una fila en `members` de la organización activa (activa o quitada), buscándolas con la ayuda `security definer` `app.current_tenant_people()` (no con una consulta a `members` dentro de la política, porque **`members_select`** ahora muestra las filas de quien se fue solo a quien maneja el equipo); quien fue quitado sigue sin poder leer nada de la organización. **`create_invitation` y `resend_invitation` (H-008) se modificaron** en la misma migración: antes de tomar el candado de la organización bloquean (`for share`) la fila de `members` de quien invita o reenvía y comprueban que sigue activa y con permiso (`42501` si no). Sin eso, una invitación en curso mientras la persona era quitada o bajada de rol escapaba a la cancelación y quedaba «pendiente». Además, **solo el Dueño invita o reenvía una invitación cuyo rol maneja el equipo** (`42501 owner_only`, con el rol de esa fila ya bloqueada): `resend_invitation` guarda el vínculo de correo que manda quien llama (sin secreto), así que un Administrador podía redirigir a un cómplice una invitación a Administrador del Dueño; y el aviso al Dueño de una invitación de un Administrador a un Administrador, en producción, nadie lo envía mientras no se resuelva la decisión #17. **Orden de bloqueos** (sin ciclos; detalle en el encabezado de la migración): `remove_member` / `change_member_role` → filas de `members` (por orden de id) y luego filas de `invitations`; `create_invitation` / `resend_invitation` → fila de `members` de quien actúa, candado de organización, filas de `invitations`. Residual: `accept_invitation` (H-009) bloquea la invitación y después la fila de `members` de quien acepta, en orden inverso al de `remove_member`; solo se cruzarían si quien acepta fuera quien actúa o el quitado, y la base cortaría una con error sin dañar datos. Al aplicarse, la migración cancela las invitaciones pendientes a un rol que maneja el equipo creadas por quien no es Dueño (de antes de esta regla; el deshacer no las devuelve). **Al desplegar:** correr una vez `select app.reconcile_invitation_senders();` después de aplicar las migraciones (la migración `20261106100000_invitation_resender.sql` ya lo hace al final; repetirlo no cambia nada más). Esa limpieza reemplaza al `update` de la sección 9 de esta migración: cancela, con el mismo método, toda invitación pendiente cuyo creador o reenviador ya no pueda (también una a un rol que maneja el equipo que no creó y reenvió el Dueño), por si un Administrador estaba invitando a otro justo en ese momento. **Corrección de la revisión del 2026-11-06 (`20261106100000_invitation_resender.sql`):** `invitations.resent_by` anota quién reenvió por última vez; quitar o bajar de rol a esa persona cancela también lo que reenvió (`app.cancel_member_invitations`), y `app.invitation_state` exige que tanto quien la creó como quien la reenvió sigan pudiendo (`app.invitation_senders_ok`). Una invitación a un rol que maneja el equipo solo vale si la creó y reenvió el Dueño. **Corrección D3 y menores de la revisión de Aarón (`20261109100000_invitation_accept_sender.sql`, 2026-11-09):** `accept_invitation` deja `members.invited_by` a nombre de quien envió el enlace por última vez (`coalesce(resent_by, invited_by)`) y `invitation.accepted` anota `created_by` y `sent_by`; repetir la limpieza ya no pisa `resent_by` (rellena solo donde es nulo) y usa el mismo desempate de correos que `resend_invitation`. Migraciones `20261105110000_member_management.sql` (H-010), `20261106100000_invitation_resender.sql` (corrección del 2026-11-06) y `20261109100000_invitation_accept_sender.sql` (esta corrección).

**Reglas para toda función `SECURITY DEFINER`, ahora y en los sprints siguientes:**

1. `set search_path = ''`, con nombres completos (`public.tabla`). Sin esto, alguien podría crear una tabla falsa con el mismo nombre y engañar a la función.
2. Obtener la organización **siempre** de `app.current_tenant_id()`, nunca de un parámetro.
3. Revisar el rol con `app.has_role(...)` al inicio.
4. Retirar `execute` de `public` y `anon`.
5. Tener una prueba de aislamiento propia (§8).

### 4.5 Vistas

Una vista es una consulta guardada que se usa como si fuera una tabla. **Por defecto, una vista en Postgres se salta la RLS de las tablas que lee**, porque corre con los permisos de su dueño. Toda vista se crea con `with (security_invoker = true)`, y la prueba de estructura lo exige.

### 4.6 Qué hace `service_role` (la llave maestra)

Se salta **toda** la RLS. Reglas:

- Vive solo en `src/lib/supabase/admin-client.ts`, con `import 'server-only'` (una marca que impide que el archivo llegue al navegador). Una regla del linter prohíbe importarlo fuera de `src/lib/audit/`, `src/lib/security/`, `src/lib/brand/logo-storage.ts`, `src/server/jobs/`, `scripts/` y `tests/`; los porteros públicos (`src/lib/share/gateway.ts` del enlace del cliente y `src/lib/intake/gateway.ts` del formulario público, decisión 017) y `src/lib/team/gateway.ts` (cierra el registro del correo de una invitación; una sola función) están en esa lista. Con H-116 (registro seguro, `docs/arquitectura/h-116-registro-seguro.md`) se suma `src/lib/auth/signup-gateway.ts`: crea la cuenta sin contraseña (`generateLink` de tipo invitación) y neutraliza la contraseña de una cuenta sin verificar; es el único archivo de `src/lib/auth/` con la llave.
- **Usos permitidos:** escribir eventos de auditoría de la aplicación, tareas programadas (retención y envío de correos en sprints siguientes; el vencimiento de cotizaciones corre dentro de la base con `pg_cron`), semilla y montaje de pruebas, y el **portero del enlace del cliente**, que solo llama tres funciones angostas (leer, registrar apertura y responder) y la de avisos del proveedor de correo.
- **Usos prohibidos:** leer o escribir datos de negocio en respuesta a una petición de usuario, salvo las funciones angostas del portero. **Decisión 017:** el cliente final nunca habla con la base de datos ni existe una función ejecutable sin sesión (`anon`) para el enlace del cliente: el navegador llama al servidor, el servidor valida el formato del token y los límites de intentos (el portero) y recién ahí ejecuta, con la llave maestra, funciones que reciben el **sello** (`sha256`) del token y que **solo `service_role` puede ejecutar**. La IP y el navegador salen del servidor, nunca del navegador del cliente. El formulario público (sprint 9) seguirá el mismo patrón y se confirma al diseñarlo.
- La llave es secreta, distinta por entorno y nunca tiene el prefijo `NEXT_PUBLIC_` (las variables con ese prefijo se mandan al navegador).
- *Nota:* Supabase está reemplazando los nombres `anon` y `service_role` por "publishable key" y "secret key". El concepto no cambia. Al construir, verificar qué llaves entrega la versión instalada.

### 4.7 Realtime y Storage

- **Realtime** (avisos en vivo de cambios en tablas): **desactivado** para todas las tablas en el sprint 1. La prueba de estructura revisa que la publicación `supabase_realtime` no incluya tablas sin autorización explícita.
- **Storage** (archivos: logos y PDF, desde el sprint 2): las rutas siempre empiezan por el `tenant_id` (`{tenant_id}/logo.png`) y las políticas de `storage.objects` usan `app.my_tenant_ids()` junto con el rol. **A verificar en el sprint 2:** si el servicio de archivos de Supabase entrega las cabeceras personalizadas a la base de datos. Si no las entrega, `current_tenant_id()` devuelve `null` ahí, y los archivos se deben servir desde el servidor tras `requireActiveTenant`.

---

## 5. Cifrado en reposo y huella buscable

**En simple.** El correo, el teléfono, el RUT y la dirección se cifran en el servidor de la aplicación con una clave que la base de datos nunca ve. Si alguien se llevara una copia de la base, vería texto ilegible. Para buscar por RUT o correo se guarda además una huella hecha con **otra** clave: permite encontrar coincidencias exactas, no búsquedas por partes.

### 5.1 Dónde cifrar: comparación

| Opción | Estado | Veredicto |
|---|---|---|
| **pgsodium / TCE** (cifrado transparente de columnas dentro de Postgres) | Supabase lo marcó como **en camino a quedar obsoleto** y desaconseja usarlo en proyectos nuevos (según la documentación conocida hasta mediados de 2026; **verificar al construir**) | Descartado |
| **Supabase Vault** | Pensado para guardar **pocos secretos** (llaves de servicios), no miles de filas de clientes | Sirve para secretos, no para esto |
| **`pgcrypto` con la clave enviada en cada consulta** | La clave viaja dentro del SQL y puede quedar en los registros de la base de datos (`pg_stat_statements`, logs) | Descartado |
| **Cifrado en la aplicación** (AES-256-GCM con `node:crypto`) | Estándar y sin dependencias externas | **Recomendado** |

**Por qué en la aplicación:** la base de datos y sus respaldos nunca tienen la clave; funciona igual en local y en la nube; se puede probar con Vitest; y cambiar de proveedor de base de datos no obliga a tocar el cifrado.

**Consecuencia:** la base de datos no puede descifrar. Las exportaciones (H-074) y las solicitudes de acceso a los datos (H-106) se arman en el servidor de la aplicación.

### 5.2 Claves por entorno

| Variable | Para qué | Formato |
|---|---|---|
| `CP_PII_KEY_V1` | Cifrar y descifrar datos personales | 32 bytes aleatorios, base64 |
| `CP_SEARCH_KEY_V1` | Hacer huellas (HMAC) | 32 bytes aleatorios, base64, **distinta de la anterior** |
| `CP_PII_KEY_CURRENT` | Versión con la que se cifra lo nuevo | `v1` |

- Las claves de pruebas y de producción son distintas. Las locales se generan en `.env.local`, que no se sube al repositorio. `.env.example` lleva solo los nombres.
- **Si se pierde la clave de cifrado, los datos no se recuperan nunca.** Se guarda una copia en el gestor de contraseñas de la agencia, con acceso de al menos dos socios (**pregunta 5**).
- **Rotación:** el texto cifrado lleva su versión (`v1.`). Para rotar se agrega `CP_PII_KEY_V2`, se cifra lo nuevo con ella y una tarea vuelve a cifrar lo antiguo. Rotar la clave de huellas obliga a recalcular todas las huellas, porque no se pueden convertir. Por eso se rota solo si se filtra.

### 5.3 El formato del dato cifrado

Archivo único: `src/lib/crypto/pii.ts`.

- Cada valor se cifra con un **IV aleatorio de 12 bytes** (un número de un solo uso, para que dos correos iguales no se vean iguales cifrados).
- Se usa **AAD** (datos asociados: un "sello" que no se cifra pero que el descifrado exige que coincida) = `customers.email|<tenant_id>|<customer_id>`. Si alguien copiara el correo cifrado de un cliente de Negocio 2 a una fila de Negocio 1, **el descifrado falla** en lugar de mostrar el dato.
- Por eso el `id` del cliente lo genera la aplicación (`crypto.randomUUID()`) antes de cifrar.
- Se guarda como texto: `v1.<iv base64url>.<cifrado+etiqueta base64url>`.

### 5.4 La huella: normalizar y sellar

Archivos: `src/lib/crypto/search-hash.ts`, `src/lib/chile/rut.ts` y `src/lib/normalize/email.ts`.

**Normalizar antes de sellar** (si no, `76.123.456-7` y `761234567` darían huellas distintas):

| Dato | Normalización |
|---|---|
| **RUT** | Quitar puntos, guiones y espacios; quitar ceros a la izquierda; `k` a `K`; **validar el dígito verificador** (si no es válido, no se guarda); forma canónica `76123456-7` |
| **Correo** | Quitar espacios a los lados; normalizar Unicode (NFC); todo en minúsculas. **No** quitar puntos ni el `+algo` de Gmail: dos personas distintas quedarían como duplicadas |

**El sello:**

```ts
// search-hash.ts (esquema; el código final lo escribe quien construye)
// huella = HMAC-SHA256(CP_SEARCH_KEY_V1, `${field}|${tenantId}|${normalizedValue}`) en hex
searchHash('rut',   tenantId, normalizeRut(input))
searchHash('email', tenantId, normalizeEmail(input))
```

- **Incluir el `tenant_id` en el sello** hace que el mismo RUT dé huellas distintas en Negocio 1 y en Negocio 2. Así nadie puede cruzar organizaciones comparando huellas.
- **Incluir el campo** (`rut|` o `email|`) evita que una huella de RUT coincida por casualidad con una de correo.
- La búsqueda por RUT o correo (H-023, H-065) es **solo por el dato completo**: el servidor calcula la huella y consulta `where tenant_id = $1 and rut_hash = $2`. El nombre se busca por partes con el índice `trgm`.
- Las huellas **nunca se envían al navegador**.

---

## 6. Numeración correlativa (H-024 y decisión 008)

**En simple.** Cada organización tiene un contador guardado en la base de datos. Cuando se crea una cotización, la base de datos suma uno y entrega el número en el mismo paso, sin que dos personas puedan sacar el mismo. El contador solo puede subir.

### 6.1 Tablas

```sql
create table public.numbering_settings (
  tenant_id    uuid primary key references public.tenants(tenant_id) on update cascade,
  prefix       text not null default 'COT' check (prefix ~ '^[A-Z0-9]{1,8}$'),
  mode         text not null default 'yearly' check (mode in ('yearly','continuous')),
  pad_width    smallint not null default 4 check (pad_width between 1 and 8),
  start_number bigint not null default 1 check (start_number >= 1),   -- lo que eligió, para mostrarlo
  updated_by   uuid references auth.users(id),
  updated_at   timestamptz not null default now()
);

create table public.numbering_sequences (
  tenant_id   uuid not null references public.tenants(tenant_id) on update cascade,
  scope       text not null check (scope = 'continuous' or scope ~ '^Y[0-9]{4}$'),  -- 'Y2026'
  last_number bigint not null check (last_number >= 0),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, scope)
);

-- El contador nunca baja, ni siquiera con la llave maestra
create function app.forbid_sequence_decrease() returns trigger language plpgsql as $$
begin
  if new.last_number < old.last_number then
    raise exception 'numbering never goes back' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger numbering_sequences_monotonic before update on public.numbering_sequences
  for each row execute function app.forbid_sequence_decrease();
```

Hay un contador por **alcance**: `continuous` (corrido) o `Y2026`, `Y2027`… (anual). Con el formato anual, el 1 de enero se crea el contador del año nuevo, que parte de 1. Es el único "reinicio" legítimo, y el año en el número evita que se repita.

### 6.2 Asignación segura con varias personas a la vez (se usa desde el sprint 2)

```sql
create function app.allocate_quote_number(p_tenant uuid, out seq bigint, out display text)
language plpgsql security definer set search_path = '' as $$
declare
  s       public.numbering_settings;
  v_year  int  := extract(year from (now() at time zone 'America/Santiago'))::int;
  v_scope text;
  v_num   text;
begin
  if p_tenant is distinct from app.current_tenant_id() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into strict s from public.numbering_settings where tenant_id = p_tenant;
  v_scope := case s.mode when 'continuous' then 'continuous' else 'Y' || v_year end;

  -- Un solo paso atómico: crea el contador si no existe o lo sube en 1, y bloquea la fila
  -- hasta que termine la transacción. Dos personas a la vez se ponen en fila, nunca chocan.
  insert into public.numbering_sequences as ns (tenant_id, scope, last_number)
  values (p_tenant, v_scope, 1)
  on conflict (tenant_id, scope) do update set last_number = ns.last_number + 1, updated_at = now()
  returning ns.last_number into seq;

  -- OJO: lpad() CORTA si el número es más largo que el ancho (lpad('12345',4,'0') = '1234').
  v_num := case when length(seq::text) >= s.pad_width then seq::text
                else lpad(seq::text, s.pad_width, '0') end;
  display := s.prefix || '-' || case s.mode when 'yearly' then v_year || '-' else '' end || v_num;
end $$;
revoke execute on function app.allocate_quote_number(uuid) from public, anon, authenticated;
-- Solo la llama create_quote (sprint 2), dentro de la misma transacción que crea la cotización.
```

- **Nunca se reutiliza un número:** si se borra un borrador, el contador no baja. Si la transacción falla antes de guardar, el número nunca llegó a existir, así que tampoco es un hueco. Los saltos están permitidos (`PROYECTO.md` §8.1).
- **Red de seguridad en el sprint 2:** el índice único `quotes (tenant_id, number_display, version)`.

### 6.3 Cambiar la configuración sin retroceder (`set_numbering`)

1. Revisa que sea Dueño o Administrador de la organización activa y bloquea la fila de `numbering_settings` (`for update`).
2. Calcula el **alcance actual** (el de la configuración vigente) y el **alcance nuevo**, ambos para el año de hoy.
3. Calcula `mínimo = mayor(último del alcance nuevo, último del alcance actual) + 1`. Este es el "último usado" del criterio de H-024.
4. Si `p_start_number < mínimo`, devuelve un error con un mensaje claro: *"El próximo número no puede ser menor que 44"*.
5. Deja el contador del alcance nuevo en `mayor(último del nuevo, último del actual, p_start_number - 1)`.
6. Guarda el prefijo, el formato y el ancho, y deja un registro de auditoría `numbering.updated` con los valores anteriores y nuevos.

**Consecuencia de aplicar el criterio al pie de la letra:** si una organización pasa de `COT-2043` (corrido) a anual, su siguiente número será `COT-2026-2044`. La alternativa sería que cada formato tenga su propio contador, con la seguridad de que el texto completo nunca se repite. Es la **pregunta 7**.

---

## 7. Tablas de los sprints siguientes (esbozo)

**En simple.** Todavía no se construyen. Se dejan dibujadas para que nada de lo que se hace ahora les cierre el paso. Todas siguen los principios P1 a P13: `tenant_id`, `unique (tenant_id, id)` y relaciones compuestas.

| Tabla | Sprint | Columnas clave | Reglas que ya quedan decididas |
|---|---|---|---|
| `quotes` | 2 | `number_seq`, `number_display`, `version`, `root_quote_id`, `supersedes_id`, `customer_id` → **FK `(tenant_id, customer_id)`**, `created_by` (persona), `status` (los 14 estados de `PROYECTO.md` §7, en texto con lista cerrada), `category_id`, `payment_terms`, `valid_until date`, totales en `bigint` (`subtotal_clp`, `discount_clp`, `net_clp`, `exempt_clp`, `tax_clp`, `total_clp`), `tax_rate_bp` (IVA congelado: 1900 = 19%), `archived_at` | Único `(tenant_id, number_display, version)`. Índices `(tenant_id, status, created_at)`, `(tenant_id, customer_id)`, `(tenant_id, created_by)`, `(tenant_id, valid_until)` y `trgm` sobre `number_display` para buscar "43". **Borrar solo si `status = 'draft'` y nunca enviada** (política `delete` + `sent_at is null`) |
| `quote_items` | 2 | `position`, `catalog_item_id` (solo referencia), `description`, `unit`, `quantity numeric(12,3)`, `unit_price_clp`, `discount_kind`, `discount_value`, `line_total_clp`, `tax_treatment`, `unit_cost_clp`, `calc_inputs jsonb`, `calc_model_version` | Precio **copiado**, no enlazado. Redondeo declarado en un solo módulo (`src/lib/money/`): medio peso hacia arriba al pasar a entero. Orden de cálculo de `PROYECTO.md` §13.7 |
| `quote_packages` | 3 y 5 | `quote_id`, `email_subject`, `email_body_md` (formato básico, no HTML), `pdf_path`, `pdf_sha256`, `payment_terms_snapshot`, `customer_snapshot_enc`, `bank_snapshot_enc`, `content_sha256` | **Inmutable** (trigger `forbid_mutation` al editar). La aprobación se amarra a `content_sha256` |
| `approvals` | 5 | `quote_id`, `package_id`, `package_sha256`, `decision`, `comment`, `requested_by`, `decided_by`, `decided_at` | El envío exige una aprobación con el **mismo** `package_sha256` (`PROYECTO.md` §13.3) |
| `payment_milestones` | 5 y 6 | `quote_id`, `seq`, `label`, `percent_bp`, `amount_clp`, `status`, `requested_at` | Trigger diferido (que revisa al final de la transacción): la suma de los hitos = `total_clp`. El peso sobrante va al último hito (decisión 011) |
| `payment_records` | 6 | `milestone_id`, `kind` (`confirmation`/`reversal`), `amount_clp`, `paid_on`, `note`, `reason`, `actor` | **Solo agregar**: revertir es una fila nueva con motivo (H-055). Solo Dueño y Administrador |
| `bank_accounts` | 5 | `bank_code`, `account_type`, `account_number_enc`, `holder_name_enc`, `holder_rut_enc`, `confirmation_email_enc`, `account_last4`, `version` | Políticas solo para `owner`/`admin`, también al **leer**. Una activa por organización (supuesto de la decisión pendiente 6). Cada cambio crea una versión, va a auditoría y dispara un aviso (H-051) |
| `share_links` | 3 | `quote_id`, `package_id`, `email_message_id`, `token_sha256`, `activated_at`, `revoked_at`, `revoked_by`, `revoke_reason`, `first_viewed_at`, `last_viewed_at`, `view_count` | **Se guarda la huella del token, nunca el token.** Un enlace por correo enviado. **No tiene `expires_at`:** el enlace vence con la cotización (`quotes.valid_until`, hasta el último día inclusive; decisión 017). El cliente final entra por el portero en el servidor, que ejecuta funciones solo para `service_role` (§4.6); ni `anon` ni `authenticated` las pueden llamar, y los miembros no pueden leer `token_sha256` |
| `share_link_views` | 3 | `share_link_id`, `viewed_at`, `ip_enc`, `user_agent_short` | Retención de 12 meses (H-108) |
| `quote_events` | 2 en adelante | `id bigint identity`, `quote_id`, `occurred_at`, `type`, `actor_type`, `actor_user_id`, `data jsonb` | **Solo agregar**, igual que `audit_log`. La leen todos los miembros. Se graba desde el sprint 2 |
| `email_messages` | 3 | `quote_id`, `kind` (`quote`/`payment_1`/`payment_2`/`resend`), `to_email_enc`, `provider_message_id`, `status`, `bounced_at` | Único `(package_id, kind)` cuando no es reenvío: **evita el doble envío** |
| `quote_notes` | 6 | `quote_id`, `author`, `body`, `deleted_at` | Solo el autor la borra (borrado suave + evento) |
| `invitations` | 5 (migración 20261030100000, H-008) | `id` (lo genera la aplicación antes de cifrar), `email_enc` (correo del invitado **cifrado**, sello `invitations.email\|tenant\|id`), `email_hash` (huella del correo normalizado, para no invitar dos veces), `email_binding` (sha256 de «huella del código \| correo normalizado»: con él la base comprueba, sola, que quien acepta usa el mismo correo, H-009), `role` (dominio `app.invitation_role`: `admin`, `approver`, `sales` o `viewer`, **nunca `owner`**), `token_sha256` (huella del código del enlace, único; **el código nunca se guarda**), `status` (`pending`, `accepted`, `revoked`; «vencida» es `pending` con `expires_at` pasado), `expires_at` (7 días), `invited_by`, `send_count` (envíos en total: el primero más hasta 5 reenvíos), `last_sent_at`, `revoked_at/by`, `revoke_reason` (`cancelled`, `inviter_removed`), `owner_notice_state` (`none`, `pending`, `sent`, `exhausted`), `owner_notice_attempts` y `owner_notice_last_attempt_at` (el aviso al Dueño cuando alguien que no lo es invita a un Administrador: se anota al invitar y lo envía y reintenta la tarea; no se leen con un pase), `accepted_at/by`, `member_id` (relación compuesta con `members`), `resent_by` (sprint 5, H-010, migración 20261106100000: quién reenvió por última vez; vacío si nunca se reenvió; solo lo escribe `resend_invitation` y no lo lee nadie con un pase; índice `invitations_tenant_resender` sobre las pendientes con reenviador) | Una sola pendiente por correo y organización (índice único parcial). **Al aceptar se vacían `email_enc`, `email_hash` y `email_binding`** (restricción de forma): el correo ya vive en la cuenta. Sin escritura directa: solo `create_invitation`, `resend_invitation`, `revoke_invitation` y `accept_invitation` (H-009, migración 20261103100000). Auditoría con su propio disparador (`app.audit_invitation_change`): `invitation.created` con el rol y `invitation.updated` con solo nombres de campos, nunca el correo; más `invitation.resent` e `invitation.revoked`. **Retención:** las no aceptadas se borran 30 días después de vencer o cancelarse, con sus correos; los registros de correo de las aceptadas, 30 días después de aceptarse (`app.purge_invitations()`, `pg_cron` a las 03:40) |
| `member_catalog_permissions` | 4 | `member_id`, `catalog_item_id` | H-042 |
| `approval_rules`, `text_snippets`, `templates`, `categories`, `tags`, `quote_tags`, `notifications`, `rate_configs` | 4 a 8 | — | Configuración por organización, con RLS normal |
| `intake_forms` | 4 (migración 29) | `public_id` (22 caracteres al azar, único en toda la plataforma, va en el QR; **no es secreto**), `name`, `title`, `intro`, `success_message`, `status` (`draft`/`published`/`paused`/`archived`), `revision`, `fields jsonb` (lista **cerrada**: teléfono, empresa, comuna, dirección del servicio, fecha deseada y mensaje, cada uno `off`/`optional`/`required`; nombre y correo siempre; **sin RUT ni preguntas libres**), `embed_origins text[]` (solo `https`, máx. 10, sin comodines), `daily_cap` (1 a 200, 50 por defecto; **columna privada**), `privacy_policy_url` | Se escribe solo con funciones (`create_intake_form`, `save_intake_form`, `set_intake_form_status`, `regenerate_intake_form_public_id`), solo Dueño y Administrador; la leen todos los miembros, **salvo `daily_cap`, que solo leen Dueño y Administrador por `intake_form_daily_caps`** (migración `20261102100000`). Tope de 20 formularios no archivados por organización. Cada guardado sube `revision` |
| `intake_form_items` | 4 (migración 29) | `form_id`, `position`, `kind` (`catalog`/`free`), `catalog_item_id` (relación compuesta), `public_name`, `public_description`, `unit`, `quantity_mode`, `min_qty_milli`, `max_qty_milli`, `is_active` | **Sin ninguna columna de precio**: al elegir un servicio del catálogo la aplicación copia nombre, descripción y unidad; lo que lee el público nunca se cruza con `catalog_items` |
| `intake_requests` (antes `requests`) | 4 (migración 30) | `form_id`, `status` (`new`/`assigned`/`converted`/`discarded`), `assigned_to/at/by`, `discard_reason`, `discard_note`, `quote_id`, datos de contacto **cifrados** (`contact_name_enc`, `contact_email_enc` + `contact_email_hash`, `contact_phone_enc`, `company_enc`, `comuna_enc`, `service_address_enc`, `message_enc`), `desired_date`, `items jsonb` (copia congelada `[{form_item_id, catalog_item_id, name, unit, quantity_milli}]`, **sin precios**: la base rechaza cualquier otra clave), `form_revision`, `submit_key`, consentimiento (`consent_template_version` con formato `intake-v<n>`, `consent_text` y su huella `consent_text_sha256`, que la base obliga a coincidir; `consent_text_unavailable` solo en filas anteriores a la migración 34; `consented_at`, `consent_ip_enc`), `anonymized_at` | **No hay `estimate_clp`**: el formulario no muestra ni guarda precios. El contenido no cambia después de creado; los estados siguen una lista cerrada. Los miembros leen por columnas (nadie lee `consent_ip_enc`). Retención: nuevas o asignadas 12 meses, descartadas 30 días, convertidas se anonimizan a los 12 meses (migración 33) |
| `intake_daily_counters` | 4 (migración 30) | `form_id`, `day` (día de Chile), `accepted`, `blocked_captcha`, `blocked_rate`, `blocked_cap`, `blocked_paused`, `blocked_invalid`, `cap_notified_at` | Solo la leen Dueño y Administrador; solo escribe el servidor, dentro de la transacción del envío. 90 días de retención |

`email_messages` suma los tipos `invitation` y `invitation_notice` (este último, el aviso al Dueño cuando alguien que no lo es invita a un Administrador; un solo aviso por invitación) con `invitation_id`, sin cotización ni paquete; la política de lectura de `invitation` pide `team.manage` y la de `invitation_notice` pide ser el Dueño (`tenant.transfer`): el resto de los miembros no ve el correo registrado de una invitación. Un reenvío de invitación agrega **otra** fila (con el código nuevo) y la guarda de solo agregar deja borrar las de una invitación solo en la tarea de retención.

La entrada pública usa el patrón del portero (decisión 017): el navegador nunca habla con la base; el servidor llama a `intake_form_read`, `intake_request_submit`, `intake_record_block` y a los avisos (`intake_notice_*`), todas solo para `service_role` (migración 31). `email_messages` suma los tipos `request_assigned`, `request_received` e `intake_cap_reached` (con `intake_request_id` o `intake_form_id`, sin datos del visitante) y `quotes` suma `source_request_id` (migración 32, función `convert_intake_request`).
| `data_subject_requests` | 11 | `kind`, `subject_hash`, `handled_by`, `handled_at` | H-106 y H-107 |
| `idempotency_keys` | 3 | `key`, `actor`, `response_hash`, `created_at` | Para "enviar", "aceptar" y "marcar pago": un doble clic no repite la acción |

**Reglas que estas tablas heredan de lo decidido hoy:**

- Toda referencia a otra fila de la organización es compuesta: `(tenant_id, x_id)`.
- Los estados cambian con una **actualización condicionada** (`update ... where id = $1 and status = 'draft' returning ...`). Si dos peticiones llegan a la vez, solo una gana.
- La historia (`quote_events`) se graba desde la primera cotización, aunque su pantalla llegue en el sprint 6.

---

## 8. Prueba automática de aislamiento (H-012)

**En simple.** Es un programa que crea dos empresas ficticias y una persona que está en las dos, y luego intenta por todos los caminos que se le ocurren ver o tocar datos ajenos. Si alguno funciona, la prueba sale en rojo y no se puede integrar el cambio.

### 8.1 Montaje

- **Herramienta:** Vitest contra Supabase local (`supabase start` y luego `supabase db reset`).
- **Preparación (`beforeAll`, con la llave maestra solo para montar):**

  | Persona | Membresía |
  |---|---|
  | `ana@ejemplo.test` | Dueña de **Org A** |
  | `beto@ejemplo.test` | Dueño de **Org B** |
  | `mixta@ejemplo.test` | Administradora de Org A y de Org B (no Dueña: cada organización tiene un solo Dueño activo) |
  | `ex@ejemplo.test` | Estaba en Org A y fue quitada |
  | `carla@ejemplo.test` | Comercial activa de Org A (solo en el `seed`, para probar la asignación de solicitudes) |
  | `dario@ejemplo.test` | Aprobador activo de Org A (solo en el `seed`, H-011b: con Ana, Mixta, Carla y Dante, Org A tiene los cinco roles) |
  | `dante@ejemplo.test` | Observador activo de Org A (solo en el `seed`, H-011b) |

  Cada organización tiene catálogo, clientes cifrados, numeración y auditoría.
- **Clientes de prueba:** se inicia sesión de verdad con cada persona (pase real) y se crea un cliente de Supabase con la llave pública más ese pase. Así se reproduce exactamente lo que podría hacer un atacante con una cuenta válida.
- **En la integración continua** (GitHub Actions): `supabase start`, luego `db reset`, luego `vitest run tests/isolation tests/db`. Si sale en rojo, no se integra.

### 8.2 Prueba de estructura: protege lo que todavía no existe

Recorre el catálogo de la base de datos (`information_schema` y `pg_catalog`) y **falla si**:

1. Alguna tabla de `public` no tiene `tenant_id uuid not null`.
2. Alguna tabla tiene la RLS apagada o no tiene políticas.
3. Alguna política está dirigida a `anon` y no figura en la lista permitida (hoy solo `legal_documents`).
4. `anon` o `authenticated` tienen `TRUNCATE`, o `anon` tiene cualquier permiso sobre tablas de negocio.
5. Alguna función `SECURITY DEFINER` no tiene `search_path` fijo.
6. Alguna función de `public` se puede ejecutar como `anon` sin estar en la lista permitida.
7. Alguna vista no tiene `security_invoker = true`.
8. Alguna tabla está en la publicación de Realtime sin estar en la lista permitida.
9. Alguna tabla con `tenant_id` no tiene el trigger `forbid_tenant_change`.
10. Alguna relación hacia una tabla con `tenant_id` no es compuesta.

Así, cuando en el sprint 2 se cree `quotes`, la prueba ya la vigila sin que nadie se acuerde de agregarla.

### 8.3 Ataques que intenta (por cada tabla de negocio, en un ciclo)

| # | Camino | Esperado |
|---|---|---|
| 1 | Ana, cabecera = A: listar todo | Solo filas de A |
| 2 | Ana, cabecera = **B** | `current_tenant_id()` = null; **cero filas** en todo |
| 3 | Ana, **sin cabecera** | Cero filas (salvo el selector de `tenants` y `members` propios) |
| 4 | Ana, cabecera basura (`''`, `'null'`, `'x'`, `'1; drop table'`, UUID en mayúsculas de B, dos cabeceras) | Cero filas y ningún error que revele información |
| 5 | Ana lee **por id** un cliente de B | Vacío |
| 6 | Ana **crea** una fila con `tenant_id = B` explícito | Rechazado |
| 7 | Ana **edita** por id una fila de B | 0 filas afectadas; con la llave maestra se confirma que quedó intacta |
| 8 | Ana edita una fila propia y le pone `tenant_id = B` | Rechazado |
| 9 | Ana **borra** por id una fila de B (y una propia) | 0 filas: no hay política de borrado |
| 10 | Mixta, cabecera = A, y luego cabecera = B | Nunca ve filas de la otra; nunca mezcla en la misma respuesta |
| 11 | Mixta crea un cliente con cabecera A | Queda en A, aunque intente mandar `tenant_id = B` |
| 12 | **Ex** (quitada) con su pase todavía vigente y cabecera = A | Cero filas, de inmediato |
| 13 | **Funciones RPC:** cada función de `public` llamada por Ana apuntando a B (`set_numbering`, `preview_next_quote_number`…) | No afecta ni revela nada de B. `create_tenant` no permite escoger el `tenant_id` |
| 14 | `app.allocate_quote_number(B)` llamada por Ana | Sin permiso de ejecución; y si se llamara desde dentro, `forbidden` |
| 15 | Numeración: Ana intenta bajar el contador (`update` directo y `set_numbering` con un número menor) | Rechazado |
| 16 | **Auditoría:** Ana lee la de B; Ana intenta crear, editar o borrar en `audit_log` | Vacío o rechazado |
| 17 | **Huellas:** la huella del RUT de un cliente de B, calculada para A, no encuentra nada; el mismo RUT en A y en B da huellas distintas | Correcto |
| 18 | **Descifrado cruzado:** copiar el `email_enc` de un cliente de B a uno de A (con la llave maestra) y descifrar | Falla por el AAD |
| 19 | **Sin sesión** (`anon`): leer todas las tablas y ejecutar todas las RPC | Nada, salvo `legal_documents` |
| 20 | **100 asignaciones de número en paralelo** (prueba de concurrencia, sprint 2) | 100 números distintos y seguidos, sin repetidos |
| 21 | **API** `/api/v1/customers/{id de B}` y `/api/v1/customers` con la sesión de Ana y la organización A | **404** y lista sin filas de B. Se hace con Playwright o llamando directo a las funciones de las rutas |
| 22 | Pantalla `/o/{B}/clientes` con la sesión de Ana | "No encontrado" y un registro `tenant.access_denied` |

**A partir del sprint 2** se agregan: archivos de Storage (logo y PDF de B), búsqueda, exportación y enlace del cliente (token de B usado en A).

### 8.4 Pruebas de la base de datos (opcionales, complementarias)

Las reglas de solo agregar, el contador que no baja y la validación de RUT en SQL se pueden probar también con pgTAP (`supabase test db`). No reemplaza a Vitest.

---

## 9. Migraciones y datos de prueba

**En simple.** Cada cambio de estructura es un archivo numerado que se aplica en orden. Cada uno tiene su "deshacer" escrito y probado. Los datos de prueba son siempre inventados.

### 9.1 Convención

- `supabase/migrations/<AAAAMMDDHHMMSS>_<nombre_en_ingles>.sql` (formato de la CLI de Supabase).
- La CLI de Supabase **no tiene "deshacer" incorporado**. Cada migración tiene su par `supabase/rollbacks/<mismo_timestamp>_<nombre>.down.sql`.
- En la integración continua se aplican todas, luego se deshace la última y se vuelve a aplicar, para probar que el deshacer funciona.
- Cada migración incluye, para su tabla: creación, índices, triggers, `enable row level security`, políticas y permisos. **Nunca una tabla sin su RLS en el mismo archivo.**
- Las migraciones las hace **un solo subagente, en orden** (decisión 013), y siempre declarando el entorno (`/entorno`).

### 9.2 Orden del sprint 1

| # | Migración | Contenido | Historia |
|---|---|---|---|
| 1 | `..._foundation` | Extensiones `pg_trgm` y `btree_gin`; esquema `app`; retiro de permisos por defecto (§4.1); funciones comunes (`set_row_meta`, `forbid_tenant_change`, `forbid_mutation`, `is_valid_rut`, `platform_tenant_id`) | H-005, H-012 |
| 2 | `..._tenants_profiles_members` | Tres tablas, fila de la plataforma, `current_tenant_id`, `current_member_role`, `has_role`, `my_tenant_ids` y sus políticas | H-005, H-006 |
| 3 | `..._audit_log` | Tabla, triggers de solo agregar, `audit_row_change`; se conectan los triggers de auditoría de las tablas de la migración 2 | H-012, H-014 (base) |
| 4 | `..._legal` | `legal_documents`, `legal_acceptances`, versión preliminar, trigger `handle_new_user` sobre `auth.users`, RPC `accept_current_legal_documents` | H-110, H-001 |
| 5 | `..._numbering` | Dos tablas, trigger que impide bajar, `allocate_quote_number`, `set_numbering`, `preview_next_quote_number` | H-024 |
| 6 | `..._create_tenant_rpc` | `create_tenant` (crea organización, Dueño, numeración por defecto y auditoría) | H-005 |
| 7 | `..._catalog_items` | Tabla, índices, RLS y auditoría | H-020 |
| 8 | `..._customers` | Tabla, índices de huella, RLS y auditoría (solo nombres de campos) | H-022 |
| 9 | `..._legal_documents_seed` | Versiones vigentes de términos y privacidad, con el SHA-256 de `src/lib/legal/documents.ts` | H-110 |
| 10 | `..._auth_rate_limits` | Límite propio de intentos de ingreso y registro (por huella de cuenta y por IP); RLS sin políticas, solo el servidor | H-002 (revisión) |
| 11 | `..._create_tenant_contact_email_check` | `create_tenant` valida el formato del correo de contacto | H-005 (revisión) |
| 12 | `..._profiles_column_privacy` | `profiles` legible solo por columnas, sin `last_tenant_id`; RPC `my_last_tenant_id()` | H-012 (filtración corregida) |

Las migraciones posteriores al sprint 1 se listan en el sprint que las crea.

**Configuración de Supabase Auth** (`supabase/config.toml`, sin migración): confirmación de correo obligatoria; largo mínimo de contraseña (constante declarada; propuesta: 10); límites de intentos de ingreso; duración corta del pase con renovación automática. Localmente, los correos de verificación se ven en el buzón de prueba que trae Supabase (Inbucket o Mailpit).

### 9.3 Datos de prueba ficticios

- Un script `scripts/seed.ts` en TypeScript, porque los clientes cifrados necesitan el módulo de cifrado y las cuentas se crean con la API de administración de Auth.
- **Se niega a correr** si `SUPABASE_URL` no es local (`127.0.0.1` o `localhost`) o el proyecto de pruebas declarado. Nunca contra producción.
- Contenido: las 5 personas de §8.1 (con carla, Comercial de Org A) con correos `@ejemplo.test` (dominio reservado que no existe); "Negocio Demo 1" y "Negocio Demo 2"; 5 servicios por organización; 5 clientes ficticios por organización con RUT generados de forma válida, nombres inventados y teléfonos `+56 9 0000 00xx`.
- **Nunca** se copia nada de producción a pruebas.

---

## 10. Dónde puede fallar y cómo se evita

| Riesgo | Cómo se ve | Cómo se evita |
|---|---|---|
| **Filtración entre organizaciones** | Ana ve un cliente de Beto | RLS con `current_tenant_id()`, relaciones compuestas, `with check`, trigger de `tenant_id` y prueba §8 en cada integración |
| **Variable pegada en una conexión compartida** | La organización de una persona queda "pegada" y la siguiente petición la hereda | No se usa `set_config` de sesión; la cabecera tiene alcance de transacción; no hay conexiones SQL directas |
| **Pestañas con distinta organización** | Se guarda en la organización equivocada | Organización en la dirección y en la cabecera explícita, nunca en una cookie |
| **Función con permisos elevados mal escrita** | Una RPC acepta un `tenant_id` de parámetro y opera sobre otra organización | Reglas de §4.4 y prueba de cada RPC |
| **Vista que se salta la RLS** | Un listado nuevo muestra todo | `security_invoker = true`, exigido por la prueba de estructura |
| **Llave maestra en el navegador o en flujos de usuario** | Toda la RLS anulada | Un solo archivo con `server-only`, regla del linter, variable sin `NEXT_PUBLIC_` |
| **Permisos por defecto de Supabase** (`TRUNCATE`, funciones ejecutables por `anon`) | Alguien sin sesión ejecuta una función | Retiro en la migración 1 y prueba de estructura |
| **Escalar de rol** | Un Comercial se cambia a Administrador | `members` sin escritura directa; solo RPC con revisión (sprint 4) |
| **Dato personal en logs o auditoría** | Un RUT legible en Sentry | La auditoría guarda solo nombres de campos; los errores no incluyen valores; filtro de Sentry (`beforeSend`) |
| **Pérdida de la clave de cifrado** | Clientes ilegibles para siempre | Copia en el gestor de la agencia con dos socios; texto cifrado versionado |
| **Número repetido o que retrocede** | Dos clientes reciben `COT-2026-0043` | Subida atómica con bloqueo de fila, trigger que impide bajar e índice único en `quotes` |
| **`lpad` corta números largos** | `COT-12345` sale como `COT-1234` | Caso cubierto en la función y prueba con números de más dígitos que el ancho |
| **Redondeo** (sprint 2) | El total no cuadra al peso | Enteros, un solo módulo de dinero, tabla de casos conocidos |
| **Doble envío** (sprints 1 y 3) | Doble clic crea dos clientes o manda dos correos | Sprint 1: botón deshabilitado al enviar + aviso de duplicado por huella. Sprint 3: cambio de estado condicionado, índice único en `email_messages`, `idempotency_keys` |
| **Correo sin verificar crea organización** | Cuentas falsas en masa | `create_tenant` revisa `email_confirmed_at` en la base de datos, no solo en la pantalla |
| **Consentimiento sin registrar** | No hay prueba de aceptación | Puerta de entrada que exige aceptación vigente en cada inicio de sesión |

## 11. Qué NO hacer

- **No** sacar el `tenant_id` del pase de sesión ni de una cookie compartida entre pestañas.
- **No** usar `set_config(..., false)` ni `set` sin `local`.
- **No** usar la llave maestra para leer o escribir datos de negocio en peticiones de usuario, aunque sea "más fácil" que escribir la política.
- **No** crear una tabla sin RLS "por mientras", ni una política `using (true)` fuera de `legal_documents`.
- **No** permitir que una RPC reciba `tenant_id` como parámetro para decidir dónde operar.
- **No** crear vistas sin `security_invoker`.
- **No** cifrar con pgsodium ni mandar la clave dentro del SQL.
- **No** usar la misma clave para cifrar y para las huellas, ni hacer huellas sin el `tenant_id`.
- **No** guardar montos en `float`, `real` ni `numeric` con decimales para pesos.
- **No** calcular el número correlativo en la aplicación (`max(...) + 1`): dos personas a la vez reciben el mismo.
- **No** borrar físicamente miembros, clientes, catálogo ni auditoría.
- **No** responder "Prohibido" (403) a quien pide un recurso de otra organización: se responde "No encontrado" (404).
- **No** usar datos reales en la semilla ni en las pruebas.

---

## 12. Preguntas abiertas para Aarón

Ninguna bloquea el inicio del sprint. Cada una tiene un supuesto que se aplica si no hay respuesta.

| # | Pregunta | Supuesto si no se responde |
|---|---|---|
| 1 | Los datos de la persona (perfil, aceptación de términos) no son de ninguna empresa. ¿Se marcan con una **organización especial de la plataforma** para cumplir "`tenant_id` en toda tabla" sin excepciones, o se registra una decisión que exima esas tablas? | Organización de la plataforma (no hace falta registrar una decisión) |
| 2 | Si la empresa es una **persona natural con giro**, su RUT es un dato personal. ¿Se cifra el RUT de la organización, aunque igual salga impreso en cada PDF? | Sin cifrar; se declara en la política de privacidad |
| 3 | ¿Pueden dos organizaciones tener el **mismo RUT**? (Una empresa con dos marcas) | Sí; sin aviso |
| 4 | Cliente con el mismo RUT o correo en la misma organización: ¿**solo avisar** (como dice H-022) o **impedir**? | Solo avisar |
| 5 | **Custodia de las claves de cifrado**: ¿qué gestor de contraseñas y qué dos personas guardan la copia? Sin ella, perder la clave es perder los datos | Pendiente; se necesita antes del piloto |
| 6 | **Tope de organizaciones por cuenta**, contra el abuso en el registro abierto | 5 (constante; se ajusta con la decisión pendiente 13) |
| 7 | **Cambio de formato de numeración**: al pasar de corrido (`COT-2043`) a anual, ¿el siguiente debe ser `COT-2026-2044` (el número nunca baja, que es lo que dice H-024) o puede ser `COT-2026-0001` (cada formato con su contador, sin repetir nunca el texto completo)? | `COT-2026-2044`, al pie de la letra |
| 8 | El identificador de la organización aparecerá en las direcciones internas de la aplicación (`/o/3f2a…/clientes`), solo visibles con sesión iniciada. ¿Se acepta, o se prefiere un nombre corto (`/o/negocio-1/…`), que agrega una tabla de nombres únicos? | Se acepta el identificador |

---

## 13. Archivos que se crearán al construir

```
supabase/config.toml
supabase/migrations/<ts>_foundation.sql ... <ts>_customers.sql      (8 migraciones, §9.2)
supabase/rollbacks/<ts>_*.down.sql                                   (una por migración)
src/lib/auth/session.ts                 validación del pase de sesión (único)
src/lib/tenant/active-tenant.ts         resolución de la organización activa (único)
src/lib/tenant/constants.ts             nombre de la cabecera y de la ruta
src/lib/supabase/server-client.ts       cliente con el pase de la persona
src/lib/supabase/admin-client.ts        llave maestra, server-only, uso restringido
src/lib/crypto/pii.ts                   cifrado AES-256-GCM con AAD
src/lib/crypto/search-hash.ts           huellas HMAC por organización
src/lib/chile/rut.ts                    validar, normalizar y formatear RUT
src/lib/normalize/email.ts
src/lib/audit/log.ts                    eventos de la aplicación hacia audit_log
scripts/seed.ts                         datos ficticios; se niega fuera de local o pruebas
tests/db/schema-guards.test.ts          prueba de estructura (§8.2)
tests/isolation/*.test.ts               ataques de aislamiento (§8.3)
.env.example                            nombres de variables, sin valores
.github/workflows/ci.yml                supabase start, db reset, vitest
```

---

**Pendiente de verificar al construir** (depende del estado actual de Supabase): el estado de
pgsodium, los nombres nuevos de las llaves (publishable/secret) con `getClaims()`, y si Storage
entrega cabeceras personalizadas a la base de datos. Se confirman contra la documentación vigente
antes de la migración 1.
