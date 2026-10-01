# Plan de construcción: H-012 · Que ninguna otra organización vea mis datos 🔒

> Diseñado por el subagente planificador (Opus) el 2026-10-01. Base: `modelo-datos.md` §8.
> Lo construye un subagente Sonnet **solo** (las historias 🔒 no van en paralelo) y lo revisa el
> subagente revisor (Opus) por separado.

## 0. Resumen y hallazgo previo

**Qué se construye.** Una batería de pruebas que actúan como atacante, con pases reales, e intentan
por todos los caminos que existen hoy ver o tocar datos de otra organización. Corre en cada
integración. La RLS ya existe (migraciones 1–8); esta historia la prueba de verdad y cierra huecos.

**Hallazgo: filtración real, se corrige en esta historia.** `profiles` permite a los compañeros de
una organización leer **todas** sus columnas, incluida `last_tenant_id` (la última organización que
usó cada persona). Si Mixta (Administradora en A y B) usó B por última vez, Ana (Dueña de A) ve el
identificador de B. Va contra el criterio 3. Lo detecta el canario (§3.3) y lo corrige la
**migración 9** (§6).

## 1. Criterios de H-012 → pruebas

| Criterio | Pruebas |
|---|---|
| 1. Otra organización que abre una dirección mía ve "No encontrado" | `e2e/isolation.spec.ts` → P22, P22b, P22c, P21; `tests/isolation/lifecycle.test.ts` → A12, X9 |
| 2. Búsquedas, listas y exportaciones nunca muestran datos ajenos | `tables-read.test.ts` → A01–A05, X1–X4, X8; `crypto.test.ts` → A17; e2e → P23. Exportación y búsqueda global: `it.todo` visibles (sprints 7 y 2) |
| 3. Quien está en mis dos organizaciones nunca ve datos de una mientras trabaja en la otra | `tables-read` → A10; `tables-write` → A11; `rpc` → A13b; e2e → P24; canario sobre `profiles` |
| 4. Prueba automática en cada integración, en verde | `.github/workflows/ci.yml` (§5) + `registry-guard.test.ts` |

### Los 22 ataques de modelo-datos §8.3

| # | Ataque | Ya cubierto (no duplicar) | Nuevo: archivo · prueba |
|---|---|---|---|
| 1 | Ana con A lista todo | `behavior` (catálogo, SQL) | `tables-read` · A01 en ciclo por tabla, por HTTP |
| 2 | Ana con cabecera B | `behavior`, `http-headers` (solo RPC de vista previa) | `tables-read` · A02 |
| 3 | Ana sin cabecera | `behavior` (SQL) | `tables-read` · A03 (excepciones: selector de `tenants`, filas propias de `members`) |
| 4 | Cabecera basura o duplicada | `behavior`, `http-headers` (4 valores) | `tables-read` · A04 × variantes de §7 |
| 5 | Leer por id un cliente de B | — | `tables-read` · A05 (`?id=eq.<fila de B>`) |
| 6 | Crear fila con `tenant_id = B` | `behavior` (catálogo, SQL) | `tables-write` · A06 (con cabecera A, B y sin cabecera) |
| 7 | Editar por id una fila de B | `behavior` (catálogo) | `tables-write` · A07 + huella de B antes y después |
| 8 | Mudar fila propia a B | `behavior` (catálogo) | `tables-write` · A08 |
| 9 | Borrar fila de B o propia | `behavior` (catálogo) | `tables-write` · A09 |
| 10 | Mixta con A y luego con B | — | `tables-read` · A10: nunca mezcla |
| 11 | Mixta crea cliente con A y `tenant_id = B` | — | `tables-write` · A11: rechazado o queda en A; nunca en B |
| 12 | Ex, quitada, con pase vigente | `behavior` (simulado) | `lifecycle` · A12 con pase real obtenido antes de quitarla |
| 13 | Toda RPC apuntando a B | `http-headers` (parcial) | `rpc` · A13 en ciclo desde el registro; A13b Mixta cambia numeración en A y B no cambia |
| 14 | `allocate_quote_number(B)` | `behavior` | `rpc` · A14: `app.*` no expuesta por HTTP (404; 406 con `Content-Profile: app`) |
| 15 | Bajar el contador | `behavior` | `rpc` · A15: PATCH a `numbering_sequences` rechazado |
| 16 | Auditoría de B | `behavior` | ciclo por tabla (`audit_log` en el registro) + A16: Ana nunca ve registros de la plataforma |
| 17 | Huellas por organización | `search-hash` (unitaria) | `crypto` · A17 con la base real |
| 18 | Descifrado cruzado | `pii.test` | `crypto` · A18 con la base real |
| 19 | Sin sesión | `behavior` (SQL) | `rpc`/`tables-read` · A19 por HTTP + GraphQL |
| 20 | 100 números en paralelo | — | `tests/db/numbering-concurrency.test.ts` · A20 (20 conexiones `pg`). Recomendado, no bloquea |
| 21 | API `/api/v1/...` | — | e2e · P21 + guardia G5. Depende de las rutas existentes |
| 22 | Pantalla `/o/{B}/clientes` | — | e2e · P22 (404 + `tenant.access_denied`). Depende de H-002/H-005/H-006/H-022 |

