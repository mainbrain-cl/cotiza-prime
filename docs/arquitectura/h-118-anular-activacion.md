# H-118 · Anular la activación del segundo paso desde el correo: plan de construcción

**Estado:** diseño del `planificador` (Opus, 2026-11-12) con las decisiones de José del mismo día aplicadas. **Delicada 🔒:** no se
mezcla sin revisión adversarial; Aarón la revisa y la prueba en pantalla. **Origen:** hallazgo I1 de la revisión de Aarón al #44;
seguimiento 0 de la decisión 021 (`docs/decisiones/021-limite-de-intentos-del-segundo-paso.md`). Entorno de todas las pruebas:
🟢 PRUEBAS (Supabase local). Rutas relativas a la raíz del repositorio.

## 0. El problema, en simple

Quien conoce la contraseña de una cuenta **que aún no activó el segundo paso** puede entrar, activar su propio teléfono y dejar fuera
al dueño: Supabase cierra las otras sesiones al verificar el primer factor, y «¿Olvidaste tu contraseña?» tampoco la rescata, porque
con factor también pide el código. Si es el único Dueño, la organización queda en manos del atacante hasta que soporte quite el
factor a mano. Pedir la contraseña de nuevo antes de activar (H-004b) **no** lo cierra: el atacante ya la sabe.

**La salida que decidió Aarón:** el aviso que llega al activar trae un **enlace de un solo uso para anular la activación**. Solo lo
tiene quien controla el correo de la cuenta.

## 1. Decisiones tomadas (José, 2026-11-12)

| # | Decisión | Elegida | Efecto en el diseño |
|---|---|---|---|
| D1 | Vigencia del enlace | **72 horas** desde que sale el correo | §3 |
| D2 | ¿Cerrar en la base la activación directa por la API de Supabase? | **Sí** (+0,75 días) | disparador y «permiso» de §2.2; se descarta cuando llegue H-117 (opción B) |
| D3 | Si el correo no sale | **Revertir la activación y avisar** | §2.3 |
| D4 | Qué pasa después de anular | **Segundo correo de recuperación** (no sesión de recuperación inmediata) | §4, paso 5 |
| D5 | Quién cierra el tramo de hasta 15 minutos en que el pase del atacante sigue sirviendo | **H-116** (`app.session_alive()`), si va antes del piloto | riesgo residual 4 |
| D6 | A quién avisar cuando alguien anula | Solo el registro de actividad (más el correo a la persona de §4) | §4 |
| D7 | El aviso propio de Supabase (`mfa_factor_enrolled`) | **Se apaga** (D2 = sí): duplicaría el correo sin enlace y, si se revierte, diría «activaste» en falso | cambia la condición 2 de la decisión 021 (ya no hay que encenderlo en producción) |

**Partición:** la regla del proyecto dice que una historia no pasa de dos días. Se parte en **H-118a** (aviso: correo, permiso,
disparador, tablas) y **H-118b** (anular: enlace, página, pasarela), **dentro de un mismo PR**, con etapas.

## 2. Quién envía el correo y qué pasa si no sale

### 2.1 Hechos comprobados en el código
- Hoy `confirmTotpEnrollmentAction` (`src/lib/auth/second-step-actions.ts`) **no envía nada**: el aviso sale de
  `[auth.email.notification.mfa_factor_enrolled]` en `supabase/config.toml`, una plantilla fija sin enlace propio.
- La capa de correo (`src/lib/email/transport.ts`) ya tiene adaptadores `mailpit`, `memory` y `resend` (por `fetch`). Fuera de
  producción solo envía a dominios permitidos (`ejemplo.test`); el resto falla con `recipient_not_allowed`. En producción la app no
  arranca con `mailpit` ni `memory`. Para reintentos con plazo: `sendWithRetry` (`src/lib/quotes/send/dispatch.ts`), como
  `src/lib/team/delivery.ts`.
