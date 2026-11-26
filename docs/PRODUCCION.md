# Guía de salida a producción del MVP

Pasos en el orden real para dejar Cotiza Prime en línea según la **decisión 023** (Supabase gratis con un proyecto de pruebas y
uno de producción en São Paulo, Vercel en el equipo `mb`, Resend gratis, Turnstile solo con sus claves, sin Sentry). Cada
paso se hace **primero en pruebas y después en producción**.

En los ejemplos, el dominio de producción es `cotizaprime.mainbrain.cl` y el de pruebas `pruebas.cotizaprime.mainbrain.cl`
(cambiarlos si JC elige otro). `<ref>` es el identificador del proyecto de Supabase (20 letras y números).

## Bloqueos encontrados

Se encontraron leyendo el código el 2026-11-26. No se arreglaron en esta guía: hay que resolverlos antes del paso 2.4.

- [ ] **La política de privacidad nombra a Sentry como proveedor**, y la 023 pide quitar esa mención:
      `src/content/legal/privacy.md:82`. Cambiar el texto cambia su huella, así que exige una versión nueva:
      `CURRENT_LEGAL_VERSION` y su fecha en `src/lib/legal/documents.ts:19-20`, una migración nueva que inserte la versión en
      `legal_documents` (como `supabase/migrations/20261001130000_legal_documents_seed.sql`) y la prueba
      `tests/db/legal-seed.test.ts`. Conviene hacerlo **antes** del primer `db push` a producción, para que nadie acepte la
      versión vieja. En la misma pasada se pueden completar las regiones de la tabla de proveedores (`privacy.md:80-83`:
      Supabase en São Paulo, Resend, Vercel).
- [ ] **Los términos y la privacidad todavía muestran «[POR COMPLETAR]»** a quien se registra (no impide usar la aplicación,
      pero se ve): `src/content/legal/privacy.md:7`, `:9`, `:72`, `:80-83` y `src/content/legal/terms.md:7`, `:80`, `:87`.
      Aarón decide si se completan antes de la presentación (también exige versión nueva, como el punto anterior).

## 0. Antes de empezar

- [ ] Leer la tabla de variables (al final) y tener a mano un **gestor de contraseñas** del proyecto (lo custodia José,
      decisión 023). Todo secreto que se genere o se copie de un panel se guarda **primero ahí** y después se pega en Vercel.
- [ ] En la máquina de quien opera: Node 24, `npm ci` hecho en el repositorio, y `pg_dump` **versión 17** (la base es
      PostgreSQL 17; en macOS `brew install postgresql@17`).
- [ ] Nunca pegar un secreto en un comando (queda en el historial). Para generar uno sin que quede en pantalla:
      `openssl rand -base64 32 | pbcopy` (44 caracteres = 32 bytes en base64; sirve para todas las claves generadas de la tabla).

## 1. Cuentas

- [ ] **1.1** Crear el correo propio del proyecto (alias de Main Brain o Gmail). Con él se crean Supabase, Resend y
      Cloudflare. Guardar el acceso en el gestor.
- [ ] **1.2** Confirmar que el repositorio es `github.com/mainbrain-cl/cotiza-prime` y que el equipo `mb` de Vercel tiene
      acceso a esa organización de GitHub.
- [ ] **1.3** Definir el dominio con JC (o usar el subdominio de `mainbrain.cl`) y saber quién maneja el DNS de ese dominio:
      los pasos 3, 4 y 5 agregan registros ahí.

## 2. Supabase (pruebas y producción)

### 2.1 Crear los proyectos

- [ ] Crear **dos proyectos** en el plan gratis, región **South America (São Paulo) `sa-east-1`**: `cotiza-prime-pruebas` y
      `cotiza-prime`. Contraseña de la base larga y aleatoria, guardada en el gestor.
- [ ] De cada uno, anotar en el gestor (Project Settings → API Keys / Data API): la **Project URL**, la llave pública
      (`anon`) y la llave maestra (`service_role`), el `<ref>` y la dirección del **Session pooler** (botón «Connect»; la
      conexión directa es solo IPv6). Usar las llaves «legacy» `anon` y `service_role` si el panel las ofrece (son las que
      se probaron; ver «Lo que no se pudo verificar»).

