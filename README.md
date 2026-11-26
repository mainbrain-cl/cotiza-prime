# Cotiza Prime

Plataforma web donde cada empresa crea su organización para cotizar con su marca, sus precios y
sus reglas, y seguir cada cotización hasta que se paga. El plan completo está en
[`docs/PROYECTO.md`](docs/PROYECTO.md).

## Cómo levantarlo en local

Requisitos: Node 24, npm 11 y Docker Desktop abierto.

1. Instalar dependencias: `npm ci`
2. Levantar la base de datos local: `npx supabase start`
   (usa los puertos 56321 a 56329, para no chocar con otros proyectos de Supabase local)
3. Copiar `.env.example` a `.env.local` y completar los valores con `npx supabase status -o env`
4. Generar las claves de cifrado (una para datos personales y otra, distinta, para las huellas de
   búsqueda) y pegarlas en `.env.local` como `CP_PII_KEY_V1` y `CP_SEARCH_KEY_V1`, con
   `CP_PII_KEY_CURRENT=v1`. Cada clave sale de:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   Cada entorno usa claves distintas. Si se pierde `CP_PII_KEY_V1`, los datos cifrados no se
   recuperan.

5. Cargar datos ficticios: `npm run db:seed` (se niega a correr si la URL de Supabase no es local;
   crea ana, beto, mixta, carla (Comercial de Negocio Demo 1), dario (Aprobador), dante (Observador) y ex `@ejemplo.test`, con la contraseña que imprime al terminar)
6. Levantar la aplicación: `npm run dev` y abrir http://localhost:3000

Para apagar la base local: `npx supabase stop`. Si `npx supabase start` se queda esperando a que estén sanos servicios que
esta base no usa (analítica, vector, tiempo real, Studio), levantarla sin ellos:
`npx supabase start -x studio,vector,logflare,realtime,imgproxy,edge-runtime,postgres-meta,supavisor`. Reiniciar sin
`--no-backup` conserva los datos. (Studio, cuando está levantado: http://127.0.0.1:56323.)

### Probar el registro en dos pasos (H-116)

Desde H-116 **nadie crea una cuenta con contraseña desde la aplicación**: el registro público de Supabase está apagado
(`[auth] enable_signup = false` en `supabase/config.toml`; **hay que reiniciar Supabase local, `npx supabase stop` y
`npx supabase start`, para que tome el cambio**) y la cuenta nace en nuestro servidor, sin contraseña. El código del
correo es de 10 dígitos (`otp_length = 10`).

1. Abre http://localhost:3000/registro, escribe un correo (por ejemplo `nueva@ejemplo.test`), pulsa «Confirmar que soy una
   persona» (la verificación de prueba, solo local) y «Enviarme el enlace».
2. El correo llega al buzón de pruebas: http://127.0.0.1:56324. Abre el botón «Confirmar mi correo» (la dirección es de
   NUESTRA aplicación: `/confirmar-correo?token_hash=…`). Abrir la página no gasta el enlace; el botón «Continuar» sí.
3. En «Termina de crear tu cuenta» (`/crear-cuenta`) eliges tu nombre y tu contraseña (10 o más caracteres) y aceptas los
   términos. Recién entonces la cuenta queda terminada y puede crear una organización o aceptar una invitación.
4. Mientras la cuenta no está terminada, cualquier otra pantalla te devuelve a «Termina de crear tu cuenta». Si cierras la
   pestaña, usa «¿Olvidaste tu contraseña?» con ese correo: el enlace te lleva a terminar la cuenta.
5. Si el correo ya tiene una cuenta, la pantalla responde lo mismo y **no se envía ningún correo**.

Para probar el ataque que motivó la historia (alguien registra tu correo antes con su contraseña) hay una prueba
automática: `E2E_PROD=1 npx playwright test --project=chromium e2e/account-prehijack.spec.ts`. La parte que quita
el disparador del cambio de correo corre aparte, con `E2E_PROD=1 npx playwright test --project=trigger-off`: **nunca a la
vez que otra suite** (mientras dura, la base local no tiene el disparador `forbid_email_change`; si una corrida muere a
medias, la siguiente se detiene y dice cómo volver a ponerlo).

Los e2e que NO prueban el registro usan `signUpAndVerify` (`e2e/helpers.ts`), que crea la cuenta ya terminada con la API de
administración de la Supabase local e ingresa por la pantalla; los que sí lo prueban usan `registerThroughGateway` (el
recorrido real, con el buzón de pruebas).

### Probar la verificación en dos pasos (H-004a)

