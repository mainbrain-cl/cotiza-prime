# B1 · Secuestro de cuenta por registro previo — diseño del cierre (historia propuesta H-116, delicada)

> **Estado: diseño del `planificador` (Opus), 2026-11-05. Sin construir.** Nace de la revisión adversarial de H-009 (regla cero de
> Aarón, 2026-11-03), que encontró este hallazgo **bloqueante para el piloto**; el hallazgo se reprodujo dos veces (el revisor y la
> sesión principal). **H-116 es una historia propuesta, todavía no está en `docs/HISTORIAS.md`**: cambia los criterios de H-001 y lo
> que ve quien se registra, así que la aprueba Aarón (Compuerta 2 de `PROCESO.md`). Por la decisión 020 §5 es delicada y **no se
> mezcla sin Aarón**. Entorno de todo lo que sigue: PRUEBAS (Supabase local en Docker); hoy no existe proyecto de producción.

## Resumen para José

1. **El origen está en el registro (H-001), no en H-009.** Supabase deja que cualquiera cree una cuenta con un correo ajeno y su
   propia contraseña. Cuando la dueña del correo verifica, sigue sirviendo la contraseña del atacante.
2. **Arreglo recomendado.** Apagar el registro público de Supabase y crear las cuentas solo desde nuestro servidor, sin contraseña.
   La contraseña, el nombre y la aceptación de términos se piden después de que la persona abre el enlace del correo.
3. **Segunda defensa en la base de datos.** Una cuenta «sin terminar» no puede crear organizaciones ni aceptar invitaciones. Solo
   se puede terminar desde una sesión que nació del enlace del correo.
4. **Costo.** Entre 4,5 y 5,5 días, incluido medio día de prueba exploratoria para confirmar cómo se comporta Supabase. Cambia lo
   que ve quien se registra, así que Aarón tiene que aprobarlo.
5. **Bloquea el piloto,** junto con una lista de 16 ajustes del Supabase de producción (§5). Parte se puede comprobar con un guion;
   el resto se revisa a mano en el panel.

---

## 1. Causa raíz y qué garantía hace falta

**Qué pasa por dentro.** Cada cuenta de Supabase junta en un mismo registro dos cosas que pueden venir de personas distintas:

- La **contraseña**, que la elige quien llena el alta. Puede ser cualquiera, incluso llamando directo a la API pública con la llave
  que el navegador conoce.
- La **prueba de que controla el correo**, que la da quien hace clic en el enlace.

Si la cuenta ya existía sin verificar, un segundo registro no cambia la contraseña. GoTrue (el servidor de cuentas de Supabase,
versión 2.197.0, confirmada en el binario del CLI) solo reenvía el correo. Entonces el clic de la dueña «confirma» una cuenta cuya
contraseña eligió el atacante. Es el ataque conocido como cuentas «pre-secuestradas».

**Qué tiene que ser verdad.** Que el correo esté verificado solo significa que esa persona controla la cuenta si se cumple esto:
**todo lo que permite entrar como la persona (contraseña, sesiones, segundo factor) y todo lo que se le atribuye (nombre,
consentimiento) se fija después de verificar, desde la sesión que abrió ese enlace, y nada fijado antes, por quien sea, sigue
sirviendo.**

## 2. Evaluación de las opciones

