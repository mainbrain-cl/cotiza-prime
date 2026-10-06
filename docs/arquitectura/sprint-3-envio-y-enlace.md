# Sprint 3 — Plan de construcción: enviar, enlace del cliente, aceptar o rechazar

Diseñado por el subagente `planificador` (Opus) el 2026-10-06. Cubre H-029, H-030, H-031 (🔒) y
H-033, H-034, H-035. Decisiones relacionadas: 016 (proveedor de correo, pendiente de Aarón) y 017
(portero en el servidor). Entorno de trabajo: 🟢 PRUEBAS.

## 0. Lo que ya existe y se reutiliza

- Organización activa: `requireActiveTenant` (`src/lib/tenant/active-tenant.ts`), cabecera
  `x-cp-tenant-id`; la base lo comprueba con `app.current_tenant_id()`.
- `quotes` ya tiene los estados `sent`, `viewed`, `accepted`, `rejected_by_customer`, `expired`,
  `superseded` y las columnas `sent_at`, `valid_until`. `quote_events` es solo-agregar. La vigencia
  "en días" se fija al enviar (migración 18).
- PDF: `loadQuoteDocumentData`, `buildQuoteDocumentData` (recibe `today`), `renderQuotePdf`,
  `quotePdfFileName`. Cifrado: `src/lib/crypto/pii.ts` (sello AAD con tabla, organización e id de
  fila: el id lo genera la app antes de cifrar). Huellas: `src/lib/crypto/search-hash.ts`.
  Límite de intentos: `src/lib/security/login-rate-limit.ts` + tabla `auth_rate_limits` (lista
  cerrada `scope`). Auditoría: `src/lib/audit/log.ts`, `getRequestContext`/`getAppOrigin`.
  Storage del logo solo desde servidor (`src/lib/brand/logo-storage.ts`, migración 19).
  Aislamiento: `tests/isolation/registry.ts`, `tests/db/schema-guards.test.ts`.
- Mailpit: web 56324; la API `POST /api/v1/send` funciona (verificado 2026-10-06), así que el
  adaptador local no necesita librería. `pg_cron` 1.6.4 y `pg_net` disponibles en la imagen local.

**Hallazgo:** el PDF muestra como "fecha de emisión" el día en que se arma y `@react-pdf` guarda la
hora de creación dentro del archivo: volver a armarlo nunca da el mismo archivo. Una vez enviada, el
PDF se lee **siempre del archivo congelado**, incluida la ruta interna
`/api/v1/tenants/[tenantId]/quotes/[quoteId]/pdf`.

## 1. Migraciones (un solo agente, una a la vez, cada una con su deshacer y sus pruebas de base de datos)

Ninguna convierte datos existentes (hoy solo hay borradores). Todas reversibles. Única con efecto
puntual: activar `pg_cron` en M24 (su deshacer cancela la tarea programada).

### M20 `20261006100000_quote_packages_and_links.sql`

**`quote_packages`** (copia congelada de lo que recibe el cliente): `id uuid` (lo genera la app),
`tenant_id uuid not null`, `quote_id`; `state` (`preparing` → `ready` → `sent`, o `failed` /
`abandoned`), `send_key uuid`; `issue_date date`, `valid_until date`; `email_subject` (≤150, sin
saltos de línea), `email_body_md` (≤5.000); `customer_snapshot_enc` (nombre, RUT, correo, teléfono y
dirección al enviar, cifrados); `document_snapshot jsonb` (modelo del documento sin logo ni datos del
cliente, ≤256 kB); `pdf_path`, `pdf_sha256`, `pdf_bytes`, `logo_path`; `content_sha256`;
`created_by`, `created_at`. Restricciones: `unique (tenant_id, id)`, `unique (tenant_id, quote_id,
send_key)`, relación compuesta `(tenant_id, quote_id)`. Regla `app.quote_packages_guard()`: solo
permite que los datos del PDF pasen de vacíos a llenos en `preparing` y los cambios de estado de la
lista; todo lo demás es solo agregar.

**`share_links`**: `id uuid` (app), `tenant_id`, `quote_id`, `package_id`, `email_message_id`,
`token_sha256 text` (64 hex, **índice único global**), `activated_at`, `revoked_at`, `revoked_by`,
`revoke_reason` (`manual`, `failed_attempt`, `new_version`), `first_viewed_at`, `last_viewed_at`,
`view_count int`. Relaciones compuestas a cotización y paquete; índice `(tenant_id, quote_id)`. No
guarda vencimiento propio: sale de `quotes.valid_until`.

