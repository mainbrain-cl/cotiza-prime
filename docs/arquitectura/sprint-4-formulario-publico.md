# Sprint 4 — Plan de construcción: formulario público y solicitudes

Diseñado por el subagente `planificador` (Opus) el 2026-10-07. Cubre H-086, H-087, H-092 y H-093 (🔒) y
H-088, H-089, H-090, H-091. Decisiones relacionadas: 017 (portero en el servidor), 018 (React Bits), 019
(anti-robot, propuesta). Entorno de trabajo: 🟢 PRUEBAS.

**El cambio de fondo:** hasta ahora desde afuera solo se podía *leer* una cotización. Aquí un desconocido
*escribe* datos personales en la base. Por eso se copia el patrón del enlace del cliente: el navegador nunca
habla con la base; habla con un portero en el servidor (`src/lib/intake/gateway.ts`) que solo llama a unas
pocas funciones `service_role`.

Decisiones de Aarón (2026-10-06): el formulario **no muestra precios ni estimado** (solo el desglose de lo que
se pide, en vivo); enlace público **e incrustable** en la v1; la solicitud llega a la organización dueña; el
comercial la convierte en cotización con un clic; **no se pide RUT**; consentimiento con fecha y versión;
anti-robot, límite de tasa por IP y por formulario, tope diario por organización y validación en servidor.

## 0. Lo que ya existe y se reutiliza

Portero y límites: `src/lib/share/gateway.ts`, `src/lib/share/public-request.ts` (`isSameOriginPost`,
`PUBLIC_RESPONSE_HEADERS`, `tooManyRequests`), `src/lib/security/login-rate-limit.ts` (`auth_rate_limits`, lista
cerrada de `scope`). Cifrado: `src/lib/crypto/pii.ts` (sello AAD tabla|tenant|id; el id lo genera la app antes
de cifrar) y `search-hash.ts`. Marca en pantalla pública: `src/lib/share/brand-vars.ts`, clase `.customer-light`,
logo como `data:`. Correo: `src/lib/email/transport.ts`, `internal-notice.ts`, `email_messages`. Cotizador:
`create_quote` (idempotente con `creation_key`), `save_quote_draft`, `createCustomer`, `findDuplicates`,
`calculateQuote`. Pruebas: `tests/isolation/registry.ts` (`ISOLATION_TABLES`, `RPC_CASES`,
`SERVER_ONLY_FUNCTIONS`, `APP_ROUTES` con `RouteScope`) y `static-guards.test.ts`.

**Hallazgos que cambian el plan:** (1) el esbozo de `modelo-datos.md` §7 trae `estimate_clp` en `requests`: se
**elimina** (no hay precios); corregir ese documento. (2) Las invitaciones llegan en el sprint 5 (H-008): para
probar «asignar» hay que agregar a `scripts/seed.ts` un Comercial activo en Negocio Demo 1 (p. ej.
`carla@ejemplo.test`). (3) `email_messages` exige hoy `quote_id` y `package_id`: hay que ampliarla para avisos
de solicitud. (4) El limitador «deja pasar si falla» (`failOpen`) no sirve para el tope diario: ese tope vive
**dentro de la transacción de la base**. (5) Hoy todas las rutas llevan `X-Frame-Options: DENY` y
`frame-ancestors 'none'`, y la CSP no tiene `frame-src`: Turnstile no cargaría en `/f/*` sin política propia.

## 1. Migraciones (un solo agente, una a la vez, cada una con deshacer que se niega a correr si hay solicitudes)

**M29 `20261007100000_intake_forms.sql`**
- `intake_forms`: `id uuid`, `tenant_id`, `unique (tenant_id, id)`; `public_id text` (único global, regla
  `^[A-Za-z0-9_-]{22}$`, 128 bits al azar generados por la base; **no es secreto**, va impreso en el QR); `name`
  (interno, 1–120), `title` (público, 1–120), `intro` (texto plano ≤1.000), `success_message` (≤500); `status`
  (`draft`, `published`, `paused`, `archived`) con `published_at`/`paused_at`; `revision int`; `fields jsonb`
  (lista cerrada validada por `app.intake_fields_valid(jsonb)`: nombre y correo siempre obligatorios; teléfono,
  empresa, comuna, dirección del servicio, fecha deseada y mensaje como `off`/`optional`/`required`; **no existe
  RUT ni preguntas libres**); `embed_origins text[]` (máx. 10; cada uno `^https://[a-z0-9.-]+(:[0-9]{1,5})?$`,
  sin comodines, rutas, espacios ni `;`; `app.embed_origins_valid(text[])`); `daily_cap int` (1–200, 50 por
  defecto); `privacy_policy_url` opcional solo `https`; `created_by`, `updated_by`, fechas. Índice `(tenant_id,
  status)`. Tope de 20 formularios por organización (constante con nombre).