**Caminos extra:**

| # | Camino | Se espera |
|---|---|---|
| X1 | `Prefer: count=exact` con cabecera B | `Content-Range: */0` |
| X2 | Embebidos (`customers?select=*,tenants(*)`) | Solo A |
| X3 | Filtros `?tenant_id=eq.B`, `?or=(tenant_id.eq.B)` | `[]` |
| X4 | GraphQL (`/graphql/v1`) | Con B vacío; sin sesión error |
| X5 | Upsert (`Prefer: resolution=merge-duplicates`) con `id` de B | Error y B intacta (`tables-write`) |
| X6 | `/auth/v1/admin/users` con el pase de Ana | 401/403 (`rpc`) |
| X8 | **Canario**: ninguna respuesta a Ana con A contiene UUID de B o C, UUID de Beto ni `CANARIO-B-<runId>` | En toda tabla y todo HTML |
| X9 | Organización archivada | Su Dueña: cero filas y 404 (`lifecycle`) |

## 2. Montaje

**Fixture propia, no el seed** (`scripts/seed.ts` queda para jugar a mano). Correos únicos por
ejecución: `<rol>-<runId>@ejemplo.test`.

| Persona | Membresía | Cómo se crea |
|---|---|---|
| ana | Dueña de A | API admin de Auth (confirmada, aceptación legal vigente) y `create_tenant` por HTTP con su pase |
| beto | Dueño de B | Igual |
| carla | Dueña de C, luego **archivada** | Igual; luego `update tenants set status='archived', archived_at=now()` por `pg` |
| mixta | `admin` de A y B; `last_tenant_id = B` | Insert en `members` por `pg` |
| ex | `sales` de A | Se quita **dentro** de A12, después de obtener su pase |

- Catálogo y clientes se crean **por PostgREST con el pase del Dueño y su cabecera** (prueba también
  el camino legítimo). Clientes cifrados con `encryptPii`/`searchHash`; un cliente de A y uno de B
  comparten el mismo RUT ficticio (A17). Todo texto de B lleva `CANARIO-B-<runId>`.
- Numeración por `pg` como `postgres` con cabecera; auditoría por los triggers.

**Archivos:**

```
tests/support/local-supabase.ts   localEnv(), adminCreateUser(), signIn(), rest(), rpc(), graphql(), freshToken()
                                  (se extrae de http-headers.test.ts, que pasa a importarlo)
tests/isolation/fixture.ts        createIsolationFixture(runId): sin Vitest; lo usa también Playwright
tests/isolation/global-setup.ts   arma la fixture una vez y la comparte con provide('fixture', fx)
```