**`share_link_views`**: `id bigint identity`, `tenant_id`, `share_link_id`, `viewed_at`, `ip_enc`
(sello `share_link_views.ip|tenant|id`), `user_agent_short` (≤120). Solo agregar, salvo la limpieza
por plazo (como `audit_log`, con `app.retention_purge`). Índices `(tenant_id, share_link_id,
viewed_at)` y `(viewed_at)` (excepción justificada: limpieza a 12 meses).

**Columnas nuevas en `quotes`**: `current_package_id` (compuesta), `send_lock_key uuid`,
`send_lock_until timestamptz`, `first_viewed_at`, `responded_at`; índice `(valid_until) where status
in ('sent','viewed')`. Reglas nuevas: `quotes_send_lock_guard` (con candado vigente y cambio de
`revision` → `CP423`; así no se reescribe `save_quote_draft`) y `quotes_status_transition_guard`
(lista cerrada: `draft→sent`, `sent→viewed`, `sent|viewed→accepted|rejected_by_customer|expired`;
los sprints siguientes la amplían).

**Bucket privado `quote-documents`**: rutas `{tenant_id}/{quote_id}/{package_id}.pdf` y
`...-logo.{ext}`; tope 20 MB; solo PDF e imágenes. Miembros de la organización activa solo `select`;
nadie con sesión inserta, edita ni borra.

**Tope de intentos**: `auth_rate_limits_scope_check` suma `share_ip`, `share_token`,
`share_respond_ip`, `quote_send_user`.

### M21 `20261006110000_email_messages_and_responses.sql`

**`email_messages`**: `id uuid` (app), `tenant_id`, `quote_id`, `package_id`, `share_link_id`,
`kind` (`quote`, `quote_resend`, `internal_notice`; `payment_1`/`payment_2` reservados),
`to_email_enc`, `to_email_hash`, `provider`, `provider_message_id`, `status` (`pending`, `sent`,
`delivered`, `bounced`, `complained`, `failed`), `status_at`, `sent_at`, `delivered_at`,
`bounced_at`, `bounce_type` (`hard`/`soft`), `error_code` (sin datos personales), `created_by`.
Únicos: `(tenant_id, package_id) where kind='quote'` (anti doble envío) y `(provider,
provider_message_id)`. Índices `(tenant_id, quote_id, created_at)` y `(tenant_id, status) where
status='bounced'`.

**`quote_responses`** (registro de conformidad): `id uuid` (app), `tenant_id`, `quote_id`,
`package_id`, `share_link_id`, `decision` (`accepted`/`rejected`), `response_key uuid`,
`acceptor_name_enc`, `reason_code` (`price_too_high`, `not_in_budget`, `chose_other_provider`,
`timing`, `no_longer_needed`, `other`), `reason_text_enc`, `package_content_sha256`,
`acceptance_text_version`, `ip_enc`, `user_agent_short`, `responded_at`. Restricciones: **`unique
(tenant_id, quote_id)`**; rechazo exige motivo; `other` exige texto; aceptación exige nombre. Solo
agregar (`forbid_mutation`).

**Lectura (RLS `tenant_id = (select app.current_tenant_id())`)**: `quote_packages` y
`email_messages` todos los miembros; `share_links` todos los miembros sin `token_sha256`;
`quote_responses` todos sin `ip_enc` ni `user_agent_short`; `share_link_views` solo Dueño y
Administrador, sin `ip_enc`. Sin escritura para nadie con sesión, fuera de Realtime, nada para
`anon`.

### M22 `20261006120000_quote_send_rpcs.sql` — funciones para miembros (`to authenticated`)

Todas `SECURITY DEFINER`, `search_path=''`, organización solo de `app.current_tenant_id()`.