| Opción | Qué deja abierto | Veredicto |
|---|---|---|
| **(i) Apagar el registro público y crear la cuenta solo desde el servidor, sin contraseña.** La contraseña, el nombre y los términos se piden después de verificar | Depende de que producción tenga el registro apagado; eso se vigila con un guion y una alerta. Quedan riesgos menores: alguien te hace entrar a una cuenta suya («login CSRF») y alguien te manda enlaces no pedidos (§4) | **Recomendada, como base** |
| **(ii) Dejar el registro abierto y pedir la contraseña después** con `updateUser({ password })` + `signOut({ scope: "others" })` | **Hay una ventana.** Entre el clic de la víctima y su contraseña nueva, la del atacante sirve. Un programa que intenta entrar cada segundo la aprovecha y en ese tiempo puede: (a) inscribir su propia verificación en dos pasos, porque la API está encendida (`[auth.mfa.totp] enroll_enabled = true`), y dejar a la víctima bloqueada; (b) crear organizaciones o llamar funciones directo, si la regla vive solo en pantalla; (c) cambiar la contraseña antes que la víctima, porque `secure_password_change` no pide reautenticación en las primeras 24 h de su sesión; (d) seguir usando su pase hasta 15 min después de `signOut others`, porque PostgREST, la puerta de consultas a la base, solo revisa la firma y el vencimiento del pase, no si la sesión se cerró. Además, el nombre y el consentimiento siguen siendo los que escribió el atacante | Insuficiente sola |
| **(ii-b) Obligar a elegir la contraseña de nuevo en `/auth/callback`** | Igual que (ii). Además, el atacante nunca pasa por nuestras pantallas | Insuficiente |
| **(iii) Revisar en la base el método de la sesión.** El pase lleva una marca, `amr`, que dice si la sesión se abrió con contraseña o con un enlace del correo | No se puede exigir siempre «enlace del correo»: los ingresos normales son con contraseña. Por sí sola tampoco impide que el atacante entre y haga otras cosas | **Sí, como segunda capa,** solo en el momento de «terminar la cuenta» |
| **(iv) Ganchos de Supabase** (funciones nuestras que Supabase llama en un momento dado). `password_verification_attempt` y `before_user_created` existen en esta versión: aparecen en el binario del CLI 2.119.0 y en los comentarios de `config.toml` | El de contraseña podría rechazar contraseñas elegidas antes de verificar, pero `auth.users` no guarda cuándo se fijó la contraseña: habría que llevar ese dato aparte. Además, creo que en el Supabase alojado ese gancho es de planes Team o Enterprise (no verificado). Hasta donde sé, `before_user_created` no distingue un alta pública de una del servidor | No |
| **(iv-b) Disparador en `auth.users` que borra la contraseña al confirmar el correo** | Funcionaría con cualquier configuración, pero depende de detalles internos de GoTrue: que después de confirmar no vuelva a guardar la contraseña que tiene en memoria, y de que Supabase siga permitiendo escribir en `auth.users` desde un disparador. Es frágil ante actualizaciones | No por ahora |
| **(v) Configuración.** «Confirm email» ya está encendido: es la condición del ataque, no lo arregla. «Secure email change» no toca este camino. El captcha de Supabase frena programas, pero no a una persona | — | No basta |
| **«El último registro gana»** con la llave maestra (que se salta todas las reglas de la base) | Hay carrera. Además invierte el ataque: el atacante se registra después que la víctima, pisa su contraseña y la víctima termina verificando una cuenta con la contraseña del atacante | Descartada |

## 3. Recomendación: opción (i) en tres capas

### 3.1 Las tres capas

1. **Nadie puede tener una contraseña antes de verificar.**
   - En `supabase/config.toml`, `[auth] enable_signup = false`, y su equivalente en producción. **No** se toca
     `[auth.email] enable_signup`: se cree que ese interruptor apaga el correo como método de ingreso completo, contraseña
     incluida (por verificar, §8).
   - El paso 1 del registro pide solo el correo.
   - El servidor, a través de una pasarela vigilada (como `src/lib/team/gateway.ts`), llama a
     `auth.admin.generateLink({ type: "invite", email })`. Esa llamada crea la cuenta sin contraseña si no existía y devuelve el
     código del enlace.
   - Si la cuenta existía sin verificar, la pasarela le pone una contraseña aleatoria que nadie conoce
     (`auth.admin.updateUserById(id, { password })`). Así se neutraliza una contraseña plantada por un registro abierto por error
     o por una cuenta antigua.
   - El correo sale por nuestra capa de correo (`src/lib/email`) con un enlace a **nuestra** aplicación, armado siempre con
     `APP_ORIGIN` y nunca con la dirección que trae la petición.
2. **Solo la sesión del enlace puede terminar la cuenta, y la base no deja usar una cuenta sin terminar.**
   - Nueva columna `profiles.account_ready_at`.
   - Nueva función `complete_account_setup`, que exige que la sesión venga de un enlace del correo.
   - `create_tenant`, `invitation_preview` y `accept_invitation` exigen cuenta terminada.
   - Por qué basta con esas tres: a los datos de una organización solo se llega siendo miembro, y solo `create_tenant` y
     `accept_invitation` crean membresías. Una cuenta sin terminar no ve ni toca nada de nadie.
3. **Se vigila la configuración.**
   - Guion `npm run check:auth-config` que lee la configuración pública de Supabase (`GET /auth/v1/settings`). Falla si el registro
     está abierto, si la confirmación de correo está apagada o si hay proveedores externos o ingreso anónimo.
   - Una prueba que lee `config.toml`.
   - Una alerta al arrancar en producción (supuesto J5).

### 3.2 Recorridos