- **Pases reales**, un inicio de sesión por persona en el montaje global (límite de 10 cada 5 min
  por IP; no se sube el límite). `freshToken()` renueva si quedan <60 s (pase de 900 s).
- **Ataque con `fetch` directo a `/rest/v1`**, no `supabase-js`, para controlar cabeceras
  (duplicadas, mayúsculas). Con cabecera / sin cabecera / anónimo (solo `apikey`).
- La llave maestra y `pg` como `postgres` solo para montar y verificar que B quedó intacta. **Nunca
  para atacar.**
- Claves de cifrado de prueba: en `vitest.db.config.mts`, si faltan `CP_PII_KEY_V1` y
  `CP_SEARCH_KEY_V1`, se generan al azar y se pasan en `test.env`. Alias `server-only` →
  `src/test/server-only-stub.ts`. Verificar que el montaje global resuelve el alias.
- **Limpieza:** no se borra nada (auditoría de solo agregar). Cada ejecución usa su `runId`; las
  pruebas nunca suponen la base vacía. No crear funciones SQL "para limpiar pruebas".

## 3. Prueba en ciclo por tabla

### 3.1 Registro único: `tests/isolation/registry.ts`

```ts
type Visibility = "business" | "selector-tenants" | "selector-members" | "profiles" | "own-user" | "public";
export interface TableSpec {
  name: string;
  visibility: Visibility;
  rolesThatRead?: Role[];          // audit_log: ['owner','admin']
  pk: string[];
  ownerColumn: "tenant_id" | "user_id";
  insertBody?: (fx, targetTenant) => object;
  updatePatch?: object;
  hasFixtureRowsInB: boolean;
}
export const ISOLATION_TABLES: TableSpec[] = [ /* customers, catalog_items, numbering_settings,
  numbering_sequences, audit_log, tenants, members, profiles, legal_acceptances, legal_documents */ ];
export const RPC_CASES: Record<string, RpcCase> = { /* set_numbering, preview_next_quote_number,
  accept_current_legal_documents, create_tenant, my_last_tenant_id (tras migración 9) */ };
export const APP_ROUTES: AppRoute[] = [ { path: "/api/v1/ping", public: true } /* + H-020/H-022 */ ];
```

| Tipo | La fila se permite si… |
|---|---|
| `business` | `row.tenant_id === ctx.active` (y rol en `rolesThatRead` si aplica); sin organización activa, cero filas |
| `selector-tenants` | `row.tenant_id ∈ misOrganizaciones(persona)`, consultado en vivo por `pg` |
| `selector-members` | `row.user_id === yo` o `row.tenant_id === ctx.active` |
| `profiles` | `row.user_id === yo` o la persona es miembro activo de `ctx.active` |
| `own-user` | `row.user_id === yo` |
| `public` | Siempre; `tenant_id` = plataforma |

### 3.2 Guardia: `tests/isolation/registry-guard.test.ts`

| Prueba | Falla si… |
|---|---|
| G1 | El conjunto de tablas de `public` con `tenant_id` difiere (en cualquier sentido) de `ISOLATION_TABLES` |
| G2 | Alguna tabla `business` tiene cero filas de B en la fixture |
| G3 | Hay una función de `public` ejecutable por `authenticated` que no está en `RPC_CASES` |
| G4 | Alguna función de `public` tiene un parámetro con "tenant" en el nombre |
| G5 | Hay una `route.ts` bajo `api/v1` o una `page.tsx` bajo `o/[tenantId]` sin entrada en `APP_ROUTES` |

### 3.3 Cómo corre