- La llave maestra (el cliente que se salta las reglas de la base) está permitida en `src/lib/security/` (guardia 2 y ESLint). Hoy
  nadie usa `auth.admin.*`.
- La guardia 14 (`tests/isolation/static-guards.test.ts`) prohíbe `.mfa.(…|listFactors)(` fuera de `second-step-actions.ts`.
- `resetPasswordAction` (H-003) elige la contraseña nueva, cierra las otras sesiones y limpia contadores desde una sesión de
  recuperación. `getAppOrigin()` toma la dirección de `APP_ORIGIN`, nunca de la petición.
- `auth_rate_limits` es el modelo de tabla «de plataforma» a copiar: `tenant_id` con valor por defecto y control a
  `app.platform_tenant_id()`, RLS con una política solo para `service_role`, sin permisos para `anon` ni `authenticated`, y limpieza
  de filas viejas dentro de la función que escribe.
- `app.session_alive()` **no existe todavía** (está diseñada en H-116).
- Aviso para H-116: su diseño dice copiar `app.current_tenant_id()` de `20261001120200`; la versión vigente ahora es la de
  `20261112100000`.

### 2.2 El hallazgo importante: enviar solo desde nuestra pantalla no alcanza
Quien sabe la contraseña puede activar su teléfono **hablando directo con Supabase** (la dirección y la llave pública están en la
página). Así no pasa por nuestro servidor y nunca saldría el correo. **Decidido (D2 = sí): cerrarlo en la base.**
- Nuestra acción crea una fila `expected` (cuenta + factor, vive **2 minutos**) justo antes de `challengeAndVerify`.
- Un **disparador** (`before insert or update` sobre `auth.mfa_factors`, función `app.mfa_factor_verify_gate()`) actúa cuando un
  factor pasa a «verificado»: sin permiso vigente rechaza (42501) y Supabase no activa nada; si el factor no es TOTP también rechaza
  (cierra el riesgo anotado de «factores que no son TOTP»); con permiso, deja el aviso en `pending` en la misma transacción. El
  disparador **solo rechaza**, no reescribe nada de Supabase (mismo criterio que el disparador contra el cambio de correo de H-116).
- Descartado: el gancho «Send Email» de Supabase (reemplaza todos los correos y choca con H-116) y una tarea programada (depende de
  la decisión 17; queda como respaldo futuro).
- Hay que **confirmar en el paso 0** que Supabase local y un proyecto alojado de pruebas permiten el disparador sobre
  `auth.mfa_factors` y el acceso a `auth.sessions` (junto con el punto 9 de la §8 de H-116).

### 2.3 Cómo se envía y qué pasa si falla (D3)
- Al final de `confirmTotpEnrollmentAction`, **siempre** (haya salido bien o mal la verificación) se envían los avisos `pending` de
  esa cuenta: token nuevo (solo se guarda su huella), correo con `sendWithRetry` con plazo de unos 15 s. Hacerlo siempre cierra una
  carrera: el atacante manda un código malo por la pantalla y verifica directo mientras el permiso sigue vivo. Los pendientes también
  se reintentan tras cada `verifySecondStepAction` exitoso.
- **Si el proveedor no acepta el correo (o hay error de configuración): se revierte la activación** (la pasarela borra el factor;
  auditoría `session.mfa_enroll_reverted`). La pantalla dice: «No pudimos enviarte el correo de aviso, así que no dejamos activa la
  verificación. Inténtalo de nuevo en unos minutos.» Si todo sale bien: «Te enviamos un aviso a <correo>». Dejarla activa con una
  advertencia no protege: la lee quien activó, que puede ser el atacante.