| Recorrido | Qué pasa |
|---|---|
| **Registro** | `/registro`: correo (más anti-robot, decisión A4) → «Enviarme el enlace». Revisa los topes por IP y por correo → pasarela → correo. La respuesta en pantalla es idéntica exista o no la cuenta |
| **Verificación** | El enlace abre `/confirmar-correo?token_hash=…&type=invite`. Al abrirla no se gasta el código, porque los antivirus de correo abren los enlaces antes que la persona: la pantalla solo muestra «Continuar». El clic manda un POST: el servidor llama `verifyOtp({ token_hash, type })`, se abre la sesión y la persona va a `/crear-cuenta`. Funciona en otro dispositivo, cosa que hoy no pasa porque el canje actual exige el navegador donde empezó el registro |
| **Terminar la cuenta (primer ingreso)** | `/crear-cuenta`: nombre, contraseña dos veces y la casilla de términos, con el correo a la vista. El servidor, en este orden: (1) `hasEmailLinkSession()`; (2) `updateUser({ password })`; (3) `signOut({ scope: "others" })`; (4) llama `complete_account_setup`. Luego va a `/invitacion` si hay una invitación guardada en el navegador; si no, a «Crea tu primera organización» |
| **Ingreso normal** | Sin cambios. Una cuenta sin terminar no tiene contraseña, así que no entra. La pantalla de ingreso agrega ayuda para ese caso |
| **Recuperar contraseña** | Sin cambios para cuentas terminadas. Si la cuenta no está terminada, `/auth/recuperar` lleva a `/crear-cuenta` en vez de `/restablecer-contrasena`: un solo lugar fija la primera contraseña |
| **Cambio de correo** | No hay pantalla todavía (H-109). Requisito anotado para H-109: cerrar las demás sesiones al cambiar el correo y advertir en el correo de confirmación. Hay una variante relacionada, ver §4 |
| **Registro desde una invitación (H-009)** | `/invitacion` → «Crear mi cuenta» → `/registro` con el aviso actual → enlace → «Continuar» → `/crear-cuenta` → `/invitacion` → «Unirme». La cookie de la invitación dura 1 hora; si vence o la persona termina en otro dispositivo, el inicio ya dice «¿Te invitaron? Abre de nuevo el enlace» |
| **Correo que ya tiene cuenta verificada** | `generateLink` responde «ya existe». No se envía nada (supuesto A2) y la pantalla responde igual que hoy |
| **Enlaces de verificación viejos** (enviados antes del cambio) | Siguen llegando a `/auth/callback` durante su hora de vida. De ahí la persona pasa al inicio, y el control de entrada de la sesión la manda a terminar la cuenta |

### 3.3 Pantallas y textos (español de Chile; Aarón los aprueba)

- **`/registro`**
  - Título: «Crea tu cuenta».
  - Bajada: «Primero confirmamos tu correo. Después eliges tu nombre y tu contraseña».
  - Un campo: «Correo».
  - Nota: «Usaremos tu correo solo para enviarte el enlace. Lee la política de privacidad».
  - Botón: «Enviarme el enlace».
  - Al enviar: «Te enviamos un enlace a **correo**. Ábrelo dentro de una hora. Si ya tenías una cuenta con este correo, ingresa o
    recupera tu contraseña».
- **El correo**
  - Asunto: «Confirma tu correo para crear tu cuenta en Cotiza Prime».
  - Botón: «Confirmar mi correo».
  - Pie: «Si no lo pediste tú, ignora este mensaje: sin tu clic la cuenta no se activa».
- **`/confirmar-correo`**
  - «Confirma tu correo» con el botón «Continuar».
  - Si el enlace falla: «Este enlace ya se usó o venció» con el botón «Pedir un enlace nuevo».
- **`/crear-cuenta`**
  - Título: «Termina de crear tu cuenta».
  - Recuadro destacado: «Estás creando la cuenta de **correo**», con el enlace «¿No es tu correo? Salir».
  - Botón: «Crear mi cuenta».
- **`/ingresar`**, ayuda nueva: «¿Empezaste a crear tu cuenta y no la terminaste? Pide otro enlace en "Crear cuenta"».
- **`/invitacion`** con cuenta sin terminar: se reutiliza el resultado `unverified`, con el texto nuevo «Antes de unirte, confirma tu
  correo y termina de crear tu cuenta» y el botón «Terminar mi cuenta».

### 3.4 Base de datos

Una migración: `supabase/migrations/2026110X100000_account_setup.sql`, con su deshacer en `supabase/rollbacks/` (la fecha se asigna al
construir: única y posterior a la última de `main`).

- **`profiles.account_ready_at timestamptz`.** Vacía quiere decir «sin terminar». No hace falta tabla nueva: `profiles` ya tiene
  `tenant_id` (la organización de la plataforma). Las personas no reciben permiso para leer ni escribir esta columna, porque la
  lectura de `profiles` es por columnas desde `20261001150000`. No hacen falta índices nuevos: todo se busca por la llave principal.