| Archivo | Qué hace |
|---|---|
| `tables-read.test.ts` | `describe.each(ISOLATION_TABLES)` × escenarios. `GET /rest/v1/{t}?select=*` con `Prefer: count=exact`; cada fila cumple `allowed`; el texto no contiene canarios ajenos. **Control positivo:** con su cabecera, el Dueño ve sus filas; si no, falla |
| `tables-write.test.ts` | Huella de B por tabla con `pg` antes (`md5(string_agg(t::text,'|' order by t::text))`) y después de A06–A09, A11, X5: idéntica, y ninguna fila `ATAQUE-<runId>` fuera de A |

Rechazo = `status >= 400` o `[]` con `Prefer: return=representation`. Manda la verificación con `pg`.

## 4. Capa de la aplicación (depende de H-002/H-005/H-006/H-020/H-022)

Contrato asumido (`modelo-datos.md` §2.3): `requireActiveTenant(id)` → `{ tenantId, role, supabase }`;
si no corresponde, `notFound()` y auditoría `tenant.access_denied` con `tenant_id` = plataforma,
`resource_type='tenant'`, `resource_id` = id solicitado solo si es UUID, `result='denied'`, sin
datos personales. Función núcleo testeable sin Next: `resolveActiveTenant({ userId, requestedTenantId })`.

`e2e/isolation.setup.ts` arma la fixture con `fixture.ts`, la guarda en `e2e/.auth/fixture.json`
(en `.gitignore`) e inicia sesión por pantalla con ana, mixta, carla y ex (`storageState`).

`e2e/isolation.spec.ts` (proyecto `isolation`, `retries: 0`):

| Prueba | Se espera |
|---|---|
| P22 | Ana en `/o/{B}/clientes`: 404, "No encontrado", sin canario; en `pg` existe `tenant.access_denied` con `tenant_id` = plataforma y `resource_id = B`; ninguna fila nueva con `tenant_id = B` |
| P22b | `/o/{UUID al azar}`, `/o/{B}`, `/o/no-uuid`, `/o/{B MAYÚSCULAS}`, `/o/{B sin guiones}`, `/o/{plataforma}`: mismo código y mismo texto |
| P22c | Páginas `/o/{A}/...` con `Cache-Control` `private` o `no-store` |
| P21 | Cada ruta de `APP_ROUTES` con organización: cabecera B con sesión de Ana → 404; con A, sin canario |
| P24 | Mixta con dos pestañas (A y B): cada una ve solo lo suyo; un cliente creado en la pestaña A queda en A |
| P25 | Acción del servidor con el UUID de A reemplazado por B (`page.route`): error o 404; cero clientes `ATAQUE` en B |
| P23 | Ana registra en A un cliente con el RUT que solo existe en B: no aparece aviso de duplicado |
| P26 | Ex en `/o/A/...` y Carla en `/o/C/...` (archivada): 404 y su registro de auditoría |

**Guardias estáticas** (`tests/isolation/static-guards.test.ts`, sin red). Fallan si:
1. El literal `x-cp-tenant-id` aparece en `src/` fuera de `src/lib/tenant/constants.ts`.
2. `admin-client` se importa fuera de `src/lib/audit/`, `src/server/jobs/`, `scripts/`, `tests/`.
3. Una `page.tsx` bajo `o/[tenantId]`, una `route.ts` bajo `api/v1` (salvo públicas) o un archivo `'use server'` que use Supabase no llama a `requireActiveTenant`.
4. Aparece `getSession(` en código de servidor.
5. Aparece un import de `pg` o `postgres` en `src/`.

## 5. Integración en CI

- `package.json`: `"test:isolation": "vitest run --config vitest.db.config.mts tests/isolation"`.
- `vitest.db.config.mts`: `include` con `tests/db/**` y `tests/isolation/**`, `globalSetup`, `env`, alias `server-only`.
- `ci.yml`, después de `db reset`: exportar variables desde `npx supabase status -o env` (verificar
  los nombres en la CLI 2.119) y claves `CP_*` aleatorias; correr `test:db`, luego el paso
  **"Prueba de aislamiento entre organizaciones (H-012)"** (`npm run test:isolation`), luego
  `playwright install --with-deps chromium` y `test:e2e`.