- `intake_form_items`: `id`, `tenant_id`, `form_id`, `position`; `kind` (`catalog`, `free`; `calc_model`
  reservado para M16); `catalog_item_id` con relación compuesta `(tenant_id, catalog_item_id)`; `public_name`
  (1–150), `public_description` (≤500), `unit`; `quantity_mode` (`none`, `optional`, `required`),
  `min_qty_milli`, `max_qty_milli`, `is_active`. **Sin ninguna columna de precio**: al elegir un servicio del
  catálogo la app *copia* nombre, descripción y unidad (editables); lo que lee el público nunca se cruza con
  `catalog_items`.
- Funciones para miembros (`SECURITY DEFINER`, `search_path=''`, tenant solo de `app.current_tenant_id()`,
  solo Dueño/Administrador): `create_intake_form(p_form_id, p_name)`, `save_intake_form(p_form_id,
  p_expected_revision, p_form jsonb, p_items jsonb)` (`CP409` si otra pestaña guardó antes),
  `set_intake_form_status(p_form_id, p_status)` (publicar exige ≥1 ítem y correo de contacto de la
  organización), `regenerate_intake_form_public_id(p_form_id)` (invalida QR y códigos incrustados anteriores).
- Lectura RLS para todos los miembros; nadie con sesión escribe directo. Auditoría: `intake_form.created`,
  `updated`, `published`, `paused`, `archived`, `link_regenerated`, `embed_origins_changed` (lista anterior y
  nueva).

**M30 `20261007110000_intake_requests.sql`**
- `intake_requests` (se propone este nombre en vez de `requests`): `id uuid` (lo genera la app antes de
  cifrar), `tenant_id`, `form_id` (compuesta); `status` (`new`, `assigned`, `converted`, `discarded`);
  `assigned_to`, `assigned_at`, `assigned_by`; `discard_reason` (`spam`, `duplicate`, `out_of_scope`, `other`),
  `discard_note` (≤200), `discarded_by/at`; `quote_id` (compuesta), `converted_by/at`. **Cifrados** con sello
  `intake_requests.<campo>|tenant|id`: `contact_name_enc`, `contact_email_enc`, `contact_phone_enc`,
  `company_enc`, `comuna_enc`, `service_address_enc`, `message_enc`; `contact_email_hash` (misma huella
  `searchHash('email', tenant, …)` de los clientes); `desired_date date`; `items jsonb` (copia congelada
  `[{form_item_id, catalog_item_id, name, unit, quantity_milli}]`, máx. 30 ítems y 16 kB; `app.intake_items_valid`
  **rechaza cualquier clave fuera de esa lista**, así no cabe `unit_price_clp` ni «estimado»); `form_revision`;
  `submit_key uuid` (`unique (tenant_id, form_id, submit_key)`); consentimiento: `consent_template_version`,
  `consent_text_sha256`, `consented_at`, `consent_ip_enc` (opcional, ver decisión 5); `anonymized_at`,
  `created_at`.
- Guardia: el contenido no cambia después de creado; solo estados, por función, lista cerrada `new→assigned`,
  `assigned→assigned`, `new|assigned→converted|discarded`, `discarded→new`. Índices: `(tenant_id, status,
  created_at desc)`, `(tenant_id, assigned_to, status)`, `(tenant_id, contact_email_hash)`, `(tenant_id,
  form_id, created_at)`, `(created_at)` (excepción justificada: borrado por plazo). Lectura para todos los
  miembros por columnas y **sin** `consent_ip_enc`.
- `intake_daily_counters` `(tenant_id, form_id, day)` (día en hora de Chile): `accepted`, `blocked_captcha`,
  `blocked_rate`, `blocked_cap`, `blocked_paused`, `blocked_invalid`, `cap_notified_at`; solo la leen
  Dueño/Administrador; solo escriben funciones de servidor.
- `auth_rate_limits`: scopes nuevos `intake_read_ip`, `intake_submit_ip`, `intake_submit_ip_day`,
  `intake_submit_form`.
- `email_messages`: `kind` nuevos `request_assigned`, `request_received`, `intake_cap_reached`; columna
  `intake_request_id` (compuesta); `quote_id` y `package_id` pasan a poder ser nulos con regla: los tipos de
  cotización los exigen, los de solicitud exigen `intake_request_id`. (Parte más delicada: puede ir en una
  migración propia si el revisor lo prefiere.)

**M31 `20261007120000_intake_public_rpcs.sql`** (solo `service_role`)
- `intake_form_read(p_public_id)`: **solo lee**. Devuelve `state` (`ok`, `paused`, `not_found`), título,
  introducción, `fields`, ítems activos (id, nombre público, descripción, unidad, cantidad), `revision`, nombre
  y contacto de la organización, colores, `logo_path`, `privacy_policy_url`, `embed_origins`. **No devuelve**
  `catalog_item_id`, `daily_cap`, nombre interno, autor ni nada de precios. Organización archivada →
  `not_found`.