- **`app.account_ready(uid)`.** Interna.
- **`public.my_account_ready()`.** Solo sobre la cuenta propia; la usa `requireUser`.
- **`app.session_from_email_link()`.** Lee `auth.jwt() -> 'amr'` y acepta los dos formatos que puede traer esa marca: lista de
  textos o de objetos con `method`. Es verdadera si hay un método de enlace del correo y ninguno `password`. La lista exacta
  (supuesto: `otp`, `magiclink`, `recovery`, `invite`) se fija tras la prueba exploratoria.
- **`public.complete_account_setup(p_full_name, p_terms_version, p_privacy_version)`.**
  - Corre con permisos elevados (`security definer`), con `search_path = ''` y solo para `authenticated`. Rechaza transacciones de
    solo lectura.
  - Revisa en este orden:
    1. Que haya sesión.
    2. Que la sesión venga del enlace del correo. Si no, error 42501 y auditoría `account.setup_denied`.
    3. Que el correo esté verificado.
    4. Que la cuenta no tenga ninguna verificación en dos pasos inscrita (`auth.mfa_factors`). Si la tiene, se rechaza con
       `factor_present` y se audita. En el diseño normal es imposible; solo pasa con la configuración mal puesta.
    5. Nombre de 1 a 120 caracteres, sin caracteres de control.
    6. Versiones de los documentos iguales a las vigentes. Si no, `legal_changed`.
  - Luego guarda el nombre y las aceptaciones con contexto `signup`, IP (`x-cp-client-ip`) y navegador; pone `account_ready_at` si
    estaba vacía; y audita `account.setup_completed`.
  - Repetirla no cambia nada ni falla.
- **`app.handle_new_user`.** Se quita la rama que registraba la aceptación desde `raw_user_meta_data.accepted_legal`: esos datos los
  escribe quien crea la cuenta, que puede no ser la persona.
- **`create_tenant`, `invitation_preview` y `accept_invitation`.** Se agrega `app.account_ready(v_uid)` junto al chequeo de
  `email_confirmed_at`. El cuerpo se copia de la **última** migración que define cada una (al construir: `20261001140100` para
  `create_tenant`, y las de H-009 y su corrección I1 para las otras dos). `create_tenant` responde 42501 «Termina de crear tu cuenta
  antes de crear una organización»; las de invitación responden `unverified`, sin resultado nuevo.
- **Topes.** Se amplía la lista de valores permitidos de `auth_rate_limits.scope` con `signup_email`.
- **Relleno de datos existentes.** Cuentas ya verificadas y con contraseña pasan a terminadas. Solo afecta la base local, porque no
  hay producción.

### 3.5 Archivos

**Nuevos**
- `src/lib/auth/signup-gateway.ts`: la pasarela. Es el único archivo de `src/lib/auth/` con la llave maestra, y solo llama a
  `generateLink({ type: "invite" })` y a `updateUserById(id, { password })` cuando `email_confirmed_at` está vacío.
- `src/lib/auth/signup-service.ts`: arma el enlace y envía el correo.
- `src/lib/email/account-link.ts`: el correo, con los textos escapados, como `invitation.ts`.
- `src/app/(auth)/confirmar-correo/` y `src/app/(auth)/crear-cuenta/`: páginas, formularios y acciones.
- `scripts/check-auth-config.ts`.

**Se modifican**
- `src/lib/auth/actions.ts`: `signUpAction` pide solo el correo y nunca llama a `supabase.auth.signUp`. Se agregan
  `confirmEmailLinkAction` y `completeAccountSetupAction`.
- `src/lib/auth/session.ts`: `hasEmailLinkSession()` sale de generalizar `hasRecoverySession`. `requireUser` agrega el control de
  cuenta terminada, antes del de términos, con la opción `skipSetupGate` para `/crear-cuenta`.
- `src/lib/auth/paths.ts`, `schemas.ts` y `errors.ts`.
- `src/app/(auth)/registro/page.tsx` y `signup-form.tsx`; `src/app/(auth)/ingresar/page.tsx`.
- `src/app/auth/recuperar/route.ts`: si la cuenta no está terminada, va a `/crear-cuenta`.
- `src/app/auth/callback/route.ts`: solo un comentario; queda para enlaces viejos.
- `src/lib/team/accept-model.ts`: texto de `unverified`.
- `src/lib/security/login-rate-limit.ts`: tope `signup_email`.
- `next.config.ts`: `/confirmar-correo` con `no-store`, `no-referrer`, `noindex` y `Cross-Origin-Opener-Policy`; `/crear-cuenta` con
  `no-store`.
