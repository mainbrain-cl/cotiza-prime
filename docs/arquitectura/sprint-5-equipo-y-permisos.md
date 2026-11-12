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

> **Estado (2026-11-11): H-004a construida** (activar y pedir el código al ingresar, con la base también exigiendo el segundo
> paso). Lo que difiere de este diseño está en el «Registro de construcción — H-004a» al final de este documento: el corte
> vive en `getSessionState` (`session.ts`); la recuperación de contraseña con factor pide el código ANTES de elegir la nueva;
> un mismo código no sirve dos veces en 120 s; el límite propio es de 5 fallos por cuenta cada 15 min y 15 por día; el aviso
> por correo lo manda Supabase Auth; el enlace «Seguridad de tu cuenta» está abajo del menú flotante (y en «Más» en el
> teléfono), no dentro del menú «Principal». H-004b (códigos de respaldo y desactivar) y H-004c (obligatoria para Dueño y
> Administrador) siguen pendientes. Lo de abajo (códigos de respaldo, `effective_role`) es su diseño original.

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
- **Requisito para H-004c:** `active.role` debe ser el rol efectivo, o la app y la base discrepan (la app decide con el
  rol guardado en `members`; la base, con `app.effective_role()`). El editor del formulario ya tolera el `42501` del tope
  (`loadForm` deja `dailyCap = null` y `loadProtection` responde «prohibido»); el resto de las pantallas, no.
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
   H-008), con aviso al Dueño. *(Decisión de José, 2026-10-30: el aviso sale **al invitar**, ahora; construido en H-008. Los
   avisos de cambiar el rol y quitar llegan con H-010.)* La alternativa más segura es que solo el Dueño maneje a los Administradores.
   **Decisión por defecto aplicada por Aarón el 2026-11-05 (H-010):** solo el Dueño da o quita un rol que maneja el equipo
   (nombrar Administrador, bajar a un Administrador o quitarlo). Invitar como Administrador sigue abierto al Administrador,
   porque ya avisa al Dueño (H-008, sin cambios). Ver el registro de construcción de H-010.
5. ¿Alguien puede cambiarse el rol o quitarse a sí mismo? **Supuesto:** no. «Salir de la organización» sería
   otra historia.
6. Vigencia y topes de las invitaciones. **Supuesto:** 7 días; 20 por persona por hora; 50 por organización
   por día; 50 pendientes; 5 reenvíos. *(Decisión de José, 2026-10-30: el tope de 20 por hora se queda **por persona
   dentro de cada organización**; ver el registro de construcción de H-008.)*
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
    tanto se usa Mailpit. *(PENDIENTE antes de enviar correos reales: ver M3 en el registro de construcción de H-008.)*

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

---

## Registro de construcción — H-008 (2026-10-30)

Construida siguiendo este diseño (§2). Lo que se decidió donde el diseño no era exacto, y lo que se apartó de él:

- **Acción de la matriz:** el permiso de equipo se llama `team.manage` (así quedó en `matrix.ts` y en `app.role_can`).
- **Rol permitido sin escribir roles en las funciones:** `app.invitation_role` es un dominio (`admin`, `approver`, `sales`, `viewer`); las funciones lo usan al validar `p_role`, así la guardia 14 de `schema-guards` no crece. La columna `role` de `invitations` es de ese tipo.
- **`send_count`** cuenta los envíos en total (el primero más hasta 5 reenvíos, máximo 6).
- **Reenvío tras un correo que nunca salió:** el intervalo mínimo de 10 minutos no se exige si el último correo de la invitación falló o lleva más de 2 minutos «pendiente» (si no, un fallo del proveedor dejaría a la persona 10 minutos sin poder reintentar). El tope de 5 reenvíos sigue valiendo.
- **Topes por persona** cuentan solo dentro de la organización activa (como dice el diseño). Una persona con varias organizaciones tiene 20 por hora en cada una; ver riesgos del informe.
- **Cierre del envío** (`invitation_email_settle`): solo `service_role`, a través de `src/lib/team/gateway.ts` (una sola función, vigilada por la guardia estática 11). Invitar, reenviar y cancelar corren con el pase de la persona.
- **`email_messages`:** el correo registrado de una invitación solo lo leen quienes manejan el equipo (política de lectura actualizada); un reenvío agrega otra fila. Los correos de una invitación aceptada se borran 30 días después de aceptarse (el diseño dice «al aceptar»: H-009 puede borrarlos en el acto si prefiere).
- **Tarea de borrado:** `app.purge_invitations()`, `pg_cron` diario a las 03:40.
- **Solo invitaciones, sin lista de miembros:** la pantalla «Tu equipo» lista únicamente las invitaciones pendientes; la lista de miembros con su rol es de H-010.
- **Auditoría:** `invitation.created` (con el rol, que no es dato personal) e `invitation.updated` (solo nombres de campos) salen de un disparador propio de la tabla, `app.audit_invitation_change()`; `invitation.resent` e `invitation.revoked` son explícitos. Ninguno lleva el correo. **Ruido conocido:** cada reenvío y cada cancelación dejan además un `invitation.updated`. No se quitó porque habría que apagar la auditoría de los cambios de la tabla; H-009 deberá sumar su propio `invitation.accepted`.

### Cambios tras la revisión de H-008 (2026-10-30)