- `intake_request_submit(p_public_id, p_request_id, p_submit_key, p_form_revision, …_enc,
  p_contact_email_hash, p_desired_date, p_items, p_consent_template_version, p_consent_text_sha256,
  p_consent_ip_enc)`, en una transacción y en este orden: (1) bloquea el formulario; **el tenant sale de esa
  fila, nunca de un parámetro**; (2) misma `submit_key` → mismo resultado; (3) no publicado → `paused`; (4)
  revisión distinta → `form_changed`; (5) revalida cada `form_item_id` contra *este* formulario y reescribe
  nombre y unidad desde la base; (6) datos obligatorios; (7) topes (`daily_cap` del formulario y 300 diarias por
  organización; si se pasan suma `blocked_cap`, responde `cap_reached` y `notify_cap` solo la primera vez del
  día); (8) inserta y suma `accepted`; (9) auditoría `intake_request.received` con actor `public`.
- `intake_record_block(p_public_id, p_reason)`: solo suma al contador del día; si el id no existe no hace nada.
- `intake_notice_recipients(p_request_id, p_kind)`, `intake_notice_register`, `intake_notice_settle`: como en
  H-031 (destinatarios ya filtrados: el asignado activo, o Dueño y Administradores activos).

**M32 `20261007130000_intake_request_rpcs.sql`** (miembros)
- `assign_intake_request(p_request_id, p_assignee_user_id)`: Dueño/Administrador; el asignado debe ser miembro
  **activo** de **esta** organización con rol Dueño, Administrador o Comercial.
- `discard_intake_request(p_request_id, p_reason, p_note)` y `restore_intake_request`: Dueño, Administrador o el
  Comercial asignado.
- `convert_intake_request(p_request_id, p_customer_id, p_creation_key)`: Dueño, Administrador o Comercial (el
  Comercial solo las asignadas a él o sin asignar; en ese caso queda asignada a él). `for update`; ya
  convertida → misma cotización; descartada → `CP423`. Llama a `public.create_quote`, marca convertida, evento
  `created_from_request {request_id}` y auditoría `intake_request.converted`.
- Columna nueva `quotes.source_request_id` (compuesta) para mostrar «Solicitud original» en el editor.

**M33 `20261007140000_intake_retention.sql`**
- `app.purge_intake_data()` con `pg_cron` diario: borra `new`/`assigned` de más de 12 meses y `discarded` de
  más de 30 días; en `converted` de más de 12 meses vacía los `_enc` y marca `anonymized_at` (conserva
  servicios y fechas); borra contadores de más de 90 días; usa `app.retention_purge` como `audit_log`.

## 2. El recorrido público, sin sesión

**Qué identifica a un formulario:** un id aleatorio (`/f/Xk3…`, 22 caracteres), no un nombre legible (un
nombre revela la empresa, se puede suplantar y recorrer). Como el id es público no hace falta guardar solo su
huella. Si se llena de basura, el administrador regenera el id.

**Rutas:** `/f/[publicId]` (página), `/f/[publicId]/incrustar` (sin marco y con fondo transparente), `POST
/api/v1/public/forms/[publicId]/requests` (envío). Tipo nuevo `RouteScope = "form"` en el registro.

**Portero `src/lib/intake/gateway.ts`** (solo servidor): llama solo a `intake_form_read`,
`intake_request_submit`, `intake_record_block` y las tres funciones de avisos; descarga el logo de
`tenant-logos` comprobando que la ruta empiece por el `tenant_id` que devolvió la base; la regla del linter
sobre la llave maestra se amplía **solo** a este archivo.

**Orden del envío** (`src/lib/intake/submit-service.ts`; lo que no pasa un paso se corta ahí):
1. `isSameOriginPost` (dentro del marco incrustado el `Origin` también es el nuestro).
2. Forma del `publicId`; si no calza, 404 sin consultar la base.
3. Límite por IP: `intake_submit_ip` 5 cada 10 minutos; `intake_submit_ip_day` 20 al día; IP agrupadas como
   `ipLimitKey`; sin IP en producción → grupo «desconocida». Excedido: 429.
4. Cuerpo ≤16 kB, solo `application/json`.
5. Validación con `zod` (`submit-schema.ts`): nombre 2–120 sin caracteres de control, de dirección invertida ni
   invisibles; correo normalizado; teléfono con `normalize/phone`; mensaje ≤2.000; fecha entre hoy y un año; 1 a
   30 ítems con `parseQuantity`; errores por campo.
6. Trampas: campo oculto que una persona no llena; sello de tiempo firmado (`render-token.ts`) entregado al
   mostrar el formulario: se rechaza si pasaron menos de 3 s, más de 24 h o es de otro formulario.