- `prepare_quote_send(p_quote_id, p_expected_revision, p_send_key, p_package_id,
  p_email_message_id, p_share_link_id, p_token_sha256, p_email_subject, p_email_body_md,
  p_to_email_enc, p_to_email_hash, p_customer_snapshot_enc)`: rol `owner`/`admin`/`sales` y **solo
  el autor**; `for update`; exige estado `draft`, la `revision` esperada, ≥1 línea, cliente no
  anonimizado, vigencia por fecha no pasada. Fija `issue_date` (hoy en Chile) y `valid_until`
  (fecha, o hoy + días). Candado de 120 s (constante). Crea paquete, enlace **inactivo** y correo
  `pending`. Misma `send_key` con paquete en curso → `in_progress`; candado ajeno → `CP409`.
- `attach_quote_package_document(p_package_id, p_pdf_path, p_pdf_sha256, p_pdf_bytes, p_logo_path,
  p_document_snapshot, p_content_sha256)`: verifica que el archivo exista en `storage.objects` bajo
  `{tenant}/{quote}/`; paquete → `ready`.
- `confirm_email_dispatch(p_email_message_id, p_provider, p_provider_message_id)`: correo → `sent`;
  enlace activado. `kind='quote'`: cotización `draft→sent`, `sent_at`, `valid_until`,
  `current_package_id`, quita candado; evento `sent`, auditoría `quote.sent`. Reenvío: evento
  `resent`.
- `fail_email_dispatch(p_email_message_id, p_error_code)`: correo y paquete → `failed`; enlace queda
  inactivo (`failed_attempt`); quita candado; evento `send_failed`. **La cotización no cambia de
  estado.**
- `prepare_quote_resend(p_quote_id, p_resend_key, p_email_message_id, p_share_link_id,
  p_token_sha256, p_to_email_enc, p_to_email_hash)`: estado `sent` o `viewed`; mismo paquete y mismo
  PDF; tope de reenvíos por cotización y por día.
- `revoke_quote_links(p_quote_id)`: autor, Dueño o Administrador; revoca todos los enlaces activos;
  evento `link_revoked`; auditoría `share_link.revoked`.

### M23 `20261006130000_share_public_rpcs.sql` — solo para `service_role` (el portero)

Ni `anon` ni `authenticated`. Todas reciben el sello del enlace y solo actúan sobre esa fila.

- `share_link_read(p_token_sha256)`: **solo lee**. Devuelve `{state, tenant_id, quote_id,
  package_id, share_link_id, quote_status, response, document_snapshot, customer_snapshot_enc,
  pdf_path, pdf_sha256, logo_path, org_contact}`. `state`: `ok`, `expired`, `revoked`,
  `superseded`, `responded`, `not_found`. Si la fecha ya pasó, vence la cotización ahí mismo.
- `share_link_record_view(p_token_sha256, p_ip_enc, p_user_agent)`: suma `view_count`; la primera
  vez `sent→viewed`, `first_viewed_at` y un único evento `viewed`.
- `share_link_respond(p_token_sha256, p_response_id, p_response_key, p_decision,
  p_acceptor_name_enc, p_reason_code, p_reason_text_enc, p_ip_enc, p_origin_ip inet, p_user_agent,
  p_acceptance_text_version)`. En una sola operación, en orden: (1) busca el enlace y **bloquea la
  cotización** (`for update`); (2) misma `response_key` → devuelve el mismo resultado; (3) otra
  respuesta existente → `already_responded` con la decisión que quedó, sin cambiarla; (4) rechaza si
  está revocado o sin activar; (5) rechaza si el paquete no es `current_package_id` o el estado es
  `superseded`; (6) si la fecha pasó, vence y responde `expired`; (7) revalida decisión, motivo de
  la lista, texto de "otro" de 3 a 200 caracteres y nombre, aunque la app ya validó; (8) `update
  quotes set status=… where id=… and status in ('sent','viewed')`; (9) inserta en
  `quote_responses` con `package_content_sha256`; (10) evento de línea de tiempo y auditoría con la
  IP real.

Se suman a `SERVER_ONLY_FUNCTIONS` del registro: estas tres y `record_email_event`.

### M24 `20261006140000_expiry_bounces.sql`

- `app.expire_due_quotes()`: pasa a `expired` las `sent`/`viewed` con `valid_until` anterior a la
  fecha de hoy en Chile (`app.current_business_date()`); vigencia vale **hasta el último día
  inclusive**; evento `expired` con actor `system`. Programada con `pg_cron` cada hora
  (`cron.schedule('expire-quotes','5 * * * *', …)`); el deshacer cancela la tarea.