- Unificar nombres de variables (`.env.example` usa `ANON_KEY`/`SERVICE_ROLE_KEY`; `http-headers`
  usa `PUBLISHABLE_KEY`/`SECRET_KEY`): todo se lee desde `tests/support/local-supabase.ts`.
- `playwright.config.ts`: pasar al `webServer.env` las variables de Supabase y `CP_*`; proyectos `setup` e `isolation`.
- **Bloqueo real:** hoy se sube directo a `main`, así que la prueba avisa pero no impide. Bloquear
  exige pull requests y una regla en GitHub; en repositorio privado requiere GitHub Pro o Team.
  Decisión de Aarón; mientras tanto, regla del proceso que exige el revisor.

## 6. Migración 9 (un solo agente, 🟢 PRUEBAS)

`supabase/migrations/20261001120900_profiles_column_privacy.sql` + rollback:

```sql
revoke select on public.profiles from authenticated;
grant select (user_id, tenant_id, full_name, created_at, updated_at) on public.profiles to authenticated;

create function public.my_last_tenant_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.last_tenant_id from public.profiles p
  where p.user_id = auth.uid() and p.last_tenant_id in (select app.my_tenant_ids())
$$;
revoke all on function public.my_last_tenant_id() from public, anon;
grant execute on function public.my_last_tenant_id() to authenticated;
```

Consecuencia: H-006 lee la última organización con `rpc('my_last_tenant_id')` (encapsulado en
`getLastTenantId()` de `active-tenant.ts`), nunca con `profiles.select('*')`.

## 7. Riesgos y casos borde

| Caso | Se espera |
|---|---|
| Cabeceras duplicadas (`"A, B"`) | Ana: cero filas. Mixta: filas de una sola organización, nunca mezcladas (A04, A10) |
| Nombre en mayúsculas (`X-CP-TENANT-ID`) | Funciona con A; con B cero filas |
| Valor en mayúsculas, con espacios, `{B}`, sin guiones | En la base cero filas por membresía; en las direcciones de la app solo se acepta la forma canónica en minúsculas, todo lo demás 404 (P22b) |
| Valor de 2 KB, `'null'`, `''`, plataforma | Cero filas, ningún error con datos |
| Persona quitada con pase vigente | A12 y P26 |
| Organización archivada | `current_tenant_id` null, 404. `my_tenant_ids()` no filtra por `status`: sigue en el selector de sus miembros (no es filtración hacia otra empresa; anotado para H-112) |
| Registro de acceso denegado | `tenant_id` = plataforma (si fuera B, el Dueño de B vería el identificador de Ana) |
| Saber si un UUID existe por error de duplicado | Riesgo residual aceptado: UUID aleatorios y no expuestos |
| Pases de 15 minutos / límite de inicios de sesión | `freshToken()`; una sesión por persona y ejecución |
| Prueba que pasa porque no hay datos | Control positivo + G2 |
| GraphQL expuesto | X4. Recomendación: dejar de exponerlo si no se usa |

## 8. Qué NO hacer

- No atacar con la llave maestra ni simular el pase con `set_config` en las pruebas HTTP.
- No `it.skip` ni "saltar si no hay Supabase": si la base no está, la prueba falla.
- No relajar políticas, subir límites ni sacar tablas del registro para que pase.
- No confiar solo en `layout` o `proxy.ts` para el 404: cada página y acción llama a `requireActiveTenant`.
- No responder 403: siempre 404.
- No escribir el literal `x-cp-tenant-id` en las pruebas: importar la constante.
- No `select('*')` sobre `profiles` tras la migración 9.
- No duplicar `schema-guards`: G1–G5 lo complementan.

## 9. Orden de construcción