### 2.2 Ajustes de Auth del panel

Se dejan **a mano** en cada proyecto (`supabase/config.toml` solo vale para la base local). La columna «Guion» dice si lo
revisa `npm run check:auth-config` (paso 7.1) o si queda a mano. Los nombres del panel pueden variar un poco.

| #   | Dónde (panel)                         | Ajuste                                                                                                                 | Guion   |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Authentication → Sign In / Providers  | «Allow new users to sign up»: **apagado** (el registro lo hace nuestro servidor)                                       | Sí      |
| 2   | Sign In / Providers → Email           | Proveedor Email **encendido** (es el ingreso con contraseña y la recuperación)                                         | Sí      |
| 3   | Sign In / Providers → Email           | «Confirm email»: **encendido**                                                                                          | Sí      |
| 4   | Sign In / Providers → Email           | «Secure email change»: **encendido**                                                                                    | Sí      |
| 5   | Sign In / Providers → Email           | «Secure password change»: **encendido**                                                                                 | Sí      |
| 6   | Sign In / Providers → Email           | Largo mínimo de contraseña: **10**                                                                                      | Sí      |
| 7   | Sign In / Providers → Email           | «Email OTP Length»: **10**; «Email OTP Expiration»: **3600** s                                                         | Sí      |
| 8   | Sign In / Providers                   | Ingreso anónimo y «manual linking»: **apagados**                                                                        | Sí      |
| 9   | Sign In / Providers                   | Teléfono, SAML, Web3 (Solana y Ethereum) y **todos** los proveedores externos (Google, GitHub, Apple…): **apagados**   | Sí      |
| 10  | Sign In / Providers                   | Passkeys: **apagadas**                                                                                                  | A mano  |
| 11  | Authentication → Multi-Factor         | App de códigos (TOTP): **encendida**. Teléfono y WebAuthn: **apagados**                                                 | En parte (teléfono y WebAuthn) |
| 12  | Authentication → Sessions / JWT       | Pase de **900 s**; rotación del pase de renovación **encendida** con intervalo de **10 s**                              | Sí      |
| 13  | Authentication → Sessions             | Duración máxima 168 h e inactividad 12 h: **solo en plan Pro**. En el plan gratis el guion las marca como falla: aceptado por la 023 | Sí      |
| 14  | Authentication → Emails → SMTP        | SMTP propio con Resend (paso 4.5), remitente «**Cotiza Prime**» y correo `no-responder@<dominio de envío>`             | En parte (solo que haya SMTP) |
| 15  | Authentication → Emails → Templates   | Cargar las plantillas de `supabase/templates/` con su asunto (tabla de abajo)                                          | A mano  |
| 16  | Emails → Security notifications       | «Password changed» **encendido** con su plantilla; «MFA factor enrolled» **apagado** (ese aviso lo manda nuestro servidor); el resto apagado | A mano  |
| 17  | Authentication → URL Configuration    | **Site URL** = `https://cotizaprime.mainbrain.cl` (en pruebas, la de pruebas), sin `localhost`                          | Sí (solo que exista) |
| 18  | Authentication → URL Configuration    | **Redirect URLs**: solo `https://<dominio>/auth/recuperar` y `https://<dominio>/auth/callback`, sin comodines ni `localhost` | A mano  |
| 19  | Authentication → Hooks                | Ningún gancho activo                                                                                                    | Sí      |
| 20  | Authentication → Attack Protection    | Protección de contraseñas filtradas: solo plan Pro; fuera del MVP                                                       | A mano  |

Plantillas (copiar el HTML del archivo y el asunto tal cual):