- `record_email_event(p_provider, p_provider_message_id, p_event, p_occurred_at, p_bounce_type)`
  (solo servidor): idempotente; el estado avanza `pending < sent < delivered`; `bounced` y
  `complained` pasan por encima de `delivered`; un aviso más viejo que `status_at` se ignora; si
  rebota, evento `email_bounced`.

## 2. Enlace del cliente (resumen de la decisión 017)

- Token `randomBytes(32)` base64url (43 caracteres) en `src/lib/share/token.ts`
  (`newShareToken()`, `hashShareToken()`); en la base solo `sha256`. Cada correo (también reenvío)
  lleva su enlace nuevo.
- Pantalla `/c/[token]`; API `/api/v1/public/quote-links/[token]/pdf` (GET), `/view` (POST),
  `/accept` (POST), `/reject` (POST). Token mal formado (largo ≠ 43 o fuera de base64url) se rechaza
  **antes** de consultar la base.
- `src/lib/share/gateway.ts` (`server-only`): llama solo a las tres funciones de M23 y descarga PDF
  y logo congelados. Prueba estática: no usa `.from(` ni otras funciones. La regla del linter sobre
  `createAdminClient` se amplía solo a ese archivo, a `src/lib/quotes/send/document-storage.ts` y a
  `src/lib/email/delivery-events.ts`.
- Límites (`consumeShareQuota`, siempre con huellas, nunca IP en claro): 60 lecturas/min por IP; 30
  /min por enlace; 10 respuestas/hora por IP; excedido → `429`.
- Vencida o revocada: mensaje con nombre y contacto de la organización (del paquete congelado), sin
  la cotización. Token inexistente: mensaje genérico.
- Aperturas: solo con el aviso POST `/view` desde la página; un GET nunca cambia nada. Si quien abre
  tiene sesión y es miembro de esa organización, no cuenta. IP cifrada y navegador recortado; se
  borran a los 12 meses (lo hace H-108).
- Cabeceras en `/c/*` y `/api/v1/public/*`: `Cache-Control: private, no-store`,
  `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`; metadatos sin montos ni nombre;
  en POST comprobar `Origin` = `APP_ORIGIN`; `serverLog` nunca registra el token.
- La pantalla usa `document_snapshot` y el mismo `quote-document-model.ts` (cifras idénticas al PDF);
  logo de la copia congelada como `data:`; datos del cliente descifrados en el servidor. **Sin
  datos bancarios** (una prueba lo vigila).
- Al responder: `src/lib/share/actions.ts` (`respondToQuote`; rechazo exige motivo antes de llamar a
  la base); `src/lib/share/after-response.ts` (`onQuoteResponded()` avisa al autor por correo
  `internal_notice`; si falla no afecta al cliente). Gancho `onQuoteAccepted()` con `TODO(H-053)`
  (correo 2 de cobro: otro sprint; no crea filas de cobro ni lee nada bancario).

## 3. Línea de tiempo y auditoría

| Evento en `quote_events` (sin datos personales) | `audit_log` |
|---|---|
| `sent` `{package_id, email_message_id}` | `quote.sent` |
| `send_failed` `{code}` | `quote.send_failed` (failure) |
| `resent` `{email_message_id}` | `quote.resent` |
| `viewed` (solo la primera vez) | — |
| `accepted` / `rejected_by_customer` `{reason_code}` | `quote.accepted` / `quote.rejected` (actor `public`, IP real) |
| `expired` (actor `system`) | — |
| `link_revoked` | `share_link.revoked` |
| `email_bounced` `{email_message_id, bounce_type}` | — |

Se amplía `AuditAction` en `src/lib/audit/log.ts`. **Nunca** van a `data`, `details` ni a los logs:
correo, nombre de quien acepta, texto del motivo ni IP.

## 4. Qué se congela al enviar y cómo se envía (`sendQuoteAction`, `src/lib/quotes/send/actions.ts`)