7. Anti-robot (`src/lib/antibot/turnstile.ts`): consulta `siteverify` de Cloudflare (dirección fija, única
   salida permitida); además de la respuesta comprueba que `hostname` sea el de `APP_ORIGIN` y `action` =
   `intake_submit`; **si Cloudflare no responde, se bloquea**; adaptador `memory` para pruebas que
   `app-env.ts` impide en producción.
8. `intake_form_read` → con el `tenant_id` devuelto se cifra todo y se calcula la huella del correo.
9. `intake_request_submit`. Después, en segundo plano y sin afectar al visitante: aviso de solicitud nueva y,
   la primera vez del día que se llega al tope, aviso de tope.
Cada rechazo con formulario conocido suma a `intake_record_block` con su motivo.

**Doble envío:** la `submit_key` se crea una vez al cargar la página; si se corta la conexión el widget pide
otro token de Turnstile (sirve una sola vez) y reenvía con la **misma** clave.

**Cabeceras:** `/f/*` y `/api/v1/public/forms/*`: `no-store`, `noindex`, `nosniff`. `/f/[publicId]` con CSP
propia igual a la general pero con `script-src` y `frame-src` abiertos a `https://challenges.cloudflare.com`; sigue
con `frame-ancestors 'none'` y `X-Frame-Options: DENY`. `refreshSession` del `proxy` no corre en `/f/*` ni en
`/api/v1/public/*`. Sin CORS: la API solo acepta envíos de nuestro origen.