| Plantilla del panel        | Archivo                                                 | Asunto                                                  |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| Confirm signup             | `supabase/templates/signup_link_unavailable.html`       | Pide tu enlace para crear tu cuenta en Cotiza Prime     |
| Invite user                | `supabase/templates/signup_link_unavailable.html`       | Pide tu enlace para crear tu cuenta en Cotiza Prime     |
| Change email address       | `supabase/templates/email_change_unavailable.html`      | El cambio de correo no está disponible en Cotiza Prime  |
| Reset password             | `supabase/templates/recovery.html`                      | Elige una contraseña nueva en Cotiza Prime              |
| Password changed (aviso)   | `supabase/templates/password_changed_notification.html` | Se guardó la contraseña de tu cuenta de Cotiza Prime    |

- [ ] **2.2.a** Dejar los 20 ajustes y las 5 plantillas en **pruebas**.
- [ ] **2.2.b** Lo mismo en **producción**.

### 2.3 Migraciones en pruebas

Las 59 migraciones de `supabase/migrations/` se aplican en orden sobre la base vacía, antes de abrir el tráfico
(`docs/arquitectura/modelo-datos.md` §9.4). La CLI corre cada archivo en una transacción, así que el `lock_timeout` de las
migraciones vale.

- [ ] `npx supabase login` (abre el navegador; el token queda en esa máquina, nunca en el repositorio).
- [ ] `npx supabase link --project-ref <ref de pruebas>` (pide la contraseña de la base).
- [ ] `npx supabase db push --dry-run` → debe listar las 59.
- [ ] `npx supabase db push`.
- [ ] Comprobar en el editor SQL del panel:
  - `select kind, version, is_current from public.legal_documents;` → `terms` y `privacy` vigentes (la semilla legal va en
    una migración; **no** existe otra semilla para producción).
  - `select jobname, schedule from cron.job;` → `expire-quotes`, `purge-intake-data` y `purge-invitations`.
  - `select id from storage.buckets;` → `tenant-logos` y `quote-documents`.
  - `select tgname from pg_trigger where tgrelid in ('auth.users'::regclass, 'auth.mfa_factors'::regclass) and not tgisinternal;`
    → `on_auth_user_created`, `forbid_email_change` y `mfa_factor_verify_gate`.
- [ ] Si una migración falla (por ejemplo, un permiso sobre el esquema `auth` en Supabase alojado): **detenerse**, no editar
      la migración ni aplicarla a mano, y avisar.

**Nunca** contra un proyecto alojado: `npm run db:seed` (datos de prueba; además se niega), `supabase db reset --linked`,
`supabase db push --include-seed` ni `supabase config push` (subiría la configuración local, con `localhost`).

### 2.4 Migraciones en producción

- [ ] Resolver antes los «Bloqueos encontrados».
- [ ] **Respaldo manual antes de migrar** (la primera vez la base está vacía, pero se deja el hábito). Fuera del repositorio,
      sin la contraseña en la dirección (`pg_dump` la pide):
      `pg_dump "postgresql://postgres.<ref>@<host del session pooler>:5432/postgres" -Fc -f ~/respaldos-cotiza-prime/prod-$(date +%Y%m%d-%H%M).dump`
- [ ] `npx supabase link --project-ref <ref de producción>` → `npx supabase db push --dry-run` → `npx supabase db push`.
- [ ] Las mismas comprobaciones del paso 2.3.
- [ ] Volver a enlazar pruebas (`npx supabase link --project-ref <ref de pruebas>`) para no migrar producción por error la
      próxima vez.

## 3. Vercel

- [ ] **3.1** En el equipo `mb`: «Add New → Project» → importar `mainbrain-cl/cotiza-prime`. Framework Next.js, comandos por
      defecto (`npm ci`, `next build`). **No desplegar todavía** (sin variables, la aplicación no arranca).
- [ ] **3.2** Settings → Build and Deployment → **Node.js 24.x**. Settings → Git → rama de producción **`main`**.
- [ ] **3.3** Settings → Functions → región **São Paulo (`gru1`)**, junto a Supabase.
- [ ] **3.4** Settings → Environment Variables: cargar la tabla de variables, cada una **en su entorno** (Production con
      las de producción; Preview con las de pruebas) y las secretas marcadas **Sensitive**. Una variable Sensitive no se
      puede volver a leer en Vercel: la copia que vale es la del gestor.