- `supabase/config.toml`.
- `eslint.config.mjs`, `tests/isolation/static-guards.test.ts` y el comentario de `src/lib/supabase/admin-client.ts`, para permitir
  la pasarela nueva.
- `scripts/seed.ts`.
- `tests/support/local-supabase.ts`, `tests/isolation/fixture.ts` y `tests/db/helpers.ts`: las cuentas de prueba quedan terminadas,
  y las aceptaciones de términos se escriben aparte. `actAs` acepta `amr`.
- `tests/isolation/registry.ts`.
- `e2e/helpers.ts`: `signUpAndVerify` y `waitForVerificationLink` siguen el flujo nuevo.
- Los e2e que llenan `/registro` a mano: `e2e/auth-tenants.spec.ts`, `e2e/team-accept-invitation.spec.ts` y
  `e2e/login-rate-limit.spec.ts`.
- Documentación: `README.md` (despliegue), `CLAUDE.md` (lista del piloto), `docs/HISTORIAS.md` (H-116 y los criterios de H-001) y
  `docs/arquitectura/`.

Antes de programar, el agente que construya debe leer la guía de Next que viene en `node_modules/next/dist/docs/`: los parámetros de
una página y las acciones de servidor cambiaron en esta versión.

### 3.6 Dónde puede fallar y cómo se evita

- **Permisos saltados.**
  - Alguien llama `complete_account_setup` con un pase de contraseña: la base lo rechaza por `amr`.
  - Alguien escribe `account_ready_at` directo: no tiene permiso sobre esa columna.
  - Alguien llama `create_tenant` o `accept_invitation` con una cuenta sin terminar: la base lo rechaza.
- **Aislamiento entre organizaciones.** No cambia ninguna regla por fila; las funciones nuevas no reciben `tenant_id` y van al
  registro de pruebas de aislamiento.
- **Doble envío.**
  - Doble clic en «Enviarme el enlace»: el botón queda deshabilitado mientras envía y hay un tope de 1 enlace por minuto y 3 por
    hora por correo. Supuestamente cada enlace nuevo anula el anterior (por confirmar).
  - Doble envío de «Crear mi cuenta»: la función es repetible, y el error `same_password` se trata como éxito.
- **Datos personales expuestos.**
  - El enlace, su código y `email_otp` nunca van a registros del servidor, auditoría ni `email_messages`; lo vigila una guardia
    estática.
  - La auditoría guarda solo la huella del correo.
  - El correo de la persona solo se muestra en `/crear-cuenta`, a ella misma.
- **Enlace hacia un sitio ajeno.** Siempre se arma con `getAppOrigin()`, nunca con la cabecera `Host` de la petición.
- **Antivirus que abren el enlace.** Abrir la página (GET) no gasta el código; solo el POST lo canjea.
- **«Login CSRF»** (alguien te hace entrar, sin que lo notes, a una cuenta que es suya). El canje es una acción de servidor y Next
  revisa el origen, pero un enlace del atacante que la víctima abra y luego pulse sigue siendo posible. Se mitiga con el correo en
  grande y «¿No es tu correo? Salir».
- **Falla a mitad de terminar la cuenta.** La contraseña ya cambió pero la base falló: la persona reintenta y `same_password` sigue
  adelante.
- **Sesión de más de 24 h.** Con `secure_password_change`, `updateUser` pide reautenticación. Mensaje: «Tu enlace venció, pide uno
  nuevo».
- **Revelar si un correo tiene cuenta.** La respuesta en pantalla es la misma en todos los casos.
- **Redondeo.** No aplica.

### 3.7 Pruebas que deben existir

**Prueba del ataque: `e2e/account-prehijack.spec.ts`.** Debe fallar en `main` hoy y pasar después; ese contraste rojo→verde queda en
el PR.

1. El atacante hace `POST /auth/v1/signup` con la llave pública, el correo E, `Clave-Del-Atacante` y metadatos «Atacante» con
   términos aceptados. Se anota la respuesta, pero no se corta la prueba ahí.
2. La organización invita a E como Administrador.
3. La víctima, en el navegador, abre la invitación, crea su cuenta con E por la interfaz, abre el correo más reciente, termina la
   cuenta con `Clave-De-La-Victima` y pulsa «Unirme».
4. Se comprueba:
   - con la contraseña del atacante: `invalid_credentials`;
   - con la de la víctima: entra;
   - el nombre del perfil es el de la víctima;
   - las aceptaciones de términos son posteriores a la verificación y traen el navegador de la víctima;
   - `POST /auth/v1/signup` responde 422 `signup_disabled`.