Líneas y totales no se editan al salir de `draft` (`save_quote_draft` ya devuelve `CP423`).
Reenviar adjunta el **mismo archivo** y antes comprueba que su sello coincida con `pdf_sha256`.
Pasos: (1) `requireActiveTenant` y zod; (2) validar el formato básico; (3) exigir correo del
cliente; (4) generar ids, token y datos cifrados en la app; (5) `prepare_quote_send`; (6) armar el
PDF con `issue_date`/`valid_until` congelados (`buildQuoteDocumentData` recibe la fecha de emisión);
(7) subirlo con `uploadPackageDocument` (`upsert:false`); (8) `attach_quote_package_document`; (9)
enviar con clave anti-duplicado (`idempotencyKey = email_message_id`) y tope de 15 s; (10) aceptado
→ `confirm_email_dispatch`; fallo → `fail_email_dispatch` y error en pantalla. Con la misma
`send_key`, un paquete que quedó a medias se abandona y se crea otro. Tarea de reconciliación
(`src/server/jobs/reconcile-sends.ts`): marca `abandoned` los paquetes en `ready` con más de 10
minutos y avisa a Sentry.

**Capa de correo `src/lib/email/`** (decisión 016): `types.ts` (contrato `EmailTransport.send(msg) →
{ok, providerMessageId} | {ok:false, retryable, code}`), `transport.ts` (`getEmailTransport()` según
`EMAIL_PROVIDER`: `mailpit` / `smtp` / `resend` / `memory`), adaptador `mailpit` por
`POST :56324/api/v1/send`, `resend` por `fetch` sin su librería, `memory` para pruebas;
`basic-format.ts` (lector propio sin librería: negrita, listas, enlaces solo `https`; escapa todo;
produce HTML y texto plano; ≤5.000 caracteres, ≤20 enlaces, sin caracteres de control);
`quote-email.ts` (remitente "Nombre de la organización" `<EMAIL_FROM_ADDRESS>`, nombre limpio de
comillas y saltos de línea, ≤60 caracteres; botón "Revisar y aceptar la cotización" a
`getAppOrigin()/c/{token}`); `delivery-events.ts`. Variables: `EMAIL_PROVIDER`,
`EMAIL_FROM_ADDRESS`, `MAILPIT_API_URL` o `SMTP_*`, `RESEND_API_KEY`, `EMAIL_WEBHOOK_SECRET`,
`EMAIL_ALLOWED_RECIPIENT_DOMAINS` (lista blanca fuera de producción, p. ej. `ejemplo.test`).
`app-env.ts` impide arrancar en producción con `mailpit` o `memory`. Rebotes: la ruta
`/api/v1/webhooks/email/[provider]` verifica la firma (sin firma válida → 401) y llama a
`record_email_event`; fuera de producción el adaptador simula rebote si el destinatario es
`@rebota.ejemplo.test`.

## 5. Ataques y pruebas obligatorias

**Aislamiento (`npm run test:isolation`)**: agregar al registro las tablas `quote_packages`,
`share_links`, `share_link_views` (lectura solo `owner`/`admin`), `email_messages`,
`quote_responses` (todas `business`, sin escritura; fixture con `CANARIO-B-<runId>`), las 6
funciones para miembros (`writesActiveTenant: true`) y las 4 solo del servidor, y las direcciones
públicas con tipo nuevo `scope: "token"`. Ataques: (1) Ana (A) llama `prepare_quote_send`,
`prepare_quote_resend`, `revoke_quote_links`, `attach_…` sobre datos de B → `CP404` y B intacta; (2)
`attach_quote_package_document` con ruta de B → rechazado; (3) Ana, Beto y sin sesión llaman directo
`share_link_read`, `share_link_respond`, `share_link_record_view`, `record_email_event` → sin
permiso; (4) pedir `token_sha256`, `ip_enc` o `user_agent_short` → error de permiso; un Comercial
lee `share_link_views` → 0 filas; (5) Storage: Ana descarga `quote-documents/{B}/…` → denegado; Ana
intenta subir, sobrescribir o borrar el PDF congelado de A → denegado; (6) copiar
`customer_snapshot_enc` o `acceptor_name_enc` de B a una fila de A y descifrar → falla por el sello;
(7) enlace de A apuntando a paquete de B → imposible por la relación compuesta (probar con llave
maestra); (8) token de B con la sesión de Ana: ve la cotización de B solo como "cliente", **no**
registra apertura como miembro ni deja rastro en A.