- [ ] **3.5** Settings → Domains: agregar `cotizaprime.mainbrain.cl` a Production. Para pruebas, agregar
      `pruebas.cotizaprime.mainbrain.cl` asignado a **Preview** con una rama fija (por ejemplo `pruebas`). Crear en el DNS
      el registro que muestra Vercel (normalmente un `CNAME` a `cname.vercel-dns.com`).
- [ ] **3.6** Deployment Protection: la protección de Vercel en las vistas previas bloquea el enlace del cliente y los avisos
      de Resend en pruebas. Si se va a probar el recorrido completo en el dominio de pruebas, desactivarla para ese dominio.
- [ ] **3.7** Tarea programada: `vercel.json` ya programa `GET /api/v1/jobs/invitation-notices` una vez al día
      (`0 12 * * *`, UTC), lo único que admite el plan gratis. Solo corre en producción y solo con `CRON_SECRET` (si falta,
      la ruta responde 404).
- [ ] **3.8** `maxDuration = 60` lo declaran `src/app/api/v1/jobs/invitation-notices/route.ts`,
      `src/app/o/[tenantId]/cotizaciones/[quoteId]/enviar/page.tsx`, `src/app/(auth)/ingresar/page.tsx`,
      `src/app/(auth)/ingresar/codigo/page.tsx`, `src/app/(auth)/crear-cuenta/page.tsx`, `src/app/cuenta/seguridad/page.tsx` y
      `src/app/cuenta/anular-dos-pasos/page.tsx`. 60 s cabe en el plan gratis; no hay que configurar nada.

## 4. Resend y DNS

- [ ] **4.1** Crear la cuenta con el correo del proyecto. Domains → Add domain: el dominio de envío (por ejemplo
      `cotizaprime.mainbrain.cl`), región São Paulo si la ofrece. El plan gratis permite **un** dominio: lo comparten
      pruebas y producción.
- [ ] **4.2** Agregar en el DNS los registros que muestra Resend (MX y TXT de SPF en `send.<dominio>`, TXT de DKIM en
      `resend._domainkey.<dominio>`) y un **DMARC**: TXT en `_dmarc.<dominio>` con `v=DMARC1; p=none;`. Esperar «Verified».
- [ ] **4.3** En el dominio → Configuration: **Click tracking y Open tracking apagados** (si no, los enlaces del correo
      pasan por un redirector y se rompen el de anular el segundo paso y los de un solo uso).
- [ ] **4.4** API Keys (todas «Sending access», limitadas al dominio): `cotiza-prime-produccion`, `cotiza-prime-pruebas`,
      `supabase-smtp-produccion`, `supabase-smtp-pruebas`. Las dos primeras van a `RESEND_API_KEY` de cada entorno.
- [ ] **4.5** SMTP de Supabase (ajuste 14 del paso 2.2), en cada proyecto: host `smtp.resend.com`, puerto `465`, usuario
      `resend`, contraseña = la llave `supabase-smtp-…` de ese entorno, remitente `no-responder@<dominio>` con nombre
      «Cotiza Prime».
- [ ] **4.6** Webhooks → Add endpoint: `https://cotizaprime.mainbrain.cl/api/v1/webhooks/email/resend` con los eventos
      `email.delivered`, `email.bounced` y `email.complained`. Su «Signing secret» (`whsec_…`) va a `EMAIL_WEBHOOK_SECRET` de
      Production. Otro igual para el dominio de pruebas (Preview). Se puede crear antes del primer despliegue, y hay que
      hacerlo: sin ese secreto la aplicación no arranca en producción.
- [ ] **4.7** Límite del plan gratis: 100 correos al día **en total** (pruebas, producción y los de Supabase). Para la demo
      alcanza; si se acaba, nadie recibe el enlace de registro ni el de recuperar la contraseña hasta el día siguiente.

## 5. Cloudflare Turnstile