**Variante «registro abierto por error».** El atacante se crea con la llave maestra, con contraseña y sin confirmar, que es lo mismo
que haría un registro público. Un bucle intenta entrar con su contraseña cada 200 ms durante todo el flujo de la víctima. Ningún
intento obtiene sesión. Si alguno la obtuviera, `create_tenant`, `accept_invitation` y `complete_account_setup` con ese pase fallan.

**Base de datos (`tests/db/account-setup.test.ts`)**
- `complete_account_setup` rechaza `amr` de contraseña, sin `amr` y con factor inscrito; acepta un `amr` de enlace del correo;
  repetirla no falla; rechaza versiones viejas.
- Las tres funciones rechazan una cuenta sin terminar.
- La columna no se puede escribir.
- `handle_new_user` ya no registra consentimiento; se reescribe la prueba de `tests/db/behavior.test.ts:423`.
- El relleno y el deshacer.

**Aislamiento**
- Funciones nuevas en el registro.
- Ataques nuevos X7 y X8: `/auth/v1/signup` y `/auth/v1/otp` con `create_user` deben ser rechazados.
- Ana, con pase de contraseña, no puede llamar `complete_account_setup`.

**Guardias estáticas**
- `supabase.auth.signUp(` y `signInWithOtp(` no aparecen en `src/`.
- La llave maestra en `src/lib/auth/` solo está en la pasarela.
- La pasarela nunca llama `createUser`, `email_confirm`, `listUsers`, `deleteUser`, `.from(` ni `.rpc(`.
- `config.toml` tiene `[auth] enable_signup = false`, `enable_confirmations = true`, `double_confirm_changes = true`, sin ingreso
  anónimo, sin enlace manual de cuentas y sin proveedores externos encendidos.

**Unitarias**
- Esquemas; mensajes; `hasEmailLinkSession` con cada combinación de `amr`.
- El orden de `completeAccountSetupAction`: contraseña → cerrar otras sesiones → base.
- El correo escapa el texto y lleva `APP_ORIGIN`.
- El guion de configuración, con respuestas simuladas.

**E2e de regresión**
- Registro sin invitación y desde invitación, incluido otro dispositivo.
- Un GET de antivirus no gasta el enlace.
- Recuperar contraseña de una cuenta sin terminar lleva a `/crear-cuenta`.
- Tope por IP y por correo.
- Móvil a 375 px.
- Suites completas en local, porque el CI no corre: `test`, `test:db`, `test:isolation`, `test:db:rollbacks`, y luego
  `npm run db:seed`, `E2E_PROD=1 npx playwright test --project=chromium` y `--project=isolation`.

### 3.8 Etapas y días

| Etapa | Días |
|---|---|
| 0. Prueba exploratoria contra GoTrue local (los 10 puntos de §8) | 0,5 |
| 1. Migración y pruebas de base de datos | 1 |
| 2. Pasarela, correo, acciones, pantallas y control de entrada de la sesión | 1,5–2 |
| 3. E2e, incluida la del ataque; aislamiento; guardias; guion; documentos | 1 |
| 4. Revisión adversarial y correcciones | 0,5–1 |
| **Total** | **4,5–5,5** |

Pasa de 2 días. Partirla deja un estado intermedio roto o inseguro: con el control de cuenta terminada pero sin la pantalla de
terminar, nadie nuevo podría crear organizaciones. Por eso se propone una rama y un PR con commits por etapa (decisión J0).

### 3.9 Qué vuelve a revisión adversarial (agente `revisor`)

- Todo el registro nuevo, repitiendo `squat.cjs` y `prehijack.cjs` adaptados.
- Un ensayo con `enable_signup = true` en una copia local, para probar la segunda capa.
- «Login CSRF», antivirus, cabecera `Host`, el código del enlace en registros, los topes por correo e IP.
- Lectura de `amr` con pases de distintas formas, el relleno, el cambio en `handle_new_user`, el camino viejo de `/auth/callback` y
  la variante del cambio de correo.

---

## 4. Riesgos que quedan y lo que esto no resuelve

- **Correo de la víctima comprometido.** Fuera de alcance: todo se apoya en el correo, igual que recuperar la contraseña. Lo
  atenúan los dos pasos (H-004).
- **Correos de verificación a terceros (spam).** Ahora solo salen por nuestro formulario: tope por IP, tope por correo y anti-robot
  (decisión 019). Antes había además la puerta directa de Supabase. Pedir enlaces para un correo ajeno manda mensajes no pedidos y,
  cada vez, anula el enlace anterior: es una molestia, acotada por el tope por correo. Mientras 019 no se decida, solo hay topes.