**Incrustable (H-093):** un `iframe`, no un script nuestro dentro del sitio del cliente. El código para pegar
trae `<iframe src="{APP_ORIGIN}/f/{id}/incrustar" title=… loading="lazy">` y un script de ~10 líneas escrito
**como texto** que ajusta la altura solo si el mensaje viene de `APP_ORIGIN` y de ese marco, acotada a
200–4.000 px. La página incrustada solo informa `{source:'cotiza-prime', type:'resize', height}`, nunca datos, y
no escucha mensajes de afuera. **Solo en sitios autorizados:** `X-Frame-Options` no admite lista, así que
`/incrustar` se **excluye** de la regla global de `next.config.ts` (con `source` que la excluye) y su cabecera
se arma en `src/proxy.ts`: `frame-ancestors` con solo los orígenes validados (`buildEmbedCsp()`), leídos con el
portero (`readFrameAncestors(publicId)`) y guardados 60 s en memoria; si falla la lectura o la lista está
vacía, `'none'`. **Verificar en `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
el orden de aplicación de cabeceras entre `proxy` y `next.config` en Next 16**; una prueba de punta a punta lo
confirma. Nunca se pueden incrustar `/o/*`, `/c/*`, el PDF ni `/f/[id]` sin `/incrustar` (una prueba lo
vigila). Navegadores muy antiguos sin `frame-ancestors` son un riesgo aceptado.

**Aviso de privacidad y consentimiento** (`consent-notice.ts`): texto versionado en el repositorio: «Tus datos
los recibirá {Organización} ({contacto}) para responder tu solicitud de cotización. Se guardan hasta 12 meses si
no se concreta. Puedes pedir acceso o supresión en {contacto}. Cotiza Prime los procesa por encargo de
{Organización}», más el enlace a la política de la organización si la tiene. Casilla obligatoria. **El navegador
solo manda `consent: true` y la revisión**; el servidor rearma el texto con los datos de esa revisión y guarda
versión y huella. Sin correo automático al visitante (convertiría el formulario en una máquina de enviar correos
a direcciones ajenas).

## 3. Vista previa en vivo sin precios (H-088)

Al navegador solo llega lo que devuelve `intake_form_read`: nombres públicos, descripciones, unidades y
etiquetas. El resumen se arma **solo en el navegador** con `buildRequestSummary(config, draft)`
(`src/lib/intake/summary-model.ts`, sin importar nada de dinero), sin consultar al servidor por tecla.
`src/components/intake/request-summary.tsx` es **el mismo componente** que usa la pantalla de la solicitud en la
app (una prueba compara el texto de las dos). En teléfono el resumen va debajo con un botón fijo «Ver resumen
(3)» que abre una hoja desde abajo sin desmontar los campos; el borrador no se guarda en el navegador. Marca
con `brandStyle` y `.customer-light`, sin vidrio ni fondos animados de Cotiza Prime; probar a 375 px.

## 4. Convertir en cotización, asignar y avisos (H-089, H-090)

Pantallas: `/o/[tenantId]/solicitudes` (filtros: sin asignar, asignadas a mí, convertidas, descartadas; tiempo
transcurrido; servicios pedidos) y `/o/[tenantId]/solicitudes/[requestId]` (detalle, asignar, descartar con
motivo, «Crear cotización»). Datos descifrados en el servidor; **todo lo que escribió el visitante se muestra
como texto plano** de React, nunca `dangerouslySetInnerHTML` ni `basic-format`.

**Convertir** (`src/lib/intake/convert-actions.ts`): (1) muestra el formulario de cliente existente con los datos
de la solicitud cargados; `findDuplicates` por huella del correo ofrece «usar el cliente existente»; (2) si el
cliente es nuevo, el `customerId` se genera una vez en la pantalla (un doble clic reutiliza el que ya existe) y
se vuelve a cifrar con el sello de `customers`; (3) `convert_intake_request` crea la cotización y marca la
solicitud; (4) `save_quote_draft` con las líneas de los ítems `catalog` que sigan activos (cantidad de la
solicitud, precio del catálogo actual, que la base ya revisa); los `free` no son líneas; (5) si (4) falla queda
un borrador vacío y el editor ofrece «Cargar los servicios de la solicitud» (solo si no hay líneas); (6) **el
mensaje del visitante no se copia a `observations`** (se imprime en el PDF): queda en un panel «Solicitud
original» en el editor.

**Avisos** (se propone «ambos»; pendiente §16.2 nº 5): dentro de la app, insignia en el menú con las solicitudes
nuevas y lista «asignadas a mí» (sin tabla de notificaciones); por correo (`src/lib/intake/notices.ts`):
«Te asignaron una solicitud» al asignado, «Llegó una solicitud» a Dueño y Administradores activos (máx. 20 al día
por organización), «Tu formulario llegó al tope de hoy» una vez al día. **Ningún correo lleva datos del
visitante** (solo nombre del formulario y botón a la app); cada uno queda en `email_messages`.

## 5. Código QR (H-091)

`qrcode-generator` (MIT, sin dependencias): SVG propio (solo `<svg>`, `<path>`, `<rect>`, margen de 4 módulos,
corrección M); PNG de 2048 px desde ese SVG con `sharp` (ya en el proyecto, decisión 014). Alternativa
`qrcode` (MIT, trae `pngjs` y `yargs`): verificar licencia y fijar versión antes de adoptarla y anotarla en
`DISENO.md`. Ruta `GET /api/v1/tenants/[tenantId]/intake-forms/[formId]/qr?format=svg|png`, con
`requireActiveTenant`, solo Dueño/Administrador, descarga como `attachment` con nombre saneado, SVG con la misma
política estricta que el logo. El contenido es `${getAppOrigin()}/f/${publicId}`, nunca de cabeceras. Formulario
en pausa: el QR no cambia y la página dice «no disponible» con el contacto. **Regenerar el enlace deja sin
servicio los QR impresos: la pantalla lo advierte antes de confirmar.** Prueba: decodificar el PNG con `jsqr`
(Apache-2.0, solo desarrollo).

## 6. Permisos por rol

| Acción | Dueño | Admin | Aprobador | Comercial | Observador |
|---|:-:|:-:|:-:|:-:|:-:|
| Ver formularios | ✅ | ✅ | ✅ | ✅ | ✅ |
| Crear, editar, publicar, pausar, sitios para incrustar, regenerar enlace, QR | ✅ | ✅ | — | — | — |
| Ver solicitudes con datos de contacto | ✅ | ✅ | ✅ | ✅ | ✅ |
| Asignar | ✅ | ✅ | — | — | — |
| Descartar o restaurar | ✅ | ✅ | — | solo las asignadas a él | — |
| Convertir | ✅ | ✅ | — | las suyas o sin asignar | — |
| Ver envíos bloqueados y topes | ✅ | ✅ | — | — | — |

Cada fila se verifica en la función de la base, no solo en la pantalla.

## 7. Ataques y pruebas obligatorias

**Aislamiento (`test:isolation`):** registro de las 4 tablas (contadores solo Dueño/Administrador), las 9
funciones para miembros, las 6 solo-servidor y las rutas `form`. Ataques: (1) Ana asigna/descarta/convierte una
solicitud de B y guarda/publica un formulario de B → `CP404` y B intacta; (2) asignar una solicitud de A a Beto
(solo en B) o a `ex` (quitado) → rechazado; (3) convertir con `customer_id` de B o guardar un formulario con
`catalog_item_id` de B → rechazado por la relación compuesta; (4) envío al formulario de A con `form_item_id` del
formulario de B → `invalid_items` sin guardar; (5) sin sesión, Ana o Beto llaman directo `intake_form_read` o
`intake_request_submit` → sin permiso; (6) pedir `consent_ip_enc` → error; un Comercial lee los contadores → 0
filas; (7) copiar `contact_email_enc` de B a una fila de A y descifrar → falla por el sello; (8) un `public_id`
regenerado: el viejo da `not_found`.

**Base de datos (`test:db`):** 60 envíos a la vez con tope 50 → exactamente 50 y `blocked_cap = 10`; misma
`submit_key` 20 veces → 1; 10 conversiones a la vez → 1 cotización; convertir una descartada → `CP423`; editar el
contenido como `postgres` → rechazado; `items` con `unit_price_clp` → rechazado; **recorrer todas las claves del
JSON de `intake_form_read` y que ninguna calce con `/price|cost|clp|tarif|amount|margin/i`**; sitios para
incrustar `http://…`, `*`, `https://a.cl; script-src *`, con salto de línea o más de 10 → rechazados; el cambio de
día usa hora de Chile; el borrado por plazo respeta 12 meses, 30 días y 90 días.

**Unitarias:** esquema del envío (invisibles, dirección invertida, 2.001 caracteres, correos raros); sello de
tiempo (falsificado, de otro formulario, muy rápido, vencido); Turnstile (`hostname`/`action` distintos y sin
respuesta → bloquea); `buildEmbedCsp` y el código para pegar escapan todo; QR solo con elementos permitidos;
`summary-model` sin campos de dinero.

**Punta a punta:** crear, publicar y abrir a 375 px sin desplazamiento horizontal; **ninguna respuesta de `/f/*`
contiene `$` ni los precios de la semilla** (revisar todas las respuestas de red); no se envía sin
consentimiento; confirmación en pantalla; aparece en la lista; asignar → correo en Mailpit sin datos del
visitante; convertir → borrador con líneas y cliente; nombre `<img src=x onerror=alert(1)>` y mensaje con
`<script>` se ven como texto sin alertas; la sexta solicitud seguida → 429; tope 2 → la tercera ve «no recibe
más solicitudes hoy» y el Dueño recibe un solo aviso; con la llave de prueba de Turnstile que siempre falla →
bloqueado y se cuenta; incrustable con `page.route` (`https://sitio-permitido.test` carga y ajusta altura;
`https://otro.test` no carga; en pausa muestra el aviso); `/o/*`, `/c/*` y `/f/[id]` siguen con `DENY`.

**Guardias estáticas nuevas:** 10 el portero de solicitudes solo llama a sus funciones; 10b toda ruta `form` con
POST comprueba `Origin` antes de la puerta; 10c `src/app/f/**` y `src/components/intake/**` no importan
`@/lib/money`, `quotes/calc` ni el catálogo; 10d sin `dangerouslySetInnerHTML` en lo de solicitudes; 10e
`serverLog` en `src/lib/intake/**` nunca recibe nombre, correo, IP ni `publicId`.

**Riesgos:** una competencia agotando el tope diario con captchas resueltos por servicios pagados (se mitiga
con límite por IP, aviso al tope, descartar como spam y regenerar el enlace; confirmar correo del visitante
queda como historia futura); ataque de volumen (cortafuegos de Vercel; va en la lista del piloto); al exportar a
Excel (H-074) escapar textos del visitante que empiecen con `= + - @`.

## 8. División del trabajo (decisión 013: máximo 2 agentes; las 🔒, solas)

| # | Tarea | Agente |
|---|---|---|
| 1 | M29 → M33 (deshacer, pruebas de base, registro, semilla con un Comercial activo) | Un Sonnet, una migración a la vez |
| 1b | Piezas sin base de datos: `antibot/*`, `render-token`, `submit-schema`, `summary-model`, `embed.ts`, `consent-notice`, `qr.ts` + unitarias | Sonnet, en paralelo con 1 |
| R1 | Revisión de M29–M33 | Opus |
| 2 | 🔒 **H-086**: constructor, vista previa con marca, publicar y pausar | Sonnet solo; revisión Opus aparte |
| 3 | 🔒 **H-087**: portero, envío, página pública, consentimiento. **Incluye desde el inicio Turnstile, límites y tope en la base** (un formulario público nunca existe sin protección) | Sonnet solo; revisión Opus aparte |
| 4 | H-088 (resumen en vivo) ‖ H-089 (lista, asignar, descartar, avisos) | 2 Sonnet en paralelo |
| 5 | 🔒 **H-092**: pantalla de bloqueados, aviso de tope, ajuste del tope, guardias 10–10e | Sonnet solo; revisión Opus aparte |
| 6 | 🔒 **H-093**: `/incrustar`, `proxy.ts`, `next.config.ts`, código para pegar, sitios autorizados | Sonnet solo; revisión Opus aparte |
| 7 | H-090 (convertir) ‖ H-091 (QR) | 2 Sonnet; revisión Opus en lote con H-088 y H-089 |

Al cerrar el sprint actualizar `modelo-datos.md` (§4.6, §7 sin `estimate_clp`), la tabla de librerías de
`DISENO.md` y `PROYECTO.md` §16.2 nº 16.

## 9. Qué NO hacer

Llamar a la base desde el navegador o dejar alguna función ejecutable para `anon`; recibir el `tenant_id` como
parámetro en el envío; leer `catalog_items` desde la parte pública o mandar cualquier monto «y ocultarlo» en la
pantalla; campos de texto libre definidos por el administrador o un campo RUT; copiar el mensaje del visitante
a campos que salen en el PDF, a correos o a logs; responder con un correo automático al visitante; usar
`X-Frame-Options: ALLOWALL` o `frame-ancestors *`; dar como código para pegar un `<script src>` nuestro; que el
tope diario dependa del limitador «deja pasar si falla»; generar el QR con una dirección sacada de cabeceras.

## 10. Decisiones para Aarón (con el supuesto que se aplica mientras tanto)

1. **Anti-robot:** Cloudflare Turnstile (gratis, sin librería; Cloudflare recibe IP y datos del navegador:
   subencargado con transferencia a EE. UU.). Alternativa ALTCHA (MIT, en nuestro servidor, sin terceros, más
   débil). Si Cloudflare no responde, se bloquea. *Propuesta: Turnstile, decisión 019.*
2. **Identificador del formulario:** id aleatorio. *Aplicado.*
3. **Dominio:** lo que una empresa pegue en su web apunta a nuestro dominio; si cambia, se rompen formularios
   incrustados y QR impresos. La decisión de dominio debe estar resuelta **antes del piloto**.
4. **Aviso de privacidad del formulario:** el texto propuesto lo debe revisar el abogado; para publicar la
   organización necesita un correo de contacto.
5. **Plazos de conservación:** no convertidas 12 meses; descartadas 30 días; convertidas se anonimizan a los 12
   meses; contadores 90 días; **IP del consentimiento** cifrada 12 meses o no guardarla (*propuesta: guardarla
   cifrada y no ponerla en la auditoría*).
6. **Topes:** 50 por formulario al día (el administrador sube hasta 200), 300 por organización; por IP 5 cada 10
   minutos y 20 al día.
7. **Avisos:** dentro de la app más correo (asignación, solicitud nueva hasta 20 al día, tope alcanzado), sin
   datos del visitante; sin respuesta automática al visitante.
8. **Quién hace qué:** asignan Dueño y Administrador; el Comercial convierte las suyas o las sin asignar y
   descarta las suyas.
9. **RUT y preguntas libres:** el formulario no pide RUT ni permite preguntas propias; H-086 decía «me advierte
   si pido RUT» y ahora dice «no se puede pedir RUT y se explica por qué» (corregido).
10. **Nombre de la tabla:** `intake_requests` en vez de `requests`.

## 11. Correcciones de la revisión de las migraciones

Opus revisó las migraciones 29 a 33. Todo lo corregido va en la **migración 34**
(`20261007150000_intake_review_fixes.sql`, con su deshacer). Pruebas nuevas en `tests/db/intake-*.test.ts` y en
el registro de aislamiento.

### Importantes

| # | Hallazgo | Qué se corrigió |
|---|---|---|
| I1 | El consentimiento no se podía comprobar después (solo se guardaba la huella) | `intake_requests.consent_text` (1 a 3.000 caracteres, sin caracteres invisibles ni de control) y la regla `consent_text_sha256 = sha256(consent_text)` en la tabla. El envío recibe el texto (cambia la firma: el parámetro 16 pasa de la huella al texto) y **la base calcula la huella**. La versión queda con formato fijo `intake-v<n>`. Las filas anteriores no tienen el texto: se marcan `consent_text_unavailable = true` (no se inventa ninguno) y quedan exentas del formato de versión. El texto solo puede llevar datos de la organización: el portero lo arma con la plantilla fija y nunca con algo que escribió el visitante (ver «Recordatorios para el portero») |
| I2 | Faltaba el derecho de supresión para solicitudes que no son «convertidas con 12 meses» | `anonymize_intake_request(p_request_id, p_reason)` para Dueño y Administrador, en **cualquier estado**: vacía los datos de contacto cifrados, mensaje, dirección, huella del correo y la IP del consentimiento, y marca `anonymized_at`. Conserva servicios, fechas, responsable, vínculo con la cotización y el texto y la huella del consentimiento. Es idempotente, deja `intake_request.anonymized` en la auditoría (solo motivo y estado, sin datos personales) y la guarda de la tabla lo permite únicamente con el interruptor interno que enciende esa función, y solo para vaciar. El motivo es de una lista cerrada (`data_subject_request`, `wrong_data`, `other`) |
| I3 | `convert_intake_request` podía amarrar la solicitud a una cotización que no era la recién creada | Después de `create_quote`, la cotización devuelta tiene que estar en borrador y sin solicitud de origen; si no, `CP422 creation_key_reused` y no se cambia nada. **Límite conocido:** una cotización borrador y sin vincular que la misma persona creó antes con esa misma clave sí pasa (no se puede distinguir de una recién creada sin cambiar `create_quote`) |

### Menores (14)

| # | Tema | Estado |
|---|---|---|
| 1 | `intake_record_block` | **Corregido.** Solo acepta `captcha`, `rate` e `invalid`, y solo para formularios publicados o en pausa. El tope y la pausa ya se cuentan dentro del envío |
| 2 | `intake_notice_register` | **Corregido.** Usa la misma regla de destinatarios que `intake_notice_recipients` (una sola función, `app.intake_notice_audience`): asignado si sigue activo, o Dueño y Administradores. Si no es destinatario, `42501`. Si el identificador del aviso ya es de otra fila (otra solicitud, otro tipo, otro destinatario u otra organización), devuelve `registered:false, reason:'id_in_use'`; un reintento idéntico sigue devolviendo `registered:true` |
| 3 | Tope de 20 avisos al día | **Corregido.** `pg_advisory_xact_lock` por organización y tipo, al contar y al registrar |
| 4 | Avisos y organización activa | **Corregido.** Si la organización no está activa, no hay destinatarios y el registro devuelve `registered:false, reason:'tenant_inactive'` |
| 5 | Aviso del tope | **Corregido.** El resultado trae `cap_kind` (`form` \| `org`). El del formulario avisa una vez por formulario y día; el de la organización, **una vez por organización y día** (columna nueva `intake_daily_counters.org_cap_notified_at`). Si se cumplen los dos topes, manda el del formulario |
| 6 | Auditoría del envío | **Corregido.** Lleva el identificador de correlación de `x-cp-request-id` (como `write_audit`); sigue sin IP |
| 7 | `revision` de `save_intake_form` | **Corregido.** Solo sube si cambia lo que ve el público: título, introducción, mensaje de éxito, campos, política de privacidad y servicios (los activos y lo que de ellos se muestra). No sube por el nombre interno, el tope diario ni los sitios autorizados, ni por guardar lo mismo. **Consecuencia aceptada:** dos pestañas que cambian solo cosas internas ya no chocan (`CP409`) entre sí |
| 8 | Servicios inactivos del catálogo | **Corregido.** `catalog_item_inactive` (`CP422`) al agregar o cambiar un servicio activo con un servicio de catálogo inactivo. Uno que el formulario ya traía con ese mismo servicio no impide guardar otros cambios (si no, desactivar un servicio del catálogo bloquearía todo el formulario) |
| 9 | Borrado de avisos en `email_messages_guard` | **Corregido.** Solo en la limpieza por plazo y solo si la solicitud del aviso ya venció (nuevas o asignadas de más de 12 meses, o descartadas de más de 30 días): la misma regla con que se borra la solicitud |
| 10 | Constancia de la limpieza | **Corregido.** `purge_intake_data` deja una fila `intake_retention.purged` por organización afectada (actor `system`; solo cantidades) y se agregó el índice parcial `(discarded_at) where status = 'discarded'`. Se eligió la auditoría porque su tabla exige `tenant_id`: no hay una fila «global» |
| 11 | Recordatorios para el portero de H-087 | **No es de la base.** Quedan anotados abajo |
| 12 | Borradores futuros | **Sin cambios en la base:** son ideas para más adelante, no defectos de lo construido |
| 13 | `app.business_date_of` | **Corregido.** Pasa de `immutable` a `stable` (depende de `now()` en los usos y de la zona horaria) |
| 14 | `docs/HISTORIAS.md` | **Corregido.** H-086: «el sistema me sugiere lo mínimo; no se puede pedir RUT y se explica por qué» |

### Recordatorios para el portero de H-087

- Mandar a `intake_request_submit` el **texto exacto** del aviso de privacidad que se mostró, armado solo con la
  plantilla fija y datos de la organización (nombre, contacto, dirección de su política); jamás con algo que
  escribió el visitante. Versión en formato `intake-v<n>`. La huella no se manda: la calcula la base.
- Reenviar `x-cp-request-id` (identificador de la petición) en las llamadas, para que la auditoría quede
  correlacionada.
- Llamar a `intake_record_block` solo con `captcha`, `rate` o `invalid`; el tope y la pausa los cuenta el envío.
- Con `cap_reached`, usar `cap_kind` para el texto del aviso: `form` dice «tu formulario llegó al tope de hoy»; `org`
  dice que la organización llegó a su tope diario. Avisar solo si `notify_cap` es verdadero.
- Respetar `registered:false` de `intake_notice_register` (`daily_limit`, `tenant_inactive`, `id_in_use`): no enviar el
  correo en esos casos.
- Una solicitud anonimizada (`anonymized_at` no nulo) no tiene datos de contacto: la pantalla debe mostrarla como
  «datos eliminados» y no ofrecer convertirla ni avisar por correo.

### Fuera de este cambio

- `convert_intake_request` y `assign_intake_request` aceptan hoy una solicitud ya anonimizada (no se pidió
  tocarlas). La pantalla debe impedirlo; si se quiere también en la base, es una corrección chica para la próxima
  migración.