- [ ] **5.1** Crear la cuenta de Cloudflare con el correo del proyecto (no hace falta tener el dominio en Cloudflare).
- [ ] **5.2** Turnstile → Add widget: «Cotiza Prime producción», hostname `cotizaprime.mainbrain.cl`, modo **Managed**. La
      **Site Key** va a `NEXT_PUBLIC_TURNSTILE_SITE_KEY` y la **Secret Key** a `TURNSTILE_SECRET_KEY` (Sensitive), en
      Production.
- [ ] **5.3** Otro widget «Cotiza Prime pruebas» con `pruebas.cotizaprime.mainbrain.cl`, para Preview.
- [ ] **5.4** `ANTIBOT_PROVIDER=turnstile` en los dos entornos. Se lee **al compilar** (arma la política de seguridad de
      `/registro` y `/f/*`): si se cambia, volver a desplegar.

## 6. Primer despliegue

- [ ] **6.1** Con todas las variables cargadas: Deployments → desplegar `main` (o «Redeploy» sin caché si ya hubo uno).
- [ ] **6.2** Si todo responde 500, mirar los registros de la función en Vercel: `EmailConfigError` o `AntibotConfigError`
      nombran la variable que falta (`src/instrumentation.ts` no deja arrancar producción sin correo y anti-robot reales).
- [ ] **6.3** `https://cotizaprime.mainbrain.cl/api/v1/ping` responde `{"ok":true}`. La franja **PRUEBAS** no aparece en
      producción y sí en pruebas.
- [ ] **6.4** Vercel → Settings → Cron Jobs → «Run» sobre la tarea: responde 200 (con 404, falta `CRON_SECRET` o es corto).
- [ ] **6.5** Desplegar también pruebas (rama de Preview) y repetir 6.2 y 6.3 ahí.

## 7. Verificación antes de que entre un cliente

Primero en pruebas y después en producción, con correos reales propios.

- [ ] **7.1** En la máquina de quien opera, con un token personal de Supabase (Account → Access Tokens; nunca en el repo):
      `SUPABASE_ACCESS_TOKEN=… npm run check:auth-config -- --url https://<ref>.supabase.co --anon-key <llave pública> --ref <ref>`.
      Todo en verde salvo las dos reglas de sesión del ajuste 13 (plan gratis). Revisar a mano lo que el guion lista como
      «A MANO» y guardar la salida.
- [ ] **7.2** Registro en dos pasos en `/registro` con un correo real: aparece Turnstile, llega «Confirma tu correo…» (no a
      spam, remitente correcto, el enlace apunta al dominio de la aplicación y no a un redirector), «Continuar», nombre,
      contraseña y términos en `/crear-cuenta`.
- [ ] **7.3** Crear la organización.
- [ ] **7.4** Catálogo: crear un servicio con precio.
- [ ] **7.5** Clientes: crear un cliente con otro correo real propio.
- [ ] **7.6** Cotización: crearla con ese cliente, agregar el servicio, «Guardar» y ver el PDF.
- [ ] **7.7** Enviar: llega el correo con el PDF adjunto; el botón abre el enlace del cliente (`/c/…`).
- [ ] **7.8** Desde el teléfono, en el enlace: **aceptar**. Con una segunda cotización: **rechazar** eligiendo un motivo.
- [ ] **7.9** En la aplicación: el estado de cada cotización cambió y su línea de tiempo muestra creada, enviada, vista y
      aceptada o rechazada. La insignia dice «Correo entregado» (prueba de que el webhook de Resend llega).
- [ ] **7.10** «¿Olvidaste tu contraseña?»: llega el correo en español, de «Cotiza Prime», y el enlace termina en
      `/auth/recuperar` y deja elegir la contraseña nueva.
- [ ] **7.11** Solo en producción, antes de dar acceso a alguien: `select count(*) from auth.users where email_confirmed_at is null;`
      en el editor SQL (solo lectura), y anotar el resultado junto a la salida de 7.1.

### Si el proyecto gratis se pausa

Supabase pausa un proyecto gratis tras **7 días sin uso**: la aplicación responde con errores y nadie puede entrar.

- [ ] Antes de una demo o de un periodo de uso, abrir el panel de Supabase y comprobar que ambos proyectos estén activos.
- [ ] Si está pausado: en el panel, «Restore project» (tarda unos minutos; los datos se conservan). Después, repetir 6.3.