- **Cuentas sin verificar.** Quedan en `auth.users` hasta una limpieza. Hoy guardan nombre y consentimiento falsos; después solo
  guardan el correo. La limpieza (7 días sin verificar, 30 verificadas sin terminar) va en una historia aparte, que depende de la
  decisión pendiente nº 17 (cómo se programan las tareas en producción).
- **Pase vigente hasta 15 minutos después de cerrar la sesión.** En el diseño normal ya no aplica a B1, pero sí si producción queda
  mal configurada. Es un problema general, que también contradice `SEGURIDAD.md` §1 («cierre efectivo»). Se propone una historia
  aparte: que `app.current_tenant_id()` rechace pases cuyo `session_id` ya no esté en `auth.sessions`.
- **Variante por cambio de correo (no reproducida).** El atacante, con su propia cuenta, pide cambiar su correo al de la víctima.
  Con «Secure email change» él confirma su lado y solo falta que la víctima haga clic en «confirma el cambio». Exige engañar a la
  víctima y el daño queda acotado: la víctima recupera la contraseña y las demás sesiones se cierran. Mitigación: plantilla en
  español con advertencia. Bloquearlo del todo es la decisión J4.
- **«Login CSRF»** residual: ver §3.6.
- **H-114, IP falsificable.** Afecta el tope por IP del registro y la IP guardada con el consentimiento.
- **Que nadie corra el guion de configuración.** Por eso queda en la lista del piloto y como alerta al arrancar.

## 5. Requisitos de producción y del piloto (Supabase de producción)

Los nombres del panel pueden variar.

1. «Allow new users to sign up»: **OFF**.
2. Proveedor Email: **encendido**, porque es el ingreso con contraseña y la recuperación.
3. «Confirm email»: **ON**.
4. «Secure email change»: **ON**.
5. «Secure password change»: **ON**.
6. Largo mínimo de contraseña: **10**.
7. Ingreso anónimo, enlace manual de cuentas, todos los proveedores externos, teléfono/SMS, SAML y Web3: **OFF**.
8. Pase de 900 s; rotación del pase de renovación ON con intervalo de 10 s; sesión de 168 h e inactividad de 12 h (puede exigir plan
   Pro, verificar).
9. **SMTP propio** para Supabase Auth: según la documentación de Supabase, el envío de serie solo llega a miembros del equipo del
   proyecto. Mismo proveedor y dominio de la decisión 016, con SPF, DKIM y DMARC.
10. Plantillas en español: recuperación, cambio de correo con advertencia y contraseña cambiada. Las de confirmación, invitación y
    enlace mágico, aunque no deberían salir, apuntando a nuestra aplicación.
11. Site URL = la dirección de producción. Redirecciones permitidas: solo `/auth/recuperar` y `/auth/callback` de producción, sin
    `localhost` ni comodines.
12. Ganchos: ninguno.
13. En la aplicación: `APP_ORIGIN`, `EMAIL_PROVIDER` real y anti-robot real.
14. `npm run check:auth-config` en verde, con la salida guardada.
15. Cero cuentas sin verificar antes de abrir el piloto.
16. Protección de contraseñas filtradas si el plan la incluye (decisión de Aarón).

La lista actual de `CLAUDE.md` y `README.md` («Confirm email ON, Secure email change ON…») se reemplaza por esta.

## 6. Decisiones

**De Aarón** (producto, proveedores y lo que ve la persona; además, por ser delicada, no se mezcla sin él, decisión 020 §5)

| # | Pregunta | Opciones y costo | Supuesto |
|---|---|---|---|
| A1 | ¿Registro en dos pasos? Cambia los criterios de H-001 | (a) Sí: un paso más para quien se registra. (b) No hay forma segura en un solo paso con contraseña | (a) |
| A2 | Si el correo ya tiene cuenta | (a) No enviar nada, como hoy: quien verificó y no terminó usa «Olvidé mi contraseña». (b) Correo «ya tienes cuenta; entra o recupera»: mejor experiencia, un correo más por intento. (c) Enlace para entrar sin contraseña: más cómodo, pero abre una puerta nueva sin contraseña | (a) |
| A3 | Proveedor de correo (016) | El correo de registro sale por nuestro proveedor, y Supabase necesita SMTP propio. Ambos bloquean el piloto, como ya lo hacían las invitaciones | Resend, como propone 016 |
| A4 | ¿Anti-robot en el paso 1? (019) | Sí: con el verificador intercambiable; en local, `memory`. No: el freno queda solo en los topes | Sí |
| A5 | ¿Registro solo con lista de correos durante el piloto? `PROYECTO.md` §15.3 dice «sin registro abierto al público» | Sí: superficie mínima, pero el equipo da de alta a cada empresa. No: abierto | No (no hace falta para B1) |
| A6 | Textos de §3.3 | — | Los propuestos |