- Entra con una cuenta **nueva** (no actives la verificación en `ana`, `beto`, `carla`, `mixta` ni `ex`: activarla cierra
  las demás sesiones de esa cuenta y rompe las sesiones guardadas de las pruebas). Menú → «Seguridad de tu cuenta» →
  «Activar la verificación en dos pasos».
- Con el teléfono: escanea el código QR con Google Authenticator, Microsoft Authenticator o 1Password. Sin teléfono: copia
  la clave que aparece bajo el QR en cualquier generador TOTP (por ejemplo, `oathtool --totp -b CLAVE`).
- El correo de aviso («Se activó la verificación en dos pasos en tu cuenta») ya NO lo envía Supabase Auth: lo envía nuestro
  servidor (H-118a, `src/lib/security/mfa-enrollment-notice.ts`) con el botón «No fui yo: anular la activación» y llega a
  Mailpit (http://127.0.0.1:56324). Si el correo no sale (por ejemplo, el destinatario no es de `ejemplo.test`), la
  activación se revierte y la pantalla lo dice. La base solo deja activar un factor si el servidor dejó antes un «permiso» de
  2 minutos: activar hablando directo con Supabase (`/auth/v1/factors/.../verify`) responde 500 y no activa nada. Un script o
  una prueba que quiera activar un factor por la API tiene que pedir antes el permiso: `select public.mfa_alert_expect(<cuenta>,
  <factor>)` (ver `tests/support/mfa-gate.ts`).
- **Si tu Supabase local se levantó antes de que se apagara el aviso propio de Supabase** (`[auth.email.notification.mfa_factor_enrolled]`
  ya no está en `config.toml`): `npx supabase stop` y de nuevo `npx supabase start` (sin `--no-backup`, los datos se conservan).
  Reiniciar Docker NO basta: el contenedor de Auth conserva la configuración con que se creó. Para comprobarlo:
  `docker inspect supabase_auth_cotiza-prime --format '{{range .Config.Env}}{{println .}}{{end}}' | grep MFA_FACTOR_ENROLLED` no debe
  mostrar nada.
- **Probar la anulación (H-118b):** con una cuenta nueva, activa el segundo paso (el aviso llega a Mailpit con el botón «No fui yo:
  anular la activación»). El enlace termina en `/cuenta/anular-dos-pasos#<código>`: el código va tras el «#», que el navegador no
  manda al servidor. Abrirlo no hace nada; solo el botón rojo «Anular la activación» anula: quita el factor, deja la contraseña
  sin uso, cierra todas las sesiones y manda dos correos (elegir la contraseña nueva, y «Anulamos la verificación en dos pasos de
  tu cuenta»). El enlace vale 72 horas y una sola vez; un enlace que no sirve, por la causa que sea, da el mismo mensaje.
- **Quitar el factor de una cuenta local:** desde «Seguridad de tu cuenta» → «Desactivar la verificación en dos pasos» (H-004b); si
  hace falta por la base, en Studio, `auth.mfa_factors`, borrar la fila; o `delete from auth.mfa_factors where user_id = '…';`
  en `psql` (base local, puerto 56322).
- **Desbloquear los intentos de una cuenta (soporte)**: los contadores del código viven en `auth_rate_limits` con las huellas
  `mfa_verify_user` (ventana de 15 min) y `mfa_verify_user_day` (día) del ingreso con contraseña, y las mismas con el sufijo
  `|recovery` del camino de recuperación por correo. No se leen a mano (son huellas): en `psql` local,
  `delete from public.auth_rate_limits where scope in ('mfa_verify_user', 'mfa_verify_user_day', 'mfa_code_used');` los limpia
  todos; en producción, **antes de desbloquear verificar la identidad de la persona** (decisión pendiente 8).
- **Si todos los códigos fallan**, mira el reloj de la máquina virtual de Docker: tras suspender el equipo en macOS se
  atrasa. Compara `docker exec supabase_auth_cotiza-prime date -u` con `date -u`; si difieren, reinicia Docker.
- Las pruebas de punta a punta de este flujo: `E2E_PROD=1 npx playwright test --project=chromium e2e/mfa.spec.ts --workers=1`.

### Probar los códigos de respaldo (H-004b)

Siempre con una cuenta **nueva** (como arriba: activar la verificación cierra las otras sesiones de la cuenta). Todos los correos llegan a
Mailpit (http://127.0.0.1:56324).

- **Activar** pide ahora también tu contraseña, junto al código de la aplicación. Si la contraseña está mal no se gasta el código. Al
  activar aparece «Tus códigos de respaldo» (10 códigos): se ven **una sola vez**; «Listo» queda deshabilitado hasta marcar «Guardé
  estos códigos en un lugar seguro». Al recargar no vuelven. En la base solo quedan huellas (`select count(*) from
  public.mfa_recovery_codes` en el `psql` local, puerto 56322).
- **Crear o generar códigos nuevos:** «Seguridad de tu cuenta» → «Crear códigos de respaldo» (si activaste antes de H-004b) o «Generar
  códigos nuevos» (los anteriores dejan de servir). Pide la contraseña y el código de la aplicación, nunca uno de respaldo.
- **Entrar con un código de respaldo:** ingresa solo con la contraseña, y en la pantalla del código usa «¿No tienes tu teléfono? Usa un
  código de respaldo». Sirve una sola vez, **desactiva la verificación**, cierra las otras sesiones y llega el aviso «Se usó un código
  de respaldo en tu cuenta». También funciona tras abrir el enlace de «¿Olvidaste tu contraseña?» (después se elige la contraseña nueva).
- **Desactivar** (con la sesión abierta): «Seguridad de tu cuenta» → «Desactivar la verificación en dos pasos». Pide la contraseña y un
  código (de la aplicación o de respaldo). El correo «Se pidió desactivar la verificación en dos pasos de tu cuenta» sale **antes** de
  desactivar: si no sale (por ejemplo, el destinatario no es de `ejemplo.test`), no se desactiva nada y el código de respaldo no se
  pierde. Al desactivar se borran los códigos y se cierran las otras sesiones.
- **Límite:** el código de la aplicación y los de respaldo comparten los mismos intentos (5 en 15 minutos, 15 al día); el camino de
  la contraseña, el del enlace del correo y el de las acciones con la sesión abierta («manage») tienen contadores aparte.
- Las pruebas de punta a punta: `E2E_PROD=1 npx playwright test --project=chromium --workers=1 e2e/mfa-recovery.spec.ts`.

## Scripts

| Comando                | Qué hace                                  |
| ---------------------- | ----------------------------------------- |
| `npm run dev`          | Servidor de desarrollo                    |
| `npm run build`        | Compila para producción                   |
| `npm run typecheck`    | Revisa los tipos de TypeScript            |
| `npm run lint`         | Revisa el código con ESLint               |
| `npm run format`       | Da formato con Prettier                   |
| `npm run format:check` | Verifica el formato sin modificar         |
| `npm test`             | Pruebas unitarias (Vitest)                |
| `npm run test:e2e`     | Pruebas de extremo a extremo (Playwright) |
| `npm run test:db`      | Pruebas de la base de datos (necesitan `supabase start` y `supabase db reset`) |
| `npm run db:seed`      | Datos ficticios en la base local (solo local) |
| `npm run test:db:rollbacks` | Prueba los deshacer de las migraciones (borra los datos de la base local) |

La primera vez, `npx playwright install chromium` descarga el navegador de las pruebas.

## Salida a producción

Pasos, ajustes de los paneles y variables de entorno para poner el MVP en línea: [`docs/PRODUCCION.md`](docs/PRODUCCION.md).

## Despliegue: anti-robot del formulario público

- `ANTIBOT_PROVIDER` es **obligatorio y no tiene valor por defecto** (`turnstile` o, solo local, `memory`). Con
  `turnstile` también hacen falta `TURNSTILE_SECRET_KEY` y `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
- **Tiene que estar definido también al compilar** (`next build`), no solo al arrancar: la política de seguridad
  (CSP) de `/f/*` se arma en `next.config.ts` y con `turnstile` abre `script-src` y `frame-src` a
  `https://challenges.cloudflare.com`. Si se compila sin la variable, el formulario carga pero Cloudflare queda
  bloqueado y nadie puede enviar. En Vercel: definirla para el entorno de compilación y de ejecución, y
  recompilar si se cambia.
- `memory` (acepta un token fijo) **no arranca** con `NODE_ENV=production`, con cualquier `VERCEL_ENV` ni con
  `NEXT_PUBLIC_APP_ENV=production`. La única excepción es `ANTIBOT_ALLOW_MEMORY=1`, pensada solo para CI y las
  pruebas de punta a punta con la aplicación compilada (ya va en `playwright.config.ts`); con
  `NEXT_PUBLIC_APP_ENV=production` se ignora. No se define nunca en un entorno real.

## Despliegue: tareas programadas (decisión #17)

La tarea de avisos al Dueño por invitaciones (H-008) la llama el programador de tareas del hosting. En el repositorio
vive la ruta `GET /api/v1/jobs/invitation-notices` y su horario en `vercel.json`.

- **Variable `CRON_SECRET`**: mínimo 32 caracteres, solo servidor, un valor distinto por entorno (nunca en el
  repositorio). En Vercel se configura como variable de entorno `CRON_SECRET` del proyecto y Vercel la envía sola
  como `Authorization: Bearer <valor>`. Sin ella (o con menos de 32 caracteres) la ruta queda **desactivada** y
  responde 404; con un valor incorrecto responde 401. Cambiar el valor exige volver a desplegar. La ruta atiende un lote
  chico (2 avisos por llamada) para caber en los 60 s que tiene.
- **Horario**: `vercel.json` la programa **una vez al día** (`0 12 * * *`, hora UTC), porque el plan gratuito de Vercel
  (Hobby) solo admite tareas diarias y una más frecuente hace fallar el despliegue. Con el plan Pro se puede cambiar a
  cada hora (`0 * * * *`). Las tareas programadas solo corren en el despliegue de producción, no en las vistas previas.
- **Probarla a mano**: con `CRON_SECRET` en el entorno de `npm run dev`,
  `curl -i -H "Authorization: Bearer <valor>" http://localhost:3000/api/v1/jobs/invitation-notices`.
  El script `npm run job:invitation-notices` sigue sirviendo para uso local o manual.

## Despliegue: la configuración de Supabase Auth de producción (H-009 y H-116)

Aceptar una invitación solo funciona con el mismo correo al que se envió, y el registro solo es seguro si nadie puede crear
una cuenta con contraseña antes de verificar el correo. Eso descansa en la configuración del proyecto de Supabase de
producción, que **hay que dejar a mano** (`supabase/config.toml` solo vale para la base local) y que **bloquea el piloto**. La
lista completa (17 puntos) está en `docs/arquitectura/h-116-registro-seguro.md`, §5. Lo esencial:

- **«Allow new users to sign up»: APAGADO** (la defensa que de verdad cierra el ataque de registro previo). El proveedor
  Email sigue ENCENDIDO (es el ingreso con contraseña y la recuperación); no se apaga `[auth.email] enable_signup`.
- Confirm email ON, Secure email change ON, Secure password change ON, contraseña de 10 o más, código del correo de **10**
  (`mailer_otp_length`), y sin ingreso anónimo, enlace manual de cuentas, proveedores externos, teléfono, SAML, Web3 ni ganchos.
- SMTP propio para los correos de Supabase (con SPF, DKIM y DMARC) y las plantillas en español cargadas en el panel.
- **`npm run check:auth-config` en verde, con la salida guardada.** Lo corre quien opera el proyecto de Supabase (Aarón o quien él
  designe), en SU máquina, con un token personal de la API de gestión que **nunca** va en el repositorio ni en la aplicación:

  ```
  SUPABASE_ACCESS_TOKEN=… npm run check:auth-config -- --url https://<ref>.supabase.co --anon-key <llave pública> --ref <ref>
  ```

  Sin token se puede correr la parte pública (`--public-only`), que se declara PARCIAL y no sirve como salida del piloto. Lo que
  no se pudo leer cuenta como fallo. Contra Supabase local: `npm run check:auth-config -- --public-only --url
  http://127.0.0.1:56321 --anon-key <llave pública>`. Quedan «A MANO» (el guion los lista): SPF, DKIM y DMARC, las plantillas,
  las redirecciones permitidas, y cero cuentas sin verificar (consulta de solo lectura en el editor SQL del panel).
- Si el registro público de Supabase queda abierto en producción, la aplicación **bloquea su propio formulario** `/registro`
  («El registro no está disponible por ahora») y deja una alerta en el registro del servidor (`signup_open_in_supabase`). Eso
  **no frena el ataque** (va directo a la API de Supabase): solo lo hace visible. Lo que lo frena es tenerlo apagado.

## Estructura

```
docs/                 Plan, decisiones, sprints y base técnica
e2e/                  Pruebas de extremo a extremo
supabase/             Configuración y migraciones de la base de datos
src/app/              Páginas y rutas (App Router)
src/app/api/v1/       API versionada
src/components/ui/    Componentes de shadcn/ui
src/lib/auth/         Único lugar donde se valida el pase de sesión
src/lib/tenant/       Único lugar donde se resuelve la organización activa
src/lib/supabase/     Clientes de Supabase (servidor y navegador)
```