**Base de datos (`npm run test:db`)**: 20 aceptaciones a la vez con la misma clave → 1 respuesta y
1 evento; aceptar y rechazar a la vez → una gana; aceptar y revocar a la vez → coherente; 10
`prepare_quote_send` a la vez → 1 paquete y 1 correo `quote`; guardar el borrador con candado →
`CP423`; aceptar con fecha vencida sin que corra la tarea → `expired`; una aceptada nunca vence;
cambio de estado prohibido como `postgres` → rechazado; `quote_responses` y `share_link_views` no
se editan; aviso del proveedor repetido o desordenado no retrocede el estado; enviar sin líneas, con
cliente sin correo o anonimizado, o siendo Observador, Aprobador o no autor → rechazado.

**Unitarias**: `basic-format` (`<script>`, `[x](javascript:…)`, `http://`, `on*=`, enlaces
anidados, >20 enlaces); asunto con `\r\n` → rechazado; nombre de remitente con comillas o saltos →
limpiado; token (largo, alfabeto, sello distinto para cada token).

**Punta a punta** (`e2e/quote-send.spec.ts`, `e2e/share-link.spec.ts`): enviar y comprobar el correo
en Mailpit (remitente, PDF adjunto, botón); `sha256` del adjunto = descarga desde el enlace =
`pdf_sha256`; abrir el enlace sin sesión a 375 px sin desplazamiento horizontal → **Vista**; aceptar
con nombre → **Aceptada**, confirmación, aviso al autor en Mailpit, botones desactivados al
recargar; rechazar sin motivo bloqueado, "otro" sin texto bloqueado; revocar y vencer → mensaje con
contacto; rebote simulado → aviso en la cotización y la lista, corregir correo y reenviar; envío
que falla → error en pantalla y sigue **Borrador**; el HTML del correo 1 y de la página no contiene
"Banco", "Cuenta" ni "RUT titular"; cabeceras `no-store`, `noindex`, `no-referrer`; un GET con
agente de antivirus no cambia el estado; 61 peticiones seguidas → `429`.

## 6. División del trabajo (decisión 013: máximo 2 agentes a la vez; las 🔒, solas)

| # | Tarea | Agente |
|---|---|---|
| 1 | M20 → M21 → M22 → M23 → M24, cada una con deshacer, `tests/db`, registro y fixture de aislamiento | Un solo Sonnet, una migración a la vez |
| 1b | Capa de correo `src/lib/email/*` (sin base de datos) y unitarias | Sonnet, en paralelo con 1 |
| R1 | Revisión Opus de M20–M24 antes de cualquier pantalla | Opus |
| 2 | **H-029**: acción de envío, `document-storage`, pantalla de redactar con vista previa lado a lado, PDF congelado en la ruta `/pdf` | Sonnet, solo; revisión Opus aparte |
| 3 | **H-030**: `gateway.ts`, `/c/[token]`, descarga del PDF, aviso de apertura, límites, cabeceras | Sonnet, solo; revisión Opus aparte |
| 4 | **H-031**: aceptar o rechazar, aviso al autor, gancho del correo 2 | Sonnet, solo; revisión Opus aparte |
| 5 | H-034 (vencimiento visible) ‖ H-035 (revocar con confirmación) | 2 Sonnet en paralelo |
| 6 | H-033 (avisos del proveedor, insignia de rebote, reenviar) | Sonnet; revisión Opus en lote con H-034 y H-035 |

Al aprobarse la decisión 017 hay que actualizar `modelo-datos.md` §4.6, §7 y §8.3.

## 7. Riesgos

- **PDF lento:** hasta ~35 s con 200 líneas; enviar espera esa respuesta y puede chocar con el
  máximo de Vercel. Declarar `maxDuration` y medir; si no alcanza, pasa a una cola (historia nueva).
- **Correo enviado sin confirmar** si el servidor cae justo entre el proveedor y la confirmación:
  limitado por la clave anti-duplicado y la reconciliación; no es cero con SMTP.
- **Token en los registros de acceso de Vercel** (va en la dirección): mitigado por guardar solo el
  sello y por la revocación.
- **Spam** mientras no exista el dominio verificado: no cerrar el sprint con un cliente real.

## 8. Decisiones que necesitan a Aarón (con el supuesto aplicado mientras tanto)

