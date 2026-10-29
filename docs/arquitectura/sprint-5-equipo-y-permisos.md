---
document_id: CP-ARQ-SPRINT-5
title: Sprint 5 — Equipo y permisos: diseño de H-011, H-008, H-009, H-010, H-004 y H-041
version: 0.1 (diseño del planificador, sin revisar por un humano)
status: DISEÑO — nada de esto está construido. Depende de la confirmación del sprint (Compuerta 3) y de las preguntas de §8
autor: subagente `planificador` (Opus), 2026-10-28
language: es-CL
---

# Sprint 5 — Equipo y permisos: diseño

> Resultado del `planificador` (Opus) sobre el código de `main` (2026-10-28). Se guardó tal cual salió, con
> retoques de formato. **Es una propuesta**: las preguntas de §8 no están resueltas y cada «supuesto» es solo
> lo que se haría si nadie responde. Ver también `docs/sprints/005-equipo-y-permisos.md`.

**En simple:** la base de datos ya filtra por rol casi todas las escrituras y revisa la membresía en cada
consulta; por eso «quitar a alguien al instante» ya funciona por diseño. Falta:

- las invitaciones (la tabla no existe);
- cambiar el rol y quitar miembros (no hay funciones);
- que la regla de qué puede hacer cada rol viva en **un solo lugar** (hoy está copiada en unos 20 sitios);
- la pantalla «No tienes permiso para esto»;
- las pruebas por rol;
- la verificación en dos pasos (habilitada en Supabase, pero sin usar);
- los precios bloqueados.

---

## 1. Qué existe y qué falta

**Lo que ya existe**

- **Tabla `public.members`** (`20261001120200_tenants_profiles_members.sql`): los 5 roles, el estado
  `active`/`removed`, `invited_by` y `removed_at`/`removed_by`; un solo Dueño activo (índice único
  `members_one_owner`); nadie la escribe directo, solo por funciones. Quitar a alguien cambia su estado,
  no borra la fila.
- **Rol en la base:** `app.current_member_role()` y `app.has_role(...)` leen `members` en cada consulta, a
  través de `app.current_tenant_id()`, que exige miembro activo y organización activa.
- **Rol en la app:** `requireActiveTenant()` (`src/lib/tenant/active-tenant.ts`) consulta `members` en cada
  petición y entrega `active.role`. Su memoria (`cache` de React) dura una sola petición.
- **Auditoría:** el disparador `members_audit` guarda las altas y cambios con valor anterior y nuevo;
  `src/lib/audit/labels.ts` ya describe «rol: Comercial → Administrador».
- **Correo:** `src/lib/email/transport.ts` y `email_messages` con una lista cerrada de tipos.
- **Límites de intentos:** tabla `auth_rate_limits` y `src/lib/security/login-rate-limit.ts`.
- **Verificación en dos pasos (TOTP, códigos de una aplicación del teléfono):** `supabase/config.toml` ya
  la tiene habilitada en `[auth.mfa.totp]`, pero ningún código la usa.

**Hallazgos**

1. **Invitaciones:** no existen la tabla `invitations` ni funciones para invitar, aceptar, cambiar rol o
   quitar. La fixture de pruebas (`tests/isolation/fixture.ts`) inserta miembros directo con `pg`.
2. **La matriz de permisos está repetida unas 20 veces.** En la app: `WRITER_ROLES` (en 9 pantallas),
   `QUOTE_WRITER_ROLES`, `ROLES_THAT_CAN_WRITE`, `CUSTOMER_WRITER_ROLES`, `canManageCatalog`,
   `canManageForms`, `AUTHOR_ROLES`/`MANAGER_ROLES`, `ASSIGNABLE_ROLES` y comparaciones
   `role !== "owner" && …` en unos 10 archivos. En la base: cada función repite su lista dentro de
   `has_role(...)`, con más de 40 usos.
3. **Sin permiso de rol, la pantalla dice «No encontrado»** (`notFound()`) en `clientes/nuevo`,
   `clientes/[id]/editar`, `cotizaciones/nueva`, `formularios/nuevo`, `solicitudes/[id]/convertir`,
   `configuracion/actividad` y la ruta del QR. H-011 pide «No tienes permiso para esto»; «No encontrado» se
   mantiene solo para quien no es miembro de la organización.
4. **Solo una cosa asume literalmente «solo el Dueño»: el registro de actividad.** La pantalla lo restringe
   al Dueño (`AUDIT_VIEWER_ROLES = ["owner"]`, `src/lib/audit/queries.ts`), pero la base también deja leerlo
   al Administrador (política `audit_select`). Lo demás ya distingue roles; solo nunca se probó con un rol
   distinto del Dueño.
5. **Un criterio de H-010 ya falla hoy.** La política `profiles_select` solo deja leer el nombre de los
   miembros activos: al quitar a alguien, sus cotizaciones muestran «—» como autor (`authorNames()` en
   `src/lib/quotes/queries.ts`).