## 8. Fuera del MVP (se revisa antes del lanzamiento público, decisión 023)

- Plan Pro de Supabase (respaldos automáticos con restauración probada, sesiones con tope, contraseñas filtradas, sin pausa) y medir sus cupos de ingreso y verificación.
- Sentry y alertas (incluidas las de `invitation_notice_failed` y `session.mfa_annul_warning`), y límite de tasa en el Firewall de Vercel para `/api/v1/jobs/*`.
- Revisión del abogado de términos, privacidad y acuerdo de tratamiento, con los «[POR COMPLETAR]» resueltos.
- Verificación en dos pasos obligatoria (H-004c), H-114, H-117, H-119 y H-120, y lo de `docs/seguridad-pendiente.md`.
- Listas de salida de `SEGURIDAD.md` §11 y `LEGAL.md` §6, plan pagado de Resend y tarea de avisos cada hora (Vercel Pro).

## Variables de entorno

Leídas en `src/` y `next.config.ts` (verificado el 2026-11-26). «Sensitive» = secreta: se marca así en Vercel y vive en el
gestor. Cada entorno tiene **sus propios valores**: nunca la misma clave en pruebas y producción.

| Variable                          | Para qué                                                                                                   | Secreta   | De dónde sale                                                                    | Production                    | Preview (pruebas)                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `NEXT_PUBLIC_APP_ENV`             | Entorno; solo `production` exacto quita la franja PRUEBAS y activa los controles de arranque. Se fija al compilar | No        | Se escribe                                                                       | `production`                  | `test`                                                   |
| `NEXT_PUBLIC_SUPABASE_URL`        | Dirección del proyecto de Supabase (también entra en la política de seguridad al compilar)                 | No        | Supabase → Project URL                                                           | La de producción              | La de pruebas                                            |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`   | Llave pública de Supabase                                                                                  | No        | Supabase → API Keys → `anon`                                                     | Sí                            | Sí                                                       |
| `SUPABASE_SERVICE_ROLE_KEY`       | Llave maestra (solo servidor; se salta la seguridad por fila)                                              | **Sí**    | Supabase → API Keys → `service_role`                                             | Sí                            | Sí                                                       |
| `CP_PII_KEY_CURRENT`              | Versión de la clave con que se cifra lo nuevo                                                              | No        | Se escribe                                                                       | `v1`                          | `v1`                                                     |
| `CP_PII_KEY_V1`                   | Cifrado de datos personales (AES-256-GCM). **Exactamente 32 bytes en base64**                              | **Sí**    | `openssl rand -base64 32`                                                        | Sí                            | Sí (otra)                                                |
| `CP_SEARCH_KEY_V1`                | Huellas de búsqueda (RUT, correo), límites de intentos y códigos de respaldo. 32 bytes en base64, distinta de la anterior | **Sí**    | `openssl rand -base64 32`                                                        | Sí                            | Sí (otra)                                                |
| `APP_ORIGIN`                      | Dirección pública para los enlaces de los correos, sin barra final. Obligatoria en producción              | No        | Se escribe                                                                       | `https://cotizaprime.mainbrain.cl` | `https://pruebas.cotizaprime.mainbrain.cl`          |
| `EMAIL_PROVIDER`                  | Proveedor de correo; `mailpit` y `memory` no arrancan en producción                                        | No        | Se escribe                                                                       | `resend`                      | `resend`                                                 |
| `EMAIL_FROM_ADDRESS`              | Remitente de los correos de la aplicación (el nombre visible es el de cada organización)                   | No        | Dirección del dominio verificado en Resend                                       | p. ej. `cotizaciones@cotizaprime.mainbrain.cl` | La misma                              |
| `RESEND_API_KEY`                  | Envío por Resend                                                                                           | **Sí**    | Resend → API Keys (paso 4.4)                                                     | `cotiza-prime-produccion`     | `cotiza-prime-pruebas`                                   |
| `EMAIL_WEBHOOK_SECRET`            | Firma de los avisos de entrega y rebote (mínimo 16). Obligatoria en producción: sin ella no arranca        | **Sí**    | Resend → Webhooks → Signing secret (paso 4.6)                                    | Sí                            | Sí (el del webhook de pruebas)                           |
| `EMAIL_ALLOWED_RECIPIENT_DOMAINS` | Fuera de producción, solo se envía a estos dominios (por defecto `ejemplo.test`, que no existe)            | No        | Se escribe                                                                       | **No definir**                | Los dominios de quienes prueban, p. ej. `mainbrain.cl,gmail.com` |
| `ANTIBOT_PROVIDER`                | Proveedor anti-robot, obligatorio y sin valor por defecto. Se usa al compilar                              | No        | Se escribe                                                                       | `turnstile`                   | `turnstile`                                              |
| `TURNSTILE_SECRET_KEY`            | Verificación de Turnstile en el servidor                                                                   | **Sí**    | Cloudflare → Turnstile → Secret Key                                              | Widget de producción          | Widget de pruebas                                        |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`  | Clave pública del widget                                                                                   | No        | Cloudflare → Turnstile → Site Key                                                | Widget de producción          | Widget de pruebas                                        |
| `INTAKE_RENDER_SECRET`            | Firma del sello de tiempo del formulario público. Mínimo 32 caracteres                                     | **Sí**    | `openssl rand -base64 32`                                                        | Sí                            | Sí (otra)                                                |
| `CRON_SECRET`                     | Protege la tarea programada; Vercel la envía sola. Mínimo 32 caracteres; sin ella la ruta da 404           | **Sí**    | `openssl rand -base64 32`                                                        | Sí                            | No hace falta (las tareas no corren en Preview)          |

**No deben existir en Vercel:** `ANTIBOT_ALLOW_MEMORY` (solo CI y pruebas locales), `MAILPIT_API_URL` (solo local),
`CP_PII_KEY_V2` (solo al rotar la clave, con una migración de datos), `SUPABASE_ACCESS_TOKEN` (solo en la máquina de quien
corre `check:auth-config`) y `TEST_DATABASE_URL` (solo pruebas). `NODE_ENV`, `VERCEL_ENV` y `NEXT_RUNTIME` los pone la
plataforma: no se definen.

**Custodia de las claves de cifrado.** Si se pierde `CP_PII_KEY_V1`, los datos personales cifrados (correos, teléfonos, RUT
y direcciones) **no se pueden volver a leer**; si se pierde o cambia `CP_SEARCH_KEY_V1`, dejan de funcionar la búsqueda por
RUT y correo, los contadores de intentos y los códigos de respaldo. Ninguna de las dos se rota sin una migración de los datos.
Por eso: se generan una vez por entorno, se guardan en el gestor del proyecto **antes** de pegarlas en Vercel, y nunca se
reemplazan en Vercel «para probar».

## Lo que no se pudo verificar

- **Supabase alojado:** que las migraciones que crean disparadores sobre `auth.users` y `auth.mfa_factors` se apliquen con
  los permisos de un proyecto alojado (solo se probaron en local); por eso se migra primero pruebas.
- **Llaves nuevas de Supabase** (`sb_publishable_…` y `sb_secret_…`): la aplicación se probó solo con las llaves `anon` y
  `service_role`. Si el proyecto nuevo no ofrece estas, probar el recorrido completo en pruebas antes de producción.
- Los nombres exactos de los campos y menús de los paneles (Supabase, Vercel, Resend, Cloudflare) y de la API de gestión que
  lee `check:auth-config` (el propio guion avisa si un campo no viene).
- **Plan del equipo `mb` de Vercel:** si es el gratis (Hobby), sus condiciones son para uso no comercial; confirmarlo con
  Aarón. El tope de 60 s y la tarea diaria caben en ese plan.
- Si la tarea diaria o los trabajos de `pg_cron` bastan para que Supabase no pause el proyecto por inactividad.
- Correo real con Resend (Gmail y Outlook), el widget real de Turnstile y el recorrido en un iPhone.