1. Proveedor de correo (propuesta Resend), dominio y acuerdo de tratamiento → decisión 016.
2. Portero en el servidor → decisión 017 (aplicada).
3. "Responder a": contacto de la organización; si no tiene, el del autor.
4. Enlace vencido o revocado: solo el aviso con el contacto (sin ver ni descargar el PDF).
5. Reenviar después de revocar: sí, con enlace nuevo y queda en la historia.
6. Quién envía y revoca: envía solo el autor (decisión 009); revocan autor, Dueño y Administrador.
7. Al aceptar: solo el nombre más una casilla de conformidad con texto versionado (sin RUT).
8. Avisos al autor: por correo y con el estado visible en la aplicación en este sprint.

## 9. Desviaciones declaradas por el implementador

Lo que las migraciones 20 a 24 hicieron distinto del plan de arriba, con su razón. Las revisó Opus; las
que dicen «a ratificar» necesitan el visto bueno de Aarón. Las correcciones de la revisión están en la
migración 26 (`20261006150000_sprint3_review_fixes.sql`).

1. **`send_key` con unicidad parcial.** `unique (tenant_id, quote_id, send_key)` solo vale para
   paquetes vivos (`preparing`, `ready`, `sent`), y se suma el índice `quote_packages_one_live`
   (a lo más un paquete vivo por cotización). Con un único total, un paquete que quedó a medias y se
   abandona impediría crear el siguiente con la misma clave.
2. **El proveedor `pending` se fija una vez.** El proveedor de correo no se conoce al preparar el
   envío: el correo nace con proveedor `pending` y `confirm_email_dispatch` lo fija (la migración 22
   lo permite una sola vez; después es inmutable).
3. **Vigencia por defecto de la organización.** Una cotización sin vigencia elegida toma
   `tenants.default_validity_days`; al confirmar el envío queda guardada como `days`.
4. **Reenvío por autor, Dueño o Administrador.** El primer envío es solo del autor (decisión 009);
   reenviar y revocar los pueden hacer también el Dueño y el Administrador.
5. **Topes de reenvío: 5 por día y 20 en total por cotización** (a ratificar). Son constantes con
   nombre en la base (`app.resend_max_per_day`, `app.resend_max_total`).
6. **Texto de «otro» cifrado, con largo acotado de 46 a 1.200 caracteres.** La base no puede contar los
   caracteres de un texto cifrado, así que acota el cifrado (equivale a 3–200 caracteres reales). La
   aplicación valida los 3–200 antes de cifrar.
7. **La IP de una apertura se sella con el id del enlace**, no con el de la apertura (un número que la
   aplicación no conoce antes de insertar): `share_link_views.ip|tenant|share_link_id`.
8. **El aviso «más viejo» se compara con el último aviso del proveedor** ya aplicado (entrega o rebote),
   no con `status_at`: el correo se confirma después de que el proveedor responde, y una entrega muy
   rápida llegaría «antes».
9. **Un aviso del proveedor antes de confirmar el envío devuelve `unknown`** (el correo aún no tiene su
   identificador). La ruta de avisos debe responder un error recuperable para que el proveedor
   reintente, no un éxito.
10. **`org_contact` sale del paquete congelado:** `document_snapshot.organization.name` y
    `document_snapshot.organization.detailLines`; si falta el nombre, el de la organización.
11. **Atajo en el deshacer de la migración 23:** borraba los enlaces y las aperturas para poder volver a
    aplicarla. Queda **reemplazado** por la protección de la revisión (migración 26, hallazgo I4): los
    deshacer de las migraciones 21 a 26 abortan con un error claro si ya hay registros legales
    (paquetes, correos, enlaces, aperturas, respuestas o cotizaciones enviadas).
12. **Dos ajustes a `tests/db/quotes.test.ts`** por la lista cerrada de cambios de estado de la
    migración 21: la prueba que pasa una cotización de «Enviada» a «Cambios solicitados» apaga el
    guardián `quotes_status_transition_guard` dentro de su transacción (ese cambio no está permitido
    todavía), y el estado inventado ahora falla con `42501` (el guardián actúa antes que la lista de
    estados), no con la violación de restricción.

### Correcciones de la revisión (migración 26)

- **B1 · lo enviado es lo guardado.** `quote_packages.quote_revision` (lo llena un disparador al
  crear el paquete, dentro de la misma transacción de `prepare_quote_send`): adjuntar el PDF y
  confirmar el envío exigen que la cotización siga en esa revisión (`CP409`). Si el candado ya venció y
  se guarda el borrador, el candado se suelta.