- **I1 · Aviso al Dueño al invitar (decisión de José; segunda revisión: opción A, «robusto, no de mejor esfuerzo»).** Cuando quien invita NO es el Dueño y el rol invitado puede manejar el equipo (hoy, Administrador), el Dueño recibe un correo de Cotiza Prime: quién invitó, a qué organización, con qué rol, la fecha (dd-mm-aaaa) y un botón a «Tu equipo». **Nunca lleva el correo del invitado.** Cómo queda garantizado (en producción, **solo cuando se resuelva la decisión #17**, cómo se programa la tarea de avisos; mientras tanto, solo el intento inmediato):
  - **Desde H-010 (segunda revisión, 2026-11-05) este caso ya no ocurre en invitaciones nuevas:** solo el Dueño invita o reenvía a un rol que maneja el equipo (`42501 owner_only`). El mecanismo se conserva para los avisos ya anotados y para los avisos futuros (ver «Correcciones de la segunda revisión» en H-010).
  - **Se anota al invitar, en la misma operación.** `create_invitation` deja `invitations.owner_notice_state = 'pending'` cuando corresponde (`app.invitation_notice_applies`, que decide con la matriz y no con nombres de rol: el rol invitado tiene `team.manage` y quien invita no tiene `tenant.transfer`). Así, aunque alguien llame la función de la base directo, sin pasar por la pantalla, el aviso queda anotado. Se eligió una columna en `invitations` (y no una fila de `email_messages` creada en `create_invitation`) porque la fila de correo necesita el correo del Dueño cifrado por el servidor, que la base no puede producir.
  - **Lo envía una tarea y la tarea reintenta.** `src/server/jobs/send-invitation-notices.ts` (se corre a mano con `npm run job:invitation-notices`, solo para uso local) envía los pendientes y reintenta los fallidos. Constantes de la base: **5 intentos como máximo** (`app.invitation_notice_max_attempts`), **10 minutos mínimos entre intentos** (`..._retry_minutes`) y **5 minutos** tras los que un intento que nunca se cerró (el servidor se cayó) se da por fallido (`..._stale_minutes`). Cada intento es una fila de `email_messages` (`invitation_notice`); el índice único deja una sola viva (pendiente o enviada), y un fallido no impide el reintento.
  - **Reservar es gastar un intento (tercera revisión).** Antes de enviar, `invitation_notices_pending` RESERVA el aviso: anota la hora y cuenta el intento, con `for update skip locked` (dos tareas a la vez no toman el mismo aviso; con `p_invitation_id` reserva solo uno, para el intento inmediato). Así un aviso que falla sin llegar a anotarse (no hay Dueño con correo, el servidor se cae, algo se rompe) igual gasta sus intentos y termina agotándose: nunca tapa la cola de las demás organizaciones. Cada reserva permite anotar exactamente un correo (`invitation_notice_register` no cuenta, solo comprueba que haya una reserva sin usar) y `invitation_notice_recipients` solo entrega destinatarios con una reserva. Sin un Dueño activo con correo, el aviso se da por agotado en el acto (`exhausted = 'no_recipient'`, queda en el log). La cola tiene su índice parcial (`invitations_notice_queue`).
  - **Intento inmediato.** Después de responder (con `after()`), la acción de invitar intenta enviarlo de una vez, para no hacer esperar a quien invita. La garantía es la tarea, no ese intento. Un fallo del aviso nunca deshace ni cambia el resultado de la invitación.
  - **Agotado = visible.** Un aviso que usa sus 5 intentos pasa a `owner_notice_state = 'exhausted'` y deja en el log `invitation_notice_exhausted` (solo el código `max_attempts`, sin datos personales). Nadie lo reintenta solo: quien opere la plataforma debe revisarlo (`select … from invitations where owner_notice_state = 'exhausted'`) y avisar al Dueño por otro medio.
  - **«Enviado» no es «recibido».** `owner_notice_state = 'sent'` solo significa que el proveedor aceptó el correo. Si el correo del Dueño rebota después, el estado sigue en `sent` (el rebote queda en `email_messages`, donde el Dueño es el único que lo puede leer).
  - **«Al menos una vez».** Si el servidor se cae justo después de enviar y antes de anotarlo, el intento se da por fallido y se reintenta: el Dueño podría recibir el aviso dos veces. Se prefiere eso a no avisar.
  - **Qué sigue pasando.** El destinatario sale SIEMPRE del Dueño activo de la organización de la invitación (nunca de un parámetro; otro Dueño u otro rol da `recipient_not_owner`). **Una invitación aceptada, o vencida sin aceptar, igual genera el aviso** (que un Administrador invitó a otro ya ocurrió; si no, un cómplice que acepte el enlace en segundos antes de que corra la tarea dejaría el aviso perdido para siempre); **una cancelada no**. Las funciones nuevas (`invitation_notices_pending`, `invitation_notice_recipients`, `invitation_notice_register`) las ejecuta solo `service_role` por `src/lib/team/gateway.ts`, y el cierre del envío sigue siendo `invitation_email_settle`. Los avances del aviso no ensucian la auditoría (no hay `invitation.updated` por ellos). Las filas `invitation_notice` de `email_messages` las lee solo quien puede transferir la organización (el Dueño): el Administrador, que es quien invitó, no ve si el aviso salió o falló; las filas `invitation` siguen visibles para quien maneja el equipo.
  - **Para H-009 (importante).** `accept_invitation` NO debe borrar las filas `invitation_notice` de `email_messages` al aceptar (si se borran en el acto los correos de la invitación, el aviso se reenviaría o se perdería) y debe dejar intacto `owner_notice_state` (y sus otras dos columnas `owner_notice_*`). Esas filas se borran 30 días después de aceptarse, con el resto, por `app.purge_invitations()`.
  - **PENDIENTE de operación, decisión propia (no verificado): cómo se programa la tarea de avisos en producción** (`docs/PROYECTO.md` §16.2 #17, antes del piloto; no está ligada a la decisión 016, que es proveedor y dominio de correo). El script (`scripts/send-invitation-notices.ts`, `npm run job:invitation-notices`) es **solo para uso local o manual**: usa `tsx` y `.env.local`, y termina con código distinto de 0 si la tarea no pudo correr. En Vercel las tareas programadas llaman a una dirección HTTP protegida por un secreto; esa ruta **no existe, a propósito**, y probablemente habrá que crearla. **Mientras tanto, en producción el aviso al Dueño es de mejor esfuerzo: solo funciona el intento inmediato.** Tampoco hay planificador en el repositorio (no hay `vercel.json`).
- **B1 (segunda revisión).** Un nombre de quien invita (o de la organización) de puros espacios o caracteres invisibles ya no silencia ni el aviso al Dueño ni la invitación: si el nombre queda vacío al limpiarlo, los dos correos usan el texto de respaldo (`src/lib/email/invitation-names.ts`, una sola constante por nombre) y la base entrega `nullif(btrim(full_name), '')`. Antes, el aviso quedaba `failed` sin reintento mientras la invitación sí salía.
- **Resto de la segunda revisión.** Si algo falla entre anotar y cerrar un intento del aviso, el registro se cierra igual como fallido. El aviso se envía con `after()` (quien invita ya no espera dos envíos en serie). El mensaje del tope de pendientes menciona también el reenvío. El lector de pantalla lee «Invitada» en las dos fechas. La guardia 11b también revisa el armador del aviso, los nombres y las tareas. Una prueba de base de datos contaba avisos de toda la base y fallaba si antes corría el e2e: ahora filtra por la organización de la prueba.
- **Aviso «sin conexión».** El formulario de invitar muestra el aviso de «sin conexión» (`OfflineNotice`) como los demás formularios.
- **Tercera revisión (2026-11-02).** B1: el aviso sale también si la invitación se aceptó (o venció) antes de enviarse; solo la cancelada no lo genera. I1: el intento se reserva (y se cuenta) antes de enviar, y sin Dueño con correo el aviso se agota en el acto con su código en el log. I2: el script termina con error si la tarea falla y queda documentado como solo local; la programación en producción es la decisión pendiente #17. M1: el Administrador ya no lee las filas `invitation_notice`. M2: los nombres se recortan por caracteres (un emoji no queda partido) y, si el asunto igual no cabe, con nombres más cortos: nunca se pierde el correo. M4: índice parcial para la cola. M5: «enviado» solo quiere decir que el proveedor aceptó el correo. M6: un rol desconocido deja el código `invalid_role`.
- **Cuarta revisión (2026-11-02).** I1: `invitation_notice_recipients` entrega también el estado de la invitación; para una **ya aceptada** el aviso dice «La persona ya aceptó y es Administrador de tu organización. Revisa tu equipo.», no promete cancelar y su botón («Abrir Cotiza Prime») lleva al inicio, porque «Tu equipo» solo lista las pendientes (la lista de miembros llega con H-010); para pendiente o vencida queda el texto de cancelar con el botón a «Tu equipo». M1: se eligió **repetir las condiciones como columnas en el `WHERE` del `update` de la reserva** (y no declarar `app.invitation_notice_ready` como `volatile`): la fila ya bloqueada se vuelve a mirar actualizada, de modo que dos reservas casi simultáneas no toman el mismo aviso; es explícito y no depende de cómo toma la foto cada función. M2: una reserva solo sirve si es reciente (menos de 5 minutos, `app.invitation_notice_stale_minutes`): una que nadie usó no queda de saldo. M3: cancelar una invitación saca su aviso de la cola (`owner_notice_state` pasa de `pending` a `none`; si el aviso ya salió, queda `sent`). M4: los textos que decían «robusto» o «la tarea lo reintenta» ahora dicen que en producción eso vale solo cuando se resuelva la decisión #17. M5: el recorte de nombres usa `Intl.Segmenter` (banderas y tonos de piel no se parten; una familia unida por caracteres invisibles se separa porque esos caracteres se limpian por seguridad). M6: la prueba de las funciones solo del servidor (`tests/isolation/rpc.test.ts`) ahora exige un rechazo por permiso (401 o 403, nunca «la función no existe»).
- **Quien ya tenga aplicada la migración antigua** (`20261030100000_invitations.sql`, editada en su lugar varias veces): `npx supabase migration up` NO recibe los cambios (misma versión). Hay que correr **`npx supabase db reset` y luego `npm run db:seed`**.
- **M1.** Reenviar una invitación **vencida** cuenta contra el tope de 50 pendientes, igual que invitar.
- **M4/M5.** La lista muestra «Invitada el dd-mm-aaaa»; la vigencia sale de `INVITATION_TTL_DAYS` y «Vencida» se decide con el booleano `expired`.
- **M7/M8.** Se quitaron `nextResendAt` e `invitationIdSchema` (no se usaban).

### Decisiones y excepciones anotadas (sin cambio de código)

- **M2 · Tope por hora (decisión de José, 2026-10-30).** Las 20 invitaciones por hora se quedan **por persona dentro de cada organización** (máximo real de 100 por hora con 5 organizaciones). El tope diario por organización (50) sigue limitando el daño. Revisable si hace falta.
- **M3 · PENDIENTE antes de enviar correos reales (decisión de José, 2026-10-30).** El nombre de la organización y el de quien invita salen en el correo de Cotiza Prime; alguien podría escribir una dirección web engañosa en ese nombre y los programas de correo la volverían enlace. **Aplica tanto al correo de la invitación como al aviso al Dueño**, que llevan los mismos nombres. No se corrige ahora: se resuelve antes de enviar correos reales (decisión 016, proveedor de correo), porque hoy todo sale a Mailpit.
- **M6 · Excepción conocida.** El valor de `email_hash` se copia a `email_messages.to_email_hash`, que puede leer quien maneja el equipo. Impacto nulo: ya ve el correo en claro y la huella usa una clave que solo tiene el servidor.
- **La página `/invitacion/...` todavía no existe (es H-009).** Hoy el botón del correo lleva a «No encontrado». No es un error: quien pruebe H-008 debe esperarlo.

---

## Registro de construcción — H-009 (2026-11-02)

Construida siguiendo este diseño (§2, «Flujo de H-009», y §5). Migración `20261103100000_invitation_accept.sql` (deshacer en `supabase/rollbacks/`).

### Qué se construyó

- **Base de datos.** `invitation_preview(p_token_sha256)` y `accept_invitation(p_token_sha256)`: con sesión, `security definer`, `search_path = ''`, EXECUTE solo `authenticated` (decisión 017). Tienen **un solo argumento**: no hay manera de mandar un rol ni una organización. `accept_invitation` revisa, en este orden: sesión (42501) · forma de la huella (CP422) · correo de la cuenta verificado (`auth.users.email_confirmed_at`) · persona no bloqueada · busca la invitación por la huella del código y **la bloquea** · estado · correo contra `email_binding` · membresía · aceptada con los tres campos de correo vaciados. Ya miembro activo: se marca aceptada sin tocar su rol; quitado antes: se reactiva su misma fila con el rol de la invitación; si no, se crea. El rol sale siempre de la invitación. Auditoría `invitation.accepted` (rol, `already_member`, `reactivated`; nunca el correo ni el código).
- **Reglas heredadas de H-008, cumplidas y probadas.** No toca las filas `invitation_notice` de `email_messages` ni `owner_notice_*` (una prueba compara los dos antes y después de aceptar, y comprueba que la tarea todavía puede reservar el aviso de una invitación ya aceptada y que sale con `invitation_status = 'accepted'`); los correos de una invitación aceptada se borran a los 30 días de aceptarse (prueba con `app.purge_invitations()` a los 29 y a los 31 días); no usa la llave maestra (corre con el pase de la persona); el vínculo se calcula sin claves secretas y su comparación vive en la base.
- **Aplicación.** `/invitacion/[token]` (ruta, fuera de `/o/`): valida el formato, aplica el límite de aperturas por IP, guarda el código en la cookie `cp_invitation` (`HttpOnly`, `Secure` en producción, `SameSite=Lax`, 1 hora, `path=/`) y responde 303 a `/invitacion` con `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer` y `X-Robots-Tag: noindex`. La ruta **no consulta la base**. `/invitacion` (pantalla): sin sesión, solo «ingresa o crea tu cuenta» (no consulta nada, no nombra la organización ni dice si el correo tiene cuenta); con sesión, la vista previa («Ana te invitó a Negocio 1 como Comercial.» + la frase del rol + vigencia) y «Unirme». Acciones `acceptInvitationAction` y `leaveInvitationAction` (`src/lib/team/accept-actions.ts`). Al aceptar se borra la cookie, se refresca el selector y se entra a la organización. El ingreso (`signInAction`), `/auth/callback` y el inicio sin organizaciones vuelven a `/invitacion` si hay cookie. El inicio/«Crea tu primera organización» muestra «¿Te invitaron? Abre de nuevo el enlace del correo de la invitación.» para quien verificó en otro dispositivo.
- **Archivos nuevos:** `src/lib/team/accept-model.ts` (resultados, mensajes, cookie, esquemas zod), `accept-service.ts`, `accept-actions.ts`, `invitation-cookie.ts`; `src/app/invitacion/` (`page.tsx`, `loading.tsx`, `error.tsx`, `[token]/route.ts`); `src/components/team/accept-invitation-form.tsx`. Tocados: `src/lib/auth/actions.ts`, `src/app/auth/callback/route.ts`, `src/app/page.tsx`, `src/app/organizaciones/nueva/page.tsx`, `src/lib/security/login-rate-limit.ts` (alcance `invite_link_ip`), `next.config.ts` (cabeceras de `/invitacion/:path*`), `tests/isolation/registry.ts` y `rpc.test.ts`, `src/lib/tenant/guard-coverage.test.ts`.

### Desviaciones del diseño (con motivo)

1. **Los fallos esperados se devuelven, no se lanzan.** El diseño no lo decía; es obligatorio para el límite de intentos: un error deshace la transacción y con ella el conteo. Solo se lanza error sin sesión (42501) y con un argumento sin forma de huella (CP422). Los resultados: `accepted`, `unverified`, `rate_limited`, `not_found`, `wrong_email`, `revoked`, `expired`, `used`, `archived`.
2. **El límite de aceptaciones fallidas lo cuenta la propia base** (`invite_accept_user`, clave = huella del id de la cuenta, 10 en 10 minutos, bloqueo de 10), no el servidor con la llave maestra: así vale también si alguien llama la función directo y no hace falta darle la llave maestra a la aceptación. Cuentan `not_found` y `wrong_email` (las dos formas de probar códigos), también en la vista previa *(desde la corrección I1, 2026-11-05, la vista previa ya no cuenta: solo «Unirme» cuenta)*; cancelada, vencida o usada no cuentan *(desde la misma corrección, eso vale para la persona invitada: a una cuenta ajena se le contesta `wrong_email` en cualquier estado y su intento de aceptar sí cuenta)*. Efecto sobre las pruebas de aislamiento: la prueba A13 ya no compara la tabla `auth_rate_limits` (sube a propósito) y las pruebas de H-009 reparten sus llamadas entre personas para no agotar el cupo de Ana.
3. **La vista previa no entrega organización, quién invitó ni rol si el correo no coincide** (el diseño decía «devuelve organización, quién invita, rol, estado y si el correo coincide»). Quien tiene el enlace de otra persona no aprende nada de la organización. Con la invitación cancelada, vencida o usada tampoco. *(Desde la corrección I1, 2026-11-05, tampoco aprende el estado: recibe `wrong_email` sea cual sea; ver M-2.)*
4. **Quien invitó tiene que seguir pudiendo manejar el equipo** (miembro activo con `team.manage`); si no, el resultado es `revoked`. Cubre el tiempo entre «H-008 existe» y «H-010 cancela las invitaciones de quien se va o baja de rol», que ya no tiene huecos: sin esto, una invitación pendiente de un Administrador quitado seguía sumando gente. H-010 igual debe cancelarlas (supuesto 8).
5. **Repetir el clic no falla:** si la misma persona ya aceptó y sigue siendo miembro activa, el resultado es `accepted` (sin duplicar nada ni volver a auditar). Si la quitaron después, el código da `used`.
6. **El código viaja en la cookie tal cual** (no su huella). Es el mismo secreto que el enlace del correo; guardar la huella no habría quitado ningún riesgo (con la huella también se acepta).
7. **Alcance `invite_link_ip`** (30 aperturas del enlace por minuto por IP, bloqueo de 1 minuto, con huellas de la IP agrupada) para la ruta del enlace; se suma a `invite_accept_user` en la misma restricción de `auth_rate_limits`.
8. **Un hallazgo de las pruebas de punta a punta, corregido:** el estado inicial de «Unirme» estaba exportado desde un archivo `"use server"` (Next solo admite funciones ahí y rompe la pantalla al abrirla; las pruebas unitarias no lo ven). Ahora vive en `accept-model.ts` y una prueba vigila que el archivo de acciones solo exporte funciones. También: los botones de la vista sin sesión se achicaban a 21 px en teléfono (`flex-1` en columna); ahora `sm:flex-1`.

### Límites y lo que no se verificó

- **Tras aceptar, nadie ve al nuevo miembro en «Tu equipo»** hasta que **H-010** agregue la lista de miembros (la pantalla sigue listando solo invitaciones pendientes; la persona sí queda en la base, en su selector y dentro de la organización). Anotado, no construido.
- **El código aparece una vez en la dirección** (`/invitacion/[código]`) antes de la redirección: queda en los registros de acceso de la plataforma de despliegue y en el historial del correo. Es el costo de que el enlace sea un clic; lo que se logró es sacarlo de la barra de direcciones, del historial del navegador y de lo que se comparte al copiar la dirección. No se verificó cómo se comportan Vercel ni el futuro proveedor de correo (decisión 016): hay que revisar que no registren la dirección completa y que no reescriban el enlace (rastreo de clics).
- Un antivirus o vista previa que abra el enlace solo deja una cookie en su propio navegador: no acepta ni cambia nada (aceptar exige sesión y un clic).
- La cuenta compartida es un riesgo conocido: quien tenga acceso al correo de la persona invitada puede aceptar. Es inherente a invitar por correo.
- No se probaron navegadores distintos de Chromium ni lectores de pantalla reales. El contraste y los tamaños siguen los tokens de `docs/DISENO.md`; 375 px y áreas táctiles de 44 px sí tienen prueba.
- Verificación en dos pasos (H-004c): `app.invitation_state` decide con `app.role_can(...)` (rol guardado) y no con `app.effective_role()`; si H-004c cambia el criterio de quién puede invitar, hay que revisarlo ahí.
- La tarea de avisos en producción sigue pendiente (decisión #17, ver H-008).

### Requisito de salida a producción y de piloto (revisión de H-009, ronda 1)

**H-009 exige en el proyecto de producción: Confirm email ON, Secure email change ON y sin proveedores externos (OAuth) ni ingreso anónimo, salvo decisión registrada.** La garantía «solo puede aceptarse con el mismo correo al que se envió» descansa en que `auth.users.email_confirmed_at` signifique que la persona es dueña de ese correo. Eso hoy solo está escrito en `supabase/config.toml` (líneas 228-230: `enable_confirmations`, `double_confirm_changes`), es decir, en la base local; el proyecto de producción de Supabase se configura aparte y hay que comprobarlo a mano antes de invitar a alguien real. Sin «Confirm email», cualquiera podría registrar una cuenta con el correo de otra persona y aceptar su invitación; sin «Secure email change», una cuenta podría cambiar su correo al de la invitación sin confirmar los dos lados. También está anotado en la migración (junto a la comprobación de `email_confirmed_at`) y en el `README.md` (sección «Despliegue: cuentas y correo verificado»).

### Cambios tras la revisión de H-009, ronda 1 (2026-11-02)

La migración `20261103100000_invitation_accept.sql` se editó en su lugar (aún no estaba en `main`) y su deshacer quedó al día.

- **D1 · `inviter_inactive`.** Un resultado propio cuando quien invitó ya no está en la organización o ya no maneja el equipo, y también para una invitación cancelada con `revoke_reason = 'inviter_removed'` (la que H-010 dejará). Texto: «…Pide a otra persona de la organización que te invite de nuevo.». «Cancelada» (`revoked`) queda solo para las canceladas a mano. Es definitivo (no sirve volver a intentar), pero la cookie NO se borra al fallar «Unirme»: solo «Entendido» la borra (ver la desviación 2 de más abajo).
- **D2 · `invitation.accept_denied`.** *(Corregido el 2026-11-09: si la persona NO es ni fue de esa organización, la fila va sin autor; ver «Corrección: el intento de alguien de fuera queda sin autor», al final.)* Quien prueba un código REAL con otro correo deja un registro `denied` en la auditoría de la organización de la invitación (`{reason: 'wrong_email', step: 'accept' | 'preview'}`), sin el correo ni el código; se escribía tanto al aceptar como al ver la vista previa, pero **desde la corrección I1 (`20261105100000`) solo se escribe al aceptar**: la vista previa ya no escribe nada. No se registra para `not_found` (no hay organización) ni cuando la cuenta ya está bloqueada. Por qué no inunda la auditoría: se escribe junto al conteo de fallos, así que no puede pasar de 10 cada 10 minutos por cuenta; para llegar ahí hay que conocer un código real; y repartir los intentos entre cuentas exige crearlas: el tope por IP del REGISTRO es de la aplicación (`signUpAction`); quien se registra llamando directo a `/auth/v1/signup` solo choca con el tope de Supabase y con la confirmación del correo, que es el freno real.
- **M2 · solo lectura.** Las dos funciones se niegan (25006, `read_only`) en una transacción de solo lectura, que es como PostgREST ejecuta un GET: ahí no se podría contar un fallo. Probado con una transacción de solo lectura en la base y con un GET real (405 / `25006`, sin ningún `result`).
- **M3.** La vista previa de quien ya es miembro activo trae `already_member` y `current_role`; la pantalla dice «Ya eres parte de X como <rol actual>. Esta invitación no cambia tu rol.», no describe el rol de la invitación y el botón dice «Entrar».
- **M4.** `rate_limited` y `unverified` ofrecen «Intentar de nuevo» y no borran el código.
- **M5.** `acceptLegalAction` vuelve a `/invitacion` si hay una invitación esperando.
- **M6.** La ruta del enlace, al bloquear por tope de aperturas, borra también la cookie anterior.
- **M7.** Etiquetas `invitation.accepted` y `invitation.accept_denied` en el registro de actividad (y elegibles en su filtro).
- **M9.** La prueba A13 compara `auth_rate_limits` salvo el alcance `invite_accept_user` y solo lo de las últimas 23 horas; llama a `accept_invitation` / `invitation_preview` con Dante (no con Ana), y la prueba de H-009 gasta 2 de los 10 intentos de Ana (antes 8).
- **M10.** La guardia 11b (`serverLog` sin datos de personas) revisa también `src/app/invitacion/`.
- **M11.** «Falta tu invitación» ofrece un botón grande («Ir a mi cuenta» con sesión, «Ingresar» sin ella); cuando «Unirme» falla porque el código ya no sirve queda una sola salida («Entendido»).
- **M12.** La fila `members` de `modelo-datos.md` nombra `accept_invitation` como función que escribe en `members`.
- **Aviso en las pruebas de aislamiento:** el registro de `invitation.accept_denied` en la organización B es a propósito; la prueba de H-009 lo excluye de la huella de B y comprueba aparte que existe y qué contiene. *(Desde la corrección del 2026-11-09, al final de este documento, el intento de alguien de fuera va sin autor y la prueba lo cuenta por invitación, no por persona.)*

### Cambios tras la revisión de H-009, ronda 2 (2026-11-02)

- **I-1 · el tope valía menos con peticiones simultáneas.** La pregunta «¿está bloqueada?» solo ve lo ya confirmado: 30 peticiones a la vez con la misma cuenta y un código real veían «no bloqueada», las 30 sumaban un fallo y escribían una fila de `invitation.accept_denied`. `invitation_preview` y `accept_invitation` toman ahora un candado por cuenta (`pg_advisory_xact_lock(hashtextextended('invite_accept_user|' || id, 0))`) justo después de la guarda de solo lectura: las llamadas de una misma cuenta pasan en fila y la segunda ya ve el fallo de la primera. Probado con cuatro conexiones reales: con la cuenta en 9 fallos queda UN registro y las otras tres reciben `rate_limited`. El costo es que dos pestañas de la misma persona se esperan unos milisegundos.
- **Desviación 2 de la ronda 1, con su consecuencia.** Cuando «Unirme» falla porque el código ya no sirve, la acción no borra la cookie (borrarla vuelve a dibujar la pantalla como «Falta tu invitación» y se pierde el motivo); la borra «Entendido». **Consecuencia:** si la persona no pulsa «Entendido», el código muerto puede reaparecer al ingresar durante hasta una hora, mostrando otra vez el motivo.
- **M-3 · cierre de sesión.** `signOutAction` borra ahora la cookie `cp_invitation` (en un computador compartido, quien ingresara después caía en la invitación de otra persona: no podía aceptar, pero sumaba un fallo a su cuenta y dejaba su IP en la auditoría de esa organización). Solo `signOutKeepingInvitationAction`, el botón «Cerrar sesión e ingresar con otro correo» de la propia invitación, la conserva.
- **M-4 y M-5 (pruebas).** El corte de 23 horas de A13 se calcula una sola vez; la prueba de la auditoría cubre ahora cancelada, vencida, usada e `inviter_inactive` con una cuenta equivocada (0 registros y 0 fallos) y que lo ve solo el Dueño de la organización (el registro de actividad es suyo: ni el Administrador, el Comercial, el Observador ni otra organización); el aislamiento cuenta los `accept_denied` esperados (Mixta +1 en B, Ex +1 en B, Carla bloqueada +0; *desde la corrección del 2026-11-09 se cuentan por invitación: Mixta +1 en B con su id, Ex +1 en B sin autor*); el desbloqueo del e2e filtra por la huella de ESA cuenta.

### Límites conocidos (anotados, sin cambiar código)

- **M-1 · (resuelto por la corrección I1, 2026-11-05) la vista previa ya no escribe ni cuenta fallos.** Antes, al cargar `/invitacion` con un correo que no coincidía, la vista previa dejaba un `invitation.accept_denied` en la auditoría de la organización de la invitación (identificador de la cuenta, IP y navegador), y además contaba fallos. Ya no es cierto: ver la pantalla no escribe nada. Ver «Corrección I1» más abajo, incluido el costo (ver la pantalla de correo equivocado ya no deja registro).
- **M-2 · (resuelto por la corrección I1, 2026-11-05; queda un resto menor) algunos estados se respondían antes de comparar el correo.** Antes, quien tenía el enlace sin ser la persona invitada se enteraba de si la invitación seguía pendiente, se había usado, la habían cancelado, había vencido, la organización estaba archivada o quien invitó ya no podía invitar; y con la vista previa de solo lectura lo podía preguntar sin límite y sin rastro. Ahora `app.invitation_state` compara primero quién pregunta y a cualquier otra cuenta le contesta `wrong_email` en todos los estados (ver «Corrección I1», punto «La vista previa no cuenta el estado»). **Resto (límite conocido, no se corrige ahora):** `not_found` sigue distinguiéndose de `wrong_email`. Sin la fila no se sabe quién es la persona invitada, y juntarlos le diría «cambia de cuenta» a la invitada que abre un enlace viejo. **No es un solo bit:** quien guarda un enlace ajeno y lo consulta una vez al día ve no solo SI el código dejó de existir, sino CUÁNDO pasó de `wrong_email` a `not_found`, y eso cuenta qué le ocurrió a la invitación:
  - **en el momento, sin esperar 30 días:** se reenvió (`resend_invitation` cambia `token_sha256` y el código viejo deja de existir al instante);
  - **en `expires_at` + 30 días, cerca de la hora de la limpieza diaria:** venció sin usarse (`app.purge_invitations` borra las pendientes 30 días después de vencer);
  - **otro día cualquiera:** la cancelaron 30 días antes (se borra 30 días después de `revoked_at`);
  - **nunca:** se aceptó, porque `app.purge_invitations` no borra las aceptadas.

  Solo lo ve quien ya tenía un código real, y no le dice nada de la organización ni de la persona invitada. **Arreglo posible a futuro (no hecho):** a los 30 días de aceptada, cambiar el `token_sha256` de la invitación por un valor al azar, para que también la aceptada pase a `not_found` y su fecha se confunda con la de una vencida o cancelada.
- **M-7 · textos opcionales, no se hacen ahora.** Una invitación cancelada a mano o vencida dice «pide a quien te invitó» aunque esa persona ya no pueda invitar; y en «Ya eres parte de esta organización» la salida dice «Seguir sin unirme».

### Corrección I1 de la revisión adversarial (2026-11-05)

**El hallazgo, en una frase.** Abrir `/invitacion` (una simple visita) escribía en la base —contaba fallos por cuenta y dejaba `invitation.accept_denied` en la auditoría—, y como la cookie de sesión es `SameSite=Lax`, una página ajena podía mandar a cualquier persona con sesión abierta a `/invitacion/<código>` y así (a) dejar en la auditoría de otra organización el identificador y la IP de la víctima (rastreo) o (b) con 11 códigos inventados dejarla bloqueada 10 minutos sin poder aceptar su invitación legítima (bloqueo).

**Qué cambió.**

- **La vista previa es de solo lectura.** Migración `20261105100000_invitation_preview_read_only.sql` (con su deshacer): `public.invitation_preview` ya no cuenta fallos, no escribe auditoría, no toma el candado por cuenta y no toca ninguna tabla. Sí **lee** el tope de la cuenta, así que devuelve `rate_limited` si ya estaba bloqueada. Misma firma, mismos resultados y mismos permisos (solo `authenticated`; `SECURITY DEFINER`; `search_path = ''`). Se mantiene el rechazo de una transacción de solo lectura (25006) para no cambiar quién puede llamarla.
- **Contar fallos y auditar quedan solo en «Unirme»** (`accept_invitation`, una acción de servidor = POST con revisión de origen de Next): sigue sumando el fallo (código inexistente u otro correo), sigue escribiendo `invitation.accept_denied` con `step: 'accept'` y a los 10 fallos bloquea. Los códigos tienen 256 bits: contar los fallos de la vista previa no protegía nada real.
- **Cabecera `Cross-Origin-Opener-Policy: same-origin`** en `/invitacion` y `/invitacion/:path*` (`next.config.ts`): si otro sitio abre la pantalla en una ventana nueva, esa ventana queda aislada y el sitio de origen no puede controlarla.
- **La vista previa no cuenta el estado a quien no es la persona invitada (revisión del PR, cierra M-2).** En la misma migración (editada en su lugar, con su deshacer), `app.invitation_state` compara PRIMERO quién pregunta: una invitación aceptada es de la cuenta que la aceptó (`accepted_by`; el vínculo del correo ya se vació); una pendiente o cancelada, de la cuenta cuyo correo corresponde al vínculo guardado. Cualquier otra cuenta recibe `{result: 'wrong_email'}` y nada más, igual si la invitación está pendiente, cancelada, vencida, usada, aceptada, con la organización archivada o con quien invitó sin permiso. La pantalla que ve es «Cambia de cuenta para unirte» («Esta invitación es para otro correo…»), que no dice nada del estado. Para la persona invitada nada cambia: sigue viendo cada estado con su mensaje. Como la definición es una sola, **también cambia `accept_invitation`**: antes, una cuenta ajena con una invitación cancelada, vencida o usada recibía el estado sin contar un fallo ni dejar registro (el mismo dato, por POST); ahora recibe `wrong_email`, suma un fallo y deja `invitation.accept_denied`, como con una pendiente. Lo que sigue distinto: `unverified` y `rate_limited` (dependen de la cuenta, no de la invitación) y `not_found` (ver M-2). Además, `app.invitation_state` hace siempre el mismo trabajo antes de responder `wrong_email`: calcula el vínculo del correo (normalizar + sha256) y compara `accepted_by` en todos los estados, y recién después mira el estado. Así una aceptada no responde antes que una pendiente o cancelada, y medir el tiempo de la vista previa no dice si ya se aceptó.
- **«Unirme» acepta la invitación que se mostró (revisión del PR, era un riesgo anterior a I1).** La acción usaba el código que hubiera en la cookie al pulsar. Una página ajena puede reemplazar esa cookie entre que la persona mira y pulsa (una navegación de primer nivel a `/invitacion/<otro código>`; la cookie es `SameSite=Lax`), y la persona entraba a OTRA organización (por ejemplo, la de alguien que la invitó a su correo desde otra cuenta de Administrador). Ahora el formulario lleva oculta la huella de la invitación que se mostró, `invitationViewFingerprint(código)` = sha256 de «`cp_invitation_view|`código» (`src/lib/team/invitation-code.ts`). **No es** la huella que usa la base (`sha256(código)`), porque esa sirve para llamar a `invitation_preview` y `accept_invitation` y no debe ir en la página; de esta no se saca ni el código ni esa huella. `acceptInvitationAction` compara (en tiempo constante) la huella del código de la cookie con la recibida; si no coinciden, o falta, **no llama a la base** (no suma un fallo ni deja registro), no borra la cookie y redirige a `/invitacion?aviso=invitacion-cambio`, que vuelve a mostrar la invitación que hay ahora con el aviso «Ahora se muestra otra invitación. Revisa a qué organización te unes.». El código sigue saliendo solo de la cookie; del formulario no se usa nada más.
- **Pruebas:** base de datos (la vista previa no cambia ninguna tabla ni el contador; a la persona invitada le responde cada estado; a una cuenta ajena le responde exactamente `{result: 'wrong_email'}` en los ocho estados, tres veces cada uno, sin escribir nada; con la cuenta a un fallo del bloqueo, la vista previa con códigos inventados o ajenos no la bloquea —esta prueba falla con la versión anterior—; `rate_limited` sin cambiar el contador; aceptar sí cuenta y audita, también con una cuenta ajena en cada estado; el deshacer deja `invitation_preview` y `app.invitation_state` idénticas a las de `20261103100000`), aislamiento (ataques 6 y 7), unitarias (cabeceras; la huella de lo mostrado; la acción rechaza sin llamar a la base si la huella no es la del código de la cookie, falta, es la huella de la base o es el código) y e2e (visitar una invitación ajena y 12 códigos inventados no deja registro ni bloquea; la cabecera está presente; cambiar la cookie desde otra pestaña entre ver y pulsar «Unirme» no une a ninguna organización, no deja registro ni fallo y vuelve a mostrar la invitación nueva con el aviso). La prueba e2e que mira la auditoría cuenta solo las filas de SU cuenta: contar todas fallaba al azar porque otros archivos escriben a la vez (`fullyParallel`, dos trabajadores).

**Cambio de comportamiento, a propósito.** La pantalla «Cambia de cuenta para unirte» (correo equivocado) no tiene un botón que acepte, así que **verla ya no deja ninguna fila en la auditoría** (antes dejaba «Alguien intentó usar una invitación con otro correo»). Solo un intento real de aceptar deja ese registro. Se cambió esa señal por no permitir rastreo ni bloqueo entre sitios. No se agregó ningún reemplazo. Lo dicho antes sobre `step: 'preview'` (ronda 1, D2) ya no ocurre: solo existe `step: 'accept'`.

**Límites conocidos de esta corrección.**

- La organización dueña de una invitación ya no se entera de que alguien con otro correo abrió su enlace; solo de quien intenta aceptar (que desde la pantalla de correo equivocado nadie puede hacer sin otro medio).
- El ataque real desde otro origen en un navegador no está cubierto por una prueba automática de este PR (se repite aparte con los guiones del revisor).
- **Abrir el enlace sí escribe dos cosas, y es a propósito (impacto bajo).** «Ver la pantalla no escribe nada» vale para `/invitacion` y para la base de la invitación, no para la ruta del enlace `/invitacion/[código]` (`src/app/invitacion/[token]/route.ts`): ese GET suma una apertura al contador `invite_link_ip` de la IP (30 por minuto; al pasarlo, bloqueo de 1 minuto) y escribe la cookie `cp_invitation` (o la borra, si el enlace está mal formado o la IP está bloqueada). Una página ajena puede entonces gastar el cupo de aperturas de una IP (la persona espera un minuto y vuelve a abrir el enlace) y cambiar la invitación guardada en el navegador; esto último ya no hace daño porque «Unirme» acepta solo la invitación que se mostró. No deja nada en la auditoría ni en el contador de la cuenta.
- La cuenta que aceptó una invitación y después se borró y se volvió a crear con el mismo correo es otra cuenta: con ese código ve «Cambia de cuenta» (antes, «ya se usó»). Ninguno de los dos le sirve para entrar.

**No está en este PR.** **B1** (secuestro de cuenta por registro previo con el correo del invitado, otro hallazgo de la misma revisión) se diseña aparte. Tampoco M1 a M4 de la revisión (IP/navegador falsificables en auditoría, etiqueta del registro de actividad, creación directa de invitaciones) ni H-010.

---

## Registro de construcción — H-010 (2026-11-05)

Construida siguiendo este diseño (§4 y §5). Migración `20261105110000_member_management.sql` (deshacer en `supabase/rollbacks/`).

### Firmas finales

Las tres corren con el pase de la persona (`security definer`, `search_path = ''`, solo `authenticated`), sacan la organización de `app.current_tenant_id()` (no tienen argumento de organización) y deciden con `app.can('team.manage')`:

- `public.list_members() returns jsonb`: arreglo con los miembros **activos**: `member_id`, `user_id`, `full_name`, `email` (de `auth.users`), `role`, `joined_at`, `is_self`. El Dueño primero, luego por fecha de ingreso. Solo Dueño y Administrador (decisión de José: la lista con correos no la ve nadie más).
- `public.change_member_role(p_member_id uuid, p_new_role text, p_expected_role text) returns jsonb`: `changed` (con `cancelled_invitations`) o `unchanged`.
- `public.remove_member(p_member_id uuid, p_expected_role text) returns jsonb`: `removed` (con `cancelled_invitations` y `assigned_requests`: cuántas solicitudes siguen asignadas a esa persona, esperando que alguien las reasigne) o `already_removed`.
- Ayuda interna `app.cancel_member_invitations(p_tenant, p_user, p_by) returns integer` (nadie con un pase la ejecuta).
- Constante `app.member_change_max_per_hour()` = 30 y su conteo `app.member_changes_exhausted(p_tenant, p_actor) returns boolean` (cambios de rol y quitadas sumados; nadie con un pase ejecuta ninguna de las dos). Antes de la segunda revisión se llamaba `app.member_role_change_max_per_hour()` y solo contaba cambios de rol.
- Ayuda `app.current_tenant_people() returns setof uuid` (`security definer`, la ejecuta `authenticated` porque la usa la política `profiles_select`): los `user_id` con una fila en `members` de la organización activa, activa o quitada.

### Códigos de error y motivo

| Código | Motivo (`message`) | Cuándo |
|---|---|---|
| `CP404` | `not_found` | No es miembro de la organización activa, o no hay organización activa |
| `42501` | `forbidden` | No maneja el equipo (o dejó de manejarlo mientras esperaba el candado) |
| `42501` | `owner_only` | El rol actual del miembro, o el nuevo, maneja el equipo y quien actúa no es el Dueño. También en `create_invitation` y `resend_invitation` (H-008, redefinidas aquí): la invitación es para un rol que maneja el equipo y quien invita o reenvía no es el Dueño |
| `CP429` | `limit_member_changes` | Quien actúa, **si no es el Dueño**, ya hizo 30 cambios en esta organización en la última hora, contando juntos los cambios de rol y las quitadas (`change_member_role` y `remove_member`). El Dueño no tiene tope (tercera revisión) |
| `CP422` | `invalid_arguments` · `invalid_role` | Falta un argumento · el rol nuevo no existe o es el del Dueño |
| `CP404` | `member_not_found` | El miembro no existe en **esta** organización (uno de otra da lo mismo), o ya no está activo al cambiar su rol |
| `CP423` | `cannot_target_self` | Nadie se cambia el rol ni se quita a sí mismo |
| `CP423` | `cannot_target_owner` | Nadie toca al Dueño (se responde con una lectura simple, sin bloquear su fila; se vuelve a mirar sobre la fila bloqueada) |
| `CP409` | `role_changed` | El rol real ya no es el que la persona vio (`p_expected_role`) |

### Cómo se cumplen las 8 reglas de §5

1. **Permiso:** `app.can('team.manage')`, y se vuelve a comprobar con el rol de la fila **ya bloqueada** de quien actúa. Además, si el rol actual del miembro o el nuevo maneja el equipo, quien actúa tiene que ser el Dueño (`app.role_can(rol_de_quien_actúa, 'tenant.transfer')`, también sobre las filas ya bloqueadas; si no, `42501 owner_only`).
2. **Organización:** el miembro se busca con `tenant_id = app.current_tenant_id()`. Probado con Dueños, Administradores y una persona que está en dos organizaciones, parada en cada una.
3. **Nadie toca al Dueño ni sube a alguien a Dueño:** el Dueño se reconoce con la matriz (`app.role_can(rol, 'tenant.transfer')`), no con un nombre de rol escrito; el rol nuevo debe ser del dominio `app.invitation_role` (los cuatro asignables).
4. **Nadie se toca a sí mismo.**
5. **Nunca queda sin Dueño:** consecuencia de la regla 3 más el índice único `members_one_owner`.
6. **Concurrencia:** se bloquean las filas del miembro **y** de quien actúa, siempre por orden de id (`order by id for update`); después se vuelve a comprobar que quien actúa sigue activo y con permiso, y que el rol sigue siendo el esperado. Probado con dos conexiones reales: el Dueño quita a un Administrador mientras este quita a otra persona (gana el Dueño, el Administrador recibe `42501`), el Dueño sube a alguien a Administrador mientras un Administrador lo quita (el Administrador recibe `owner_only`), dos cambios al mismo miembro (el segundo recibe `CP409`), quitar mientras otro cambia el rol, e invitar o reenviar mientras te quitan o te bajan de rol.
7. **Auditoría:** `member.role_changed` y `member.removed`, sin correo ni nombre (solo roles, ids y cuántas invitaciones se cancelaron). El disparador general sigue dejando además un `member.updated` con el cambio de rol o de estado (**ruido conocido**: hay dos filas por acción, como con `invitation.updated`). No se construyó ningún correo (ver más abajo).
8. **`list_members()`:** solo con `team.manage`; el correo sale de `auth.users`.

### Qué se cambió respecto del diseño

- **Sin correos.** El diseño (§5, regla 7) decía que cada cambio avisa por correo al afectado y al Dueño. **Decisión de José (2026-11-05): no se construye en H-010.** Queda solo en la auditoría; el aviso por correo llegará después reutilizando el mecanismo de H-008 (`email_messages`, tarea de avisos). El «Dueño se entera» del supuesto 4 de §8 queda, por ahora, solo en el registro de actividad. **Aarón aceptó «sin correos por ahora» el 2026-11-05**, junto con la regla de que solo el Dueño maneja a los Administradores (ver «Correcciones de la revisión de Aarón»).
- **La lista de miembros ya existe:** la pantalla «Tu equipo» tiene la sección «Miembros» (antes solo listaba invitaciones pendientes). El aviso al Dueño de H-008 sigue llevando a «Tu equipo» (ahora con lista).
- **La ficha del miembro** (`/o/[tenantId]/equipo/[memberId]`) se agregó (el diseño la pide para H-042): nombre, correo, rol con su frase, fecha de ingreso y las mismas acciones, con un lugar anotado para la sección que le sumará H-042.

### Decisiones donde el diseño no decía

- **Resultado idempotente:** cambiar a un rol que el miembro ya tiene es «listo» sin cambios ni auditoría, **aunque el rol esperado sea otro** (el resultado deseado ya está). Quitar a alguien ya quitado es `already_removed`, sin segunda auditoría.
- **Orden de revisiones:** primero «es de esta organización» y recién después «es el Dueño» o «es uno mismo», para no revelar nada de otras organizaciones; el Dueño se comprueba primero con una lectura simple (sin bloquear su fila, desde la tercera revisión) y otra vez sobre la fila bloqueada.
- **Quitado ≠ eliminado:** `list_members()` entrega solo activos (lo más conservador). El nombre de quien se fue lo lee cada cotización por `profiles`, no por esta función.
- **`profiles_select`:** ahora lee `full_name` de cualquiera con una fila en `members` de la organización activa (activa o quitada). Solo las columnas ya permitidas; el correo no está en `profiles`. Quien fue quitado sigue sin poder leer nada de la organización.
- **«Sus solicitudes asignadas quedan sin responsable activo»:** la solicitud conserva `assigned_to`. Como ahora el nombre de quien se fue **sí** se puede leer, `loadRequestList` y `loadRequest` (`src/lib/intake/requests-queries.ts`) consultan los nombres de los asignados solo entre los miembros **activos**; si no, una solicitud asignada a un ex miembro habría pasado a mostrar su nombre en vez de «Alguien que ya no está en el equipo». Cambio mínimo, con prueba (`requests-assignees.test.ts`).
- **Actualizar tras un error:** las acciones solo rehacen la pantalla si funcionaron; un «el rol cambió» no la rehace, para que el aviso quede en el diálogo.
- **Aviso al quitar:** el diálogo explica las cinco consecuencias (cotizaciones, borradores, invitaciones, solicitudes y que volver exige una invitación nueva).
- **Fixture de aislamiento:** `OrgData.ownerMemberId` (la fila de `members` de la dueña) para atacar y abrir `/equipo/[memberId]`; `concretePath` ganó un parámetro `memberId`.
- **Prueba de perfiles del aislamiento (`tables-read`):** ahora acepta que se lea el perfil de quien tuvo una fila en `members` de la organización activa (`peopleOfOrgs`), no solo los activos.

### Límites conocidos

- **Sin aviso por correo** al afectado ni al Dueño al cambiar un rol o quitar a alguien (ver arriba).
- **«Al instante» = en su siguiente clic o petición.** La pantalla que la persona ya tenía abierta sigue a la vista hasta entonces (no hay avisos en vivo).
- **Solicitudes asignadas a alguien que dejó de poder cotizar:** quien se quita queda con la solicitud asignada («sin responsable activo»). Quien solo **baja de rol** (por ejemplo de Comercial a Observador) conserva sus solicitudes asignadas con su nombre, y nadie las ve como huérfanas; el Dueño o un Administrador las puede reasignar a mano. La insignia del menú (`loadRequestBadge`) cuenta solo las **nuevas sin asignar**, así que las asignadas a un ex miembro no suman ahí. No se cambió.
- **Borradores de quien se fue:** quedan en solo lectura y nadie los puede tomar (supuesto 10: se podrán duplicar con H-069).
- ~~Un Administrador puede cambiar y quitar a otro Administrador~~ **Cerrado el 2026-11-05:** solo el Dueño da o quita un rol que maneja el equipo (ver «Correcciones de la revisión de Aarón»).
- **Verificación en dos pasos (H-004c):** `change_member_role` y `remove_member` deciden con `app.can('team.manage')` y con `app.role_can(rol_de_la_fila, 'team.manage')`; esa segunda forma usa el rol guardado y no `app.effective_role()`. Si H-004c cambia el criterio de quién puede manejar el equipo, hay que revisarlo aquí también.
- **Dato anotado, no tocado:** `loadAssignableMembers` (`requests-queries.ts`) lee `members` sin filtrar por organización y la política deja ver las propias filas de otras organizaciones; una persona que está en dos organizaciones podría salir repetida en la lista de asignables. No se verificó ni se cambió (fuera de H-010).

### Correcciones de las revisiones (2026-11-05)

Tras la revisión normal y la adversarial (sin bloqueantes). La migración `20261105110000_member_management.sql` se editó **en su lugar** (aún no estaba en `main`) y la base local se dejó al día aplicando el deshacer y la migración corregida en una sola transacción; `supabase_migrations.schema_migrations` tiene `20261105110000` una sola vez.

- **A · invitaciones que escapaban a la cancelación por una carrera.** `create_invitation` revisaba el permiso de quien invita al principio, pero no bloqueaba su fila de `members`: si lo quitaban o le bajaban el rol mientras invitaba, `app.cancel_member_invitations` no veía las invitaciones aún no guardadas y quedaban «pendientes» (el revisor: 5 de 8 con quitarlo, 6 de 6 con bajarlo a Observador), con riesgo de revivir si la persona volvía con un rol que maneja el equipo. Ahora `create_invitation` (misma definición de H-008, más un bloque) hace `perform 1 from members … for share` sobre la fila de quien invita **antes** del candado de la organización y falla con `42501` si ya no está activo o ya no maneja el equipo. **`resend_invitation` recibe el mismo bloque:** no dejaba escapar invitaciones (reenviar y cancelar se ordenan por la fila de `invitations`), pero sí permitía que una persona recién quitada reenviara una invitación ajena y saliera un correo a su nombre; es el mismo bloqueo mínimo. `revoke_invitation` no se tocó (cancelar nunca perjudica). El deshacer restaura las dos definiciones originales (una prueba compara el cuerpo con el de `20261030100000_invitations.sql`).
- **Orden de bloqueos** (también en el encabezado de la migración): `remove_member` / `change_member_role` → filas de `members` del objetivo y de quien actúa (`for update`, por orden de id) → filas de `invitations` del objetivo. `create_invitation` / `resend_invitation` → fila de `members` de quien actúa (`for share`) → candado de organización (advisory) → filas de `invitations`. Sin ciclo: las funciones de invitaciones piden su fila de `members` **antes** de cualquier otro bloqueo (mientras esperan, no sostienen nada), y quien tiene el candado de organización nunca pide después una fila de `members`. `for update` choca con `for share`, así que `remove_member` espera a las invitaciones en curso, y estas, al despertar, ven la fila ya cambiada y fallan con `42501`.
- **B · `profiles` solo deja leer `user_id`, `tenant_id` y `full_name`.** La migración 12 concedía además `created_at` y `updated_at`; `updated_at` cambia cada vez que la persona cambia de organización, así que otra empresa habría visto cuándo un ex miembro usa la plataforma. La migración hace `revoke select (created_at, updated_at) on public.profiles from authenticated` (el deshacer los vuelve a conceder). Se comprobó que ningún código de `src/` ni de las pruebas de aislamiento los lee; `last_tenant_id` sigue cerrada.
- **C · el registro de actividad dice a quién afectó la acción.** `member.role_changed` y `member.removed` guardan como recurso el id de la fila de `members` (verificado). `listAuditEntries` resuelve al leer, con `members` + `profiles.full_name`, el nombre de esa persona (nada nuevo en la base) y la pantalla dice «Cambió el rol de María Pérez de Comercial a Observador» y «Quitó a María Pérez del equipo»; en «Sobre qué» aparece «Miembro: María Pérez». Sin nombre legible: «una persona del equipo». Nunca un correo.
- **D · el borrador de quien se fue.** Si el autor ya no es miembro activo, la cotización dice «Quien armó este borrador ya no está en el equipo; queda solo para leer.» (antes: «Solo <nombre> puede editar este borrador», falso).
- **E · menores.** `loadAssignableMembers` filtra por organización (Mixta ya no sale repetida); el aviso al Dueño por una invitación ya aceptada lleva a «Tu equipo» (que desde H-010 muestra a la persona) con el botón «Ver tu equipo»; comentarios obsoletos corregidos; variables y comprobaciones de relleno quitadas de `e2e/member-management.spec.ts`; la prueba del borrador exige `42501` y que no cambie; el cliente falso de `requests-assignees.test.ts` aplica los filtros (quitar uno hace fallar la prueba); las pruebas de concurrencia esperan con `pg_blocking_pids` a que la segunda conexión esté realmente bloqueada; quitar desde la ficha ya no rehace la ficha antes de navegar (la acción de quitar no revalida: la lista se refresca o el navegador va a la lista); «Cambiar rol» reinicia la elección al cerrar el diálogo (`ConfirmAction` ganó `onOpenChange`); los textos del Dueño y de uno mismo viven en una sola constante (`members-model.ts`).

### Límites conocidos (agregados tras las revisiones)

1. ~~Sin correos, un Administrador puede ascender o bajar a otros Administradores y el Dueño solo se entera si revisa el registro de actividad.~~ **Resuelto el 2026-11-05:** con la regla «solo el Dueño maneja a los Administradores», Aarón acepta «sin correos por ahora» (solo auditoría) para H-010; ver abajo.
2. **Los intentos rechazados no quedan en la auditoría** (`forbidden`, `cannot_target_owner`…): mismo patrón que H-008.
3. **Carrera residual entre `remove_member` y `accept_invitation`.** Bloquean en orden inverso (`remove_member`: `members` y luego `invitations`; `accept_invitation`: `invitations` y luego la fila de `members` de quien acepta). Solo podrían cruzarse si quien acepta es justo quien actúa o el quitado; el revisor no pudo reproducirla. Si ocurre, la base corta una de las dos con error, sin dañar datos.

### Correcciones de la revisión de Aarón (2026-11-05)

Aarón pidió corregir los hallazgos de la revisión sin esperar a José. La migración se editó otra vez **en su lugar** (sigue sin estar en `main`), con su deshacer y la prueba del deshacer al día.

- **Solo el Dueño da o quita un rol que maneja el equipo — decisión por defecto aplicada por Aarón el 2026-11-05.** El hueco: un Administrador podía invitar a un cómplice como Observador (sin aviso al Dueño) y después subirlo a Administrador con `change_member_role`, saltándose el aviso de H-008; también podía bajar o quitar a otros Administradores. Ahora, en `change_member_role` y `remove_member`, si el rol **actual** del miembro o el rol **nuevo** tiene `team.manage`, quien actúa tiene que ser el Dueño (el rol con `tenant.transfer`); si no, `42501` con el motivo `owner_only`, que la pantalla traduce como «Solo el Dueño puede nombrar Administradores, cambiarles el rol o quitarlos del equipo.». Se revisa sobre las filas **ya bloqueadas**, justo después de «nadie toca al Dueño» (en la segunda revisión pasó a ir **después** de «ya tenía ese rol» / «ya estaba quitado»: ver más abajo). En pantalla, el Administrador no ve «Cambiar rol» ni «Quitar» en la fila ni en la ficha de otro Administrador (dice «Solo el Dueño puede cambiar el rol de un Administrador o quitarlo del equipo.») y, al cambiar el rol de alguien, no se le ofrece «Administrador» (`roleOptionsFor`). ~~`create_invitation` (H-008) no cambia: el Administrador puede seguir invitando como Administrador porque eso ya avisa al Dueño.~~ **Corregido en la segunda revisión:** ese aviso, en producción, nadie lo envía (decisión #17); ahora solo el Dueño invita o reenvía a un Administrador (ver «Correcciones de la segunda revisión»).
- **Con esa regla, Aarón acepta «sin correos por ahora» para H-010:** cambiar el rol o quitar a alguien queda solo en la auditoría (registro de actividad del Dueño). El aviso por correo sigue pendiente para más adelante, reutilizando el mecanismo de H-008.
- **Texto de quitar.** El diálogo decía «Sus solicitudes asignadas quedan sin responsable», falso: siguen `assigned` a quien se fue y solo el Dueño o un Administrador las reasigna. Ahora: «Sus solicitudes asignadas quedan esperando que las reasignes.» y, al terminar, el aviso dice cuántas eran («Tenía 2 solicitudes asignadas: quedan esperando que las reasignes.»), con el número que entrega `remove_member` (`assigned_requests`, contado dentro de la misma transacción). No se agregó a la auditoría.
- **Bajar a un Administrador avisa antes.** En el diálogo de «Cambiar rol», al elegir un rol que no maneja el equipo para alguien que sí lo maneja, aparece «Las invitaciones pendientes que envió se cancelarán.» antes de confirmar (antes solo lo decía el aviso final).
- **`isActiveMember` ya no inventa que el autor se fue.** Si la consulta falla devuelve «no se sabe» (`null`, con el código en el log, como las demás consultas de `quotes/queries.ts`) y la cotización dice «Solo quien armó este borrador puede editarlo. Tú puedes verlo.», cierto en ambos casos.
- **Tope de cambios de rol.** `change_member_role` acepta hasta 30 cambios por persona, por organización y por hora (`app.member_role_change_max_per_hour()`); el siguiente da `CP429 limit_role_changes` («Hiciste muchos cambios de rol en la última hora…»). Se cuenta en la propia auditoría (`member.role_changed` de esa persona en la última hora, con el índice `audit_tenant_actor`) y no con `auth_rate_limits`: esa tabla es del servidor con la llave maestra y cuenta **fallos**; aquí hay que contar cambios hechos, y la fila de `members` de quien actúa ya está bloqueada, así que dos cambios simultáneos de la misma persona no pasan el tope juntos. «Ya tenía ese rol» no deja registro y no cuenta. ~~`remove_member` no tiene tope: cada quitada saca a alguien del equipo y volver exige una invitación, que ya tiene topes.~~ **Corregido en la segunda revisión:** quitar suma al mismo tope (ver abajo).
- **Las filas quitadas de `members` (con cuándo y quién), solo para quien maneja el equipo.** Ojo con lo que esto NO dice (precisado en la segunda revisión): no es que «solo el Dueño y el Administrador ven a quien se fue». Lo que queda oculto para los demás son `removed_at`, `removed_by` y las filas quitadas de `members`; cualquier miembro sigue pudiendo listar por `profiles` el `user_id` y el nombre de quienes se fueron, porque hace falta para mostrar el autor de sus cotizaciones. `members_select` dejaba a cualquier miembro (también al Observador) leer por la API las filas quitadas con `removed_at` y `removed_by`. Ahora: las propias, las **activas** de la organización activa para todos, y las quitadas solo con `team.manage`. Se revisó cada lectura de `members`: en `src/` (`active-tenant.ts` y `auth/actions.ts` leen las propias; `requests-queries.ts` y `quotes/queries.ts` filtran `status = 'active'`; `audit/queries.ts` es del Dueño) y en la base (todas las funciones que leen `members` son `security definer`). El único consumidor que se rompía era la propia `profiles_select`, que consultaba `members` dentro de la política: ahora usa la ayuda `security definer` `app.current_tenant_people()`, así el Observador sigue leyendo el nombre del autor que se fue. La prueba de aislamiento `tables-read` ahora exige esta regla para `members`.
- **Prueba de concurrencia de `resend_invitation`.** Como la de `create_invitation`: quitar o bajar de rol primero hace esperar al reenvío, que falla con `42501` sin anotar correo; reenviar primero hace esperar a la cancelación, que igual cancela la invitación.
- **Foco.** Tras quitar a alguien desde la lista, el foco va al título «Miembros» (y la lista se refresca recién con el diálogo ya cerrado); tras cambiar un rol, vuelve al botón «Cambiar rol» de esa fila (se quitó el `key={role}` que rehacía el botón). `ConfirmAction` ganó `focusAfterSuccess` y `onClosedAfterSuccess`. Desde la ficha, quitar sigue llevando a la lista.
- **Comentarios obsoletos:** el de `profiles` en la migración (decía que `created_at` y `updated_at` seguían legibles) y el de `actorName` en `src/lib/audit/queries.ts` (decía que el nombre de quien ya no está no se lee).

### Correcciones de la segunda revisión (2026-11-05)

La migración, su deshacer y la prueba del deshacer se editaron otra vez **en su lugar** (siguen sin estar en `main`).

- **[Bloqueante] Un Administrador ya no puede meter a un cómplice como Administrador por las invitaciones — decisión por defecto aplicada por Aarón el 2026-11-05.** Quedaban dos caminos: (a) `resend_invitation` guarda el `p_email_binding` que manda quien llama, y ese vínculo es sha256(«huella del código | correo»), sin secreto: un Administrador podía llamar la función directo por PostgREST sobre una invitación a Administrador **hecha por el Dueño**, con el vínculo del correo de un cómplice y un código suyo; el cómplice aceptaba como Administrador y, como quien invitó era el Dueño, `owner_notice_state` quedaba en `none` y no salía ningún aviso. (b) Un Administrador podía llamar `create_invitation` directo con el rol Administrador: el aviso al Dueño quedaba solo anotado y, en producción, **nadie lo envía**, porque la tarea de avisos no está programada (decisión #17). Ahora **solo el Dueño** (el rol con `tenant.transfer`) llama `create_invitation` o `resend_invitation` sobre una invitación cuyo rol tiene `team.manage`; los demás reciben `42501 owner_only`. Se decide con el rol de la fila de `members` de quien actúa **ya bloqueada** (`for share`, el mismo bloqueo que ya existía): en `create_invitation`, antes del candado de organización y de los topes; en `resend_invitation`, después de «no existe» (`CP404`) y «ya no está pendiente» (`CP423`) y antes de los topes de reenvío. Los Administradores siguen invitando, reenviando y cancelando invitaciones con roles que **no** manejan el equipo: redirigir una de esas no es peor que invitar directo. **Esto cierra el camino de escalada que la decisión #17 dejaba abierto.**
  - **En pantalla:** el formulario de invitar no le ofrece «Administrador» a quien no es el Dueño y dice «Solo el Dueño puede invitar Administradores.» (`roleOptionsFor`, la misma lista que al cambiar el rol); en una invitación a Administrador, quien no es el Dueño no ve «Reenviar» sino «Solo el Dueño puede reenviar la invitación de un Administrador. Tú puedes cancelarla.» (`canResendInvitation`); «Cancelar invitación» sigue. Si igual llega `owner_only` (llamando la acción a mano), se muestra «Solo el Dueño puede invitar o nombrar Administradores.» (`mapTeamError`, tipo `owner_only`).
  - **Pruebas que asumían que un Administrador invita a un Administrador:** las del aviso al Dueño (`tests/db/invitations.test.ts`, `tests/db/invitation-accept.test.ts`, `tests/db/members.test.ts`) ahora arman esa invitación como **montaje** (la crea el Dueño y se reescribe quién invitó y el aviso, como una fila de antes de H-010); la primera prueba del aviso ahora exige `owner_only` sin fila, correo ni aviso. La e2e del aviso (`e2e/team-invitations.spec.ts`) pasó a comprobar que el Administrador no ve la opción ni el botón y que nadie recibe un aviso. Nuevas: el Administrador no crea ni reenvía una invitación a Administrador —también con un vínculo falso por llamada directa, y el cómplice no entra—, el Dueño sí, el Administrador sigue reenviando las de otros roles y puede cancelar la del Dueño; y el ataque 6 de `tests/isolation/invitations.test.ts`, por PostgREST.
  - **Qué le queda a la tarea de avisos (decisión #17).** Para invitaciones **nuevas**, `create_invitation` ya no anota ningún aviso (solo el Dueño invita a un Administrador); el código que lo anota se dejó como defensa, por si la regla cambia. La tarea sigue importando para: las invitaciones a Administrador que un Administrador haya hecho **antes** de esta migración y sigan con el aviso pendiente (si las hay en algún entorno); los avisos por correo de cambio de rol y de quitar a alguien, que están pendientes y van a reutilizar ese mecanismo; y cualquier aviso futuro de la misma familia. Programarla sigue siendo requisito antes del piloto, pero ya no es lo único que separa a un Administrador de sumar otro Administrador sin que el Dueño se entere.
- **[Medio] `remove_member` tiene tope.** Antes un Administrador podía sacar de una vez, sin aviso, a todos los Comerciales y Aprobadores. Ahora `member.removed` suma con `member.role_changed` al mismo tope de 30 por persona, por organización y por hora (`CP429 limit_member_changes`), contado igual en la auditoría y con la fila de quien actúa bloqueada (`app.member_changes_exhausted`; la constante pasó a llamarse `app.member_change_max_per_hour()` y el motivo, de `limit_role_changes` a `limit_member_changes`). «Ya estaba quitado» no deja registro y no cuenta. El mensaje dice «Hiciste muchos cambios en tu equipo en la última hora (cambios de rol y personas quitadas)…».
- **[Bajo] Orden de revisiones.** En `change_member_role` y `remove_member`, «ya tenía ese rol» (`unchanged`) y «ya estaba quitado» (`already_removed`) van ahora **antes** de `owner_only`: una pantalla vieja recibe el mensaje cierto. No revela nada: quien llega ahí sigue manejando el equipo de esa misma organización (comprobado sobre su fila ya bloqueada), ya ve los roles en `list_members()` y las filas quitadas en `members`, y no cambia nada. Un cambio real sobre un Administrador sigue dando `owner_only`.
- **[Bajo] Pruebas del tope:** quitar cuenta, cambios y quitadas se suman, separación por organización (al tope en A, sigue pudiendo en B) y dos cambios simultáneos de la misma persona con 29 en la hora (cambio + cambio y cambio + quitar, con dos conexiones reales): pasa uno y el otro recibe `limit_member_changes`.
- **[Bajo] `member-actions.tsx`.** El hallazgo decía que el `router.refresh()` tras quitar sobraba porque `removeMemberAction` ya revalida; **no es así**: `removeMemberAction` no llama `revalidatePath`, a propósito (desde la ficha, rehacerla daría «No encontrado» antes de ir a la lista), y la prueba unitaria lo exige. Ese `router.refresh()` es lo único que saca la fila de la lista, así que se dejó y se reescribió el comentario para decirlo. El foco no cambia.
- **[Documento] Redacción.** Ver la precisión en «Las filas quitadas de `members`…» de la lista anterior: solo `removed_at`, `removed_by` y las filas quitadas de `members` quedan ocultas; el `user_id` y el nombre de los ex miembros los lista cualquier miembro por `profiles`.

### Límites conocidos (al día tras la segunda revisión, 2026-11-05)

1. **Sin aviso por correo** al afectado ni al Dueño al cambiar un rol o quitar a alguien: solo auditoría. Aarón lo aceptó el 2026-11-05 junto con la regla «solo el Dueño maneja a los Administradores».
2. ~~Un Administrador sí puede invitar como Administrador~~ **Cerrado en la segunda revisión:** solo el Dueño invita o reenvía a un rol que maneja el equipo.
3. **Riesgo que queda, dicho con honestidad.** Un Administrador todavía puede, **sin que nadie se entere en el momento** y dentro de los topes: bajar de rol o quitar a miembros que no manejan el equipo (hasta 30 cambios por hora en cada organización, contando ambas cosas), reasignar solicitudes, cambiar los datos bancarios y los precios, y cancelar invitaciones (también las del Dueño). El Dueño solo se entera por el registro de actividad, hasta que existan los correos de aviso.
4. **El tope de cambios en el equipo es de 30 por persona y hora**, sumando cambios de rol y quitadas, y solo cuenta los cambios hechos (los rechazados no cuentan, como en el punto 2 de «Límites conocidos (agregados tras las revisiones)»). **Desde la tercera revisión no vale para el Dueño** (ver abajo).
5. **Ex miembros visibles por nombre:** cualquier miembro activo puede listar por `profiles` el `user_id` y el nombre de quienes se fueron de su organización (hace falta para el autor de las cotizaciones). Lo que no ve es cuándo se fueron ni quién los quitó.
6. **Las solicitudes asignadas a quien se fue no se reasignan solas:** se dice en el diálogo y en el aviso final, con su número; el Dueño o un Administrador las reasigna a mano.
7. **Quitar desde la ficha** lleva a la lista como una navegación normal: el foco parte del inicio de la página nueva.

### Correcciones de la tercera revisión, adversarial (2026-11-05)

Las tres son decisiones por defecto aplicadas por Aarón el 2026-11-05. La migración, su deshacer y la prueba del deshacer se editaron otra vez **en su lugar** (siguen sin estar en `main`). La base local tiene la versión anterior: hay que dejarla al día (deshacer + migración corregida en una transacción) antes de correr las pruebas de base.

- **Invitaciones a Administrador que quedaron de antes de la regla `owner_only`.** La migración (sección 9) cancela, al aplicarse, las invitaciones **pendientes** cuyo rol tiene `team.manage` y cuyo invitador no tiene hoy una fila activa con `tenant.transfer` en esa organización (también si ya se fue). Igual que `app.cancel_member_invitations`: `status = 'revoked'`, `revoke_reason = 'inviter_removed'` (la persona invitada ve «quien te invitó ya no puede invitar»), el aviso al Dueño sale de la cola (`pending` → `none`) y el disparador de auditoría deja un `invitation.updated` por fila, con actor `system` y `revoked_by` vacío (no hay quien actúe). Se puede repetir sin efecto: solo toca las que siguen `pending`. **El deshacer no las devuelve:** no se sabe cuáles estaban pendientes antes y revivirlas reabriría el camino que se cerró; quedan canceladas con su auditoría y, si hace falta, el Dueño invita de nuevo. Prueba: `tests/db/member-management-rollback.test.ts` arma a mano esas filas después del deshacer, vuelve a aplicar la migración y comprueba cuáles se cancelan (de un Administrador, de un Comercial, del Dueño de A en B) y cuáles no (del Dueño, de un rol que no maneja el equipo), que repetir la cancelación no toca nada y que el deshacer no las devuelve.
- **El Dueño no tiene tope de cambios.** El tope de 30 por hora es contra el abuso de un Administrador; el Dueño tiene que poder ordenar el equipo rápido en un incidente. `change_member_role` y `remove_member` solo lo revisan si quien actúa no tiene `tenant.transfer` (con el rol de su fila **ya bloqueada**). Sus cambios siguen quedando en la auditoría. Prueba nueva en `tests/db/members.test.ts`: con más de 30 cambios en la hora, el Dueño cambia y quita; un Administrador con los mismos recibe `limit_member_changes`.
- **`cannot_target_owner` sin bloquear la fila del Dueño.** Antes, `change_member_role` y `remove_member` bloqueaban (`for update`) la fila del miembro antes de responder «nadie toca al Dueño»: un Administrador que llamara una y otra vez sobre el Dueño mantenía bloqueada su fila y lo hacía esperar en todo lo que la bloquea (invitar, reenviar, cambiar o quitar a alguien). Ahora se responde con la lectura simple del paso 4 (que ya buscaba al miembro en la organización), antes de cualquier bloqueo; la revisión sobre la fila bloqueada se mantiene. El orden de bloqueos no cambia. Prueba nueva con dos conexiones: con la fila del Dueño bloqueada por otra conexión y `lock_timeout = 2s`, el Administrador recibe `cannot_target_owner` (no `55P03`).

### Corrección: invitaciones reenviadas (revisión del 2026-11-06)

Migración `20261106100000_invitation_resender.sql` (con su deshacer y la prueba del deshacer); integrada en `main` por el PR #33 (2026-11-09).

- **Hallazgo.** Quitar o bajar de rol a un Administrador (H-010) cancelaba solo las invitaciones pendientes con `invited_by` = esa persona. Pero `resend_invitation` cambia el código y el vínculo del correo (a quién queda atada la invitación) sin anotar quién la reenvió, y al aceptar o mirar el estado solo se exigía que quien la **creó** siguiera con permiso. Ataque: el Administrador X, sabiendo que lo van a quitar, llama directo a la base, reenvía una invitación pendiente de Comercial que hizo el Dueño (u otro Administrador) y la ata al correo de un cómplice. Lo quitan: la limpieza no la cancela. El cómplice acepta con el código que X conoce y entra como Comercial.
- **Arreglo.**
  - Columna `invitations.resent_by` (quién reenvió por última vez; nula si nunca se reenvió; sin permiso de lectura ni de escritura para nadie con un pase) e índice parcial `invitations_tenant_resender`.
  - `public.resend_invitation` anota `resent_by = quien reenvía` (copia literal con ese único cambio; sin argumentos nuevos).
  - `app.cancel_member_invitations` cancela también las pendientes con `resent_by` = la persona. Una que creó **y** reenvió cuenta una sola vez.
  - `app.invitation_sender_ok` / `app.invitation_senders_ok`: `app.invitation_state` (la usan `invitation_preview` y `accept_invitation`) exige que quien creó **y** quien reenvió sigan activos y manejando el equipo. La revisión sigue **después** de `wrong_email`: quien no es la persona invitada recibe lo mismo y en el mismo tiempo (H-009).
  - **D2: una invitación a un rol que maneja el equipo solo vale si la creó y la reenvió el Dueño** (las ayudas piden `tenant.transfer` a quien envía cuando el rol de la invitación tiene `team.manage`). Cierra para siempre el camino que `owner_only` ya cerraba al crear o reenviar, también para las que quedaron desviadas antes.
  - `app.reconcile_invitation_senders()`: limpieza única y repetible (la migración la llama al final). Rellena `resent_by` solo en las pendientes con más de un envío, con quien creó el último correo de invitación, y cancela las pendientes cuyo creador o reenviador ya no puede (`inviter_removed`, sin `revoked_by`, el aviso al Dueño fuera de la cola; la auditoría deja un `invitation.updated` de `system` por fila). Devuelve `{backfilled, cancelled}`. **Al desplegar**, correrla una vez después de las migraciones (la migración ya lo hace) reemplaza al `update` de la sección 9 de H-010.
  - Textos: «que había enviado» pasa a «que había enviado o reenviado» (resultado de quitar, diálogos y registro de actividad); `resent_by` se llama «quién la reenvió» en las etiquetas de auditoría.
- **Decisiones por defecto aplicadas (José, 2026-11-06; las revisa Aarón).** (1) Si sale quien **creó** la invitación, se cancela aunque el Dueño la haya reenviado después (ya pasaba antes). (2) Se reutiliza el motivo `inviter_removed`, no hay uno nuevo. (3) El relleno inicial cubre solo las pendientes; de las cerradas queda la auditoría `invitation.resent`. (4) D1: columna propia (`resent_by`) y no leer el último correo. (5) D2 incluida ya (arriba). (6) ~~**D3, límite conocido:** si el cómplice **ya aceptó antes** de que quiten a X, se acepta y no se deshace (`accept_invitation` no cambia): X podía meter a esa persona invitándola él mismo con un rol que no maneja el equipo, y queda visible en «Tu equipo». Para sacarla, el Dueño la quita.~~ **D3 cerrado el 2026-11-09 (pedido de Aarón, `20261109100000_invitation_accept_sender.sql`):** si el cómplice ya aceptó antes de que quiten a X, la membresía sigue sin deshacerse (X podía invitarlo él mismo con un rol que no maneja el equipo), pero ya no queda sin rastro (queda guardado, aunque todavía no se muestra en pantalla): al aceptar, `members.invited_by` guarda a quien envió el enlace por última vez (`coalesce(resent_by, invited_by)`) y `invitation.accepted` anota `created_by` y `sent_by`. Para sacarla, el Dueño la quita.
- **Orden de bloqueos.** Las funciones de uso normal no cambian el suyo. La migración y la limpieza toman `members` (compartido) y después `invitations` (exclusivo), como `remove_member`; `accept_invitation` va al revés (H-009): si coincide con la migración, la base corta una de las dos con error, sin dañar datos.
- **Aviso para H-111 (segunda revisión, 2026-11-06).** Con D2, si el Dueño invita a un Administrador y luego traspasa la organización, esa invitación deja de poder aceptarse («quien te invitó ya no puede») pero sigue pendiente en «Tu equipo»; reenviarla no la arregla (quien la creó sigue siendo el Dueño anterior) e invitar de nuevo al mismo correo responde «ya tiene una invitación pendiente». H-111 debe cancelar esas invitaciones en la misma operación (acotado a la organización; ver la nota técnica de H-111 en `HISTORIAS.md`).
- **Pruebas.** `tests/db/members.test.ts` (M1: el ataque exacto, quitar a X cancela la invitación del Dueño que reenvió y el cómplice recibe `inviter_inactive`; M2 a M7: bajar de rol, creada por un Administrador y reenviada por otro —sale cualquiera de los dos—, reenvía el Dueño, crea y reenvía la misma persona cuenta una vez, el Dueño reenvía después al correo real y no se cancela nada, dos organizaciones; R1 a R3 con dos conexiones: X reenvía primero, el Dueño actúa primero, el cómplice acepta primero —D3: queda a nombre de X—), `tests/db/invitation-accept.test.ts` (A2: quien reenvió fue quitado o bajado de rol; A3/D2: a Administrador solo vale si la creó y reenvió el Dueño; nueva fila «reenviada por quien ya no maneja el equipo» en todos los estados), `tests/db/invitations.test.ts` (`resent_by` vacío al crear, lo llena y lo reemplaza al reenviar, no se lee), `tests/db/invitation-resender-rollback.test.ts` (RB1 a RB5, entre ellas que sin la migración el ataque exacto vuelve a funcionar), `tests/db/invitation-preview-read-only-rollback.test.ts` (la definición vigente de `invitation_state` pasó a ser la de esta migración) y `tests/isolation/invitations.test.ts` (ataque 3: `resent_by` no se lee, no se escribe y no sirve de filtro; ataque 7: Mixta reenvía en A y en B, Ana la quita de A y solo se cancela la de A).

- **Tres arreglos menores del mismo trabajo (hallazgos de la revisión).** (a) El rechazo `owner_only` ahora queda en el log del servidor (`serverLog("warn", ..., { code: "owner_only" })`, sin correo, nombre ni identificadores) en `members-service.ts` y `service.ts`; antes solo se registraban los errores de tipo «otro». (b) En «Configuración», cada entrada pide el permiso que exige su pantalla (`sections.ts`): «Tu equipo» pide `team.manage` y el registro de actividad `audit.read`, no el general `settings.manage`. (c) `tests/db/permissions-parity.test.ts` compara las acciones de TypeScript contra la ÚLTIMA migración que define `app.role_can` y contra la definición viva en la base, y trae pruebas negativas que demuestran que detecta una acción nueva.

### Corrección D3 y menores de la revisión de Aarón (2026-11-09)

Migración `20261109100000_invitation_accept_sender.sql` (con su deshacer y la prueba del deshacer). Pedido de Aarón en el PR #33; diseño del agente `planificador`, construcción por la sesión principal con Sonnet.

- **Hallazgo (D3).** Si un Administrador (X) reenvía una invitación del Dueño atada al correo de un cómplice y el cómplice acepta antes de que quiten a X, `accept_invitation` dejaba `members.invited_by` a nombre del Dueño (`v_inv.invited_by`): el desvío solo lo delataba la auditoría `invitation.resent`. Ninguna pantalla lee `members.invited_by` (se revisó: solo lo leen la propia función y las pruebas).
- **Menor 1.** `app.reconcile_invitation_senders` rellenaba `resent_by` con `is distinct from`. Con dos correos con el mismo `created_at` (solo pasa si se crean en una misma transacción, porque `now()` es la hora de inicio de la transacción), el desempate podía cambiar un `resent_by` correcto al repetir la limpieza, y al quitar a quien reenvió la invitación ya no se cancelaba: se reabría el ataque. Ahora rellena solo donde `resent_by` es nulo.
- **Menor 2.** El desempate de `resend_invitation` (`e.id` ascendente) no coincidía con el de la limpieza (`e.id` descendente), así que con un empate cada una elegía un correo distinto. La limpieza adopta el de `resend_invitation`; `resend_invitation` no se toca.
- **Arreglo.** Dos funciones, cada una copia literal de la anterior con las líneas indicadas: `accept_invitation` calcula `v_sender := coalesce(v_inv.resent_by, v_inv.invited_by)` justo después de comprobar que el estado es `ok` (sobre la fila ya bloqueada con `for update`: un reenvío cambia el código y `resent_by` en el mismo `update`), la usa al crear o reactivar la membresía, y suma `created_by` y `sent_by` a los detalles de `invitation.accepted` (son ids de cuenta, como el actor que ya se guarda). La respuesta a quien acepta y `invitation_preview` no cambian. La migración no llama a la limpieza ni rellena miembros que ya aceptaron.
- **Orden de bloqueos.** Sin cambios: la migración no bloquea tablas y `accept_invitation` conserva el suyo (candado por cuenta, invitación `for update`, fila de `members`).
- **Decisiones por defecto aplicadas.** (1) No se rellenan los miembros que ya aceptaron (no hay producción). (2) Si quien acepta ya era miembro activo, su `invited_by` no se toca (la auditoría igual anota `sent_by`). (3) «Último que envió» vale también si el Dueño reenvía una invitación creada por X: el miembro queda a nombre del Dueño, y X sigue visible como creador en `invitations.invited_by` y en `created_by` de la auditoría. (4) La migración no llama a la limpieza; repetirla ya no pisa nada. (5) El desempate de la limpieza adopta el de `resend_invitation`.
- **Límites conocidos.** Mientras la invitación está pendiente, el desvío no se ve en pantalla; `/invitacion` y la lista de «Tu equipo» nombran a quien la creó. Después de aceptar, el dato queda **guardado pero todavía no se muestra en ninguna pantalla**: `members.invited_by` lo puede leer cualquier miembro activo con su sesión (por la API) y `created_by`/`sent_by` quedan en `audit_log` (`invitation.accepted`), pero el registro de actividad aún no los muestra (`describeAuditDetails` no dice nada de ellos). Mostrarlo es una historia futura (por ejemplo, decir quién envió el enlace en el registro de actividad o avisar cuántos miembros entraron por enlaces de quien se quita).
- **Pruebas.** `tests/db/invitation-accept.test.ts` (D3-1: el Dueño crea y un Administrador reenvía, queda a nombre del Administrador y la auditoría anota los dos; D3-2: reactivar; D3-3: el Dueño reenvía al final; D3-4: quien ya era miembro conserva el suyo; D3-5, con dos conexiones: aceptar gana el candado y el reenvío recibe `not_pending`; **D3-5 es un control**: pasa igual con o sin D3, y la que de verdad distingue es la D3-6, ver «Menores del #35»), `tests/db/members.test.ts` (M8: sin carrera, queda a nombre de X, el Dueño lo lee y al quitar a X no cambia; M9: repetir la limpieza con un empate real de `created_at` no pisa `resent_by`, con el id del correo del Dueño menor y mayor; M6 y R3 ahora exigen `invited_by`), `tests/db/invitation-accept-sender-rollback.test.ts` (NR1 a NR3: el deshacer devuelve cada función a su texto anterior con los mismos permisos y se puede volver a aplicar; NR4: sin la migración el desvío queda oculto; NR5: sin ella, repetir la limpieza pisa `resent_by` y quitar a X ya no cancela; NR6: la limpieza y el reenvío eligen el mismo correo en un empate) y `tests/db/invitation-resender-rollback.test.ts` (deshace primero esta migración y después la de #33: la versión nueva de `accept_invitation` lee `resent_by`).

### Menores del #35 (2026-11-09)

Migración `20261109120000_member_invitation_creator.sql` (con su deshacer y la prueba del deshacer), apilada sobre el PR de «intentos ajenos» (`20261109110000`). Pedido de Aarón en el PR #35 (revisión de H-010); diseño del agente `planificador`, construcción por la sesión principal con Sonnet. **Delicada (decisión 020): no se mezcla sin Aarón.**

1. **Quién creó la invitación, también en el miembro.** `members.invitation_created_by` (uuid, nulable, con referencia a `auth.users`) guarda a quien creó la invitación aceptada (`invitations.invited_by`); `members.invited_by` sigue guardando a quien envió el enlace por última vez (D3). Si un Administrador crea y el Dueño reenvía, el miembro queda con `invited_by` = Dueño e `invitation_created_by` = Administrador. `accept_invitation` es copia literal de la de D3 con tres cambios, todos después del estado `ok` (la reactivación y el `insert` escriben la columna, más un comentario); no cambian la respuesta, el tiempo de respuesta de H-009, el orden de bloqueos ni los detalles de la auditoría (que ya anotan `created_by` y `sent_by`). Quien ya era miembro activo conserva su fila intacta; los miembros anteriores quedan con la columna vacía (el dato sigue en `invitations.invited_by` y en la auditoría); en una reactivación el valor anterior queda en `member.updated`. *Alternativas descartadas:* reinterpretar `invited_by` como creador (contradice lo ya mezclado en D3) y sacar el creador de `invitations` por `member_id` (da respuestas equivocadas si la persona ya era miembro o hubo varias reactivaciones, y Aarón pidió «en el miembro»).
2. **Aviso de orden en el deshacer de #33.** `supabase/rollbacks/20261106100000_invitation_resender.down.sql` (única edición de algo ya integrado, por pedido expreso de Aarón; es un deshacer, no una migración) empieza con una guarda: si alguna función de `public` o `app` aparte de las seis que ese archivo redefine o borra todavía usa `resent_by` (hoy `accept_invitation`), se detiene con un error que la nombra y dice qué deshacer antes. Busca la columna como palabra entera (`p_resent_by` no cuenta) y es general: cubre también funciones futuras. Es lo que habría fallado de forma silenciosa antes: con D3 puesta y solo ese deshacer, toda aceptación válida fallaba. La CLI de Supabase nunca ejecuta los deshacer y `scripts/check-rollbacks.mjs` los corre de la más nueva a la más antigua, así que no cambia nada de lo que ya funcionaba. El deshacer nuevo trae la misma guarda sobre `invitation_created_by`, y además una segunda: se niega a reponer la función de D3 si la `accept_invitation` vigente no es la de esta migración (ya se deshizo, o D3 también), porque la de D3 lee `resent_by` y fallaría toda aceptación válida si esa columna ya no existe (MC7). La guarda de #33 lista como excepciones exactamente las seis funciones que ese archivo redefine o borra, y su mensaje dice el orden completo: primero `20261109120000_member_invitation_creator.down.sql` y después `20261109100000_invitation_accept_sender.down.sql`.
3. **La prueba de carrera que distingue.** D3-5 pasaba también sin la migración de D3 (queda como control). **D3-6**: el Dueño crea; el Administrador reenvía con un código nuevo **sin confirmar** y se queda con el candado de la fila; la persona acepta con el código **viejo** y queda esperando; al confirmar el reenvío recibe `not_found`; con el código nuevo entra y el miembro queda con `invited_by` = Administrador, `invitation_created_by` = Dueño y la auditoría con `created_by` = Dueño y `sent_by` = Administrador (comprobado en ese orden: sin D3 falla en `invited_by`, que queda con el Dueño; se comprobó a mano deshaciendo D3 en una sola transacción). **D3-7**: el caso exacto de Aarón, el Administrador crea y el Dueño reenvía.
4. **`lock_timeout`.** *Tiempo máximo que espera una sentencia por un bloqueo antes de rendirse.* Sin él, una migración que espera se queda en la fila y bloquea tras ella a toda la aplicación. Esta migración sí toma bloqueos fuertes (agregar la columna pide el más fuerte sobre `members`, que se consulta en cada petición, y uno sobre `auth.users` por la referencia nueva), así que su primera sentencia es `set local lock_timeout = '3s'`; si no consigue un bloqueo, falla sin cambiar nada y se reintenta. **El tope vale por cada bloqueo, no por migración:** esta pide dos seguidos (`members` y, mientras la sostiene, `auth.users`), así que en el peor caso `members` queda detenida casi 6 s; por eso la primera ida va sobre una base vacía. **Regla para lo que venga:** toda migración y todo deshacer con fecha desde `20261109120000` empieza con esa sentencia, comprobado por la guardia 15 de `tests/db/schema-guards.test.ts` (con ejemplo negativo y el valor en una constante con nombre). Las migraciones anteriores no se editan: `modelo-datos.md` §9.4 «Antes de la primera ida a producción» dice por qué no importa (se aplican sobre una base vacía antes de abrir el tráfico), cuáles toman bloqueos fuertes y qué hacer si alguna vez se aplican con uso real.

**Decisiones por defecto aplicadas (a confirmar por Aarón):** (1) `invitation_created_by` la lee cualquier miembro activo por la API, igual que `invited_by` (no se cierra `members` por columnas: por coherencia habría que cerrar también `invited_by`, que D3 dejó visible a propósito); (2) la columna lleva referencia a `auth.users`, como `invited_by`, `removed_by` y `resent_by` (la nota correspondiente quedó en H-109 de `HISTORIAS.md`); (3) el tiempo máximo de espera es de 3 s (por cada bloqueo que se pide, y esta migración toma dos seguidos: casi 6 s en el peor caso; cada uno es menos que la espera de 5 s de las pantallas y que el límite de 8 s de la API) y la regla es obligatoria para toda migración y todo deshacer desde ahora.

**Orden de bloqueos.** Sin cambios: `accept_invitation` conserva el suyo y no toma ninguno nuevo; la columna nueva solo se escribe en la fila de `members` que la función ya tenía bloqueada.

**Pruebas.** `tests/db/member-invitation-creator-rollback.test.ts` (MC1: forma de los archivos; MC2 y MC2b: función vigente y deshacer exacto, solo cambian las líneas anunciadas; MC3: deshacer y reaplicar, forma de la columna; MC4: el comportamiento con la migración, deshecha y reaplicada; MC5: la guarda del deshacer sobre otras funciones; MC7: la guarda sobre la versión vigente de `accept_invitation`; MC6: `lock_timeout` de 3 s y, con otra conexión sosteniendo un bloqueo sobre `members`, el deshacer falla con `55P03` en unos 3 s), `tests/db/invitation-resender-rollback.test.ts` (RB6 a RB8: la guarda de #33, con sus seis excepciones), `tests/db/invitation-accept.test.ts` (D3-1 a D3-4 con `invitation_created_by`, D3-5 como control, D3-6 y D3-7, y la prueba «7», que ahora compara `accept_invitation` con la ÚLTIMA migración que la define), `tests/db/members.test.ts` (M8 y R3 leen `invitation_created_by` con la sesión del Dueño; el Observador lee ambas columnas; el de otra organización no ve la fila; nadie escribe la columna directo), `tests/db/schema-guards.test.ts` (guardia 15) y los ajustes a `invitation-accept-sender-rollback.test.ts` (NR2 a NR4 deshacen primero la migración nueva) y `invitation-resender-rollback.test.ts` (`applyDowns`: nueva, D3, #33).

**Límites conocidos.** El rastro (quién creó y quién envió) queda guardado pero **todavía no se muestra en ninguna pantalla**: mostrarlo es una historia aparte. La verificación de que la CLI aplica cada archivo dentro de una transacción (sin la cual `set local` no tendría efecto) con `npx supabase db reset --debug` queda pendiente porque vacía la base local.

### Pruebas de H-010

- **Unitarias:** `members-model.test.ts` (formas, controles, mensajes), `members-actions.test.ts` (un falso miembro de cada rol: los sin permiso reciben el mensaje y la base ni se consulta), `member-list.test.tsx` (lista, diálogos, doble clic, fallo de red sin perder lo elegido), `requests-assignees.test.ts` y las etiquetas de auditoría.
- **Base de datos:** `tests/db/invitations.test.ts` (desde la segunda revisión: solo el Dueño invita o reenvía a un Administrador, también con un vínculo falso), `tests/db/members.test.ts` (por rol con pases reales, Dueño, uno mismo, solo el Dueño maneja a los Administradores, «ya hecho» antes que «solo el Dueño», tope de cambios en el equipo —cambios y quitadas sumados, por organización y con dos conexiones a la vez—, otra organización, rol esperado, casos de dos conexiones simultáneas —también reenviar mientras te quitan—, invitaciones canceladas, nombre visible, filas de quien se fue solo para quien maneja el equipo, ex miembro sin acceso, reactivar por invitación, escritura directa rechazada) y `tests/db/member-management-rollback.test.ts` (el deshacer y volver a aplicar).
- **Aislamiento:** `tests/isolation/members.test.ts` (siete ataques), el ataque 6 de `tests/isolation/invitations.test.ts` (invitar o reenviar a un Administrador por PostgREST sin ser el Dueño), las tres funciones en `RPC_CASES`, `/o/[tenantId]/equipo/[memberId]` en `APP_ROUTES`, y la prueba A12 del ex miembro (`lifecycle.test.ts`) ahora también llama a las funciones de equipo.
- **De punta a punta:** `e2e/member-management.spec.ts` (cinco pruebas: cambiar el rol y que desaparezca «Nueva cotización»; quitar con la sesión abierta; Administrador sin acciones sobre el Dueño ni sobre sí mismo, y los demás roles sin permiso; 375 px y sin conexión; dos pestañas).
- **Nota de operación de las pruebas e2e:** Supabase local limita a 60 ingresos o registros cada 5 minutos desde una misma IP (`sign_in_sign_ups` en `supabase/config.toml`); correr varias especificaciones de equipo seguidas con la máquina cargada puede pasar los 5 s de espera de las pruebas o ese tope. Cada archivo pasa solo.

---

## Registro de construcción — H-011b (2026-11-06)

Solo pruebas y datos de prueba: sin migraciones y sin cambios en `src/`.

- **Datos de prueba.** La fixture de aislamiento suma a la organización A un **Aprobador** (`dario`) y una **Comercial** (`sofia`): con Ana (Dueña), Mixta (Administradora) y Dante (Observador), A tiene los cinco roles activos. No cambió ninguna cantidad de pruebas de aislamiento (los ataques por persona recorren una lista fija). La semilla de desarrollo suma `dario@ejemplo.test` (Aprobador) y `dante@ejemplo.test` (Observador) a Negocio Demo 1; Carla ya era Comercial.
- **Dónde corre.** `e2e/roles.spec.ts` va en el proyecto `isolation` de Playwright (usa a las personas de la fixture con la sesión ya iniciada; `chromium` crea cuentas nuevas en cada prueba). `e2e/isolation.setup.ts` inicia sesión también como `dario`, `sofia` y `dante`, y `playwright.config.ts` reparte `roles.spec.ts` al proyecto `isolation`.
- **Qué prueba.**
  - Una tabla escrita a mano con los roles que abren cada pantalla (27 pantallas) y una prueba que exige que cubra todas las del registro de aislamiento: una pantalla nueva rompe la prueba hasta que alguien decida qué roles la ven.
  - Por rol: el menú, cada pantalla (o «No tienes permiso para esto», sin el texto marcado de ninguna organización en la pantalla negada) y los botones de acción de las pantallas clave (visibles para quien corresponde, ausentes para el resto).
  - El Observador recorre las 27 pantallas sin ver ningún botón, campo o enlace que cambie algo; un control con la Dueña comprueba que ese detector sí los encuentra donde existen.
  - El borrador de Ana: ella lo edita; los demás roles lo ven en solo lectura con el motivo y no pueden enviarlo.
  - Pedidos forzados por fuera de la pantalla (se captura la acción del servidor con la sesión de quien puede y se repite con la de otro rol): guardar el borrador de Ana (Administradora y Comercial: «Solo quien creó este borrador puede editarlo.»; Aprobador y Observador: «No tienes permiso para esto.») y crear un cliente (Aprobador y Observador). Cada una tiene un control en que el mismo pedido sí se aplica con la sesión que corresponde, y se comprueba en la base que lo rechazado no cambió nada.
- **Ya cubierto en `e2e/member-management.spec.ts`** y por eso no se repite: pasar a alguien de Comercial a Observador y que «Nueva cotización» desaparezca al recargar, y quitar a alguien con la sesión abierta («No encontrado» en su siguiente clic y la cotización conserva su nombre).
- **Cómo leer lo que se espera de la pantalla.** React entrega las partes lentas de una pantalla después del resto: mirar justo al cargar puede no encontrar un botón que sí existe. Las pruebas esperan a que no quede ninguna parte pendiente antes de afirmar que algo falta.

---

## Corrección: el intento de alguien de fuera queda sin autor (2026-11-09)

**Qué pidió Aarón (PR #35, textual; se construyó en el PR #36):** «No se exime en la prueba, porque relajar un control está prohibido. Se deja de guardar el id del actor cuando es de otra organización y se registra el intento sin autor. Arregla el rojo según el orden y la fuga del UUID ajeno al Dueño.»

**El problema.** Cuando una persona probaba un código real de una invitación dirigida a otro correo, la fila `invitation.accept_denied` de la organización de la invitación guardaba su id, su IP y su navegador. El Dueño de esa organización lee esa auditoría: recibía datos de alguien que no es ni fue de su organización (fuga entre organizaciones). La prueba `tables-read` lo detectaba según el orden en que corrían los archivos (la persona era «visible» si tenía o había tenido una fila en `members` de la organización).

**Qué se hizo** (migración `20261109110000_accept_denied_outsider_anonymous`, con su deshacer; redefine solo `app.invitation_audit_wrong_email`, misma firma y mismos permisos; no toca `accept_invitation` ni `invitation_state`):

1. **Criterio:** se conserva el id si la persona tiene o tuvo una fila en `members` de la organización de la invitación, en cualquier estado (activa o quitada). Es la misma regla de H-010 y de la prueba, y no depende del orden porque las filas de `members` no se borran. Lectura simple por el índice `(tenant_id, user_id)`, sin bloquear.
2. **Fila de la organización para alguien de fuera:** `actor_type = 'user'` con `actor_user_id`, `origin_ip`, `user_agent` y `correlation_id` en nulo; se mantienen la acción, la invitación (`resource_id`), el resultado, el momento y `details = {reason, step}`. Si es miembro o ex miembro, queda exactamente como antes.
3. **Copia en la organización «plataforma»** (decisión de Aarón, opción B): siempre (también si es miembro, para que el trabajo y el tiempo sean los mismos) se escribe otra fila con el id, la IP, el navegador y `details` más `invitation_tenant_id`. Solo la ve Main Brain; sirve para contener una cuenta que prueba códigos ajenos (campo «Actor» de `SEGURIDAD.md` §9). Mismo precedente que `tenant.access_denied`. Costo: una fila más por intento, con el mismo tope de 10 cada 10 minutos por cuenta.
4. **Filas ya escritas con id ajeno:** no se tocan (la auditoría es de solo agregar; solo existen en bases locales con datos ficticios).
5. **Pantalla.** En el registro de actividad, la columna «Quién» dice «Una persona de fuera de tu organización» (`auditActorText`, `actorOutside` en `AuditEntry`) y la acción se llama «Se intentó aceptar una invitación dirigida a otra persona». El filtro por persona no la encuentra (no hay persona); el filtro por acción sí.
6. **Pruebas.** Base de datos: cinco casos que dejaban el id ajeno ahora esperan «sin autor» y la copia en la plataforma; siete casos nuevos (alguien de fuera, miembro activo, ex miembro, Dueño de otra organización, mismo trabajo para ambos, IP o correlación mal escritas, propiedades de la ayuda y que `accept_invitation` no se tocó). *Alcance de dos de esas pruebas:* la «5» comprueba que miembro y persona de fuera dejan las mismas filas, la misma respuesta y el mismo contador de fallos, pero **no mide tiempo**; la «6» **protege contra un retroceso** (que la fila de la organización, escrita con un `INSERT` directo, deje de atrapar una IP o una correlación mal escritas), no prueba el paso de `sql` a `plpgsql`: `app.write_audit` ya las atrapaba. Deshacer: `tests/db/accept-denied-outsider-rollback.test.ts`. Aislamiento: la prueba de H-009 cuenta por invitación, y el **Ataque 8** (el último del archivo, para que siempre corra después de los intentos) comprueba en la base que ninguna fila de A, B ni C guarda el id de alguien que no es ni fue de esa organización, y por la API que los Dueños de A y B no ven el id ni el correo de nadie ajeno. `tables-read.test.ts` no se tocó y **ya no falla por este registro** (sí puede fallar en `profiles` con «CANARIO-C» según el orden de los archivos, un problema anterior que también ocurre en `main`: `intake-requests.test.ts` deja a Carla como miembro quitada de A y el Dueño de A puede leer su nombre desde H-010; queda para Aarón) *(La causa real y el arreglo, que espera la aprobación expresa de Aarón: ver «Menores del #36 y del #37», punto 9.)*. Las comprobaciones de «cero» de `tests/isolation/invitation-accept.test.ts` se deciden en el momento: solo se exigen para quien no es ni fue de esa organización. e2e: el conteo se hace por organización, no por persona.

**Pendiente (legal, no lo decide la construcción).** Aarón pidió mencionar en la política de privacidad que se guarda este registro. *No es tan urgente como parece:* quien intenta aceptar siempre tiene cuenta (decisión 017) y la política vigente (`src/content/legal/privacy.md`, §3 «Datos de uso y seguridad») ya declara para las cuentas la dirección IP, el navegador y el registro de auditoría con finalidad de seguridad; la frase propuesta precisa algo ya cubierto, no tapa un vacío. Editar `src/content/legal/privacy.md` cambia su huella y exige publicar una versión nueva con su migración de `legal_documents` (la prueba `tests/db/legal-seed.test.ts` compara la huella del código con la de la base), por eso **no se editó**: hay que decidirlo junto con el abogado. Frase propuesta para §3 («Datos de uso y seguridad») o §7: «Por seguridad, conservamos un registro de los intentos fallidos de aceptar invitaciones a una organización, con la dirección IP y el navegador de quien lo intentó, por el plazo del registro de auditoría.»

**Retención.** El borrado a los 24 meses que promete la política (`privacy.md`) todavía no existe: es la historia H-108 (`app.forbid_audit_delete` solo lo permite; nadie lo ejecuta). La copia en la organización «plataforma» tampoco se borra sola hasta entonces. No es nuevo de este PR, pero queda dicho.

### Menores del #36 y del #37 (2026-11-10)

Seguimiento de la revisión de Aarón a los PR #36 y #37 (integrados en `main`). Migración `20261109130000_invitation_audit_active_only.sql` (con su deshacer y la prueba del deshacer, `tests/db/invitation-audit-active-only-rollback.test.ts`). **Delicada (auditoría): no se mezcla sin Aarón.**

1. **Quien fue miembro ya no entrega su IP actual (menor 1 del #36).** `app.invitation_audit_wrong_email` conserva el id (`actor_user_id`) si la persona tiene o tuvo una fila en `members` de la organización de la invitación, en cualquier estado; pero la IP, el navegador y la correlación solo si esa fila es `active`. Quien no es ni fue de la organización sigue sin autor, y la copia completa en la organización «plataforma» no cambia. Mismos permisos, misma firma y mismo lenguaje (`plpgsql`); no toca `accept_invitation`. *Decisión por defecto aplicada:* la propuesta de Aarón, tal cual. La función lee `members` UNA sola vez (si hubiera más de una fila para la misma persona, gana la `active`).
2. **Ataque 8 (a)** extrae los UUID del texto de cada fila de la auditoría de A, B y C (`regexp_matches(a::text, <uuid>, 'g')`, no solo `actor_user_id`) y exige que ninguno sea una cuenta de `auth.users` sin fila en `members` de esa organización (en cualquier estado). Se recorre cada fila una vez, en vez de cruzar todas las cuentas con todas las filas. Se comprobó que muerde: una fila con un id ajeno en `details`, insertada en una transacción revertida, sale en la consulta. Además, la prueba de Ex (`tests/isolation/invitation-accept.test.ts`) lee su estado en A justo antes del intento y, por HTTP real, exige IP, navegador y correlación nulos si está `removed`, o la IP `203.0.113.7/32` si sigue `active`.
3. **Textos de pruebas.** La prueba «5» ya no sugiere que mide tiempo y la «6» dice que protege contra un retroceso (ver arriba). La decisión de Aarón sobre los intentos de gente de fuera se dio en el **PR #35** y se construyó en el **PR #36**; los comentarios que la llamaban «PR #33» se corrigieron. (D3 y los menores 1 y 2 sí vienen de la revisión del #33; los menores del #35 se construyeron en el #37.)
4. **Prueba «7»** (`tests/db/invitation-accept.test.ts`): además de comparar `accept_invitation` con la última migración que la define, comprueba que `20261109110000` y `20261109130000` **no** contienen `function public.accept_invitation(` (sin eso era casi una tautología).
5. **`lock_timeout` verificado (menor 5 del #37).** Desde `20261109130000`, justo después del `set local lock_timeout = '3s'` va un bloque `do $$ ... if current_setting('lock_timeout') <> '3s' then raise exception ...; end if; end $$;` y la guardia 15 lo exige. `20261109120000` ya está integrada y no lo trae: no se edita. Se comprobó que **la CLI de Supabase sí respeta `set local`** (se aplicó la migración sin que la verificación saltara) y que `psql -f` sin `-1` no lo respeta (la verificación detiene el archivo). Se cerró el «pendiente de verificar» de `modelo-datos.md` §9.4.
6. **Guardia 15 más estricta (menor 6 del #37).** `lock_timeout` aparece una sola vez en el archivo (fuera de comentarios y de textos entre comillas; `set_config('lock_timeout', ...)` también se rechaza) y no hay `begin`, `commit`, `rollback`, `end`, `savepoint` ni `reset` (tampoco `reset role` ni `reset all`) a nivel de archivo; el `begin` de un cuerpo `$$` de plpgsql no cuenta. El archivo se lee de **una sola pasada** (comentarios de línea y de bloque, textos entre comillas simples y cuerpos `$etiqueta$`, con etiquetas que pueden llevar dígitos como `$fn1$`; cada cuerpo se vuelve a leer con las mismas reglas), así un apóstrofo suelto en un comentario dentro de un cuerpo no esconde una segunda mención. La guardia 15b trae un ejemplo negativo de cada punto.
7. **Guardas de los deshacer (menor 7 del #37), a pedido expreso de Aarón.** Se editaron los dos deshacer ya integrados (el precedente es la guarda de orden que ya se había agregado a `20261106100000_invitation_resender.down.sql` por el PR #37): ambos buscan la columna con `~*` (sin distinguir mayúsculas) y dejan de lado las funciones por su firma completa con `to_regprocedure(...)`, no por nombre. En `20261109120000_member_invitation_creator.down.sql`, la guarda 1 compara el `md5` del cuerpo de la `accept_invitation` vigente con el del cuerpo de la migración (la prueba MC7 recalcula el md5 del archivo y comprueba que coincide; también comprueba que una función editada que sigue nombrando la columna se rechaza); sigue empezando con `set local lock_timeout = '3s'`. Las pruebas que miraban el texto (RB6 de `tests/db/invitation-resender-rollback.test.ts` y MC7) se ajustaron. *Nota:* las guardas son código SQL de los archivos de deshacer; las pruebas solo las ejercitan.
8. **`members.test.ts`:** la prueba de `list_members()` exige `listed.length > 0` (antes podía pasar con una lista vacía).
9. **`tables-read.test.ts` (CAMBIO A UNA PRUEBA DE AISLAMIENTO: espera la aprobación expresa de Aarón).** **Causa real del rojo de «CANARIO-C»:** el nombre completo de Carla es `Carla CANARIO-C-<corrida>` (`tests/isolation/fixture.ts`). Desde H-010 la organización A puede leer legítimamente el nombre de Carla (ex miembro de A, por `app.current_tenant_people()`), pero `forbiddenTexts` seguía prohibiendo el canario de C en esa respuesta: la prueba confundía el canario de la organización con el nombre de una persona visible. **Arreglo:** antes de buscar los textos prohibidos, del texto escaneado se quita el nombre completo exacto de cada persona de `ctx.visiblePeople`; cualquier otra aparición del canario sigue fallando (no se relajó nada más). Verificado con la corrida normal y con `--sequence.shuffle.files` (semillas 2 y 3). Además, la visibilidad esperada se calcula alrededor de cada lectura (`readAtASteadyMoment`: antes y después de pedir la tabla, y si cambió se vuelve a leer); eso **solo cierra una ventana teórica** (los archivos corren de a uno) y **no era la causa** del rojo.


## Registro de construcción — H-004a (2026-11-11)

Historia: activar la verificación en dos pasos y pedir el código al ingresar. Rama `feat/h-004a-dos-pasos`. Plan del `planificador` (2026-11-09). **Decisiones de Aarón:** D1 = B (la base de datos también exige el segundo paso) y D2 = H-004a se integra sola (sin H-004b). Es **delicada** (permisos y aislamiento): PR en borrador, revisión adversarial, no se mezcla sin Aarón.

### Qué se construyó

- **Corte de la sesión parcial en un solo archivo (`src/lib/auth/session.ts`).** `getSessionState()` devuelve `signed_out`, `second_step_pending` (la contraseña fue correcta pero falta el código; trae el id del factor) o `complete` (con `secondStep: { active, since }`). Con un factor **verificado** mira además `getClaims()`: solo `aal2` es sesión completa; cualquier otra cosa, incluido un error, es parcial (ante la duda se cierra). Las cuentas sin factor verificado no pagan nada extra (no se llama a `getClaims`). `getOptionalUser()` devuelve nada con una sesión parcial (las rutas de la API que lo usan responden 401 sin tocarlas) y `requireUser()` manda a `/ingresar/codigo` **antes** de mirar los términos. `requirePendingSecondStep()` es el guardia de la pantalla del código. El proxy no se tocó. Una guardia estática (`static-guards.test.ts`, 14) exige que `getUser`, `getClaims`, `getSession` y `getAuthenticatorAssuranceLevel` se nombren solo en `session.ts`, y que `mfa.enroll/challenge/verify/challengeAndVerify/unenroll/listFactors` solo se nombren en `second-step-actions.ts` (que además no usa la llave maestra); la 14b exige que `serverLog` ahí nunca reciba la clave, el `uri`, el correo ni el código de 6 números.
- **La base exige el segundo paso (D1-B).** Migración `20261112100000_mfa_session_gate.sql` (con su deshacer): `app.second_step_pending()` (verdadero si la cuenta tiene un factor verificado en `auth.mfa_factors` y el pase no es `aal2`), llamada al inicio de `app.current_tenant_id()` y en `app.my_tenant_ids()` (copias literales de 20261001120200 + la línea nueva) y en la rama «filas propias» de la política `members_select`; tres alcances nuevos de `auth_rate_limits` (`mfa_verify_user`, `mfa_verify_user_day`, `mfa_code_used`). Detalle y la desviación de `members_select`: abajo y en `modelo-datos.md`.
- **Pantallas.** `/ingresar/codigo` (única que acepta una sesión parcial; nunca redirige a otra, sin bucles), `/cuenta/seguridad` (sin activar, escanear, escribir el código, activada) con `AuthCard`, y el campo de código compartido (`src/components/auth/code-field.tsx`, ver `DISENO.md`). `/`, `/ingresar` e `/invitacion` mandan la sesión parcial al código; `/restablecer-contrasena` también (supuesto 1: recuperar la contraseña con factor activo pide el código ANTES de elegir la nueva, porque el enlace del correo solo da un pase `aal1` y Supabase exige `aal2` para cambiar la contraseña de una cuenta con factor; así quien solo tiene el correo no cierra todas las sesiones de la persona). Tras el código, `afterSecondStepPath` lleva a elegir la contraseña nueva (si venía de recuperar), a la invitación (si venía de una) o al inicio.
- **Acciones (`src/lib/auth/second-step-actions.ts`).** `verifySecondStepAction`, `startTotpEnrollmentAction` y `confirmTotpEnrollmentAction`. El **límite propio y el bloqueo de códigos usados van ANTES de hablar con Supabase** (`isSecondStepLocked`, luego `consumeTotpCode`), y desafío y verificación van en una sola petición (`mfa.challengeAndVerify`; separados, en Vercel pueden salir con IPs distintas y Supabase responde `mfa_ip_address_mismatch`). Un código incorrecto suma un fallo al tope del día y al de la IP; el 429 de Supabase y los demás errores, no: liberan el código (ronda 2, I1: un 429 no prueba nada contra la cuenta, puede ser el límite compartido de Supabase por una IP ajena, y el intento ya contó en la ventana de 15 minutos al registrarse antes de llamar). Activar: antes de `enroll` se quitan los intentos sin verificar de la persona (cuentan para el tope de 10 y chocan por nombre); si ya hay un factor verificado responde «ya está activa» sin llamar a `enroll`. El QR se re-codifica como `data:image/svg+xml;charset=utf-8,<codificado>` y va en un `<img>` (nunca como HTML). La clave, el `uri` y el código solo viajan en la respuesta POST de la acción: nunca en la dirección, la auditoría ni el registro del servidor.
- **Ingreso.** `signInAction`: tras la contraseña correcta, si `data.user.factors` trae un factor verificado, redirige a `/ingresar/codigo` **sin** escribir el ingreso por organización (`logTenantLogins`, que se escribe después del código con el mismo cliente, ya con la sesión completa; con la parcial la base no entrega ninguna organización). `session.login` de la plataforma se sigue escribiendo tras la contraseña.
- **Límite de intentos (`login-rate-limit.ts`)** *(texto original; la ronda 1 lo cambió: ver «Ronda 1 de correcciones»)*. 5 fallos por cuenta cada 15 min bloquean 15 min; 15 fallos por cuenta en el día bloquean 24 h; los fallos también cuentan en `login_ip` (20 cada 15 min). Un mismo código no sirve dos veces para la misma cuenta durante 120 s (`consumeTotpCode`, la huella es de «cuenta|código»). Si el contador falla, se deja pasar (Supabase verifica igual). Constantes con nombre.
- **Auditoría.** `session.mfa_enrolled` (plataforma y cada organización de la persona; sirve a H-004c y el Dueño lo ve en el registro), `session.mfa_verified`, `session.mfa_failed`, `session.mfa_locked`; detalles solo `{reason, stage, factorType}`.
- **Enlaces, cabeceras y aviso.** «Seguridad de tu cuenta» (ícono `ShieldCheck`) abajo del menú flotante, fuera de `nav[aria-label="Principal"]`, y en «Más» en el teléfono; lo ven los cinco roles. `next.config.ts`: `/ingresar/codigo` y `/cuenta/:path*` con `Cache-Control: private, no-store, max-age=0`, y `/cuenta/:path*` con `Referrer-Policy: no-referrer`. Aviso por correo: `[auth.email.notification.mfa_factor_enrolled]` en `supabase/config.toml` + `supabase/templates/mfa_factor_enrolled_notification.html` (lo envía Supabase Auth, sin código).

### Lo comprobado de Supabase Auth local (paso 0; fijado en `tests/db/mfa-session-gate.test.ts`)

(a) Con factor verificado y pase `aal1`: activar otro factor → 403 `insufficient_aal`; quitar el verificado → 422 `insufficient_aal`; cambiar la contraseña (`PUT /user`) → 401 `insufficient_aal`. Supabase lee el nivel de la FILA de la sesión, no del JWT: verificar con un token `aal1` sube la sesión a `aal2` aunque el token viejo siga diciendo `aal1`. (b) El MISMO código con un desafío nuevo dentro del período se acepta: por eso el bloqueo de códigos usados es propio. (c) Al verificar el primer factor se cierran las OTRAS sesiones de la cuenta (`session_not_found`); la que verificó sigue. (d) Los factores sin verificar cuentan para el tope de 10 (el mensaje del error 11 dice «verified factors», engañoso), no se limpian solos —sí desaparecen al verificar otro del mismo tipo— y se pueden quitar con un pase `aal1`; un segundo `enroll` SIN `friendly_name` choca (`mfa_factor_name_conflict`, nombre vacío) con cualquier factor sin nombre, verificado o no: H-004b tendrá que dar nombres. (e) Tras verificar, `amr` = `[password, totp]` y `aal` = `aal2`; la API cruda entrega `qr_code` como documento SVG (supabase-js lo envuelve en `data:image/svg+xml;utf-8,`). (f) Una función `security definer` creada por `postgres` sí lee `auth.mfa_factors`; la persona común no. (g) **Supabase local no limita los códigos incorrectos repetidos**: 40 verificaciones erróneas seguidas de una cuenta dieron todas 422, sin 429 ni bloqueo; el límite propio es el único freno desde la aplicación (ver «Riesgos conocidos»). (h) La CLI 2.119 acepta `[auth.email.notification.mfa_factor_enrolled]` y el correo llega al reiniciar Supabase (sin `--no-backup`, los datos se conservan). Además: el ingreso con contraseña y `GET /user` traen `user.factors` con su estado, y un pase `aal1` puede pedir desafíos.

### Desviaciones del diseño (con motivo)

1. **`members_select` también se cambió** (el plan nombraba solo las dos funciones). Sin eso, una sesión parcial leía por la API sus propias filas de `members` (en qué organizaciones está y con qué rol). La rama «filas propias» (`user_id = auth.uid()`) pasa a `... and not app.second_step_pending()`; la otra rama ya queda cerrada por `current_tenant_id()`. Por eso `app.second_step_pending()` está concedida a `authenticated` (la nombra una política, que corre con el rol de quien consulta; `app` no está expuesto por la API). Se ajustó una prueba anterior (`member-management-rollback`) para comparar contra la política de esa migración sin la cláusula nueva, y `invitation-accept-rollback` borra los contadores `mfa_*` antes de deshacer/reaplicar (no caben en la lista de alcances de antes; el deshacer de la migración nueva los borra).
2. `since` («activa desde») es la fecha de creación del factor verificado más antiguo.
3. `totpCodeSchema` es un objeto `{ code }`, rechaza más de 32 caracteres antes de limpiar espacios y guiones, y solo acepta dígitos ASCII.
4. Un código correcto limpia los dos contadores de la cuenta (15 min y día), no el de la IP.
5. Al activar, en el paso del código el foco va directo al campo (no al título); en el paso de escanear, al título.
6. Las pantallas de cuenta usan `AuthCard` (superficie sólida, fondo de ingreso), con «Volver a Cotiza Prime» como enlace de 44 px.

### Riesgos conocidos (anotados, sin cambiar código)

- **Fuerza bruta directa contra Supabase Auth.** Con la base cerrada, quien tiene la contraseña no lee nada, pero sí puede pedirle a `/auth/v1/factors/{id}/challenge` y `/verify` con su pase `aal1` directo, saltándose el límite de la aplicación; Supabase local no pone tope a los códigos incorrectos (g). En producción hay que medir el límite propio de Supabase Auth y, si no alcanza, cerrar este camino (por ejemplo con el hook de Auth `mfa_verification_attempt`). **Se está diseñando aparte; no se tocó aquí.** Mientras tanto, el piloto con la verificación activa tiene este límite conocido.
- **Funciones públicas con `auth.uid()` sin organización** (`create_tenant`, `accept_invitation`, `invitation_preview`, `accept_current_legal_documents`) y las políticas `profiles_select`, `profiles_update` y `legal_acceptances_select`: **cerradas en la ronda 1 de correcciones** (ver abajo) con `app.second_step_pending()`; una guardia (16, `schema-guards.test.ts`) avisa si aparece otra del mismo tipo.
- **Sin H-004b (D2):** quien activa y pierde el teléfono queda fuera. La pantalla del código lo dice («Si ya no tienes la aplicación, cierra sesión y pide ayuda al equipo de Cotiza Prime»); mientras no haya códigos de respaldo, el factor se quita a mano (`auth.mfa_factors`, README).
- **Atacante con la contraseña que activa SU teléfono** y deja fuera a la persona: riesgo propio de un segundo paso voluntario. Lo mitigan el aviso por correo y el procedimiento de soporte; conecta con la decisión pendiente 8 (quién responde un incidente) y con H-004c (obligatoria para Dueño y Administrador).
- **`getClaims` con claves asimétricas** no detecta un cierre de sesión por sí solo; se llama después de `getUser`, que sí lo detecta.
- **Cupo de verificaciones de Supabase Auth compartido en producción** (todas salen de la IP del servidor): sin problema en el piloto; medir antes del lanzamiento.
- **Para H-004b:** el paquete trae `mfa.recoveryCodes` (experimental): ver si la versión de Supabase Auth de producción lo soporta antes de crear `mfa_recovery_codes`. Y dar `friendly_name` a los factores (punto (d)).

### Pruebas de H-004a

Unitarias: `totp.test.ts` (12), `session.test.ts`, `sign-out.test.ts`, `sign-in.test.ts` (3), `reset-password.test.ts` (4, ronda 2), `second-step-actions.test.ts` (39), `second-step.test.ts`, `login-audit.test.ts`, `errors.test.ts` y `login-rate-limit.test.ts` (ampliadas), `labels.test.ts` y `guard-coverage.test.ts`. Base de datos: `tests/db/mfa-session-gate.test.ts` (Supabase Auth real y la base con pases `aal1`/`aal2`, también por HTTP con PostgREST) y `tests/db/mfa-session-gate-rollback.test.ts` (10; el deshacer completo y en orden lo prueba `npm run test:db:rollbacks`). Aislamiento: `registry.ts` (dos pantallas nuevas, `scope: "none"`) y las guardias estáticas 14, 14b y 14c. Punta a punta: `e2e/mfa.spec.ts` (9 pruebas en serie con cuentas nuevas: activar con QR y clave, la sesión parcial lleva al código en TODAS las pantallas y APIs de organización —las APIs responden 401—, código incorrecto, código usado, límite de intentos, recuperar la contraseña con factor y 375 px con «reducir movimiento»; el correo de aviso se exige con `E2E_EXPECT_MFA_ENROLLED_MAIL=1`) y una aserción por rol en `e2e/roles.spec.ts` (los cinco roles ven «Seguridad de tu cuenta» y el botón de activar, sin activar nada: la fixture no se toca).

### Ronda 1 de correcciones de H-004a (2026-11-11; revisiones Opus normal y adversarial, sin bloqueantes nuevos)

La migración `20261112100000_mfa_session_gate.sql` todavía no estaba en `main`: las correcciones que tocan la base se EDITARON EN ella (no hay otra migración) y su deshacer.

1. **Puertas con `auth.uid()` sin organización (A1).** Con el segundo paso pendiente (contraseña sola) la base rechaza con `42501 second_step_required` `public.create_tenant`, `public.accept_invitation` (antes del candado por cuenta y del conteo de intentos), `public.invitation_preview` y `public.accept_current_legal_documents` (copias LITERALES de la definición vigente, con solo el `if` de tres líneas; las pruebas lo comprueban quitando esa línea y comparando con la migración de origen), y las políticas `profiles_select` (rama propia), `profiles_update` (using y with check) y `legal_acceptances_select` agregan `and not (select app.second_step_pending())`. `legal_documents` sigue público. Pruebas de base para cada una: aal1 con factor → `42501` / 0 filas / `UPDATE` de 0 filas; aal2, factor sin verificar y sin factor → como antes.
2. **Aislamiento (A2).** `tests/isolation/second-step.test.ts`: una persona NUEVA administradora de la organización A, con un factor TOTP verificado (se crea en ese archivo y se la quita del equipo al terminar, para no sumar un miembro más a A en los demás archivos; jamás se activa un factor en las personas de la fixture ni en la semilla), entra con pase `aal1` y recorre TODAS las tablas del registro (0 filas o rechazo; única excepción, `legal_documents`, que es pública), TODAS las funciones del registro (rechazo; solo `my_last_tenant_id` y `preview_next_quote_number` responden `null`, y la prueba fija esa lista) y el bucket de logos; con `aal2` la misma persona sí lee (control). La guardia 16 de `tests/db/schema-guards.test.ts` exige que toda política o función expuesta que nombre `auth.uid()` sin `current_tenant_id()`/`my_tenant_ids()` nombre `second_step_pending()` (lista de excepciones vacía) y MUERDE (prueba que detecta una política y una función artificiales). La prueba H1 de `tests/db/mfa-session-gate.test.ts` recorre ahora todas las tablas de `public` que la API expone.
3. **Recuperación por correo no bloqueable (A3).** Los contadores de la cuenta (`mfa_verify_user`, `mfa_verify_user_day`) del camino de recuperación usan OTRA huella (`<cuenta>|recovery`) del mismo alcance de la tabla (sin migración): `verifySecondStepAction` decide el contexto con `hasRecoverySession()` (enlace del correo, sin contraseña en el pase) y la activación usa el de contraseña. Los fallos acumulados con la contraseña sola no bloquean la verificación que llega del enlace del correo, y al revés. El bloqueo de 24 h dice «Demasiados intentos hoy. Vuelve a intentarlo mañana o pide ayuda al equipo de Cotiza Prime.» (no «espera unos minutos»). *Ronda 2, I2:* en el camino CON CONTRASEÑA el bloqueo de 24 h orienta: «Demasiados intentos. Si no fuiste tú, alguien puede tener tu contraseña: usa «¿Olvidaste tu contraseña?» para entrar con un enlace a tu correo y cámbiala.» (`MFA_LOCKED_DAY_PASSWORD_MESSAGE`; la elige `lockedDayMessageFor` según el contexto); el camino de recuperación por correo conserva el texto de arriba, sin esa sugerencia. Y un cambio de contraseña EXITOSO (`resetPasswordAction`, después de `session.password_changed`) limpia los contadores del camino «password» de esa cuenta (`clearPasswordPathSecondStepCounters`: intentos de la ventana y fallos del día), no los de recuperación ni `login_ip`; es seguro porque la contraseña vieja, con la que se acumularon los fallos, ya no sirve. `resetPasswordAction` ya tiene `user.id` a mano, no hizo falta tocar otra ruta; si limpiar falla, no se corta el cambio. Prueba nueva: `src/lib/auth/reset-password.test.ts`. *No se hizo (seguimiento): espera creciente en lugar del bloqueo de 24 h, «Cambiar contraseña» dentro de una sesión completa y el correo de aviso por contraseña correcta con código fallido (depende de la decisión 016).*
4. **Atomicidad (A4).** El intento de la ventana de 15 minutos se REGISTRA antes de hablar con Supabase (`beginSecondStepAttempt`: lee el tope del día y suma el intento; el sexto bloquea; se limpia al acertar), así los envíos en paralelo no pasan de 5 (probado con 12 conexiones simultáneas a la base y con envíos simulados). El tope del día cuenta FALLOS (después de verificar, y no se limpia al acertar); también cuentan los fallos de la IP (`login_ip`). El 429 de Supabase NO suma al tope del día ni al de la IP (corregido en la ronda 2, I1): libera el código, y el intento ya contó en la ventana de 15 minutos al registrarse antes de llamar a Supabase; sumarlo permitía agotar el tope de 24 h de otra persona desde una IP que comparte el límite de Supabase. Si Supabase falla por algo que no es un código incorrecto (red, IP distinta, sesión), el código se libera (`releaseTotpCode`) y reintentar con el mismo código correcto no da «ya se usó». *Consecuencia:* ahora el sexto intento (no el quinto) es el que recibe «demasiados intentos».
5. **Mensajes y constantes (A5).** «La activación caducó. Vuelve a empezar.» solo sale al activar; al ingresar, «No pudimos verificar el código. Cierra sesión y vuelve a ingresar.»; un solo término, «6 números» (etiqueta «Código de 6 números»); constantes con nombre para el registro único del código (`MFA_CODE_REGISTRATIONS_TO_BLOCK`) y el lado del QR.
6. **Texto veraz (A6).** «…Así tu cuenta queda mejor protegida.» (no se promete lo que depende del hook de la decisión 021).
7. **Registro del ingreso (A7).** El `session.login` tras la contraseña sola de una cuenta con factor lleva `{ stage: "password", secondStepPending: true }`; para cuentas sin factor no cambia.
8. **Guardas del deshacer (A8).** Antes de reponer nada, el deshacer comprueba (a) el md5 del cuerpo de las SIETE funciones, (b) que las cuatro políticas siguen siendo las de la migración, y (c) que ninguna OTRA función ni política nombra `app.second_step_pending()` (borrarla las rompería; precedente `20261109120000`). *Efecto de deshacer `20261105110000` (member_management) FUERA de orden:* deja `members_select` y `profiles_select` en su texto anterior, sin el segundo paso, y esta migración volvería a pisarlos al reaplicarse: el orden inverso de `npm run test:db:rollbacks` lo evita. Las pruebas de deshacer/reaplicar de migraciones ANTERIORES que comparan funciones o políticas con el texto de su migración (`invitation_accept_sender`, `invitation_preview_read_only`, `invitation_resender`, `member_invitation_creator`, `member_management`) ahora empiezan cada transacción deshaciendo la de H-004a con su propio archivo (`tests/db/before-mfa-gate.ts`): prueban la migración vieja tal como era; no se relajó ninguna comparación.
9. **Pruebas vacías (A9).** Las dos pruebas «no consulta rol ni organización» ahora simulan `requireActiveTenant` y `requirePermission` y espían `from` y `rpc` de Supabase, y exigen cero llamadas.
10. **Guardia 14b (A10).** Revisa las llamadas a `serverLog` Y `logAuditEvent`, sin textos entre comillas: no puede aparecer `checked.code`, `parsed.data.code`, un `code` suelto, `otp`, la clave, el uri, el QR ni el correo (`code:` solo con un valor que venga de un error); exige encontrar llamadas, y la 14d prueba que detecta una violación y deja pasar el código de un error.
11. **Accesibilidad y estados (A11).** «Copiada» se anuncia en una zona `aria-live="polite"`; al «Cancelar» el foco vuelve al botón «Activar»; `router.refresh()` en lugar de «Recarga la página»; `loading.tsx` en `/cuenta/seguridad`; la e2e comprueba que con «reducir movimiento» la animación de entrada queda con duración `0s` (la regla de `globals.css` fija la duración en 0, no el nombre en `none`).
12. **e2e (A12).** El QR se lee con `jsqr` y trae `otpauth://` y LA MISMA clave que se muestra; cerrar sesión desde la pantalla del código; una invitación con la verificación activa (primero el código, después se retoma la invitación); un Comercial que activa en su propia cuenta; el límite (5 intentos, el sexto rechazado, también el código correcto) con el camino de recuperación por correo sin bloquear; y en `mfa-session-gate.test.ts` (a): cambiar el correo (`PUT /user {email}`) con pase `aal1` y factor verificado responde `401 insufficient_aal`.

**Riesgos conocidos agregados en la ronda 1 (sin cambiar código):**
- **Enlace del cliente con sesión parcial.** `src/lib/share/viewer.ts` trata una sesión parcial como «cliente»: si una persona con la contraseña sola abre un enlace de cotización del cliente, cuenta como apertura del cliente y puede marcar la cotización «Vista».
- **«Pide ayuda al equipo de Cotiza Prime».** El texto de la pantalla del código sigue así hasta que exista el canal de soporte (decisión pendiente 8, quién responde un incidente); no se cambió.
- **Factores que no son TOTP.** La base cuenta CUALQUIER factor verificado y la aplicación solo maneja TOTP: en producción hay que apagar los factores por teléfono y WebAuthn en el panel de Supabase (`CLAUDE.md`, «Antes del piloto»).
- **Quitar un factor** es la puerta de atrás del segundo paso: falta el procedimiento para verificar la identidad antes (decisión pendiente 8).
- El tope diario de intentos por camino se reinicia al acertar solo en la ventana de 15 minutos, no en el día; y los intentos en paralelo pueden pasar hasta 5 del tope del día (se cuenta después de verificar). Seguimientos anotados, **no hechos en esta ronda**: `auth.sessions.aal` (M7), límite de caracteres de `profiles_update`, tope de `session.mfa_locked` por intento bloqueado (M9, como `session.login_locked`) y, para H-004b, pedir la contraseña de nuevo antes de activar.

### Menores de la revisión de Aarón (2026-11-12)

Menores de la revisión de Aarón al PR #44 (H-004a ya en `main`). Rama `fix/menores-h004a`. **Sin migraciones nuevas**: la migración `20261112100000` y su deshacer solo cambiaron en comentarios. No se tocó el cuerpo de ninguna función ni política. Los menores 1 y 9 y los demás criterios futuros siguen en la ficha H-117 de `docs/HISTORIAS.md`.

- **M2 · Guardia 16 más estricta** (`tests/db/schema-guards.test.ts`). El análisis del texto se hace en TypeScript (`identifiesSessionPerson`, `callsAppFunction`), sin comentarios ni textos entre comillas. *Identificar a la persona* ahora es `auth.uid()`, `auth.email()`, CUALQUIER uso de `auth.jwt()` salvo leer `aal` (así también `->> 'sub'`, `-> 'email'`, `#>> '{sub}'`) y `request.jwt.claim(s)`. *Pasar por la puerta* es una LLAMADA de verdad (`app.second_step_pending()`; en una función también `app.current_tenant_id()` o `app.my_tenant_ids()`), no la palabra suelta ni un nombre parecido. Además de las funciones públicas ejecutables, mira TODAS las ayudas del esquema `app` (menos las de trigger, que no se llaman a mano ni desde una política, y la puerta misma). Pruebas 16b (política y función nuevas), 16c (los otros modos de identificar, `aal` permitido, ayudas de `app`), 16d (comentario, texto entre comillas y nombres parecidos no eximen) y 16e (el análisis de texto, con la forma que deja PostgreSQL al mostrar una política). **Al endurecerla no detectó nada real hoy**: la lista de excepciones sigue vacía. Las únicas funciones de `app` con `auth.uid()` que no pasan por la puerta son tres de trigger (`audit_invitation_change`, `audit_row_change`, `set_row_meta_by`), que quedan fuera por ser de trigger. **Límite (revisión Opus del PR #49):** comprueba que el texto LLAME a la puerta, no que se use su resultado, ni entiende todo SQL escrito a mano (comillas de dólar, comentarios anidados, identificadores entre comillas dobles); las políticas llegan normalizadas y no tienen ese problema. Hoy no se cuela nada (comprobado contra el catálogo). La guardia revisa ahora TODAS las funciones de `public` que no son de trigger, no solo las que `authenticated` puede ejecutar.
- **M3 · Advertencia en el deshacer** (`supabase/rollbacks/20261112100000_mfa_session_gate.down.sql` y `modelo-datos.md` §9.4): con la app nueva funcionando, la verificación queda solo en la pantalla; si además se vuelve atrás la app, quienes la activaron entran con la contraseña sola sin que nadie se lo diga. Solo comentario; las pruebas de deshacer y la guardia 15 siguen verdes.
- **M4 · Contadores propios al activar.** `SecondStepContext` suma `"enrollment"`: otra huella de la misma cuenta (`<cuenta>|enroll`) en los mismos alcances de la tabla (sin migración). Quien falla 15 veces por tener la hora del teléfono atrasada ya no queda bloqueada 24 h para ingresar, y su bloqueo dice «Demasiados intentos hoy. Revisa que la fecha y la hora de tu teléfono estén en automático e inténtalo de nuevo mañana…» (`MFA_LOCKED_DAY_ENROLLMENT_MESSAGE`) en vez de «alguien puede tener tu contraseña». Un cambio de contraseña NO limpia estos contadores (no tienen que ver con la contraseña). El contador por IP (`login_ip`) sigue compartido entre activar e ingresar: con 5 intentos por ventana y por cuenta, una persona sola no llega a las 20 fallas de la IP; no es un riesgo.
- **M5 · Código ya usado no suma fallo.** El segundo uso del mismo código dentro de 2 minutos sigue dando «Ese código ya se usó. Espera el siguiente.» y deja auditoría `code_reused`, pero ya no suma al tope del día ni al de la IP; el intento sí cuenta en la ventana de 15 minutos.
- **M6 · Cancelar quita el factor sin verificar.** Nueva acción `cancelTotpEnrollmentAction(factorId)` en `second-step-actions.ts` (el único archivo que usa `mfa.*`): exige sesión, lista los factores de la persona y solo quita un TOTP SIN verificar con ese id (un factor verificado jamás); con su propio pase, sin llave maestra. Si falla, solo se registra el código del error y la persona sale igual. El botón «Cancelar» del panel la llama sin esperar. Guardia estática 14e y e2e. **Límite:** el servidor no puede borrar la entrada «Cotiza Prime» que la persona ya escaneó en la aplicación de su teléfono; si cancela después de escanear, esa entrada queda y debe borrarla ella (al activar de nuevo aparece una segunda con el mismo nombre). Seguimiento opcional: un aviso en pantalla al cancelar desde el paso del código.
- **M7 · Dos pestañas.** Al confirmar, si el intento ya no existe pero la cuenta tiene un factor TOTP verificado (la otra pestaña la activó), se lleva a `/cuenta/seguridad`, que muestra «está activa». Si no, «La activación caducó. Recarga la página y vuelve a empezar.» (el texto ahora sugiere recargar).
- **M8 · Comentario de rendimiento** de la migración corregido: sin factor el pase es `aal1`, así que se consulta `auth.mfa_factors` (índice por `user_id`) en cada llamada; el costo es bajo pero se paga.

**Verde local de los menores (2026-11-12, sobre la rama, en este orden y una suite a la vez):** `lint`, `typecheck` y `prettier --check` de lo tocado limpios; `npm test` 2.463 pasadas (1 omitida), 154 archivos; `test:db` 1.250 (53 archivos, tras `db reset` + `db:seed`); `test:isolation` 1.268 (3 pendientes, 21 archivos); `test:db:rollbacks` OK; e2e `chromium` de `e2e/mfa.spec.ts` 11 de 11 (con `E2E_PROD=1`, `--workers=1`; las dos pruebas nuevas son las 10 y 11). **Ojo con el e2e:** con la máquina cargada (carga sobre 20 por momentos) las pruebas 3 y 4 fallaron varias veces por la espera de 5 s («Verificando…» o «Activando…» tarda más) y pasaron con la máquina quieta; no se corrieron los e2e completos de `chromium` ni de `isolation`. `E2E_EXPECT_MFA_ENROLLED_MAIL=1` falló en la prueba 1 porque la Supabase local no sirve la plantilla `mfa_factor_enrolled_notification` (responde 404, hay que reiniciarla con `config.toml`): sin esa variable pasa.