1. Extraer `tests/support/local-supabase.ts` y adaptar `http-headers.test.ts`.
2. Configuración: `vitest.db.config.mts`, script `test:isolation`, claves de prueba.
3. `fixture.ts` y `global-setup.ts`.
4. `registry.ts` y `registry-guard.test.ts`.
5. `tables-read`, `tables-write`, `rpc`, `crypto`, `lifecycle` (se espera rojo en el canario de `profiles`).
6. Migración 9 y rollback; ajustar `getLastTenantId()`. Todo en verde.
7. `static-guards` y, opcional, `numbering-concurrency`.
8. Parte de Playwright (cuando existan H-002, H-005, H-006, H-020, H-022).
9. CI y `.gitignore` (`e2e/.auth/`).

## 10. Cuándo está terminado

- [ ] `npm run test:isolation` en verde en local y en CI, con `it.todo` visibles para Storage, búsqueda global, exportación y enlace del cliente.
- [ ] Prueba de la guardia: una tabla temporal con `tenant_id` sin registrar pone G1 en rojo; una ruta nueva sin caso pone G5 en rojo.
- [ ] Prueba de mutación: con `customers_select` cambiada a `using (true)`, A02/A10 en rojo; se revierte y se deja escrito en el cierre.
- [ ] Migración 9 aplicada y deshecha en CI, canario de `profiles` en verde.
- [ ] `e2e/isolation.spec.ts` en verde: 404 idéntico para organización ajena e inexistente, con `tenant.access_denied` en la plataforma.
- [ ] Paso de H-012 visible en GitHub Actions y decisión de Aarón sobre el bloqueo.
- [ ] Aarón lo ve en pantalla: Ana en A abre una dirección de B y ve "No encontrado"; Mixta con dos pestañas ve cada organización por separado.

---

## 11. Registro de cierre (2026-10-01)

**Construida** por un subagente Sonnet, sola. **Revisada** por el revisor (Opus): aprobada con
observaciones, sin bloqueantes y sin filtraciones encontradas.

**Filtración encontrada y corregida:** `profiles.last_tenant_id` era legible por los compañeros de
organización. Antes de la corrección, 4 pruebas de `profiles` quedaron en rojo con el UUID de B en la
respuesta. Corregida con la migración 12 (`20261001150000_profiles_column_privacy`) y la RPC
`my_last_tenant_id()`.

**Evidencia exigida por §10:**

| Prueba | Resultado |
|---|---|
| Guardia G1 con una tabla temporal `zz_guard_probe` con `tenant_id` sin registrar | Rojo (`+ "zz_guard_probe"`); revertida |
| Guardia G5 con una ruta temporal `src/app/api/v1/zz/route.ts` | Rojo (`+ "/api/v1/zz"`); revertida |
| Mutación: `customers_select` cambiada a `using (true)` | `Tests 40 failed | 442 passed`; fallaron A02 (Ana con cabecera B), A10 (Mixta), A03, A05 y X3. Revertida y verificada en `pg_policy` |
| `test:isolation` | 490 en verde, 5 `it.todo` visibles (Storage, búsqueda global, exportación, enlace del cliente, formulario público) |
| `test:e2e` | 31 en verde (15 de aislamiento) |
| Migración 12 aplicada y deshecha | `test:db:rollbacks` en verde |

**Bloqueo de integración:** hoy la prueba corre en cada subida a `main` y avisa, pero no impide
integrar. Bloquear exige pull requests y una regla en GitHub (GitHub Pro o Team en repositorio
privado). **Pendiente de decisión de Aarón**; mientras tanto, regla del proceso: el revisor no cierra
ninguna historia con la integración en rojo.

**Derivado:** la IP de origen en la auditoría se puede falsificar llamando directo a la base con un
pase válido. No es una filtración entre organizaciones; se registró como historia nueva **H-114**,
para el sprint 6 (antes del piloto).

**Correcciones de la revisión** (GraphQL desactivado, registro de visibilidades cerrado, guardias de
rutas completas, control positivo en escrituras, CI con tiempo límite y caché): en curso.