6. `src/lib/intake/requests-actions.ts` no revisa el rol en la app: confía solo en la base.
7. `canSeeProtection` y `src/lib/intake/protection-queries.ts` no existen en `main`: están en H-092 (PR #1).
   Si H-092 entra antes, su revisión de rol se pasa a la matriz igual que las demás.
8. Supabase no trae códigos de respaldo para la verificación en dos pasos: hay que construirlos.
9. El menú (`src/components/app-shell/nav-items.ts`) muestra lo mismo a todos los roles.

---

## 2. Invitaciones (H-008 y H-009)

### Tabla `public.invitations`

| Columna | Qué guarda |
|---|---|
| `id uuid` (llave principal) | La genera la app antes de cifrar, porque va en el sello del cifrado (igual que `customers`) |
| `tenant_id uuid not null` | Relación con `tenants`, con `on update cascade` |
| `email_enc` | Correo cifrado (AES-256-GCM) con el sello `invitations.email\|tenant\|id` |
| `email_hash` | Huella `searchHash('email', tenant, correo normalizado)`: sirve para saber si ya hay una invitación para ese correo |
| `email_binding` | sha256(`token_sha256` + `\|` + correo normalizado). Permite que **la base, sola**, compruebe el correo de quien acepta |
| `role` | Solo `admin`, `approver`, `sales` o `viewer`: **nunca `owner`** |
| `token_sha256 unique` | Huella del código secreto del enlace. El código nunca se guarda |
| `status` | `pending`, `accepted` o `revoked`. «Vencida» es `pending` con `expires_at` pasado |
| `expires_at` | Creación más `app.invitation_ttl_days()` (supuesto: 7 días) |
| `invited_by`, `created_at` | Quién invitó y cuándo |
| `send_count`, `last_sent_at` | Reenvíos |
| `revoked_at`, `revoked_by`, `revoke_reason` (`cancelled`, `inviter_removed`) | Cancelación |
| `accepted_at`, `accepted_by`, `member_id` | Aceptación. `member_id` es una relación compuesta con `members` |

**Reglas de la tabla**

- `unique (tenant_id, id)`.
- `unique (tenant_id, email_hash) where status = 'pending'`: una sola invitación pendiente por correo y
  organización, aunque dos administradores inviten al mismo tiempo.
- Restricciones de forma: «aceptada» exige fecha y autor; «cancelada» exige fecha de cancelación.
- Índices que empiezan por `tenant_id`.
- Disparadores: `forbid_tenant_change`, `set_row_meta` y auditoría `keys_only` (solo nombres de campos,
  nunca el correo).
- **Al aceptar se vacían `email_enc`, `email_hash` y `email_binding`**: el correo ya vive en la cuenta.
  Queda quién invitó, con qué rol, cuándo y quién aceptó.

**RLS (reglas de la base que filtran cada fila)**

- Leer: solo con `tenant_id = current_tenant_id()` y `app.can('members.manage')`.
- La lectura es por columnas: **nadie, ni el Administrador, lee `token_sha256`, `email_binding` ni
  `email_hash`.**
- Sin permisos para crear, editar ni borrar directo.

### Funciones de la base

Todas corren con permisos elevados, con `search_path = ''` fijo, y sacan la organización de
`current_tenant_id()`, nunca de un parámetro.

- **`create_invitation`.** Recibe el id, el correo cifrado, la huella, el vínculo, la huella del código, el
  rol y el id del correo. Revisa en orden: el permiso; que el rol no sea `owner`; los topes (contados dentro
  de la misma transacción con un candado por organización); que no sea ya miembro activo (calcula el sha256
  del código con el correo de cada miembro activo, sacado de `auth.users`, y lo compara con el vínculo).
  Luego crea la invitación y su fila en `email_messages` con un tipo nuevo, `invitation` (hay que ampliar las
  restricciones de tipo y de forma de esa tabla).
- **`resend_invitation`.** Genera un código nuevo (el enlace anterior deja de servir), extiende la vigencia y
  respeta el intervalo mínimo entre reenvíos.
- **`revoke_invitation`.**
- **`invitation_preview(p_token_sha256)`**, con sesión: devuelve organización, quién invita, rol, estado y si
  el correo coincide.
- **`accept_invitation(p_token_sha256)`**, con sesión (ver más abajo).
- Para cerrar el envío del correo se copia el patrón de `internal_notice_settle`.

### Topes (supuestos, como constantes con nombre)

- 20 invitaciones por persona por hora.
- 50 por organización por día.
- 50 pendientes por organización.
- 5 reenvíos por invitación, con al menos 10 minutos entre uno y otro.
- Aceptaciones fallidas: alcance nuevo `invite_accept_user` en `auth_rate_limits`, 10 en 10 minutos.

Motivo: cada invitación es un correo que sale con nuestro dominio. Sin topes, una cuenta falsa podría
usarnos para mandar basura y dañar la reputación del dominio.

### Flujo de H-008 (en este orden, para no revelar si un correo tiene cuenta)

1. ¿Es miembro de la organización? Si no, «No encontrado».
2. ¿Tiene permiso de equipo? Si no, «No tienes permiso para esto».
3. Validar correo y rol (zod).
4. Revisar los topes.
5. ¿Es miembro activo de **esta** organización? «Esa persona ya es parte de tu equipo» (no revela nada
   nuevo: el Administrador ya ve la lista).
6. ¿Ya tiene una invitación pendiente? Se ofrece reenviarla.
7. Crear y enviar.

El mensaje final y el correo son **idénticos tenga o no cuenta** en Cotiza Prime: nunca se consulta un
correo fuera de los miembros de esta organización.

**El correo** lo envía Cotiza Prime (no la marca de la organización): quién invita, a qué organización, con
qué rol, la frase que explica ese rol y la fecha de vencimiento (`dd-mm-aaaa`). El nombre de la organización
va escapado (texto, nunca código). Si el envío falla, la invitación aparece como «pendiente, no enviada» con
el botón reenviar.

### Flujo de H-009

- **Entrada `/invitacion/[token]`**, fuera de `/o/`: valida el formato y el límite de intentos, guarda el
  código en una cookie `HttpOnly`, `Secure`, `SameSite=Lax` de una hora y redirige a `/invitacion`. Así el
  código sale de la barra de direcciones y del historial. Con `Cache-Control: no-store`.
- **Sin sesión:** «Te invitaron a una organización de Cotiza Prime. Ingresa o crea tu cuenta con el correo
  al que llegó la invitación», con los dos botones. Nunca dice si el correo tiene cuenta ni muestra el nombre
  de la organización. No hace falta ninguna función abierta a personas sin sesión (línea de la decisión 017).
- **Después de ingresar o registrarse** (con el correo verificado), `/auth/callback` y el ingreso leen la
  cookie y vuelven a `/invitacion`. Si la persona verificó el correo en otro dispositivo, no está la cookie:
  el inicio sin organizaciones dice «¿Te invitaron? Abre de nuevo el enlace del correo».
- **Con sesión:** «Ana te invitó a Negocio 1 como Comercial. [Unirme]». Unirse exige un clic.
- **`accept_invitation` revisa en la base, en este orden:** que haya sesión; que el correo de la cuenta esté
  verificado (`auth.users.email_confirmed_at`); busca la invitación por la huella del código y la bloquea; si
  no existe, «no es válida»; si está cancelada, vencida, usada o la organización está archivada, un mensaje
  claro que dice a quién pedir otra; revisa el correo (sha256(huella del código + correo normalizado de la
  cuenta) debe ser igual al vínculo; si no, «Esta invitación es para otro correo»); si ya es miembro activo,
  la marca aceptada **sin tocar su rol**; si fue miembro y lo quitaron, reactiva su fila con el rol de la
  invitación; si no, crea la membresía. **El rol sale siempre de la invitación, nunca de la petición.**
- La normalización del correo es igual en TypeScript (`src/lib/normalize/email.ts`) y en SQL
  (`app.normalize_email`: quitar espacios, NFC, minúsculas), con prueba de paridad.

**Plazos de conservación:** las invitaciones no aceptadas se borran 30 días después de vencer o cancelarse,
junto con su fila de `email_messages` (tarea programada, como la de las solicitudes). Hay que ampliar la
excepción de borrado por plazo de `app.email_messages_guard`.

---

## 3. La matriz de permisos en un solo lugar

**En el código**

- `src/lib/permissions/matrix.ts` (solo datos): las acciones, cada una con `{ any: roles, own?: roles }`
  («own» = solo si el recurso es suyo); `can(role, action, { isOwn })`; las etiquetas de cada rol y la frase
  que lo explica (criterio 2 de H-008); `ASSIGNABLE_ROLES`.
- `src/lib/permissions/require.ts` (solo servidor): `requirePermission(active, action, ctx)` para las
  acciones, con un único mensaje, «No tienes permiso para esto.»; `pagePermission(active, action)` para las
  pantallas, que se llama **antes de leer cualquier dato**.
- `src/components/permissions/no-permission.tsx`: la pantalla de «No tienes permiso».
- Las pantallas calculan en el servidor qué botones corresponden y se los pasan resueltos. El menú filtra
  `NAV_ITEMS` según el permiso de cada destino.

**En la base (migración `role_matrix`)**

- `app.role_can(p_role, p_action)`: una tabla fija; una acción desconocida da «no».
- `app.effective_role()`: hoy devuelve el rol tal cual; con H-004 suma la regla de los dos pasos.
- `app.can(p_action)`: combina las dos anteriores.
- `app.has_role` pasa a usar `effective_role()`: las más de 40 funciones existentes heredan cualquier cambio
  sin reescribirlas.
- Las políticas simples pasan a `app.can(...)`: `catalog_items`, `customers`, `tenants_update`,
  `audit_select` y marca.
- Lo de «suyo» (ser el autor, tenerla asignada) sigue dentro de cada función, como hoy.

**Para que no vuelva a dispersarse**

- **Prueba de paridad** (`tests/db/permissions-parity.test.ts`): para cada acción y rol, la respuesta de
  TypeScript y la de la base coinciden.
- **Guardia de código:** falla si aparecen nombres de rol (`"owner"`, `"admin"`, `"approver"`, `"sales"`,
  `"viewer"`) fuera de `src/lib/permissions/`; y toda acción de servidor exportada debe llamar a
  `requirePermission(`. Se amplía `src/lib/tenant/guard-coverage.test.ts`.
- **Guardia de la base** (`tests/db/schema-guards.test.ts`): lista congelada de las funciones que todavía
  usan `has_role(` directo; solo puede achicarse.

### La matriz

| Acción | Dueño | Admin | Aprobador | Comercial | Observador |
|---|---|---|---|---|---|
| Ver todo de la organización | sí | sí | sí | sí | sí |
| Crear cotización | sí | sí | – | sí | – |
| Editar y enviar cotización | suyas | suyas | – | suyas | – |
| Reenviar y revocar enlace | todas | todas | – | suyas | – |
| Pedir aprobación (sprint 6) | suyas | suyas | – | suyas | – |
| Aprobar (sprint 6) | sí | sí | sí | – | – |
| Pedir segundo pago (sprint 7) | todas | todas | – | suyas | – |
| Confirmar pagos y datos bancarios | sí | sí | – | – | – |
| Crear y editar clientes | sí | sí | – | sí | – |
| Catálogo y cambiar precios bloqueados | sí | sí | – | – | – |
| Configuración (empresa, marca, numeración, plantillas, textos, reglas) | sí | sí | – | – | – |
| Equipo (invitar, cambiar rol, quitar) | sí | sí | – | – | – |
| Formularios; asignar y anonimizar solicitudes | sí | sí | – | – | – |
| Descartar, restaurar y convertir solicitudes | todas | todas | – | descartar y restaurar: las asignadas a él; convertir: las asignadas a él o sin asignar | – |
| Registro de actividad | sí | pregunta 13 | – | – | – |
| Plan, eliminar y transferir la organización | sí | – | – | – | – |

Las acciones de sprints futuros se declaran desde ya, aunque no tengan pantalla, para que H-040 y las
siguientes no inventen otra lista.

### Qué cambia en cada lugar existente

| Dónde | Hoy | Cambio |
|---|---|---|
| `cotizaciones/page.tsx`, `nueva/page.tsx` | `WRITER_ROLES` local; `nueva` dice «No encontrado» | Permiso de crear cotización; «No tienes permiso» |
| `cotizaciones/[quoteId]/page.tsx` | Listas a mano y `canRevokeLinks` | Editar, reenviar y revocar desde la matriz, sabiendo si es suya |
| `cotizaciones/[quoteId]/enviar/page.tsx` | Texto de bloqueo por rol | Revisa el permiso de envío antes de leer el paquete |
| `src/lib/quotes/actions.ts`, `quotes/send/actions.ts`, `quotes/link-rules.ts` | `QUOTE_WRITER_ROLES`, `WRITER_ROLES`, `RESEND_ROLES`, `AUTHOR_ROLES`, `MANAGER_ROLES` | `requirePermission` y la matriz |
| `clientes/*` (4 pantallas), `customers/actions.ts`, `service.ts` | Tres listas distintas; dos «No encontrado» | Una sola; «No tienes permiso» |
| `catalogo/*`, `catalog/actions.ts` | `owner`/`admin` a mano y `canManageCatalog` | Permiso de catálogo |
| `configuracion/*`, `tenant/actions.ts`, `brand/actions.ts`, `numbering/actions.ts` | `owner`/`admin` a mano; los demás ven formularios deshabilitados | Permiso de configuración; los demás según la pregunta 12; «Tu equipo» pasa de «Disponible pronto» a real |
| `configuracion/actividad`, `audit/queries.ts` | Solo el Dueño; «No encontrado» | Permiso de registro; «No tienes permiso» |
| `formularios/*`, `intake/builder-actions.ts`, `api/v1/.../qr/route.ts` | `canManageForms` y «No encontrado» | Permiso de formularios |
| `solicitudes/*`, `requests-model.ts`, `requests-queries.ts`, `convert-actions.ts`, `requests-actions.ts` | `requestPermissions` y `ASSIGNABLE_ROLES` propios; `requests-actions` no revisa nada | `requestPermissions` se reescribe sobre la matriz; `requests-actions` agrega `requirePermission` |
| `nav-items.ts`, `app-shell.tsx`, `audit/labels.ts` | Menú igual para todos; `ROLE_LABELS` en dos lugares | Permiso por destino; etiquetas desde la matriz |
| Rutas del PDF y del logo | Todo miembro | Sin cambio (ver todo) |

---

## 4. Quitar a alguien: pierde el acceso al instante

**Lo que ya existe, y se mantiene y se prueba**

- **La base:** cada consulta pasa por `current_tenant_id()`, que exige estado activo. Aunque el pase de
  sesión siga vigente (dura 15 minutos), desde la consulta siguiente la persona quitada ve cero filas y toda
  función le responde «prohibido».
- **La app:** consulta `members` en cada petición. No hay memoria entre peticiones (no existe `"use cache"`
  ni `unstable_cache` en `src/`; se agrega una guardia que lo prohíba). Las páginas van con `Cache-Control`
  privado.
- No se cierra su sesión completa: puede pertenecer a otras organizaciones.
- **Límite honesto:** la pantalla que ya tenía abierta sigue a la vista hasta su siguiente clic. Ese clic,
  una recarga o cualquier acción le muestra «No encontrado» (pregunta 11).
- Un cambio de rol funciona igual: aplica en la petición siguiente.

**Qué hace `remove_member`, en una sola transacción**

- Marca la fila como quitada y anota cuándo y quién.
- Cancela las invitaciones pendientes que esa persona había enviado (pregunta 8).
- Sus solicitudes asignadas quedan a la vista del Dueño y los Administradores como «sin responsable activo»,
  para reasignarlas. No se devuelven a «nueva»: la regla actual de estados de las solicitudes no lo permite.
- Sus borradores quedan en solo lectura, porque según la decisión 009 solo el autor edita (pregunta 9).
- Los avisos de respuesta del cliente ya van al Dueño y a los Administradores cuando el autor no está activo
  (migración 27).

**El nombre del autor sigue visible.** Se cambia `profiles_select` para leer `full_name` de cualquier
persona con una fila en `members` de la organización, activa o quitada. Solo esa columna. Así se cumple el
criterio sin copiar nombres en otras tablas.

**Ley 21.719:** que la cotización muestre a su autor es un registro legítimo de la organización. Si esa
persona pide suprimir su cuenta (H-109), su nombre pasa a «Ex miembro» y se conserva el identificador
interno. Hoy la cuenta no se puede borrar mientras tenga membresías. Aquí solo hay que no cerrarle el paso:
no copiar nombres ni correos en otras tablas.

---

## 5. Reglas de seguridad

**`change_member_role(miembro, rol_nuevo, rol_esperado)` y `remove_member(miembro, rol_esperado)` revisan:**

1. **Permiso** de equipo (y los dos pasos, después de H-004).
2. **Organización:** el miembro se busca dentro de la organización activa. Si es de otra, «No encontrado».
3. **Nadie toca al Dueño:** el rol nuevo nunca puede ser `owner`. El traspaso es otra historia (H-111).
4. **Nadie se cambia ni se quita a sí mismo.** Así un Administrador no puede ascenderse (pregunta 5).
5. **La organización nunca queda sin Dueño:** es único, no se puede quitar ni bajar de rol, y el índice
   único lo garantiza.
6. **Dos cambios al mismo tiempo:** se bloquean las filas del miembro objetivo **y** de quien actúa, siempre
   en el mismo orden, para que no se esperen mutuamente para siempre. Después se vuelve a comprobar que quien
   actúa sigue activo. El cambio solo se aplica si el rol sigue siendo el esperado; si no, «El rol cambió
   mientras lo editabas; recarga». Si dos administradores se quitan mutuamente a la vez, gana el primero.
7. **Auditoría:** el disparador existente ya guarda el rol anterior y el nuevo. Además se registran
   `member.role_changed`, `member.removed` e `invitation.created`, `resent`, `revoked` y `accepted`, sin el
   correo. Cada cambio avisa por correo al afectado y al Dueño (pregunta 4).
8. **`list_members()`:** devuelve nombre, rol y fecha de ingreso. El correo (sacado de `auth.users`) solo lo
   ve quien tiene permiso de equipo (pregunta 14).

**Dónde puede fallar y cómo se evita**

- **Filtración entre organizaciones:** todo sale de `current_tenant_id()` y queda en el registro de pruebas
  de aislamiento.
- **Subirse de rol:** nadie escribe directo en `members` ni en `invitations`.
- **Que otra persona use la invitación:** la base compara el correo con el vínculo guardado.
- **Doble envío:** índice único de pendientes, intervalo mínimo entre reenvíos y botón deshabilitado mientras
  envía.
- **El correo como dato personal:** va cifrado con su huella, nunca aparece en logs ni en la auditoría, y se
  borra al aceptar.
- **Revelar si un correo tiene cuenta:** los mensajes son idénticos en todos los casos.

### 5b. H-004: verificación en dos pasos

Supabase trae el registro del factor (`mfa.enroll`), el desafío (`challenge`), la verificación (`verify`) y
quitar el factor (`unenroll`). El pase de sesión lleva `aal`: «aal2» significa que la persona también ingresó
el segundo paso. **No trae códigos de respaldo.**

- **Activar, en `/cuenta/seguridad`:** QR y clave para escribirla a mano (la CSP ya permite imágenes
  `data:`). Se confirma con un código. Luego se muestran 10 códigos de respaldo una sola vez y hay que marcar
  «Los guardé».
- **Al ingresar:** en `src/lib/auth/session.ts` (el único archivo que valida el pase), si la cuenta tiene un
  factor y el pase es «aal1», se redirige a `/ingresar/codigo`.
- **Códigos de respaldo:** tabla `mfa_recovery_codes` (de la plataforma, no de una organización): `user_id`,
  `code_hash` y `used_at`. Nadie la lee desde la app; la usa solo el servidor, en
  `src/lib/security/mfa-recovery.ts`, una ruta que ya tiene permitida la llave maestra. Usar un código: con
  tope de intentos; se marca como usado y no sirve de nuevo; se borran los factores con la API de
  administración; queda en auditoría; se avisa por correo; y la persona debe activar un factor nuevo.
- **Desactivar:** exige un código válido. Hay que confirmar en la documentación vigente que Supabase pide
  «aal2» para quitar un factor. Queda en auditoría y se avisa.
- **Obligatoria para Dueño y Administrador:** si el pase no es «aal2», `app.effective_role()` los trata como
  Observador. Así, aunque la app se salte la pantalla, la base no les deja usar su rol. La app muestra «Activa
  la verificación en dos pasos para usar las funciones de tu rol». Aplica también a quien acaban de ascender
  a Administrador (pregunta 1).
- **Pruebas:** los códigos se generan con `node:crypto`, sin agregar dependencias. La fixture registra el
  factor de ana y de mixta para obtener pases «aal2».
- **Tamaño:** pasa de dos días; se parte en tres: H-004a (activar y pedir el código al ingresar), H-004b
  (códigos de respaldo y desactivar) y H-004c (obligatoria y ajuste de las pruebas).

### 5c. H-041: precios bloqueados y descuento máximo

- **En la base:** `catalog_items.price_locked` (parte en «no»); `tenants.sales_max_line_discount_bp` (tope de
  descuento en puntos base, 1000 = 10 %; vacío = sin tope, pregunta 16); `quote_items` copia `price_locked`
  al agregar la línea, igual que ya copia `catalog_unit_price_clp`.
- **Una sola función**, `app.quote_line_rules_check`, la llaman `save_quote_draft` y también
  `prepare_quote_send`, por si el rol cambió entre guardar y enviar. Para quien no puede cambiar precios
  bloqueados: una línea bloqueada (en la copia o en el catálogo actual) debe mantener
  `unit_price_clp = catalog_unit_price_clp`; descuento en porcentaje hasta el tope; descuento en pesos:
  `discount_clp × 10.000 ≤ gross_clp × tope`, todo con enteros y con el cálculo de la propia base. Si no
  cumple da el error `CP422` (`price_locked@n` o `discount_over_cap@n`), que se muestra junto a la línea.
- **Dueño y Administrador sí pueden cambiar un precio bloqueado.** Queda el evento
  `quote.locked_price_overridden` en la línea de tiempo y en la auditoría, solo cuando el precio cambia de
  verdad (no en cada guardado automático).
- **En pantalla:** candado y campo deshabilitado para el Comercial, y el máximo indicado junto al descuento.
  La misma regla va en `src/lib/quotes/line-rules.ts` para avisar antes de guardar, con prueba de paridad.
- **Agujeros por decidir:** el descuento global (pregunta 17) y las líneas libres con precio a mano
  (pregunta 18). H-042 se engancha en esta misma función.

---

## 6. Pruebas

**Unitarias**

- `src/lib/permissions/matrix.test.ts`: la tabla de §5.2 escrita a mano (cambiar la matriz obliga a cambiar
  la prueba a propósito); una acción desconocida da «no».
- El rol efectivo con «aal1» y con «aal2», el menú de cada rol y `requestPermissions`.
- Las reglas de línea de H-041, con los bordes (exactamente 10,00 %, montos impares).
- El código, la huella y el vínculo de la invitación, y la normalización del correo.
- Cada acción de servidor con un falso miembro de cada rol: los que no tienen permiso reciben el mensaje
  **y la base ni se consulta**.

**De base de datos**

- Paridad de permisos y de `normalize_email`.
- `role-matrix.test.ts`: con pases reales de los 5 roles, cada función y cada tabla. Lo permitido pasa, lo
  prohibido da 42501, y con la llave maestra se confirma que nada cambió.
- `invitations.test.ts`: los topes; dos invitaciones al mismo correo al mismo tiempo (queda una); invitar como
  Dueño; aceptar con otro correo, vencida, cancelada o con el código viejo tras un reenvío; dos aceptaciones
  simultáneas, y aceptar mientras otro cancela; una cuenta sin verificar; alguien que ya es miembro (su rol no
  cambia) y un ex miembro reactivado; el borrado por plazo.
- `members.test.ts`: tocar al Dueño, ascender a Dueño, cambiarse a sí mismo, un rol esperado desactualizado,
  quitarse mutuamente a la vez, las invitaciones del quitado canceladas y su nombre todavía visible.
- **H-004:** un Dueño con pase «aal1» no puede editar el catálogo ni invitar.
- **H-041:** saltarse el bloqueo llamando directo a `save_quote_draft` y a `prepare_quote_send`.
- El «deshacer» de cada migración (`test:db:rollbacks`).

**De aislamiento entre organizaciones**

- Registrar `invitations` (solo la leen Dueño y Admin) y `mfa_recovery_codes` (solo servidor), y las
  funciones nuevas en `RPC_CASES`. Las guardias G1, G3 y G4 ya lo exigen.
- Ana, apuntando a B, llama a cada función nueva con ids de B: «No encontrado» y B intacta.
- Mixta, en A, apunta a un miembro de B.
- `list_members` sin el canario de B (el texto marcado que delata una filtración).
- Ana usa el código de una invitación de B dirigida a otra persona.
- Ex, ya quitada, con su pase vigente: todo rechazado.
- El Administrador no puede leer las huellas ni el vínculo.

**De punta a punta (Playwright)**

- Sumar a la semilla y a la fixture un Aprobador y un Comercial activos en A (dante ya es Observador).
- `e2e/roles.spec.ts`, guiado por `tests/isolation/routes.ts`, con el permiso que pide cada ruta: cada rol ve
  la pantalla o «No tienes permiso», sin datos (sin el canario), y el menú que le corresponde.
- Un Comercial abre el borrador de Ana: lo ve en solo lectura, y si fuerza la acción con `page.route`, queda
  rechazada.
- El Observador recorre todo sin ver ningún botón para cambiar algo.
- Invitar → el correo llega a Mailpit → aceptar con una cuenta existente; registrarse desde la invitación;
  abrirla con otro correo; una invitación vencida.
- Quitar a alguien que tiene la sesión abierta en otra pestaña: su siguiente clic le muestra «No encontrado»,
  y la cotización sigue con su nombre.
- Pasar a alguien de Comercial a Observador: «Nueva cotización» desaparece al recargar.

---

## 7. Orden de construcción

Las migraciones las hace un solo agente, de a una y en orden, declarando el entorno (PRUEBAS). Sus fechas van
después de la última integrada (`20261007160000`), o después de la de H-092 si entra antes (no hay migración
nueva en H-092).

| Paso | Qué | Días | Migración |
|---|---|---|---|
| 1 | **H-011a, matriz única:** módulo, funciones de la base, «No tienes permiso», menú, cambio de los ~20 lugares y guardias | 2 | `role_matrix` |
| 2 | **H-008:** tabla, funciones, correo, «Tu equipo» con pendientes, reenviar y cancelar | 2 | `invitations` |
| 3 | **H-009:** `/invitacion`, cookie, ingreso, registro, retorno del correo y aceptar | 1,5 | `invitation_accept` |
| 4 | **H-010:** cambiar rol, quitar, nombre de los ex miembros | 1,5 | `member_management` |
| 5 | **H-011b:** semilla, fixture y pruebas por rol, más la revisión de Opus de H-011 (y de H-008 a H-010) | 1,5 | — |
| 6 | **H-004a:** activar y pedir el código al ingresar | 2 | — |
| 7 | **H-004b:** códigos de respaldo y desactivar | 1,5 | `mfa_recovery_codes` |
| 8 | **H-041:** bloqueo de precio y tope de descuento | 2 | `price_locks` |
| 9 | **H-004c:** obligatoria para Dueño y Admin; fixture y Playwright con «aal2» | 1,5 | `mfa_required_roles` |

Suman unos 16 días de trabajo, más que los 9 días que el plan de sprints estimaba para el sprint 5 completo
(que además incluye H-040, H-042 y H-048, no cubiertas aquí). **El sprint 5 es más grande de lo estimado**:
es algo a tener presente al confirmarlo.

**Qué puede ir en paralelo:** solo el paso 6 junto al 4, una vez integrada la migración del 4, porque no
comparten archivos. Lo demás va en serie. El paso 9 va solo y al final, porque cambia el pase de ana y de
mixta en todas las pruebas.

---

## 8. Decisiones para Aarón o José

Si nadie responde, se aplica el supuesto indicado.

1. Un Dueño o Administrador sin la verificación en dos pasos, ¿queda como Observador (ve todo, no cambia
   nada, ni siquiera cotiza) o solo pierde lo exclusivo de su rol? **Supuesto:** queda como Observador.
2. ¿La verificación también es obligatoria en el entorno de pruebas? **Supuesto:** sí (Aarón necesitará la
   aplicación de códigos en el teléfono para entrar como ana).
3. ¿Un Dueño o Administrador puede desactivarla? **Supuesto:** sí, pero queda como Observador hasta activarla
   de nuevo.
4. ¿Un Administrador puede invitar, cambiar y quitar a otros Administradores? **Supuesto:** sí (así lo dice
   H-008), con aviso al Dueño. La alternativa más segura es que solo el Dueño maneje a los Administradores.
5. ¿Alguien puede cambiarse el rol o quitarse a sí mismo? **Supuesto:** no. «Salir de la organización» sería
   otra historia.
6. Vigencia y topes de las invitaciones. **Supuesto:** 7 días; 20 por persona por hora; 50 por organización
   por día; 50 pendientes; 5 reenvíos.
7. Plazos de las invitaciones, que no están en `PROYECTO.md` §11.2. **Supuesto:** el correo se borra al
   aceptar; las no aceptadas se borran 30 días después de vencer o cancelarse.
8. Al quitar a alguien, o bajarlo de Administrador, ¿se cancelan las invitaciones que envió? **Supuesto:** sí.
9. Lo que deja quien se va. **Supuesto:** sus borradores quedan en solo lectura (se podrán duplicar con H-069)
   y sus solicitudes quedan para reasignar.
10. ¿Debe existir una forma de que alguien tome el borrador de quien se fue? **Supuesto:** no por ahora.
11. «Al instante»: ¿basta con que pierda el acceso en su siguiente clic? **Supuesto:** sí. Que la pantalla se
    vacíe sola exige avisos en vivo, que hoy están apagados.
12. ¿El Aprobador, el Comercial y el Observador ven «Configuración» en solo lectura, como hoy? **Supuesto:**
    no; solo el Dueño y los Administradores.
13. Registro de actividad: hoy la pantalla es solo del Dueño y la base deja leer también al Administrador.
    **Supuesto:** solo el Dueño en ambas, ajustando la base.
14. ¿Quién ve la lista del equipo? **Supuesto:** solo el Dueño y los Administradores, con los correos.
15. ¿Se parte H-004 en tres historias en `HISTORIAS.md`? **Supuesto:** sí.
16. H-041: ¿un solo tope de descuento para toda la organización, o uno por servicio, como anticipaba
    `modelo-datos.md`? **Supuesto:** uno por organización.
17. H-041: ¿el tope también limita el descuento global de la cotización? **Supuesto:** sí. Si no, el tope se
    salta poniendo el descuento abajo.
18. H-041: ¿el Comercial puede agregar líneas libres con precio a mano? Eso se salta el bloqueo.
    **Supuesto:** sí, porque `PROYECTO.md` §6.0 lo pide para negociar; la alternativa es una opción «los
    Comerciales solo cotizan desde el catálogo».
19. ¿Un Comercial puede editar cualquier cliente o solo los que creó? **Supuesto:** cualquiera, como hoy.
20. «No tienes permiso»: **supuesto**, un componente propio. La función `forbidden()` de Next 16 es
    experimental y exige activar `authInterrupts`.
21. Los correos reales de invitación dependen de la decisión 016 (proveedor y dominio), y el correo del
    invitado tiene que aparecer en la política de privacidad (pasa por el abogado). **Supuesto:** mientras
    tanto se usa Mailpit.

---

## Qué NO hacer

- No poner el rol ni la organización dentro del pase de sesión.
- No dar permiso de escribir directo en `members` ni en `invitations` «para simplificar».
- No usar la llave maestra para invitar, aceptar ni cambiar roles.
- No guardar el código de la invitación, no ponerlo en logs ni en el `emailRedirectTo` de Supabase.
- No decirle a nadie «ya tienes cuenta, ingresa».
- No aceptar el rol desde la petición.
- No apagar la verificación en dos pasos con una variable de entorno para que pasen las pruebas.
- No volver a copiar listas de roles en las pantallas.
- No responder «No encontrado» por falta de rol dentro de la propia organización, ni «Prohibido» a quien pide
  algo de otra.
- No reescribir las más de 40 funciones existentes solo para cambiar `has_role` por `can`: heredan el cambio
  a través del rol efectivo.
- No validar el precio bloqueado solo en la pantalla.