- **I1.** Responder y registrar una apertura vuelven a leer el enlace después de bloquear la cotización.
- **I2.** Adjuntar, confirmar y fallar un envío reciben `p_token_sha256`; sin el sello correcto,
  `42501`. Solo quien armó el envío (el servidor) lo conoce.
- **I4.** Los deshacer de las migraciones 21 a 26 abortan si hay registros legales.
- **I5.** Orden de bloqueo único: cotización, luego correo, luego paquete.
- **Menores.** Responder fija `first_viewed_at`; las funciones del enlace rechazan con la organización
  archivada; un enlace anulado no se activa; `expire_due_quotes` vacía el lote y limpia
  `cron.job_run_details` de más de 7 días.

## 10. H-029 construida (2026-10-06): lo que se hizo distinto o quedó pendiente

- **Pantalla propia de enviar** (`/o/{id}/cotizaciones/{id}/enviar`), con el correo y el PDF lado a
  lado. El PDF se enmarca con el mismo endpoint interno; solo ese archivo lleva
  `X-Frame-Options: SAMEORIGIN` y `frame-ancestors 'self'` (el resto de la aplicación sigue en `DENY`).
- **«Responder a»** se sumó al contrato de correo (`replyTo`, en los adaptadores mailpit y resend):
  contacto de la organización o, si no tiene, el correo de quien envía.
- **Reenvío:** la clave del reenvío es el id del correo (`p_email_message_id = resendKey`), así un
  doble clic no crea otro. Usa el correo ACTUAL de la ficha del cliente.
- **Historial** de la cotización (solo lectura) en su pantalla, con los eventos `sent`, `send_failed`
  y `resent` que ya registran las funciones de la base.
- **Pendiente:** la tarea de reconciliación (paquetes en `ready` y correos aceptados por el
  proveedor pero no confirmados en la base: hoy se registra en el log y se avisa en pantalla; ver
  §11); los avisos simulados de rebote (`simulatedEvents`) no se aplican hasta H-033.
- **Corregido tras la revisión de Opus (2026-10-06):** el tope `quote_send_user` ya se usa (15
  envíos o reenvíos por persona cada 10 minutos, antes de tocar la base; el armado del PDF del
  envío además pasa por `consumePdfQuota`); ver §11.

## 11. Correcciones de la revisión de H-029 y trabajo que queda anotado

**Hecho en el código**

- **Envíos que sí salieron (I1).** Ante un fallo repetible del proveedor (15 s sin respuesta, red,
  proveedor caído, aceptado sin id) se reintenta hasta 3 veces con la MISMA clave anti-duplicado,
  mientras quede tiempo dentro de `maxDuration` (`src/lib/quotes/send/dispatch.ts`). Registrar que
  el correo salió (`confirm_email_dispatch`) y que falló (`fail_email_dispatch`) también se reintenta
  ante un fallo pasajero. El mensaje de «sin conexión» del primer envío ahora dice «No sabemos si
  alcanzó a salir. Presiona Enviar de nuevo…» (repetir con la misma clave es seguro). «Dirección
  rechazada» y «problema nuestro» tienen mensajes distintos.
- **Tope por persona (I2),** archivos congelados con la ruta verificada (I3, `package-paths.ts`) y
  tiempos con prueba de consistencia contra el candado de la base (I4). `maxDuration` se queda en 60 s:
  60 + 20 de margen < 120 s del candado.

**Historia pendiente — Reconciliación de envíos (antes del piloto privado; fecha propuesta
2026-11-13, a ratificar con Aarón).** Una tarea periódica (`src/server/jobs/reconcile-sends.ts`)
que: (a) marca `abandoned` los paquetes en `ready` con más de 10 minutos y avisa a Sentry; (b)
resuelve los correos que el proveedor aceptó pero la base no alcanzó a confirmar (hoy el usuario ve
«El correo salió, pero no pudimos registrarlo» y el caso queda solo en el log), consultando el estado
del mensaje en el proveedor; (c) limpia los **archivos huérfanos (M5)** del bucket `quote-documents`:
PDF y logo subidos por un envío que falló después de subir (`upload` ok, `attach` o envío fallidos)
y que ningún paquete `sent` referencia. Mientras no exista, esos archivos solo ocupan espacio y no
son visibles para nadie fuera de la organización.