**De José** (lo corriente, decisión 020 §1)

| # | Pregunta | Supuesto y costo |
|---|---|---|
| J0 | ¿Un PR o dos apilados? | Uno, con etapas: partir deja un estado roto |
| J1 | Cuenta con verificación en dos pasos inscrita al terminar | Rechazar y auditar. Costo: soporte manual en un caso que solo pasa con la configuración mal puesta |
| J2 | Vigencia del enlace y topes | 1 h; 1 enlace por minuto y 3 por hora por correo; por IP, el tope actual |
| J3 | Limpieza de cuentas sin verificar | Historia aparte antes del lanzamiento (depende de la decisión nº 17) |
| J4 | Cambio de correo hasta H-109 | Plantilla con advertencia más una prueba que documenta la variante. Bloquearlo con un disparador en `auth.users` es más fuerte, pero frágil |
| J5 | Configuración insegura detectada al arrancar | Solo alerta, sin impedir el arranque, más el guion obligatorio en la lista del piloto |
| J6 | ¿`supabase config push` para producción? | No: a mano, con el guion. `config.toml` tiene valores solo para local |

## 7. Qué NO hacer

- Arreglarlo solo en nuestro formulario: el ataque usa la API de Supabase directo.
- Pedir la contraseña «de nuevo» dejando el registro público abierto.
- «El último registro gana» con la llave maestra.
- Apagar `[auth.email] enable_signup` en vez de `[auth] enable_signup`.
- Usar `generateLink({ type: "signup" })` con contraseña, `createUser({ email_confirm: true })` o `inviteUserByEmail` con su plantilla
  de serie, que deja los datos de la sesión en la parte de la dirección después de `#`, que el servidor no ve.
- Gastar el código del enlace al abrir la página (GET).
- Armar el enlace con la dirección que llega en la petición.
- Registrar el enlace o su código en cualquier lado.
- Guardar nombre o consentimiento escritos antes de verificar.
- Dar permiso a las personas sobre `account_ready_at`.
- Apoyarse en ganchos de pago o en un disparador que reescriba contraseñas como defensa principal.
- Relajar `secure_password_change` o `double_confirm_changes`, o encender proveedores externos para «simplificar».
- Mezclar a `main` sin Aarón.

## 8. Lo que no se pudo verificar leyendo

Todos estos puntos los cierra la prueba exploratoria de la etapa 0, con llamadas reales a GoTrue local.

1. Que `generateLink({ type: "invite" })` cree la cuenta con `enable_signup = false`. Respaldo si no: `createUser` sin contraseña
   seguido de `generateLink`.
2. Qué `amr` trae la sesión de `verifyOtp({ token_hash, type: "invite" })`. `auth-js` no lista `invite` entre sus métodos; el
   comentario de `session.ts` dice que la recuperación trae `otp`.
3. Que `[auth] enable_signup = false` mantenga el ingreso con contraseña y la recuperación, y qué apaga exactamente
   `[auth.email] enable_signup`.
4. Que `generateLink("invite")` sobre una cuenta sin confirmar devuelva un código nuevo y anule el anterior, y que sobre una cuenta
   confirmada responda `email_exists`.
5. Cuánto vive un enlace de tipo invite (¿`otp_expiry`?).
6. Si el aviso «tu contraseña cambió» sale al fijar la primera contraseña. Si sale, hay que ajustar el texto de la plantilla.
7. Qué campos entrega `GET /auth/v1/settings`. Se cree que incluye `disable_signup`, `mailer_autoconfirm` y los proveedores, pero no
   el cambio seguro de correo.
8. En el Supabase alojado: el plan que exigen los ganchos de contraseña y los límites de sesión, y la restricción del SMTP de serie.
9. Si una función de la base puede leer `auth.mfa_factors` en el proyecto alojado, como hoy lee `auth.users`.
10. Qué hace GoTrue al verificar un invite sobre una cuenta que ya tenía contraseña. La reproducción del revisor solo probó el tipo
    `signup`. También queda sin reproducir la variante del cambio de correo.

---

**Reproducción del hallazgo (2026-11-05).** Con `POST /auth/v1/signup` dos veces sobre el mismo correo (primero la contraseña del
atacante, luego la de la víctima), ambas respuestas devuelven el mismo identificador de usuario; al verificar con el correo más
reciente, la contraseña del atacante inicia sesión y la de la víctima da `invalid_credentials`. Con H-009, el atacante queda como
Administrador activo de la organización invitada. Probado solo en local; no se verificó contra un Supabase de producción.