- Pruebas en local: `EMAIL_PROVIDER=mailpit` (http://127.0.0.1:56324); las unitarias usan `memory`. **Producción** espera la decisión
  016 y H-116: dominio (decisión pendiente 1), SPF/DKIM/DMARC, `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, `APP_ORIGIN`.

## 3. Tablas, token y vigencia

**Migración** `<fecha>_mfa_annul.sql`: fecha posterior a `20261112100000` y a la última de `main` al construir (revisar con `ls`);
primero `set local lock_timeout = '3s'` y su verificación (guardia 15); deshacer en `supabase/rollbacks/` con guardas de md5.
- **`public.mfa_enrollment_alerts`** (un aviso por activación): `tenant_id` de la plataforma (valor por defecto, control,
  `forbid_tenant_change`); `user_id → auth.users` con borrado en cascada; `factor_id` sin llave foránea (el factor se borra al
  anular); `state` (`expected`, `pending`, `sent`, `reverted`, `annulled`, `closed`); `expected_until`, `verified_at`, `sent_at`,
  `attempts`, `provider`, `provider_message_id`, `error_code` (solo códigos). **No guarda el correo:** se lee de `auth.users` al enviar.
  Índices: único `(user_id, factor_id) where state='expected'`, `(user_id, state)`, `(created_at)`.
- **`public.mfa_annul_links`** (un enlace por correo enviado): `tenant_id` de la plataforma, `alert_id` y `user_id` en cascada,
  `token_sha256` único con control `^[0-9a-f]{64}$`, `expires_at`, `claimed_until`, `used_at`. Índices: único en `token_sha256`,
  `(user_id) where used_at is null`, `(expires_at)`.
- Ambas: RLS activo, política solo para `service_role`, sin permisos para `anon` ni `authenticated`.
- **Funciones** (`security definer`, `search_path = ''`, nombres completos, solo `service_role`): `mfa_alert_expect`,
  `mfa_alerts_reserve`, `mfa_alert_settle`, `mfa_alert_revert`, `mfa_annul_claim` (toma el enlace con `for update` y un plazo de 2
  min; devuelve el mismo `invalid` si no existe, venció, ya se usó o está tomado), `mfa_annul_complete` (consume ese enlace y todos
  los abiertos de la cuenta, cierra los avisos y audita `session.mfa_annulled` en la plataforma y en cada organización donde la
  persona está activa, con `app.write_audit`, `actor_type 'public'`, `details {via: 'email_link'}`), `mfa_annul_release` (suelta el
  enlace si algo falla) y, si el paso 0 lo exige, `mfa_revoke_sessions(user)` (borra de `auth.sessions`, que arrastra los
  `refresh_tokens`).
- **Límites:** se reescribe `auth_rate_limits_scope_check` copiando la lista de `20261112100000` y se agregan `mfa_annul_ip` (10
  cada 15 min) y `mfa_annul_token` (5 cada 15 min).
- **Token:** 32 bytes al azar en base64url (256 bits), huella sha256 (como `src/lib/team/invitation-code.ts`). Va en la parte «#» de la
  dirección: `{APP_ORIGIN}/cuenta/anular-dos-pasos#<token>`; el navegador no manda esa parte al servidor, así que no queda en registros
  de acceso ni la ve un escáner.
- **Vigencia (D1): 72 horas** desde que sale el correo. Un enlace por correo enviado: si hay reintento salen dos y los dos sirven;
  usar cualquiera consume todos los de la cuenta. **Nada hecho desde una sesión invalida los enlaces abiertos** (ni reactivar, ni
  desactivar —H-004b—, ni un botón «fui yo»): si no, el atacante borraría el enlace del dueño.
- **Retención:** las filas se borran 30 días después de vencer, usarse o revertirse, con la limpieza dentro de `mfa_alert_expect` y
  `mfa_annul_claim` (no hace falta tarea programada). El rastro queda en `audit_log` 24 meses. Anotar el plazo en `PROYECTO.md` §11.2.

## 4. Qué hace anular (D4: segundo correo de recuperación)

**Pasarela nueva** `src/lib/security/mfa-admin-gateway.ts`, el **único** archivo con `auth.admin.*`: inutiliza la contraseña con
`updateUserById` (48 bytes al azar), borra todos los factores con `admin.mfa.deleteFactor` y cierra todas las sesiones comprobando que
no quede ninguna.

**Orden** en `src/lib/security/mfa-annul.ts`:
1. Revisar la forma del token (43 caracteres) antes de tocar la base, y los límites por IP y por huella.
2. Tomar el enlace con `mfa_annul_claim`.
3. Contraseña al azar → borrar factores → cerrar sesiones (repetir estos pasos no hace daño).
4. `mfa_annul_complete`.
5. **Enviar a la persona el correo de recuperación de contraseña** (el mismo flujo de «¿Olvidaste tu contraseña?», que ya funciona sin
   código porque el factor ya no existe; por el camino del servidor, sin que cuente contra el tope por correo de H-116 J2 si hace
   falta) y mostrar: «Anulamos la activación y cerramos todas las sesiones. Te enviamos un correo para elegir tu contraseña nueva.»
   Si el correo de recuperación falla, el éxito se informa igual con «Para entrar, usa «¿Olvidaste tu contraseña?»». Es más lento
   para el dueño que una sesión inmediata, pero evita sesiones de recuperación abiertas desde la página y no depende de que `verifyOtp`
   deje la marca de recuperación (`markRecoverySession`/`hasRecoverySession`), que el paso 0 ya no necesita comprobar.
6. Enviar el correo «Anulamos la verificación en dos pasos de tu cuenta» (si falla, no se corta nada).

**Si algo falla:** en el paso 3 se suelta el enlace (`release`), se audita `session.mfa_annul_failed` y se muestra «No pudimos
terminar. Abre de nuevo el enlace en unos minutos». El atacante pierde la contraseña al instante, sin depender de que el dueño
termine el paso 5.

**Por qué no sirve como arma contra el dueño:** solo lo usa quien abre el correo; sirve una sola vez y dura poco; abrir el enlace no
ejecuta nada; lo peor que le pasa a un dueño legítimo es elegir otra contraseña. El correo dice «No reenvíes este correo».

**Guardias:** ampliar la 14 (`auth.admin.mfa` solo en la pasarela; `auth.admin` prohibido en el resto, dejando lugar para la pasarela
de H-116) con un caso que confirme que detecta de verdad una violación; una 14b para los archivos nuevos (nunca el token, su huella,
la contraseña ni el correo en `serverLog` ni `logAuditEvent`). `second-step-actions.ts` sigue sin llave maestra: llama al servicio.

## 5. La página `src/app/cuenta/anular-dos-pasos/`

- **Al abrir (GET):** no lee el token, no consulta la base, no pide sesión. Muestra «¿No fuiste tú?», qué va a pasar, un botón rojo
  «Anular la activación» (44 px, color de peligro, superficie sólida) y el enlace «Fui yo: no hacer nada». Un componente del
  navegador copia el token de la parte «#» a un campo oculto y la borra de la dirección (`history.replaceState`).
- **Al apretar (POST):** `annulSecondStepAction` en `src/lib/auth/mfa-annul-actions.ts`, sin sesión (excepción justificada en
  `guard-coverage.test.ts`). Un solo mensaje si el enlace no existe, venció, ya se usó o está tomado: «Este enlace ya no sirve. Si
  alguien activó la verificación en tu cuenta sin tu permiso, escríbenos.» Con demasiados intentos, el mensaje de límite habitual (no
  revela si el enlace servía).
- **Cabeceras:** ya hereda `no-referrer`; agregar `no-store`, `X-Robots-Tag: noindex, nofollow`, `Cross-Origin-Opener-Policy:
  same-origin` y `noindex` en la página. Sin desplazamiento horizontal a 375 px, contraste AA, foco visible, «reducir movimiento».
- Queda en el registro de actividad de cada organización; no toca la línea de tiempo de las cotizaciones.
- Texto nuevo en `/ingresar/codigo` (donde llega el dueño que quedó fuera): «¿No activaste tú la verificación? Busca en tu correo el
  aviso «Se activó la verificación en dos pasos» y usa su botón para anularla».
- **El correo de aviso** dice: cuándo se activó (dd-mm-aaaa, hora de Chile) y en qué cuenta; «Si fuiste tú, no hagas nada.»; el botón
  «No fui yo: anular la activación» y su fecha de vencimiento; «No lo reenvíes.»; «Después de anular, revisa «Tu equipo» y el
  registro de actividad.»

## 6. Pruebas que deben existir

- **Base** (`tests/db/mfa-annul.test.ts`, con Supabase Auth real): el disparador (sin permiso, permiso vencido o de otro factor, y
  factor que no es TOTP: se rechaza, el factor queda sin verificar y no se cierra ninguna sesión; con permiso vigente: el aviso queda
  `pending`; los ingresos posteriores con el factor ya verificado no se ven afectados); las tablas no se leen ni escriben con pase de
  solo contraseña, con uno completo ni sin sesión; `claim` (válido, usado, vencido, basura o tomado dan el mismo resultado; dos
  simultáneos: gana uno); `complete` (consume todos los enlaces de la cuenta y de ninguna otra; audita en la plataforma y en las
  organizaciones activas, no en las que la persona dejó); purga y alcances nuevos; `mfa-annul-rollback.test.ts` (md5, que ninguna otra
  función nombre las nuevas y que el disparador se vaya). **Hay que ajustar pruebas existentes** que verifican factores directo por la
  API (`mfa-session-gate.test.ts`, `tests/isolation/second-step.test.ts` y sus ayudantes): deben crear antes el permiso con la llave
  maestra.
- **Unitarias:** token y huella; correos (texto escapado, `APP_ORIGIN`, el «#», la fecha); envío (aceptado; rechazado → se revierte;
  error de configuración → se revierte; los pendientes salen aunque la verificación falle); anulación (orden de los pasos; falla a
  medio camino suelta el enlace y queda auditada; mensajes idénticos; límites; token mal formado no consulta la base).
- **Guardias estáticas:** la 14 ampliada con caso que muerde, una 14b para los archivos nuevos, y que la página nunca importe la
  llave maestra. **Aislamiento:** en `tests/isolation/registry.ts` la página con `scope: "none"`, las dos tablas como `server-only` y
  las funciones como solo servidor; el enlace de la cuenta A usado por B con su sesión abierta solo afecta a A.
- **e2e** (`e2e/mfa-annul.spec.ts`, con Mailpit): (1) **el ataque completo**: la dueña sin factor; el atacante, en otro navegador,
  entra con la contraseña y activa su teléfono; la sesión de la dueña se cierra; ella abre el correo (abrir el enlace no cambia nada),
  aprieta «Anular», recibe el correo de recuperación y elige una contraseña nueva; el atacante queda fuera (su siguiente pantalla lo
  manda a ingresar, la contraseña vieja no sirve, un pedido directo con su pase responde `session_not_found`) y el registro de
  actividad muestra `session.mfa_annulled`; (2) enlace reusado, vencido o inventado: el mismo mensaje; (3) abrir el enlace varias
  veces sin apretar no cambia nada; (4) un correo que no sale (destinatario fuera de la lista permitida) revierte la activación con su
  mensaje; (5) activar directo por la API de Supabase queda rechazado; (6) 375 px, teclado y «reducir movimiento».
- **Antes del PR:** suite completa local (una a la vez) y `test:db:rollbacks`, luego `supabase db reset` y `npm run db:seed`; la
  descripción del PR dice qué se corrió.

## 7. Qué NO hacer
No ejecutar nada al abrir el enlace (GET), ni siquiera «tomarlo». No poner el token en la ruta, los parámetros, los registros ni la
auditoría (en la base solo la huella). No mandar el correo solo desde la pantalla sin cerrar la API directa. No usar la llave
maestra fuera de la pasarela; no relajar las guardias 14 ni 14b (se amplían). No dejar que nada hecho con una sesión invalide enlaces
abiertos. No revelar en la página si el enlace era válido ni a qué correo corresponde. No usar como destinatario un correo que venga
en la petición: siempre el de `auth.users`. No reescribir `app.current_tenant_id()` aquí si lo va a hacer H-116 (una sola copia
literal, a partir de `20261112100000`). No crear la ruta de tareas programadas (eso es la decisión 17). No agregar Turnstile (el
token no se puede adivinar).

## 8. Orden de construcción, costo y relación con las demás historias
- **Costo:** unos 5,25 días (rango 4,75 a 5,5, con la revisión adversarial; sin cerrar la API directa serían unos 4,25). Se hace todo
  y se prueba en local sin esperar a Resend; en producción esperan el dominio, el DNS, las claves y una prueba con buzones reales de
  Gmail y Outlook.
- **Paso 0 (0,5 días):** fijar en pruebas cómo se comporta Supabase Auth local con el disparador, el cambio de contraseña de
  administración (`updateUserById`: ¿cierra todas las sesiones?, ¿dispara el aviso «tu contraseña cambió»?), el borrado de un factor
  verificado y el flujo de recuperación por correo. Si una acción de servidor de Next sigue corriendo cuando el navegador se
  desconecta (mirar la guía en `node_modules/next/dist/docs/`). En un proyecto alojado de pruebas: que permita el disparador sobre
  `auth.mfa_factors` y borrar o leer `auth.sessions`.
- Después: migración, pasarela y avisos (H-118a), página y anular (H-118b), pruebas, revisión adversarial y Aarón.
- **H-004b:** reutiliza la pasarela para «entrar con un código de respaldo»; su nueva activación pasa por el mismo permiso; su
  «desactivar» no toca los enlaces abiertos. **H-117 (opción B):** reutiliza el 75 a 80 % (tablas, token, correos, página, acción,
  cierre de sesiones); se descartan el disparador y el permiso, porque con verificación propia solo nuestro servidor activa.
  **H-116:** comparte proveedor, SMTP y el patrón de pasarela; su `app.session_alive()` cierra el tramo de 15 minutos del pase del
  atacante. **Decisión 8:** el procedimiento de soporte sigue valiendo para enlaces vencidos o cuando el atacante también tiene el
  correo.

## 9. Riesgos que quedan
1. Quien entra al correo de la persona durante las 72 horas posteriores a una activación legítima puede anularla y quedarse con la
   cuenta. 2. Un atacante que tiene la contraseña **y** el correo: el enlace no ayuda; solo el soporte. 3. Lo que el atacante hizo
   mientras estuvo dentro (p. ej. invitar a un cómplice) no se deshace; el correo y la pantalla piden revisar. 4. El pase del atacante
   sigue sirviendo hasta 15 minutos por la API de la base, hasta que exista `app.session_alive()` (H-116). 5. Si el servidor se cae
   entre verificar y enviar, el aviso queda pendiente hasta el próximo ingreso con código por la pantalla o hasta que exista la tarea
   (decisión 17). 6. Los rebotes de este correo no se detectan (no pasa por `email_messages`). 7. Un reescritor de enlaces que pierda
   la parte «#» deja el botón inútil; queda el soporte. 8. Si se agota la cuota gratuita de Resend, nadie puede activar (preferible a
   activar sin aviso). 9. Sigue abierta la fuerza bruta directa contra Supabase (opción C de la decisión 021, aceptada para el
   piloto). 10. Con D4 (segundo correo de recuperación), si ese correo se pierde, el dueño usa «¿Olvidaste tu contraseña?» (la
   contraseña ya quedó inutilizada y no hay forma de entrar sin recuperarla).

## 10. Lo que no se pudo comprobar leyendo
Todo lo del paso 0 (comportamiento de Supabase Auth con el disparador y la administración), si Supabase alojado permite el
disparador y el acceso a `auth.sessions`, la cuota y el adaptador `resend` contra la API de verdad, y que Gmail y Outlook conserven
el «#» del enlace.
