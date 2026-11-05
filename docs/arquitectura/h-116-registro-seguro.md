# B1 · Secuestro de cuenta por registro previo — diseño del cierre (historia propuesta H-116, delicada)

> **Estado: diseño del `planificador` (Opus), 2026-11-05, con la revisión adversarial y su segunda vuelta aplicadas y las
> decisiones de Aarón del 2026-11-05 registradas (§6). Sin construir.** Nace de la revisión adversarial de H-009 (regla cero de
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
   se puede terminar desde una sesión que nació del enlace del correo. Un pase de una sesión ya cerrada deja de servir en la base
   en el acto, sin esperar los 15 minutos de su vencimiento.
4. **Costo.** Entre 6,25 y 8 días, incluido medio día de prueba exploratoria para confirmar cómo se comporta Supabase (motivos en
   §3.8). Aarón ya aprobó el cambio de lo que ve quien se registra (§6).
5. **Bloquea el piloto,** junto con una lista de 17 ajustes del Supabase de producción (§5). Casi todos se comprueban con un guion
   que usa la API de gestión de Supabase; el resto se revisa a mano en el panel. Si producción tiene el registro abierto, la
   aplicación bloquea **nuestro** formulario de registro; eso no frena el ataque, que va directo a la API de Supabase (J5).
6. **Cierre del cambio de correo.** Hasta H-109, la base no deja cambiar el correo de una cuenta, y una cuenta solo se puede
   terminar y usar con el mismo correo con que se creó (§3.4).

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

### ¿Hay una opción más simple?

Sí, y se evaluó: una versión de unos 3 días con solo la primera capa (registro público apagado, pasarela del servidor y guion de
configuración), **sin** la segunda capa en la base de datos (cuenta «terminada», `amr`, `complete_account_setup`). **Se descarta:**
toda la defensa quedaría apoyada en que producción tenga el registro apagado. Una producción mal configurada (un interruptor mal
puesto en el panel, o un cambio futuro) reabriría el ataque completo, sin ninguna segunda barrera, y el guion y la alerta solo
avisan después. La segunda capa es lo que hace que ese error sea un incidente acotado y no un secuestro de cuentas, y además es la
que cierra la variante por cambio de correo (§4). El costo extra es de 3,25 a 5 días (§3.8).

## 3. Recomendación: opción (i) en tres capas

### 3.1 Las tres capas

1. **Nadie puede tener una contraseña antes de verificar.**
   - En `supabase/config.toml`, `[auth] enable_signup = false`, y su equivalente en producción. **No** se toca
     `[auth.email] enable_signup`: ese interruptor es el del proveedor Email completo (el CLI lo pasa como
     `external_email_enabled`), así que apagarlo quita también el ingreso con contraseña y la recuperación.
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
   - Nuevas columnas `profiles.account_ready_at` y `profiles.signup_email` (el correo con el que se creó la cuenta; lo anota
     `app.handle_new_user`).
   - Nueva función `complete_account_setup`, que exige que la sesión venga de un enlace del correo **y** que el correo actual
     sea el de alta.
   - `create_tenant`, `invitation_preview` y `accept_invitation` exigen cuenta terminada, y «terminada» solo vale mientras el correo
     de la cuenta siga siendo el de alta. Además, hasta H-109 un disparador en `auth.users` rechaza todo cambio de correo
     (cierra la variante del cambio de correo, §3.4 y §4).
   - Esas funciones, `complete_account_setup` y `app.current_tenant_id()` exigen que la sesión del pase siga abierta
     (`auth.sessions`): un pase de una sesión cerrada no sirve, aunque no haya vencido.
   - Por qué basta con esas tres: a los datos de una organización solo se llega siendo miembro, y solo `create_tenant` y
     `accept_invitation` crean membresías. Una cuenta sin terminar no ve ni toca nada de nadie.
3. **Se vigila la configuración.**
   - Guion `npm run check:auth-config`. `GET /auth/v1/settings` muestra solo una parte de la configuración (no incluye, por ejemplo,
     el cambio seguro de correo ni el largo del código), así que el guion usa además la API de gestión de Supabase
     (`/v1/projects/{ref}/config/auth`, con un token de operador que vive solo en la máquina de quien corre el guion, nunca en la
     aplicación) y verifica casi toda la lista de §5. Falla si algo no coincide.
   - Una prueba que lee `config.toml`.
   - Una comprobación al arrancar y cada 5 minutos en producción, con la parte pública (`/auth/v1/settings`): si el registro está
     abierto, **se bloquea el formulario de registro** (responde «El registro no está disponible por ahora») y se alerta (decisión
     J5). Si no se puede leer la respuesta, no se bloquea por eso: sin Supabase el registro tampoco funciona. **Esto no es una
     defensa contra el ataque:** solo cierra nuestro formulario, y el atacante llama `POST /auth/v1/signup` directo con la llave
     pública. Lo que de verdad defiende es el registro apagado en Supabase (capa 1) y la base de datos (capa 2); el bloqueo solo
     hace visible el error y evita sumar cuentas nuevas mientras se corrige la configuración.

### 3.2 Recorridos

| Recorrido | Qué pasa |
|---|---|
| **Registro** | `/registro`: correo (más anti-robot, decisión A4) → «Enviarme el enlace». Revisa los topes por IP y por correo → pasarela → correo. La respuesta en pantalla es idéntica exista o no la cuenta, y el trabajo caro (cambiar la contraseña y enviar el correo) se hace después de responder y con una duración mínima fija (§3.6) |
| **Verificación** | El enlace abre `/confirmar-correo?token_hash=…&type=invite`. Al abrirla no se gasta el código, porque los antivirus de correo abren los enlaces antes que la persona: la pantalla solo muestra «Continuar». El clic manda un POST: el servidor llama `verifyOtp({ token_hash, type })`, se abre la sesión y la persona va a `/crear-cuenta`. Funciona en otro dispositivo, cosa que hoy no pasa porque el canje actual exige el navegador donde empezó el registro |
| **Terminar la cuenta (primer ingreso)** | `/crear-cuenta`: nombre, contraseña dos veces y la casilla de términos, con el correo a la vista. El servidor, en este orden: (1) `hasEmailLinkSession()`; (2) **validar sin escribir** con `account_setup_preflight` (los mismos chequeos de `complete_account_setup`: `factor_present`, `email_changed`, `legal_changed`, nombre); (3) `updateUser({ password })`; (4) `signOut({ scope: "others" })`, que borra de `auth.sessions` todas las demás sesiones de la cuenta; (5) llama `complete_account_setup`, que comprueba que no quede otra sesión abierta. Así, si la base va a rechazar, la contraseña no se llega a fijar, y nadie más que quien termina conserva un pase que sirva. Luego va a `/invitacion` si hay una invitación guardada en el navegador; si no, a «Crea tu primera organización» |
| **Ingreso normal** | Sin cambios. Una cuenta sin terminar no tiene contraseña, así que no entra. La pantalla de ingreso agrega ayuda para ese caso |
| **Recuperar contraseña** | Sin cambios para cuentas terminadas. Si la cuenta no está terminada, `/auth/recuperar` lleva a `/crear-cuenta` en vez de `/restablecer-contrasena`: un solo lugar fija la primera contraseña |
| **Cambio de correo** | No hay pantalla todavía (H-109), y la API pública de Supabase (`PUT /auth/v1/user`) sí lo permite. Hasta H-109 la base lo rechaza con un disparador en `auth.users`, y aunque faltara el disparador, una cuenta cuyo correo ya no es el de alta no se puede terminar ni cuenta como terminada (§3.4); soporte resuelve cada caso (J1). Requisitos anotados para H-109: reemplazar el disparador por un flujo revisado que pida reautenticación, cierre las demás sesiones, mueva `signup_email` en la misma operación y advierta en el correo de confirmación |
| **Registro desde una invitación (H-009)** | `/invitacion` → «Crear mi cuenta» → `/registro` con el aviso actual → enlace → «Continuar» → `/crear-cuenta` → `/invitacion` → «Unirme». La cookie de la invitación dura 1 hora; si vence o la persona termina en otro dispositivo, el inicio ya dice «¿Te invitaron? Abre de nuevo el enlace» |
| **Correo que ya tiene cuenta verificada** | `generateLink` responde «ya existe». No se envía nada (decisión A2) y la pantalla responde igual que hoy |
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

Una migración: `supabase/migrations/<fecha>_account_setup.sql`, con su deshacer en `supabase/rollbacks/`. La fecha se asigna al
construir: única y **posterior a `20261105100000` (I1, PR #27) y a `20261105110000` (H-010, PR #28)**, y a la última de `main` en ese
momento (por ejemplo `20261105120000` o más tarde).

- **`profiles.account_ready_at timestamptz`.** Vacía quiere decir «sin terminar». No hace falta tabla nueva: `profiles` ya tiene
  `tenant_id` (la organización de la plataforma). Las personas no reciben permiso para leer ni escribir esta columna, porque la
  lectura de `profiles` es por columnas desde `20261001150000`. No hacen falta índices nuevos: todo se busca por la llave principal.
- **`profiles.signup_email text`.** El correo (en minúsculas) con el que se creó la cuenta. Lo escribe solo `app.handle_new_user`,
  al insertarse la fila en `auth.users` (en este diseño, cuando la pasarela llama `generateLink`). Mismo permiso que la columna
  anterior: las personas no la leen ni la escriben (hoy solo tienen `update (full_name, last_tenant_id)`, de
  `20261001120200`). Reemplaza a la `account_ready_email` de la primera versión de este diseño: mientras no exista H-109, el
  único correo con que una cuenta puede terminarse es el de alta, así que una segunda columna no agrega nada.
- **Cambio de correo cerrado hasta H-109.** *El problema (segunda revisión):* con «Secure email change» hacen falta dos clics,
  uno en el correo antiguo y otro en el nuevo, y quien hace el último recibe una sesión del enlace, probablemente con `amr`
  `otp`, la misma marca que trae la recuperación (comentario de `src/lib/auth/session.ts`, `EMAIL_LINK_METHODS`). El ataque: el
  atacante crea una cuenta con su propio correo por nuestro formulario, abre el enlace y, **sin terminarla**, llama
  `PUT /auth/v1/user { email: <correo de la víctima> }` con la llave pública; espera a que la víctima confirme el cambio
  (pensando que es un correo de Cotiza) y luego hace clic en el enlace de su propio buzón antiguo. Con esa sesión (y probablemente también con
  la del enlace original, que ya era de enlace del correo; §8, punto 13) `complete_account_setup` aceptaba y terminaba la cuenta con el correo
  de la víctima y la contraseña del atacante. Como la cuenta nunca se había terminado, comparar con el correo «de cuando se
  terminó» no lo frenaba. `amr` no sirve para distinguir este caso. Se cierra con dos barreras, las dos en la base, porque es lo
  único que alcanza a quien llama la API directo:
  - **Regla del correo de alta (la que importa).** `complete_account_setup`, `account_setup_preflight` y `app.account_ready`
    exigen que el correo actual de `auth.users` (en minúsculas) sea igual a `profiles.signup_email`. Si no, la cuenta no se
    puede terminar (`email_changed`, auditado) ni cuenta como terminada; soporte resuelve cada caso (J1). No depende de cómo
    GoTrue haga el cambio ni de qué `amr` entregue.
  - **Disparador `before update` en `auth.users`** (`app.forbid_email_change`), que rechaza (42501) si cambia
    `lower(email)` o si se anota un cambio pendiente (`email_change` deja de estar vacío). Así el cambio ni siquiera ocurre,
    venga de `PUT /auth/v1/user`, del enlace del correo o de la API de administración. Soporte, si alguna vez lo necesita, lo
    hace por SQL con un interruptor de sesión, igual que `app.retention_purge` en `audit_log`; las personas no pueden fijar
    ese interruptor por la API. No es la fragilidad que descartó la opción (iv-b): no reescribe nada ni depende de lo que GoTrue
    tenga en memoria, solo rechaza; y el proyecto ya depende de un disparador en `auth.users` (`on_auth_user_created`). Queda
    para la etapa 0 si GoTrue alcanza a enviar los correos antes de fallar (§8).
  - **Por qué no por configuración.** Ni `config.toml` ni la API de gestión tienen un interruptor para apagar el cambio de
    correo. `[auth.email] double_confirm_changes` («Secure email change», `mailer_secure_email_change_enabled`) solo decide si
    confirman los dos correos o solo el nuevo, y apagarlo empeora las cosas. Bloquear `PUT /auth/v1/user` antes de que llegue a
    GoTrue exigiría un proxy delante de Supabase, porque la llave pública llega directo. Se deja encendido (§5, punto 4).
- **Variante anterior, también cerrada.** El atacante terminaba su propia cuenta (incluso con segundo factor), pedía el cambio
  al correo de la víctima y ella lo confirmaba. `accept_invitation` compara con el correo actual de la cuenta (confirmado leyendo
  el código), así que sin cierre la cuenta quedaba con el correo de la víctima, la contraseña del atacante y marcada como
  terminada. Ahora el disparador impide el cambio y, si faltara, la regla del correo de alta la deja sin terminar.
- **`app.account_ready(uid)`.** Interna. Es verdadera solo si `account_ready_at` no está vacía **y** el correo actual de
  `auth.users` (en minúsculas) es igual a `signup_email`.
- **`app.session_alive()`.** Interna, `security definer`, `search_path = ''`. Es verdadera si el `session_id` del pase
  (`auth.jwt() ->> 'session_id'`) existe en `auth.sessions` y es de `auth.uid()`. *Por qué:* PostgREST solo revisa la firma y el
  vencimiento del pase, así que un pase sigue sirviendo hasta 15 minutos después de cerrar su sesión. Sin esto, si un atacante
  llegara a tener un pase de la cuenta (registro abierto por error, §3.7), cuando la víctima termina la cuenta y acepta la
  invitación ese pase podría llamar `accept_invitation` o leer los datos de la organización hasta que venza. La usan
  `complete_account_setup`, `account_setup_preflight`, `my_account_ready`, `create_tenant`, `invitation_preview`,
  `accept_invitation` y **`app.current_tenant_id()`**, que es la puerta de todas las reglas por fila: con eso un pase de sesión
  cerrada no ve datos de ninguna organización. Es el punto que la primera versión dejaba para otra historia (§4); se trae a
  H-116 porque sin él el cierre no es efectivo. Costo en consultas: una búsqueda por llave principal más por sentencia, porque
  las reglas llaman `(select app.current_tenant_id())` una vez.
- **`public.account_setup_preflight(p_full_name, p_terms_version, p_privacy_version)`.** Para `authenticated`. Corre con
  permisos elevados (`security definer`), porque lee `auth.mfa_factors` y `auth.users`, con `search_path = ''`; es `stable` y
  no escribe nada. Hace los chequeos 1 a 8 de `complete_account_setup` y devuelve el primer código de rechazo; la usa
  `/crear-cuenta` antes de fijar la contraseña. **No audita** el rechazo por `amr` (ni ningún otro): no cambia nada, así que no
  hay intento que registrar, y auditar la obligaría a escribir. El intento que sí cambia algo, `complete_account_setup`, audita
  su rechazo; y nuestra acción ni siquiera llama al `preflight` sin `hasEmailLinkSession()`.
- **`public.my_account_ready()`.** Solo sobre la cuenta propia; la usa `requireUser`.
- **`app.session_from_email_link()`.** Lee `auth.jwt() -> 'amr'` y acepta los dos formatos que puede traer esa marca: lista de
  textos o de objetos con `method`. Es verdadera si hay un método de enlace del correo y ninguno `password`. La lista exacta
  (supuesto: `otp`, `magiclink`, `recovery`, `invite`) se fija tras la prueba exploratoria.
- **`public.complete_account_setup(p_full_name, p_terms_version, p_privacy_version)`.**
  - Corre con permisos elevados (`security definer`), con `search_path = ''` y solo para `authenticated`. Rechaza transacciones de
    solo lectura.
  - Revisa en este orden:
    1. Que haya sesión.
    2. Que la sesión siga abierta (`app.session_alive()`). Si no, error 42501.
    3. Que la sesión venga del enlace del correo. Si no, error 42501 y auditoría `account.setup_denied`.
    4. Que el correo esté verificado.
    5. Que el correo actual sea el de alta (`signup_email`). Si no, `email_changed` y se audita; la cuenta queda bloqueada, que
       es lo seguro, y soporte la resuelve (decisión J1).
    6. Que la cuenta no tenga ninguna verificación en dos pasos inscrita (`auth.mfa_factors`). Si la tiene, se rechaza con
       `factor_present` y se audita. En el diseño normal es imposible; solo pasa con la configuración mal puesta (la cuenta queda
       bloqueada; soporte la resuelve, decisión J1).
    7. Nombre de 1 a 120 caracteres, sin caracteres de control.
    8. Versiones de los documentos iguales a las vigentes. Si no, `legal_changed`.
    9. Que no quede otra sesión abierta de la cuenta en `auth.sessions` (la acción ya hizo `signOut({ scope: "others" })`). Si
       queda, `other_sessions`; la acción repite el cierre y reintenta.
  - Si la cuenta todavía no estaba terminada, **borra todas las aceptaciones de términos y privacidad que la cuenta tuviera** y
    deja una fila de auditoría `legal.acceptance_discarded` por cada una (documento, versión, fecha y contexto). *Por qué
    borrar y no sobrescribir:* `legal_acceptances` no admite cambios (`legal_acceptances_no_update` → `app.forbid_mutation`,
    `20261001120400_legal.sql`), así que `on conflict do update` fallaría. Borrar sí está permitido: no hay disparador de
    borrado y las personas solo tienen `select`, así que solo esta función lo hace. Se descarta cambiar el modelo (por ejemplo,
    varias aceptaciones por documento o una columna «reemplazada»): obliga a tocar la restricción `unique (user_id,
    document_id)`, la lectura de `requireUser` y la regla de solo agregar, para guardar algo que no es un consentimiento. Todo
    lo anterior a terminar la cuenta lo escribió quien la creó, no la persona, así que no se pierde ningún consentimiento real,
    y la auditoría conserva el rastro. Tampoco se agrega un bloqueo de borrado: impediría el `on delete cascade` al eliminar
    una cuenta (H-109).
  - Luego guarda el nombre y las aceptaciones con contexto `signup`, IP (`x-cp-client-ip`) y navegador. Pone `account_ready_at` y
    audita `account.setup_completed`.
  - Repetirla sobre una cuenta ya terminada no cambia nada ni falla (no vuelve a borrar aceptaciones).
- **`app.handle_new_user`.** Anota `signup_email` con `lower(new.email)`. Se quita la rama que registraba la aceptación desde
  `raw_user_meta_data.accepted_legal`: esos datos los escribe quien crea la cuenta, que puede no ser la persona.
- **`app.forbid_email_change`** y su disparador en `auth.users`, descritos arriba.
- **`create_tenant`, `invitation_preview` y `accept_invitation`.** Se agregan `app.session_alive()` y `app.account_ready(v_uid)`
  (que incluye la comparación con el correo de alta) junto al chequeo de `email_confirmed_at`. El cuerpo se copia de la **última** migración que define cada una (al construir: `20261001140100` para
  `create_tenant`, y las de H-009 y su corrección I1 para las otras dos). `create_tenant` responde 42501 «Termina de crear tu cuenta
  antes de crear una organización»; las de invitación responden `unverified`, sin resultado nuevo.
- **`app.current_tenant_id()`.** Se agrega `app.session_alive()`: sin sesión abierta devuelve vacío, como hoy sin pase. El cuerpo
  se copia de `20261001120200` (la única que la define en esta rama; revisar `main` al construir).
- **Topes.** Se amplía la lista de valores permitidos de `auth_rate_limits.scope` con `signup_email`.
- **Relleno de datos existentes.** Todas las cuentas reciben su correo actual en `signup_email`; las ya verificadas y con
  contraseña pasan a terminadas. Solo afecta la base local, porque no hay producción.

### 3.5 Archivos

**Nuevos**
- `src/lib/auth/signup-gateway.ts`: la pasarela. Es el único archivo de `src/lib/auth/` con la llave maestra, y solo llama a
  `generateLink({ type: "invite" })` y a `updateUserById(id, { password })` cuando `email_confirmed_at` está vacío.
- `src/lib/auth/signup-service.ts`: arma el enlace y envía el correo.
- `src/lib/email/account-link.ts`: el correo, con los textos escapados, como `invitation.ts`.
- `src/app/(auth)/confirmar-correo/` y `src/app/(auth)/crear-cuenta/`: páginas, formularios y acciones.
- `scripts/check-auth-config.ts`: lee la configuración pública y la API de gestión de Supabase (token de operador por variable de
  entorno, solo en `scripts/`).
- `src/lib/auth/signup-open-guard.ts`: consulta `GET /auth/v1/settings` (con caché de 5 minutos) y bloquea `/registro` y su acción
  si en producción el registro de Supabase está abierto (J5).

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
- `supabase/config.toml`: `[auth] enable_signup = false` y `[auth.email] otp_length = 10`. El enlace equivale a un código de 6
  dígitos más un correo conocido, y se puede adivinar contra `/auth/v1/verify` (unos 30 intentos por 5 minutos por IP, con
  códigos nuevos a voluntad del atacante); con 10 dígitos deja de ser práctico. La persona solo ve el enlace, no el código.
- `eslint.config.mjs`, `tests/isolation/static-guards.test.ts` y el comentario de `src/lib/supabase/admin-client.ts`, para permitir
  la pasarela nueva.
- `scripts/seed.ts`.
- `tests/support/local-supabase.ts`, `tests/isolation/fixture.ts` y `tests/db/helpers.ts`: las cuentas de prueba quedan terminadas,
  y las aceptaciones de términos se escriben aparte. `actAs` acepta `amr` y, como ahora `app.current_tenant_id()` exige sesión
  abierta, crea una fila en `auth.sessions` y pone su `session_id` en el pase (toca todas las pruebas de base y de aislamiento
  que arman pases a mano).
- `tests/isolation/registry.ts`.
- `e2e/helpers.ts`: `signUpAndVerify` y `waitForVerificationLink` siguen el flujo nuevo.
- Los e2e que llenan `/registro` a mano: `e2e/auth-tenants.spec.ts`, `e2e/team-accept-invitation.spec.ts` y
  `e2e/login-rate-limit.spec.ts`.
- Documentación: `README.md` (despliegue), `CLAUDE.md` (lista del piloto), `docs/HISTORIAS.md` (H-116 y los criterios de H-001) y
  `docs/arquitectura/`, incluido `docs/arquitectura/modelo-datos.md` §4.6: la lista de archivos que pueden importar la llave
  maestra suma `src/lib/auth/signup-gateway.ts` (la pasarela de H-116). Esa entrada ya se agregó en este PR; al construir, la regla
  de `eslint.config.mjs` y las guardias deben coincidir con ella.

Antes de programar, el agente que construya debe leer la guía de Next que viene en `node_modules/next/dist/docs/`: los parámetros de
una página y las acciones de servidor cambiaron en esta versión.

### 3.6 Dónde puede fallar y cómo se evita

- **Permisos saltados.**
  - Alguien llama `complete_account_setup` con un pase de contraseña: la base lo rechaza por `amr`.
  - Alguien escribe `account_ready_at` o `signup_email` directo: no tiene permiso sobre esas columnas.
  - Alguien cambia su correo con `PUT /auth/v1/user`: el disparador lo rechaza y, si faltara, la cuenta deja de contar como
    terminada.
  - Alguien usa un pase de una sesión ya cerrada: `app.session_alive()` lo rechaza en las funciones y en
    `app.current_tenant_id()`, aunque el pase no haya vencido.
  - Alguien llama `create_tenant` o `accept_invitation` con una cuenta sin terminar: la base lo rechaza.
- **Aislamiento entre organizaciones.** No cambia ninguna regla por fila; las funciones nuevas no reciben `tenant_id` y van al
  registro de pruebas de aislamiento.
- **Doble envío.**
  - Doble clic en «Enviarme el enlace»: el botón queda deshabilitado mientras envía y hay un tope de 1 enlace por minuto y 3 por
    hora por correo. Supuestamente cada enlace nuevo anula el anterior (por confirmar).
  - Doble envío de «Crear mi cuenta»: la función es repetible, y el error `same_password` se trata como éxito.
  - `/resend` de Supabase: sigue abierto con la llave pública y reenvía el correo de una cuenta sin verificar. No crea cuentas ni
    contraseñas, pero ver el límite de spam en §4.
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
- **Falla a mitad de terminar la cuenta.** Los rechazos previsibles de la base (`legal_changed`, `factor_present`,
  `email_changed`, nombre inválido) se detectan antes con `account_setup_preflight`, sin fijar la contraseña, así no queda una
  cuenta con contraseña y sin terminar. Si aun así falla `complete_account_setup` (por ejemplo, por un cambio de versión de
  términos justo en ese momento, u `other_sessions`), la persona reintenta y `same_password` sigue adelante.
- **Sesión de más de 24 h.** Con `secure_password_change`, `updateUser` pide reautenticación. Mensaje: «Tu enlace venció, pide uno
  nuevo».
- **Revelar si un correo tiene cuenta.** La respuesta en pantalla es la misma en todos los casos. Los **tiempos**, en cambio,
  podrían delatarla (plausible, no medido): una cuenta sin verificar implica cambiar la contraseña y enviar un correo; una
  verificada, nada. Mitigación: la acción responde enseguida y hace ese trabajo después de responder (`after()` de Next), con una
  duración mínima fija de la respuesta (por ejemplo 800 ms) para tapar la diferencia de la llamada a `generateLink`. En la etapa 0
  se miden los tres casos. **Límite conocido:** el tope por IP y el anti-robot limitan cuántos correos se pueden sondear, pero no lo
  impiden del todo.
- **Redondeo.** No aplica.

### 3.7 Pruebas que deben existir

**Prueba del ataque: `e2e/account-prehijack.spec.ts`.** El contraste rojo→verde se demuestra así, porque la prueba nueva, tal cual,
no fallaría en `main` por el ataque sino porque `/crear-cuenta` no existe. (a) La salida del guion `prehijack.cjs` corrido contra
`main` queda en el PR como evidencia roja. (b) La prueba aísla el único paso que cambia, la forma en que la víctima verifica y
fija su contraseña (`victimVerifies()` en `e2e/helpers.ts`); todo lo demás (ataque, invitación, comprobaciones) es idéntico. Con
el helper antiguo corre en `main` y falla en la comprobación de la contraseña del atacante; con el nuevo pasa.

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

**Variante «el atacante hace el último clic».** El atacante crea una cuenta con su propio correo por `/registro`, abre el enlace y,
**sin terminarla**, llama `PUT /auth/v1/user { email: E }` con la llave pública y su pase. Se comprueba que la llamada falla (el
disparador) y que el correo de la cuenta no cambió. Luego, en la misma prueba con el disparador quitado (por el interruptor de
soporte, para probar la segunda barrera sola): la víctima confirma el cambio en el correo de E, el atacante hace el último clic en
el enlace de su buzón antiguo y, con esa sesión y también con la del enlace original, llama `complete_account_setup`: falla con
`email_changed` y se audita; `accept_invitation` y `create_tenant` fallan por cuenta sin terminar. Se anota el `amr` que trajo la
sesión del último clic.

**Variante «cambio de correo tras terminar».** El atacante termina su propia cuenta (en una de las pruebas, con segundo factor
inscrito) y pide cambiar el correo al de la víctima: el disparador lo rechaza. Con el disparador quitado y la víctima confirmando:
`accept_invitation` y `create_tenant` fallan por cuenta sin terminar, y `complete_account_setup` se rechaza con `email_changed`
desde cualquier sesión, sea de enlace del correo o de contraseña (la cuenta queda para soporte, J1).

**Variante «registro abierto por error».** El atacante se crea con la llave maestra, con contraseña y sin confirmar, que es lo mismo
que haría un registro público. Un bucle intenta entrar con su contraseña cada 200 ms durante todo el flujo de la víctima. Ningún
intento obtiene sesión. Además, para el caso en que alguno la obtuviera: después de que la víctima verifica y antes de que
termine, la prueba fija con la llave maestra una contraseña que conoce el atacante (simula que la plantada sobrevivió), el atacante
entra con ella y guarda su pase. Después de que la víctima termina la cuenta y pulsa
«Unirme», con ese pase todavía sin vencer: `create_tenant`, `accept_invitation` y `complete_account_setup` fallan, y leer datos de
la organización con `x-cp-tenant-id` devuelve cero filas, porque su sesión ya no está en `auth.sessions`. Se comprueba también que
tras terminar la cuenta queda una sola sesión, la de la víctima.

**Base de datos (`tests/db/account-setup.test.ts`)**
- `complete_account_setup` rechaza `amr` de contraseña, sin `amr` y con factor inscrito; acepta un `amr` de enlace del correo;
  repetirla no falla; rechaza versiones viejas.
- Las tres funciones rechazan una cuenta sin terminar.
- El disparador rechaza cambiar `email` (también solo en mayúsculas y minúsculas) y anotar `email_change`, y deja pasar las
  demás actualizaciones de `auth.users` (confirmar el correo, fijar la contraseña, `last_sign_in_at`).
- Con el disparador quitado: `app.account_ready` pasa a falso al cambiar el correo en `auth.users`; `accept_invitation` falla
  tras el cambio; `complete_account_setup` y el `preflight` responden `email_changed`, también sobre una cuenta nunca terminada.
- `handle_new_user` anota `signup_email` en minúsculas.
- Pase con `session_id` borrado de `auth.sessions`: fallan las seis funciones y `app.current_tenant_id()` devuelve vacío; con
  otra sesión de la cuenta abierta, `complete_account_setup` responde `other_sessions`.
- Aceptación de términos preexistente (la que escribiría un registro abierto por error): `complete_account_setup` la borra, deja
  `legal.acceptance_discarded` en la auditoría y registra la real (fecha, IP y navegador de quien termina). Repetirla sobre una
  cuenta terminada no borra nada.
- `account_setup_preflight` rechaza lo mismo que `complete_account_setup` (salvo `other_sessions`) y no escribe nada, ni
  auditoría.
- Las columnas no se pueden escribir.
- `handle_new_user` ya no registra consentimiento; se reescribe la prueba de `tests/db/behavior.test.ts:423`.
- El relleno y el deshacer.

**Aislamiento**
- Funciones nuevas en el registro.
- Ataques nuevos X7 y X8: `/auth/v1/signup` y `/auth/v1/otp` con `create_user` deben ser rechazados.
- Ataque nuevo X9: `/auth/v1/resend` no puede crear cuentas ni fijar contraseñas (solo reenvía a cuentas existentes).
- Ataque nuevo X10: `PUT /auth/v1/user` con otro correo debe fallar; con el disparador quitado, el cambio seguido de
  `complete_account_setup` o `accept_invitation` debe fallar.
- Ataque nuevo X11: un pase cuya sesión se cerró (`signOut`) no lee datos de su organización ni llama las funciones, aunque no
  haya vencido.
- Ana, con pase de contraseña, no puede llamar `complete_account_setup`.

**Guardias estáticas**
- `supabase.auth.signUp(` y `signInWithOtp(` no aparecen en `src/`.
- La llave maestra en `src/lib/auth/` solo está en la pasarela.
- La pasarela nunca llama `createUser`, `email_confirm`, `listUsers`, `deleteUser`, `.from(` ni `.rpc(`.
- `config.toml` tiene `[auth] enable_signup = false`, `enable_confirmations = true`, `double_confirm_changes = true`, `otp_length = 10`, sin ingreso
  anónimo, sin enlace manual de cuentas y sin proveedores externos encendidos.

**Unitarias**
- Esquemas; mensajes; `hasEmailLinkSession` con cada combinación de `amr`.
- El orden de `completeAccountSetupAction`: validar (`preflight`) → contraseña → cerrar otras sesiones → base; que un rechazo del
  `preflight` no llame a `updateUser`; y que ante `other_sessions` repita el cierre una vez y reintente.
- La acción de registro responde con la misma forma y duración mínima en cuenta nueva, sin verificar y verificada (con reloj
  simulado), y hace el trabajo caro después de responder.
- `signup-open-guard`: bloquea con registro abierto en producción y no bloquea con registro cerrado.
- El correo escapa el texto y lleva `APP_ORIGIN`.
- El guion de configuración, con respuestas simuladas de ambas API (pública y de gestión).

**E2e de regresión**
- Registro sin invitación y desde invitación, incluido otro dispositivo.
- `/resend` con la llave pública sobre una cuenta sin verificar: no cambia la contraseña ni crea cuentas.
- Un GET de antivirus no gasta el enlace.
- Recuperar contraseña de una cuenta sin terminar lleva a `/crear-cuenta`.
- Tope por IP y por correo.
- Móvil a 375 px.
- Suites completas en local, porque el CI no corre: `test`, `test:db`, `test:isolation`, `test:db:rollbacks`, y luego
  `npm run db:seed`, `E2E_PROD=1 npx playwright test --project=chromium` y `--project=isolation`. Cambiar `signUpAndVerify` toca
  unos 25 e2e que lo usan.

### 3.8 Etapas y días

| Etapa | Días |
|---|---|
| 0. Prueba exploratoria contra GoTrue local (los 14 puntos de §8) | 0,5–0,75 |
| 1. Migración (correo de alta, disparador del cambio de correo, `preflight`, sesión abierta en las funciones y en `app.current_tenant_id()`, borrado auditado de aceptaciones), `actAs` con sesión real y pruebas de base de datos | 1,5–1,75 |
| 2. Pasarela, correo, acciones, dos pantallas nuevas al estándar premium con su revisión visual, y control de entrada de la sesión | 2–2,5 |
| 3. E2e (cambio de `signUpAndVerify`, unos 25 e2e) y la del ataque con sus variantes (último clic, pase de sesión cerrada); aislamiento; guardias; guion con API de gestión; documentos; suites completas en local | 1,75–2 |
| 4. Revisión adversarial y correcciones | 0,5–1 |
| **Total** | **6,25–8** |

**Por qué sube respecto del diseño inicial (4,5–5,5):** (a) hay dos pantallas nuevas, `/confirmar-correo` y `/crear-cuenta`, que
deben quedar al estándar premium y pasar por la revisión visual de Aarón; (b) cambiar `signUpAndVerify` en `e2e/helpers.ts` toca
unos 25 e2e; (c) las suites completas se corren en local mientras el CI tenga cuota limitada; (d) la prueba exploratoria de la
etapa 0 puede cambiar el diseño (§8), y eso se paga en las etapas siguientes; (e) el cierre del cambio de correo (columna,
`preflight`, pruebas) y el guion con la API de gestión.

**Por qué sube en la segunda revisión (de 5,5–7 a 6,25–8):** el cierre del cambio de correo por «último clic» (correo de alta,
disparador y su prueba e2e), la sesión abierta en las funciones y en `app.current_tenant_id()` (con `actAs` creando sesiones
reales, lo que toca todas las pruebas de base y aislamiento), el borrado auditado de aceptaciones, y dos puntos nuevos y uno
ampliado en la etapa 0.

Pasa de 2 días. Partirla deja un estado intermedio roto o inseguro: con el control de cuenta terminada pero sin la pantalla de
terminar, nadie nuevo podría crear organizaciones. Por eso se propone una rama y un PR con commits por etapa (decisión J0).

### 3.9 Qué vuelve a revisión adversarial (agente `revisor`)

- Todo el registro nuevo, repitiendo `squat.cjs` y `prehijack.cjs` adaptados.
- Un ensayo con `enable_signup = true` en una copia local, para probar la segunda capa.
- «Login CSRF», antivirus, cabecera `Host`, el código del enlace en registros, los topes por correo e IP.
- Lectura de `amr` con pases de distintas formas, el relleno, el cambio en `handle_new_user`, el camino viejo de `/auth/callback` y
  la variante del cambio de correo, incluido «el atacante hace el último clic» (ahora cerrada por el disparador y por
  `signup_email`; se intenta romper cada barrera por separado).
- Pases de sesiones cerradas contra las funciones y contra las reglas por fila (`app.current_tenant_id()`), y el borrado de
  aceptaciones previas.
- Tiempos de respuesta del registro, adivinar el código del enlace con `otp_length = 10`, y `/resend`.

---

## 4. Riesgos que quedan y lo que esto no resuelve

- **Correo de la víctima comprometido.** Fuera de alcance: todo se apoya en el correo, igual que recuperar la contraseña. Lo
  atenúan los dos pasos (H-004).
- **Correos de verificación a terceros (spam).** Los correos de **registro** salen por nuestro formulario (tope por IP, tope por
  correo y anti-robot, decisión 019), pero **no es la única puerta**: `/recover`, `/otp` (para cuentas que ya existen) y `/resend`
  siguen abiertos con la llave pública de Supabase, y con ella cualquiera puede pedir esos correos para un tercero. Es un
  comportamiento conocido de Supabase y no se probó aquí. Pedir enlaces para un correo ajeno manda mensajes no pedidos y, cada vez,
  anula el enlace anterior: es una molestia, acotada por el tope por correo en nuestro formulario y por los límites propios de
  Supabase en las demás. Hasta que exista el verificador anti-robot real, en local rige `memory` y solo frenan los topes.
- **Cuentas sin verificar.** Quedan en `auth.users` hasta una limpieza. Hoy guardan nombre y consentimiento falsos; después solo
  guardan el correo. La limpieza (7 días sin verificar, 30 verificadas sin terminar) va en una historia aparte, que depende de la
  decisión pendiente nº 17 (cómo se programan las tareas en producción).
- **Pase vigente hasta 15 minutos después de cerrar la sesión: cerrado en la base.** La primera versión lo dejaba para otra
  historia; la segunda revisión mostró que, sin esto, el pase de un atacante seguía sirviendo después de que la víctima terminaba
  la cuenta. Ahora `app.session_alive()` lo rechaza en las funciones de registro y membresía y en `app.current_tenant_id()`
  (§3.4), lo que de paso cumple `SEGURIDAD.md` §1 («cierre efectivo») para todos los datos de organizaciones. Lo que no pasa por
  la base es la API de Supabase Auth (`/auth/v1/user`, inscribir un segundo factor); se cree que GoTrue ya rechaza ahí los pases
  de sesiones borradas (`session_not_found`), y se confirma en la etapa 0 (§8, punto 14).
- **Variante por cambio de correo: cerrada en este diseño.** Se confirmó leyendo el código que `accept_invitation` compara con el
  correo actual de la cuenta. Había dos caminos: el atacante terminaba su cuenta y después pedía el cambio al correo de la
  víctima, o (segunda revisión) pedía el cambio **sin terminarla** y hacía el último de los dos clics, con lo que la sesión del
  enlace le servía para terminarla con el correo de la víctima y su contraseña. Ahora, hasta H-109, un disparador en
  `auth.users` rechaza el cambio de correo, y además la cuenta solo se puede terminar y solo cuenta como terminada con el correo
  de alta (§3.4). El riesgo no se acepta: se cierra (decisión J4). Sigue la plantilla en español con advertencia, como aviso
  adicional. Falta reproducir los dos caminos en `main` en la etapa 0 (§8, puntos 10 y 13).
- **«Login CSRF»** residual: ver §3.6.
- **H-114, IP falsificable.** Afecta el tope por IP del registro y la IP guardada con el consentimiento.
- **Que nadie corra el guion de configuración.** Por eso queda en la lista del piloto y como alerta al arrancar.

## 5. Requisitos de producción y del piloto (Supabase de producción)

Los nombres del panel pueden variar. `npm run check:auth-config` verifica casi todo lo de esta lista con la API de gestión de
Supabase (`/v1/projects/{ref}/config/auth`, con un token de operador): los puntos 1 a 8, el 9 en lo que toca a que haya SMTP
configurado, el 11, el 12 y el 17. Quedan a mano en el panel: SPF, DKIM y DMARC (9), las plantillas (10) y el plan (16). Los
nombres exactos de los campos de esa API se fijan en la etapa 0. Los puntos 13 a 15 no son de Supabase y los revisa cada uno
quien se indica en el punto.

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
13. En la aplicación: `APP_ORIGIN`, `EMAIL_PROVIDER` real y anti-robot real. **Lo revisa la propia aplicación al arrancar:**
    `src/instrumentation.ts` ya impide arrancar en producción sin proveedor de correo real ni anti-robot real; H-116 le suma
    `getAppOrigin()`, que hoy solo falla en el primer uso.
14. `npm run check:auth-config` en verde, con la salida guardada. **Lo corre el operador que prepara el piloto** (Aarón o quien
    él designe) y deja la salida junto a la lista del piloto de `CLAUDE.md`; Aarón la revisa antes de abrir el piloto.
15. Cero cuentas sin verificar antes de abrir el piloto. **Lo revisa el mismo operador, a mano**, con una consulta de solo
    lectura en el editor SQL del panel (cuentas de `auth.users` sin `email_confirmed_at`), y anota el resultado junto a la
    salida del punto 14.
16. Protección de contraseñas filtradas si el plan la incluye (decisión de Aarón).
17. Largo del código de correo (`mailer_otp_length`; `[auth.email] otp_length` en local): **10**. La persona solo ve el enlace; con
    6 dígitos el código se podría adivinar contra `/auth/v1/verify`.

La lista actual de `CLAUDE.md` y `README.md` («Confirm email ON, Secure email change ON…») se reemplaza por esta. Si al correr el guion
el registro de producción está abierto, el guion falla y, además, la aplicación bloquea el formulario de registro (J5). Ese
bloqueo no es una defensa: el atacante no usa nuestro formulario sino la API de Supabase directo. Lo que defiende es el punto 1
y la base de datos.

## 6. Decisiones

**De Aarón** (producto, proveedores y lo que ve la persona; además, por ser delicada, no se mezcla sin él, decisión 020 §5)

Todas las de esta tabla quedan como **«decisión por defecto aplicada por Aarón el 2026-11-05»** (reemplaza al supuesto de la
propuesta).

| # | Pregunta | Opciones y costo | Decisión |
|---|---|---|---|
| A1 | ¿Registro en dos pasos? Cambia los criterios de H-001 | (a) Sí: un paso más para quien se registra. (b) No hay forma segura en un solo paso con contraseña | **(a) Sí.** Decisión por defecto aplicada por Aarón el 2026-11-05 |
| A2 | Si el correo ya tiene cuenta | (a) No enviar nada, como hoy: quien verificó y no terminó usa «Olvidé mi contraseña». (b) Correo «ya tienes cuenta; entra o recupera»: mejor experiencia, un correo más por intento. (c) Enlace para entrar sin contraseña: más cómodo, pero abre una puerta nueva sin contraseña | **(a) No enviar nada, como está.** Decisión por defecto aplicada por Aarón el 2026-11-05 |
| A3 | Proveedor de correo (016) | El correo de registro sale por nuestro proveedor, y Supabase necesita SMTP propio. Ambos bloquean el piloto, como ya lo hacían las invitaciones | **Resend, según la decisión 016.** Decisión por defecto aplicada por Aarón el 2026-11-05. Contratarlo sigue siendo una decisión de dinero aparte |
| A4 | ¿Anti-robot en el paso 1? (019) | Sí: con el verificador intercambiable; en local, `memory`. No: el freno queda solo en los topes | **Sí** (decisión 019). Decisión por defecto aplicada por Aarón el 2026-11-05 |
| A5 | ¿Registro solo con lista de correos durante el piloto? `PROYECTO.md` §15.3 dice «sin registro abierto al público» | Sí: superficie mínima, pero el equipo da de alta a cada empresa. No: abierto | **No hace falta** para B1. Decisión por defecto aplicada por Aarón el 2026-11-05 |
| A6 | Textos de §3.3 | — | **Se aprueban los propuestos;** se revisan en la revisión visual. Decisión por defecto aplicada por Aarón el 2026-11-05 |

**De José** (lo corriente, decisión 020 §1)

| # | Pregunta | Supuesto y costo |
|---|---|---|
| J0 | ¿Un PR o dos apilados? | Uno, con etapas: partir deja un estado roto |
| J1 | Cuenta con verificación en dos pasos inscrita al terminar, o cuyo correo ya no es el de alta | Rechazar (`factor_present` o `email_changed`) y auditar. Costo: soporte manual en casos que solo pasan con la configuración mal puesta o sin el disparador del cambio de correo |
| J2 | Vigencia del enlace y topes | 1 h; 1 enlace por minuto y 3 por hora por correo; por IP, el tope actual |
| J3 | Limpieza de cuentas sin verificar | Historia aparte antes del lanzamiento (depende de la decisión nº 17) |
| J4 | Cambio de correo hasta H-109 | **Se cierra, no se acepta el riesgo** (decisión por defecto aplicada por Aarón el 2026-11-05), con pruebas y en la estimación. Se mantiene la plantilla con advertencia. *Mecanismo corregido en la segunda revisión*, porque el de la primera versión (`account_ready_email`) no frenaba al atacante que hace el último clic sin haber terminado su cuenta: `profiles.signup_email` y la regla de que la cuenta solo se termina y solo cuenta como terminada con el correo de alta, más un disparador en `auth.users` que rechaza el cambio de correo (§3.4). El disparador no es frágil como la opción (iv-b): solo rechaza, no reescribe nada. No hay forma de apagar el cambio de correo por configuración |
| J5 | Producción con el registro abierto | **Se bloquea el formulario de registro,** no solo se avisa (decisión por defecto aplicada por Aarón el 2026-11-05), más alerta y el guion obligatorio en la lista del piloto (§3.1). Solo bloquea nuestro formulario: **no frena el ataque**, que va directo a la API de Supabase. La defensa real es el registro apagado en Supabase y la base de datos |
| J6 | ¿`supabase config push` para producción? | No: a mano, con el guion. `config.toml` tiene valores solo para local |

## 7. Qué NO hacer

- Arreglarlo solo en nuestro formulario: el ataque usa la API de Supabase directo.
- Pedir la contraseña «de nuevo» dejando el registro público abierto.
- «El último registro gana» con la llave maestra.
- Apagar `[auth.email] enable_signup` en vez de `[auth] enable_signup`.
- Dejar el código del enlace en 6 dígitos (`otp_length` debe ser 10).
- Tratar una cuenta como terminada, o dejar terminarla, sin comprobar que su correo sigue siendo el de alta.
- Usar `amr` para distinguir una sesión del enlace de registro de una del enlace de cambio de correo: probablemente traen la misma
  marca.
- Confiar en que cerrar una sesión invalida su pase: la base debe comprobar `auth.sessions`.
- Sobrescribir aceptaciones con `on conflict do update`: `legal_acceptances` no admite cambios.
- Leer el bloqueo del formulario de registro (J5) como una defensa contra el ataque.
- Fijar la contraseña antes de validar en la base lo que la base puede rechazar.
- Responder igual en pantalla pero hacer el trabajo caro antes de responder (delata si el correo tiene cuenta).
- Usar `generateLink({ type: "signup" })` con contraseña, `createUser({ email_confirm: true })` o `inviteUserByEmail` con su plantilla
  de serie, que deja los datos de la sesión en la parte de la dirección después de `#`, que el servidor no ve.
- Gastar el código del enlace al abrir la página (GET).
- Armar el enlace con la dirección que llega en la petición.
- Registrar el enlace o su código en cualquier lado.
- Guardar nombre o consentimiento escritos antes de verificar.
- Dar permiso a las personas sobre `account_ready_at` o `signup_email`.
- Apoyarse en ganchos de pago o en un disparador que reescriba contraseñas como defensa principal.
- Relajar `secure_password_change` o `double_confirm_changes`, o encender proveedores externos para «simplificar».
- Mezclar a `main` sin Aarón.

## 8. Lo que no se pudo verificar leyendo

Todos estos puntos los cierra la prueba exploratoria de la etapa 0, con llamadas reales a GoTrue local.

1. Que `generateLink({ type: "invite" })` cree la cuenta con `enable_signup = false`. Respaldo si no: `createUser` sin contraseña
   seguido de `generateLink`.
2. Qué `amr` trae la sesión de `verifyOtp({ token_hash, type: "invite" })`. `auth-js` no lista `invite` entre sus métodos; el
   comentario de `session.ts` dice que la recuperación trae `otp`.
3. Que `[auth] enable_signup = false` mantenga el ingreso con contraseña y la recuperación. (Ya confirmado:
   `[auth.email] enable_signup` es `external_email_enabled`, el proveedor Email completo; por eso no se toca, §3.1.)
4. Que `generateLink("invite")` sobre una cuenta sin confirmar devuelva un código nuevo y anule el anterior, y que sobre una cuenta
   confirmada responda `email_exists`.
5. Cuánto vive un enlace de tipo invite (¿`otp_expiry`?).
6. Si el aviso «tu contraseña cambió» sale al fijar la primera contraseña. Si sale, hay que ajustar el texto de la plantilla.
7. Qué campos entrega `GET /auth/v1/settings` (se cree que incluye `disable_signup`, `mailer_autoconfirm` y los proveedores, pero no
   el cambio seguro de correo) y cuáles entrega la API de gestión `/v1/projects/{ref}/config/auth`, con sus nombres exactos.
8. En el Supabase alojado: el plan que exigen los ganchos de contraseña y los límites de sesión, y la restricción del SMTP de serie.
9. Si una función de la base puede leer `auth.mfa_factors` y `auth.sessions` en el proyecto alojado, como hoy lee `auth.users`,
   y si sigue permitido crear un disparador `before update` en `auth.users` (hoy ya hay uno `after insert`).
10. Qué hace GoTrue al verificar un invite sobre una cuenta que ya tenía contraseña. La reproducción del revisor solo probó el tipo
    `signup`. También queda sin reproducir la variante del cambio de correo tras terminar
    (hay que reproducirla en `main` y comprobar que el cierre de §3.4 la detiene).
11. Que `otp_length = 10` valga para los enlaces de tipo invite y que el enlace siga funcionando con ese largo.
12. Tiempos de la acción de registro con cuenta nueva, sin verificar y verificada, para fijar la duración mínima de la respuesta.
13. **«El atacante hace el último clic».** Reproducirlo en `main`: cuenta propia sin terminar, `PUT /auth/v1/user` con el correo
    de la víctima, la víctima confirma y el atacante hace el último clic. Anotar el `amr` de esa sesión y si el pase del enlace
    original sigue sirviendo con el correo nuevo. Con el disparador puesto: qué responde `PUT /auth/v1/user` y si GoTrue alcanza
    a enviar los dos correos antes de fallar (si los envía, el texto de la plantilla de cambio de correo debe decir que el cambio
    no está disponible).
14. Que `signOut({ scope: "others" })` borre de `auth.sessions` las demás sesiones; que todo pase de GoTrue traiga `session_id`,
    también tras renovarse; y que la API de Supabase Auth rechace un pase cuya sesión se borró (`session_not_found`).

---

**Reproducción del hallazgo (2026-11-05).** Con `POST /auth/v1/signup` dos veces sobre el mismo correo (primero la contraseña del
atacante, luego la de la víctima), ambas respuestas devuelven el mismo identificador de usuario; al verificar con el correo más
reciente, la contraseña del atacante inicia sesión y la de la víctima da `invalid_credentials`. Con H-009, el atacante queda como
Administrador activo de la organización invitada. Probado solo en local; no se verificó contra un Supabase de producción.
