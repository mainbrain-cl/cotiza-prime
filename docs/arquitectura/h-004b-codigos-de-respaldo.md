# H-004b · Códigos de respaldo, pedir la contraseña de nuevo y desactivar la verificación: plan de construcción

**Estado:** diseño del `planificador` (Opus, 2026-11-16). Es una historia delicada: no se mezcla sin revisión adversarial y sin Aarón (decisión 020 §5). **Origen:** la ficha H-004b de `docs/HISTORIAS.md` y la orden de Aarón del 2026-11-12 (seguimiento 1 de la decisión 021). **Entorno de todas las pruebas:** PRUEBAS (Supabase local). Las rutas son relativas a la raíz del repositorio. **Depende de** H-004a y H-118, las dos en `main`.

## Decisiones aplicadas (2026-11-16)

- **José** (agencia, decisión 020 §5): **D3 = A** (contraseña junto al código, en el último paso de activar), **D5 = A** (aviso de mejor esfuerzo al entrar con un código de respaldo), **D6 = A** (10 códigos de 12 caracteres) y **D8 = A** (un solo PR con tres etapas).
- **Supuestos que se construyen mientras Aarón no responde** (son suyos; **debe confirmarlos**): **D1 = A** (tabla propia `mfa_recovery_codes`), **D2 = A** (usar un código quita el factor, cierra las otras sesiones y avisa por correo), **D4 = A** (si el aviso de desactivar no sale, no se desactiva) y **D7 = B** (se acepta, hasta H-117, que quien tenga una sesión completa robada pueda quitar el factor hablando directo con Supabase; falta confirmarlo en P0-5).
- El PR queda en borrador y **no se mezcla sin la revisión de Aarón** (historia delicada).

## 0. Qué se construye

Son cuatro cosas, en el orden que pidió Aarón:

1. **Pedir la contraseña de nuevo** antes de activar, antes de desactivar y antes de generar códigos nuevos.
   - Protege del caso de quien encuentra una sesión abierta (un computador sin bloquear) o copia la cookie de sesión: sin la contraseña no puede activar su teléfono ni apagar el segundo paso.
   - No protege de quien ya sabe la contraseña. Ese caso lo cubre H-118.
2. **Códigos de respaldo.** Al activar se muestran 10 códigos de un solo uso, una sola vez, y la persona confirma «Los guardé». En la base solo queda su huella (un resumen del código que no se puede revertir).
3. **Entrar con un código de respaldo** cuando la persona no tiene el teléfono.
4. **Desactivar** exige la contraseña y un código válido, sea de la aplicación o de respaldo.

## 1. Lo comprobado y lo que no

### 1.1 ¿Supabase trae códigos de respaldo propios?

Lo leí en `node_modules/@supabase/auth-js`, versión 2.117.2, que es la que usa el proyecto.

**Lo que sí está en la librería:**
- Existe `auth.mfa.recoveryCodes`, con `getStatus`, `generate`, `verify`, `regenerate` y `unenroll`.
- Está marcado como **experimental**. Solo funciona si el cliente se crea con `auth.experimental.recoveryCodes: true` y, según su propia documentación, si además está **habilitado en el servidor de Supabase Auth**.
- Así se comporta, según esa documentación:
  - Generar exige un pase aal2 (el nivel que significa «contraseña y código») y otro factor ya verificado.
  - Los códigos se entregan una sola vez y tienen 16 caracteres.
  - Verificar un código sube la sesión a aal2 sin quitar el factor de la aplicación, cierra las otras sesiones aal1 y tiene un bloqueo propio tras muchos fallos (`mfa_recovery_codes_locked`, 429).
  - Para Supabase, los códigos son un factor más (`factor_type = 'recovery_code'`) y aparecen en `user.factors`.

**Lo que no se pudo comprobar:**
- Si el Supabase Auth local que levanta la CLI 2.119 tiene las rutas `/auth/v1/factors/recovery-codes`, y con qué clave se encienden. `supabase/config.toml` solo trae `[auth.mfa.totp]`, `[auth.mfa.phone]` y `[auth.mfa.web_authn]`, sin ninguna sección de códigos de respaldo. El binario de la CLI se descarga aparte y no está en el repositorio, así que no lo pude revisar.
- Si el Supabase alojado (producción) los ofrece.

**Qué pasaría si se usan los de Supabase (es la opción D1 = B), según el código actual:**
- `app.second_step_pending()` cuenta **cualquier** factor verificado, así que el factor de códigos contaría.
- El disparador de H-118 (`app.mfa_factor_verify_gate`, un código que la base corre sola cuando cambia una fila) rechaza que un factor que no es TOTP pase a «verificado». Si Supabase crea el factor de códigos sin verificar y después lo actualiza, generar códigos fallaría con un error 500. No se sabe cómo lo crea.
- `lockAccountAndRemoveFactors` (la anulación de H-118) borra todos los factores que liste la API de administración. Tendría que incluir el de códigos.
- H-117 (la opción B de la decisión 021, antes del lanzamiento) elimina el factor de Supabase. Los códigos nativos necesitan otro factor de Supabase para existir, así que se perderían y todas las personas tendrían que generar códigos nuevos.

### 1.2 Hechos del código actual que el diseño usa

- `confirmTotpEnrollmentAction` (`src/lib/auth/second-step-actions.ts`) termina con un `redirect`. Hay que cambiarla para que devuelva los códigos en su respuesta, porque nunca pueden ir en la dirección de la página.
- Supabase exige aal2 para quitar un factor verificado: con aal1 responde 422 (prueba (a) de `tests/db/mfa-session-gate.test.ts`).
  - **Lo que no está probado** es que con aal2 se pueda quitar directo por la API. Se supone que sí: es el punto P0-5 del paso 0 y la base de la decisión D7.
- Quitar un factor con la llave maestra (la llave `service_role`, que se salta la seguridad por fila) no cierra ninguna sesión. Lo fijó el paso 0 de H-118 (punto 4).
- `resetPasswordAction` ya usa `signOut({ scope: "others" })` para cerrar las demás sesiones.
- `auth_rate_limits` ya tiene todos los alcances que hacen falta (`login_email`, `login_ip`, `mfa_verify_user`, `mfa_verify_user_day`). **No hay que tocar su lista.**
- Las cookies de sesión son `HttpOnly`: un script de la página no puede leerlas, pero quien tiene el computador abierto sí puede copiarlas desde las herramientas del navegador.

## 2. Decisiones (preguntas con opciones y su costo)

Cada pregunta trae el supuesto que se aplica si nadie responde.
- **Las decide Aarón:** D1, D2, D4 y D7, porque cambian cuánto se protege la cuenta y relajar un control no lo puede decidir José (decisión 020 §3).
- **Las decide José:** el resto.

**D1. ¿Códigos propios o los de Supabase?** (Aarón)
- **A. Tabla propia `mfa_recovery_codes` (recomendada).** Costo: unos 6 días en total (ver §8).
  - Ventajas:
    - No depende de algo experimental ni de que el Supabase alojado lo active.
    - Sobrevive a H-117 sin rehacerse.
    - Solo nuestro servidor puede probar un código, así que el hueco de fuerza bruta de la decisión 021 no aplica a los códigos de respaldo.
    - No choca con el disparador de H-118.
  - Desventaja: con el factor de Supabase no podemos subir la sesión a aal2 sin el teléfono. Por eso **usar un código de respaldo quita el factor**, y la cuenta queda protegida solo por la contraseña hasta que la persona active su teléfono nuevo (ver D2).
- **B. Los de Supabase (experimental).**
  - Costo: unos 3,5 a 4 días, más la incertidumbre del paso 0 (si el Supabase local o el de producción no los trae, no hay cómo) y rehacerlo todo en H-117, con todas las personas generando códigos nuevos.
  - Ventajas: el código da aal2 sin quitar el factor, y trae el bloqueo de intentos de Supabase.
- **Supuesto: A.**

**D2. Con D1 = A, ¿qué tan cerrada queda la cuenta después de entrar con un código de respaldo, hasta que la persona active su teléfono nuevo?** (Aarón)
- **A. Recomendada.** Se quita el factor, se cierran todas las otras sesiones, sale un correo y la persona va directo a activar de nuevo.
  - Riesgo: mientras no la reactive, quien sepa la contraseña entra sin segundo paso. Si además activa su propio teléfono, a la dueña le llega el aviso de H-118 con el enlace para anular.
  - Cuando exista H-004c, un Dueño o Administrador sin segundo paso quedará como Observador.
- **B. A, y además obligar a elegir una contraseña nueva en el mismo paso.** +0,5 días. Cierra el hueco frente a quien ya tenía la contraseña, a cambio de más pasos para alguien que acaba de perder el teléfono.
- **C. A, y además una marca en la base que trata como «a medias» cualquier OTRA sesión hasta que reactive.** +1 día. Cambia `app.second_step_pending()` y `session.ts`, y H-117 lo rehace. No la recomiendo.
- **Supuesto: A.**

**D3. ¿En qué momento se pide la contraseña al activar?** (José)
- **A. Recomendada.** Junto al código, en el último paso: «Escribe el código y tu contraseña».
  - No hay que guardar nada.
  - El servidor revisa la contraseña justo antes de dar el «permiso» de 2 minutos de H-118, que es lo único que deja verificar un factor. Así, ni hablando directo con Supabase se puede activar sin la contraseña.
- **B. Al empezar, antes de mostrar el código QR,** con un pase de 10 minutos guardado en la base y atado a la sesión y al factor. +0,5 días y una tabla más.
- **Supuesto: A.**

**D4. Al desactivar, si el correo de aviso no sale, ¿se desactiva igual?** (Aarón)
- **A. No (recomendada).** Primero sale el aviso y solo entonces se desactiva, igual que la decisión D3 de H-118. Costo: si el proveedor de correo falla o se acaba la cuota, nadie puede desactivar por un rato.
- **B. Sí.** Se desactiva y el aviso es de mejor esfuerzo. Si un atacante tiene la contraseña y el código, la dueña podría no enterarse.
- **Supuesto: A.**

**D5. Al entrar con un código de respaldo, ¿el aviso por correo es obligatorio?** (José)
- **A. De mejor esfuerzo (recomendada).** Es la salida de emergencia de quien perdió el teléfono; bloquearla porque falla el correo dejaría a esa persona fuera. Igual queda en la auditoría.
- **B. Obligatorio,** como en D4.
- **Supuesto: A.**

**D6. ¿Qué formato tienen los códigos?** (José)
- **A. Recomendada.** 10 códigos de 12 caracteres en grupos de 4 (por ejemplo `7KQM-3XHP-W2RT`), sin las letras que se confunden (sin I, L, O ni U). Cada uno tiene 60 bits de azar.
- **B. 10 códigos de 16 caracteres** (80 bits, como los de Supabase). Más difíciles de escribir.
- **C. 8 códigos de 10 caracteres** (50 bits). Más cómodos, con menos margen si se filtraran las huellas junto con la llave.
- **Supuesto: A.**

**D7. ¿Se cierra en la base la posibilidad de desactivar hablando directo con Supabase?** (Aarón)
Quien tenga una sesión completa robada (pase aal2) probablemente puede pedirle a Supabase que quite el factor directamente: sin pasar por nuestra pantalla, sin contraseña ni código, y sin que salga el aviso. Falta confirmarlo en P0-5.
- **A. Sí, se cierra.** Un disparador antes de borrar en `auth.mfa_factors` rechaza quitar un factor TOTP verificado si nuestro servidor no dejó antes un «permiso de baja» de 2 minutos.
  - Costo: +0,75 a 1 día.
  - Obliga a que **todo** borrado legítimo pase por el servidor: revertir y anular de H-118, entrar con un código de respaldo, desactivar, el borrado completo de una cuenta (hay que probar que no lo bloquee) y el procedimiento de soporte, que hoy borra el factor a mano.
  - Se descarta cuando llegue H-117.
- **B. No, se acepta el riesgo hasta H-117 (recomendada para el piloto).**
  - Quien lo aprovecha ya tiene una sesión completa robada, con la que puede hacer casi todo lo que permite su rol, y solo gana algo más si además sabe la contraseña.
  - H-117 lo cierra, porque ya no habrá factor de Supabase.
- **Supuesto: B,** anotado como riesgo aceptado si Aarón lo confirma.

**D8. ¿Una ficha o varias?** (José)
La historia figuraba como «mediana» (1,5 días en §7 del documento del sprint 5) y este diseño suma unos 6 días. La regla del proyecto dice que una historia de más de dos días está mal partida.
- **A. Recomendada.** Un solo PR con tres etapas, como se hizo con H-118:
  - Etapa A, «pedir la contraseña»: ~1 día, contando el paso 0.
  - Etapa B, «códigos de respaldo: crearlos, generar nuevos y entrar con uno»: ~3 días.
  - Etapa C, «desactivar»: ~0,75 días.
  - Pruebas de punta a punta y documentos: ~0,5 días.
  - Revisión y correcciones: ~0,75 días.
- **B. Tres fichas** (H-004b1, H-004b2 y H-004b3) en tres PR separados.
- **Supuesto: A.**

## 3. Diseño

### 3.1 Pedir la contraseña de nuevo

Archivo nuevo `src/lib/auth/reauth.ts`, que solo corre en el servidor, con la función `confirmPassword(user, password, purpose)`.

1. **El correo sale de la sesión,** con `getSessionState()`, que lo lee de Supabase Auth. **Nunca del formulario.**
2. **Límite de intentos:** el mismo del ingreso. Primero `isLoginLocked(email, ip)`; una contraseña incorrecta suma un fallo con `recordLoginFailure`, y una correcta limpia el contador con `clearLoginFailures`. Así no se abre un segundo presupuesto de intentos.
3. **Cómo se comprueba:** con un cliente de Supabase desechable, sin cookies (`persistSession: false`), que llama a `signInWithPassword({ email, password })`.
   - Si sale bien, se exige que `data.user.id` sea la persona de la sesión y se cierra de inmediato esa sesión desechable con `signOut({ scope: "local" })`, usando el mismo cliente.
   - Si no se logra cerrarla, se registra solo el código del error. Esa sesión queda sin dueño (su renovación solo estuvo en la memoria del servidor) y su pase vence en 15 minutos.
4. **Un 429 de Supabase** (demasiados pedidos) no cuenta como contraseña incorrecta, igual que en H-004a.
5. **Auditoría:** `session.reauth_failed`, con `{ reason, purpose }`. Nunca la contraseña ni el correo.

**Alternativas descartadas:**
- Comparar la contraseña dentro de la base con `crypt()` sobre `auth.users.encrypted_password`: la contraseña viajaría a la base y podría quedar en sus registros de error, depende del formato interno de Supabase y abre un gasto de procesador que se puede abusar.
- `reauthenticate()` de Supabase: manda un código al correo, no pide la contraseña.

**Dónde se pide:** al confirmar la activación (D3 = A), al desactivar y al crear o generar códigos nuevos.
- El campo es `type="password"`, con `autocomplete="current-password"` y letra de 16 px.
- Se agrega un campo oculto con `autocomplete="username"` que lleva el correo, para que el gestor de contraseñas complete solo.
- La contraseña nunca vuelve en `FormState.values`.

### 3.2 Los códigos

- **Generación:** archivo nuevo `src/lib/auth/recovery-code.ts`, con piezas puras.
  - Genera 10 códigos con `node:crypto` (`randomBytes`), sin dependencias nuevas, usando el alfabeto Crockford: 32 símbolos, sin I, L, O ni U.
  - `formatRecoveryCode` los muestra en grupos de 4 con guion.
  - `normalizeRecoveryCode` pasa a mayúsculas, quita espacios y guiones, y cambia O por 0 e I o L por 1. Si no quedan 12 símbolos válidos, lo rechaza sin consultar la base.
- **Huella:** `searchHash("mfa_recovery_code", PLATFORM_TENANT_ID, "<cuenta>|<código normalizado>")`, que es un HMAC-SHA256 con la llave `CP_SEARCH_KEY_V1`.
  - Esa llave ya existe, así que no hay un secreto nuevo que configurar en producción.
  - Como la huella incluye la cuenta, el código de una persona no sirve en otra.
  - Si se filtrara la tabla sin la llave, las huellas no sirven para adivinar códigos.
  - Costo conocido: cambiar `CP_SEARCH_KEY_V1` invalida todos los códigos (ya invalida las huellas de búsqueda).
- **Comparación en tiempo constante:** la base busca por igualdad exacta de la huella, con un índice único por cuenta y huella. El tiempo de respuesta no depende de cuántos caracteres coinciden, porque cambiar uno solo cambia la huella entera. En TypeScript no se compara texto carácter por carácter; si algún día hiciera falta comparar huellas ahí, se usa `timingSafeEqual`.
- **Un solo uso:** la base toma el código bloqueando su fila. Si llegan dos pedidos al mismo tiempo (una «carrera»), gana uno.
- **Atados al factor:** cada juego guarda el `factor_id` del factor de la aplicación al que respalda. Si ese factor desaparece por cualquier camino (desactivar, anular o revertir de H-118, o soporte), los códigos dejan de servir solos. Por eso no hace falta tocar el código de H-118.
- **Con D1 = A, «te quedan N» no aplica:** usar un código quita el factor y borra todo el juego. La persona tiene 10 códigos o ninguno. Contar los que quedan solo tendrá sentido desde H-117.

### 3.3 Activar (cambia lo de H-004a)

1. El botón «Activar» y el código QR quedan igual (`startTotpEnrollmentAction`). Se agrega un `friendly_name` (nombre visible) al factor, pendiente desde el punto (d) de H-004a.
2. **Segundo paso:** «Escribe el código que muestra tu aplicación y tu contraseña». `confirmTotpEnrollmentAction` hace, en este orden:
   1. Valida los campos.
   2. Revisa **la contraseña** (3.1). Si está mal, no se toca el código ni sus contadores.
   3. Hace todo lo de hoy: contadores, código ya usado, permiso de H-118, `challengeAndVerify`, avisos, y revertir si el aviso no salió.
3. **Si la activación quedó en pie,** se genera el juego con `mfa_recovery_codes_replace` y la acción **devuelve** `{ status: "enabled", recoveryCodes, setId }` en vez de redirigir.
   - Los códigos solo viajan en esa respuesta, que es un POST.
   - `/cuenta/:path*` ya tiene `Cache-Control: no-store`, así que no quedan guardados.
4. **La pantalla «Tus códigos de respaldo» muestra:**
   - La lista numerada, en Geist Mono.
   - «Copiar todos».
   - «Descargar (.txt)»: el archivo se arma en el navegador y no lleva el correo.
   - El texto «Solo los verás esta vez. Cada código sirve una sola vez. Si pierdes tu teléfono, entra con uno.»
   - La casilla «Guardé estos códigos en un lugar seguro».
   - El botón «Listo», deshabilitado hasta marcar la casilla. Llama a `acknowledgeRecoveryCodesAction(setId)` y lleva a `/cuenta/seguridad?aviso=activada`.
5. **Si generar los códigos falla,** la verificación sigue activa y la pantalla dice: «La verificación quedó activa, pero no pudimos crear tus códigos de respaldo. Créalos ahora.», con el botón de 3.6.
6. **Si la persona cierra sin apretar «Listo»,** los códigos sirven igual, pero `/cuenta/seguridad` muestra «No confirmaste que guardaste tus códigos de respaldo» y el botón «Generar códigos nuevos».

### 3.4 Entrar con un código de respaldo

**En la pantalla `/ingresar/codigo`:**
- El enlace «¿No tienes tu teléfono? Usa un código de respaldo» cambia el formulario.
- Aparece el campo «Código de respaldo», con letra de 16 px, `autocomplete="off"`, `autocapitalize="characters"` y `spellcheck="false"`.
- Antes de enviar se avisa: «Al usarlo, la verificación en dos pasos se desactiva y tendrás que activarla de nuevo con tu teléfono.»
- Si la persona escribe 6 números, se le dice «Eso parece el código de tu aplicación. Aquí va un código de respaldo de 12 letras y números.», sin contar el intento.
- El texto actual «Si ya no tienes la aplicación…» pasa a ser «Si no tienes la aplicación ni tus códigos de respaldo…».

**La acción nueva `verifyRecoveryCodeAction`** (archivo nuevo `src/lib/auth/recovery-code-actions.ts`) hace, en este orden:
1. Exige la sesión a medias con `requirePendingSecondStep()` y elige los contadores: si la persona llegó por el enlace del correo (`hasRecoverySession()`), los de «recovery»; si no, los de «password». Son los mismos de H-004a.
2. Normaliza el código. Si no tiene la forma correcta, devuelve el error del campo sin tocar la base ni los contadores.
3. Aplica el límite de intentos (3.7).
4. Toma el código por 2 minutos con `mfa_recovery_code_claim`. Si la respuesta es `invalid`:
   - Suma un fallo.
   - Escribe en la auditoría `session.mfa_failed` con `{ reason: "recovery_invalid", stage, factorType: "recovery_code" }`.
   - Muestra un único mensaje: «Ese código de respaldo no sirve. Revisa cómo lo escribiste; cada código sirve una sola vez.» Es el mismo si el código no existe, ya se usó, está tomado o la cuenta no tiene códigos.
5. Cierra las otras sesiones con `signOut({ scope: "others" })` **antes** de quitar el factor (barato; con la sesión a medias funciona, P0-3): si el servidor se cae a mitad de camino no queda abierta ninguna sesión ajena de las que existían.
6. Quita todos los factores con la pasarela, usando `removeAllFactors(userId)`, nueva en `mfa-admin-gateway.ts`: es la parte de `lockAccountAndRemoveFactors` que borra factores, sin el cambio de contraseña.
   - **Si lanza error no se asume que no pasó nada:** la respuesta pudo perderse con el factor ya borrado. Se vuelve a preguntar con `hasVerifiedFactor(userId)` si le queda a la cuenta algún factor verificado.
   - Si **sigue** puesto (o no se puede saber): suelta el código con `mfa_recovery_code_release`, así la persona no lo pierde; muestra «No pudimos terminar. Intenta de nuevo en unos minutos.» y lo deja en la auditoría.
   - Si **ya no queda ninguno:** sigue por el camino de éxito.
7. Manda el correo de aviso (3.9) **apenas el factor está fuera** (de mejor esfuerzo, D5 = A), al correo de la sesión; si la sesión no trae uno, con el que lee `complete`.
8. Vuelve a cerrar las otras sesiones (alcanza también una abierta en ese mismo momento) y completa con `mfa_recovery_code_complete`: marca el código como usado, borra el resto del juego y devuelve el correo leído de `auth.users`. Limpia los contadores de la ventana de ese camino; escribe `session.mfa_recovery_used` (con `stage`, `otherSessionsClosed` y `noticeSent`) en la plataforma y en cada organización donde la persona está activa; anota el ingreso en cada organización (`logTenantLogins`).
9. Redirige:
   - Si llegó por el enlace del correo, a elegir la contraseña nueva, como hoy.
   - Si no, a `/cuenta/seguridad?aviso=respaldo`, con el mensaje: «Entraste con un código de respaldo. Desactivamos la verificación en dos pasos y cerramos tus otras sesiones. Actívala de nuevo con tu teléfono; si recuperas el anterior, borra de su aplicación la entrada vieja de Cotiza Prime.»

### 3.5 Desactivar

**En `/cuenta/seguridad`,** con la verificación activa, aparece un botón secundario de peligro: «Desactivar la verificación en dos pasos».
- Abre una sección sobre superficie sólida (en el teléfono, una hoja que sube desde abajo) con dos campos: «Tu contraseña» y «Código de tu aplicación o código de respaldo».
- El segundo es un solo campo: si trae 6 números se trata como código de la aplicación; si trae 12 símbolos, como código de respaldo.

**La acción `disableSecondStepAction`** (archivo nuevo `src/lib/auth/second-step-manage-actions.ts`) hace, en este orden:
1. Exige una sesión completa con la verificación activa (`requireUser()` y el estado de la sesión).
2. Revisa la contraseña (3.1, con `purpose: "disable"`).
3. Revisa el código, con los contadores del camino nuevo «manage» (3.7):
   - Si es de la aplicación: el bloqueo de código ya usado y `challengeAndVerify` sobre el factor (funciona con aal2).
   - Si es de respaldo: `mfa_recovery_code_claim`.
4. **Con D4 = A,** envía el correo «Se pidió desactivar la verificación en dos pasos de tu cuenta». Va en presente para no mentir si el paso 5 falla. Si el correo no sale:
   - Se suelta el código de respaldo tomado y no cambia nada.
   - Se muestra «No pudimos enviarte el correo de aviso, así que no desactivamos la verificación. Inténtalo de nuevo en unos minutos.»
5. Quita el factor con `mfa.unenroll` usando la propia sesión, sin llave maestra, así Supabase vuelve a exigir aal2. Si el factor ya no existe, se da por hecho.
6. Borra los códigos con `mfa_recovery_codes_revoke`, y llama a `complete` si se usó uno de respaldo.
7. Cierra las otras sesiones con `signOut({ scope: "others" })`.
8. Escribe `session.mfa_disabled`, con `{ via: "totp" | "recovery_code" }`, en la plataforma y en cada organización activa.
9. Redirige a `/cuenta/seguridad?aviso=desactivada`: «Desactivamos la verificación en dos pasos y cerramos tu sesión en tus otros dispositivos. Te enviamos un aviso a <correo>.»

**No toca los enlaces de anulación de H-118:** la regla de H-118 es que nada hecho desde una sesión los invalida.

### 3.6 Generar códigos nuevos, y crearlos para quienes activaron antes de H-004b

- **Sin códigos:** las cuentas que activaron con H-004a no tienen. `/cuenta/seguridad` les muestra «No tienes códigos de respaldo. Si pierdes tu teléfono, no podrás entrar.» y el botón «Crear códigos de respaldo».
- **Con códigos:** muestra la fecha de creación y «Generar códigos nuevos», con el aviso «Los anteriores dejarán de servir».
- **Qué pide:** la contraseña **y el código de la aplicación**, nunca uno de respaldo. Así, ni con la sesión robada sola, ni con sesión y contraseña pero sin el teléfono, se pueden sacar códigos.
- **Si perdió el teléfono pero sigue con la sesión abierta:** desactiva con contraseña y un código de respaldo, y vuelve a activar.
- **Cómo se construye:** la acción `regenerateRecoveryCodesAction` va en el mismo archivo y reutiliza la pantalla de 3.3, punto 4.
- **Aviso:** sale de mejor esfuerzo el correo «Creaste códigos de respaldo nuevos; los anteriores ya no sirven».

### 3.7 Límite de intentos («propio y compartido»)

- **Compartido con el código de la aplicación:**
  - Cada intento con un código de respaldo se registra en la misma ventana de 15 minutos del camino (`mfa_verify_user`: 5 intentos, el sexto bloquea).
  - Cada fallo suma al mismo tope del día (`mfa_verify_user_day`, 15) y al de la IP (`login_ip`).
  - Cambiar del formulario del código al de respaldo no da intentos nuevos.
- **Propio:** el código es de un solo uso en la base, la base lo toma con bloqueo, y solo nuestro servidor puede probarlo, porque las funciones las ejecuta solo la llave maestra.
- **Separado por camino, nunca cruzado:**
  - Los caminos son: el ingreso con contraseña («password»), el enlace del correo («recovery») y el nuevo «manage», para las acciones dentro de una sesión.
  - «manage» usa la huella `<cuenta>|manage` sobre los mismos alcances, así que no requiere migración.
  - **No** se agrega un contador común a todos los caminos: quien solo tiene la contraseña podría gastarlo y dejar a la dueña sin poder usar un código desde el enlace del correo. Es justo lo que cerró la corrección A3 de la ronda 1 de H-004a.
- **La contraseña de nuevo** usa los contadores del ingreso (3.1).
- Con 60 bits por código, adivinar uno es imposible en la práctica. El límite sirve para frenar el ruido y para tratar los códigos de respaldo igual que el código de 6 números.
- Si los contadores fallan, se deja pasar, como hoy. Revisar eso quedó para H-117 (su menor 9).

### 3.8 Qué pasa con las sesiones

| Acción | Esta sesión | Otras sesiones |
|---|---|---|
| Pedir la contraseña | Sigue igual | No se tocan; la sesión desechable se cierra al instante |
| Activar | Pasa a completa (aal2) | Supabase las cierra (hecho (c) de H-004a) |
| Entrar con código de respaldo | Queda completa, porque ya no hay factor | Se cierran con `signOut others` |
| Desactivar | Sigue completa | Se cierran con `signOut others` |
| Generar códigos nuevos | Igual | Igual |

**El tramo de 15 minutos:** cerrar una sesión no anula el pase (JWT) que ya entregó, que sigue sirviendo hasta 15 minutos contra la API de datos.
- Al quitar el factor, el pase «a medias» de un atacante pasa a dar acceso completo durante ese tramo.
- Es el mismo riesgo 4 de H-118, y lo cierra `app.session_alive()` (H-116).

### 3.9 Avisos por correo

- **Se reutiliza lo de H-118:** `loadEmailConfig`, `getEmailTransport`, `sendWithRetry` (con plazo de 15 s), `getAppOrigin()` para los enlaces, y el destinatario siempre leído de `auth.users` por la base.
- **Correos nuevos** en `src/lib/email/`: `mfa-disabled-notice.ts`, `mfa-recovery-used-notice.ts` y `mfa-recovery-codes-created-notice.ts`.
- **Qué dicen:**
  - Cuándo pasó (dd-mm-aaaa, hora de Chile) y en qué cuenta.
  - «Si fuiste tú, no hagas nada.»
  - «¿No fuiste tú? Cambia tu contraseña ahora», con enlace a `{APP_ORIGIN}/recuperar-contrasena`, sin ningún código: cambiar la contraseña ya cierra las otras sesiones.
  - Nunca llevan códigos de respaldo.
- **Limitación conocida:** no pasan por `email_messages`, así que los rebotes no se ven (igual que en H-118).
- Las dos pantallas cuyas acciones mandan correo ya declaran `maxDuration = 60`.

### 3.10 Auditoría

- **Acciones nuevas** en `src/lib/audit/log.ts`, con su etiqueta en `labels.ts`:
  - `session.reauth_failed`
  - `session.mfa_recovery_codes_created`, con `{ stage: "enrollment" | "regenerate" }`
  - `session.mfa_recovery_used`, con `{ stage: "sign_in" | "recovery" }`
  - `session.mfa_disabled`, con `{ via }`
- **Dónde se escriben:** usar un código y desactivar quedan en la plataforma y en cada organización donde la persona está activa, como hoy `session.mfa_enrolled`.
- **Qué guardan:** solo códigos de motivo, nunca contraseña, códigos de respaldo, huellas ni correo.

## 4. Base de datos

### 4.1 Migración `<fecha>_mfa_recovery_codes.sql`

- **Fecha:** posterior a la última de `main` al momento de construir. Hoy es `20261113110000`; hay que revisarlo con `ls supabase/migrations`.
- **Guardia 15:** la primera sentencia es `set local lock_timeout = '3s'`, y justo después va el bloque `do $$ … current_setting('lock_timeout') <> '3s' …` que lo verifica.
- **Solo crea cosas:** no reescribe ninguna función ni política existente.

**Tabla `public.mfa_recovery_codes`,** de la plataforma, igual que `auth_rate_limits`:

| Columna | Qué guarda |
|---|---|
| `id` | uuid, llave |
| `tenant_id` | uuid, con valor por defecto y control `= app.platform_tenant_id()`, referencia a `tenants` y el disparador `app.forbid_tenant_change()` |
| `user_id` | la cuenta, referencia a `auth.users` con borrado en cascada |
| `set_id` | uuid del juego (los 10 códigos de una misma generación) |
| `factor_id` | uuid del factor de la aplicación al que respalda, sin llave foránea (ese factor se borra) |
| `code_hash` | la huella, con el control `^[0-9a-f]{64}$` |
| `claimed_until`, `used_at`, `acknowledged_at`, `created_at` | fechas |

- **Índices:** único `(user_id, code_hash)`; `(user_id) where used_at is null`; `(created_at)`; único `(tenant_id, id)`.
- **Seguridad por fila:** activa, con una sola política para `service_role` y `revoke all … from anon, authenticated`.

**Siete funciones.** Todas son `security definer`, con `set search_path = ''`, nombres completos (`public.tabla`, `app.funcion`), `revoke … from public, anon, authenticated` y `grant execute … to service_role`. Ninguna usa `auth.uid()`: reciben la cuenta desde el servidor.

1. **`mfa_recovery_codes_replace(p_user_id uuid, p_factor_id uuid, p_code_hashes text[]) → jsonb`**
   - Toma un candado por cuenta (`pg_advisory_xact_lock`).
   - Exige que `p_factor_id` sea un factor TOTP verificado de esa cuenta en `auth.mfa_factors`; si no, responde `{result: 'no_factor'}`.
   - Exige exactamente 10 huellas distintas con la forma correcta; si no, error `CP422`.
   - Si la cuenta tiene un código tomado en ese momento **cuyo factor sigue siendo un TOTP verificado**, responde `{result: 'busy'}` (un código huérfano, de un factor que ya no existe, no bloquea a quien vuelve a activar).
   - Borra el juego anterior, inserta el nuevo y responde `{result: 'ok', set_id, total}`.
2. **`mfa_recovery_code_claim(p_user_id uuid, p_code_hash text) → jsonb`**
   - Usa el mismo candado.
   - Busca un código de esa cuenta, sin usar y sin tomar, cuyo `factor_id` siga siendo un TOTP verificado, y lo toma por 2 minutos.
   - Responde `{result: 'ok', code_id, factor_id}`, o el mismo `{result: 'invalid'}` en cualquier otro caso.
3. **`mfa_recovery_code_complete(p_code_id uuid) → jsonb`:** marca `used_at`, borra los demás códigos de la cuenta y responde `{result: 'ok', email}` (correo leído de `auth.users`) o `invalid`.
4. **`mfa_recovery_code_release(p_code_id uuid) → boolean`:** suelta el código tomado.
5. **`mfa_recovery_codes_acknowledge(p_user_id uuid, p_set_id uuid) → boolean`:** marca el juego como guardado, solo si es el vigente.
6. **`mfa_recovery_codes_status(p_user_id uuid) → jsonb`:** devuelve `{total, acknowledged, set_id, created_at}` del juego vigente cuyo factor siga verificado; si no hay, `{total: 0}`.
7. **`mfa_recovery_codes_revoke(p_user_id uuid) → integer`:** borra los códigos de la cuenta.

**Limpieza:** va dentro de `replace`, `claim` y `status`, **acotada a 100 filas por llamada** (`limit 100 for update skip locked`). Borra los juegos cuyo factor ya no existe y tienen más de 1 día, y los códigos usados con más de 30 días. No hace falta una tarea programada, con la misma salvedad de H-118: solo corre cuando hay actividad.

**La pasarela nueva** `src/lib/security/mfa-recovery-gateway.ts` es el único archivo que llama a estas funciones (con la llave maestra), y valida cada respuesta con esquemas zod, como `mfa-alerts-gateway.ts`.

### 4.2 Deshacer: `supabase/rollbacks/<fecha>_mfa_recovery_codes.down.sql`

Lleva la guardia 15 y se niega a correr si:
- (a) alguna de las 7 funciones ya no es la de la migración (compara el md5 de su cuerpo);
- (b) otra función de `public` o `app` las nombra, o nombra la tabla;
- (c) hay códigos tomados en ese momento (un uso en curso);
- (d) hay juegos vigentes: borrarlos dejaría sin respaldo a personas que no lo saben.

El archivo lleva una advertencia: con la aplicación de H-004b funcionando, entrar con un código de respaldo deja de servir, así que solo se deshace con la aplicación vuelta atrás.

**Deshacer en producción con juegos vigentes** (la condición (d) se niega): coordinar primero la vuelta atrás de la aplicación; después, y no antes, revocar los juegos con `mfa_recovery_codes_revoke` (persona por persona o en lote) **tras avisar a las personas** que se quedan sin respaldo; recién entonces correr el deshacer. Revocar antes de volver atrás la aplicación deja a quien pierde el teléfono sin salida.

### 4.3 Cuánto se guardan (anotar en `PROYECTO.md` §11.2)

«Códigos de respaldo (solo huellas): mientras la verificación esté activa. Se borran al desactivar desde la pantalla, al entrar con uno y al activar de nuevo o generar otros; si su factor desaparece por otro camino dejan de servir al instante y se borran a más tardar con la limpieza (lotes de 100, dentro de las funciones).» Es el texto que quedó en `PROYECTO.md` §11.2. No se guarda el correo ni el código.

## 5. Relación con H-118, con `app.second_step_pending()` y con H-117

- **El disparador de H-118 no cambia.**
  - Los códigos no son un factor de Supabase y nunca pasan por `auth.mfa_factors`.
  - La activación nueva después de usar un código pasa por el permiso y manda el aviso con el enlace para anular. Si quien usó el código era un atacante que luego activa su propio teléfono, la dueña puede anularlo.
  - La contraseña de 3.3 se revisa **antes** de dar el permiso.
- **Anular (H-118b) no cambia:** quita todos los factores, y los códigos atados a ellos dejan de servir solos.
- **Desactivar no toca** `mfa_annul_links`.
- **`app.second_step_pending()` no cambia.** Pero al quitar el factor, la función responde «no pendiente» para **todas** las sesiones de la cuenta. Por eso se cierran las otras (3.8).
- **H-117 (opción B):**
  - La tabla y las funciones se conservan. Solo cambia lo que pasa después de un código válido: se marca la sesión como completa en vez de quitar el factor.
  - Con D1 = B, en cambio, se pierde todo.
- **H-004c:** desactivar dejará a un Dueño o Administrador como Observador (supuesto 3 del sprint 5). Eso no se construye aquí.

## 6. Dónde puede fallar: riesgos y casos de abuso

| Caso | Qué lo frena |
|---|---|
| Alguien con una sesión abierta ajena quiere activar su teléfono | Sin la contraseña no hay permiso de H-118, y la base rechaza verificar el factor |
| …quiere desactivar desde nuestra pantalla | Se pide contraseña y código |
| …quiere desactivar hablando directo con Supabase | Decisión D7; con B queda abierto hasta H-117 |
| …quiere ver o sacar códigos | Nunca se muestran de nuevo; generar otros pide contraseña y código de la aplicación |
| Alguien con la contraseña prueba códigos de respaldo | 60 bits por código, 5 intentos por ventana y 15 al día por camino, y solo por nuestro servidor |
| …gasta los intentos para bloquear a la dueña | Solo bloquea el camino «password»; la dueña entra por el enlace del correo, que tiene sus propios contadores |
| Alguien con la contraseña y un código robado | Entra, se quita el factor y la dueña pierde su sesión. Le llega «Se usó un código de respaldo» con «Cambia tu contraseña». Si el atacante activa su teléfono, le llega además el aviso de H-118 con el enlace para anular |
| Dos usos del mismo código al mismo tiempo | La base bloquea la fila: gana uno |
| Se generan códigos nuevos mientras se usa uno | Candado por cuenta; `replace` responde `busy` |
| Falla quitar el factor después de tomar el código | Se vuelve a preguntar si el factor sigue puesto: si sigue (o no se puede saber), se suelta el código y no se pierde; si ya no está (la respuesta se perdió), se sigue por el camino de éxito |
| El servidor se cae entre quitar el factor y completar | El código queda tomado 2 minutos y después ya no sirve (su factor no existe). La sesión ya quedó completa, así que no se pierde el acceso |
| **Qué queda abierto si el servidor se cae a mitad de camino** (corrección C1) | Orden: tomar → cerrar otras sesiones → quitar el factor → aviso → cerrar otras sesiones otra vez → completar. **Antes de quitar el factor:** el código queda tomado 2 minutos y se suelta solo; las otras sesiones ya se cerraron (inofensivo). **Entre quitar el factor y el aviso:** la cuenta queda sin segundo paso y **sin aviso por correo** (D5 = A, de mejor esfuerzo; queda sin la fila de auditoría `session.mfa_recovery_used`, solo el registro del servidor); la sesión de quien usó el código ya es completa. **Después del aviso, antes de completar:** el aviso salió, el código queda tomado hasta vencer (ya no sirve: su factor no existe) y los otros 9 códigos del juego quedan sin borrar hasta que la limpieza los recoja (inútiles también). **Nunca queda abierto:** una sesión ajena a medias que se salte el segundo paso, porque se cerraron antes de quitar el factor; solo podría aparecer una sesión NUEVA creada en los pocos segundos entre el primer cierre y quitar el factor, y el segundo cierre la alcanza si el servidor llega a él |
| Un `unenroll` o un `removeAllFactors` responde error pero el factor sí se borró | Se vuelve a leer la lista: si ya no queda el factor, se sigue por el camino de éxito (la persona no queda con el código «quemado» ni con una pantalla de error con la cuenta ya desactivada) |
| El código de la cuenta A se escribe en la sesión de la cuenta B | La huella va atada a la cuenta y la búsqueda filtra por cuenta: responde `invalid` |
| Una organización ve eventos de otra | La auditoría se escribe solo en las organizaciones donde la persona está activa |
| Códigos filtrados | Nunca van en la dirección, la auditoría, `serverLog`, las cookies ni un componente de servidor; solo en la respuesta del POST. La descarga se arma en el navegador |
| Doble envío de «Desactivar» | Quitar un factor que ya no existe se da por hecho |
| La contraseña termina en un registro | La guardia 14b se amplía a los archivos nuevos |
| El pase de 15 minutos después de quitar el factor | Riesgo conocido; lo cierra H-116 |

## 7. Pruebas que deben existir

### Paso 0 (queda fijado en `tests/db/mfa-recovery-gotrue.test.ts`)

- **P0-1.** ¿Existen las rutas `/auth/v1/factors/recovery-codes` en el Supabase local? Es solo para dejarlo escrito; con D1 = A no se usan.
- **P0-2.** La sesión desechable, con y sin factor verificado:
  - `signInWithPassword` crea una fila en `auth.sessions` y `signOut local` la borra sin tocar las demás.
  - No llega ningún correo a Mailpit.
  - Se reconoce el 429 de Supabase.
- **P0-3.** `signOut({ scope: "others" })` funciona desde un pase aal1, con factor y sin factor.
- **P0-4.** Al quitar el factor con la llave maestra mientras hay una sesión a medias abierta, esa sesión queda completa (`second_step_pending()` responde falso) y las demás no se cierran solas.
- **P0-5.** `DELETE /factors/{id}` con un pase aal2: ¿responde 200? Es la base de D7.
- **P0-6.** Después de `unenroll` con aal2, la renovación siguiente deja el pase en aal1 y la cuenta sin factor.
- **P0-7.** Borrar la cuenta en `auth.users` borra sus códigos (cascada).
- **Solo si D7 = A, P0-8:** el disparador antes de borrar en `auth.mfa_factors`, con los permisos de `postgres` y la cascada al borrar la cuenta.

### Base de datos (`tests/db/mfa-recovery-codes.test.ts`, con Supabase Auth real)

- **`replace`:**
  - Sin factor, con un factor sin verificar o con un factor de otra cuenta, responde `no_factor`.
  - Con 9 u 11 huellas, repetidas o con otra forma, da error `CP422`.
  - Reemplaza el juego anterior.
  - Dos `replace` a la vez dejan un solo juego.
  - Con un código tomado responde `busy`.
- **`claim`:**
  - Funciona con un código válido.
  - Una huella que no existe, la de otra cuenta, un código usado, uno tomado o uno cuyo factor se borró responden todos el mismo `invalid`.
  - Dos `claim` simultáneos del mismo código: solo uno responde `ok`.
- **El resto:** `complete`, `release`, `acknowledge` (con un juego viejo responde falso), `status`, `revoke` y la limpieza.
- **Permisos:**
  - `anon`, un pase aal1 y un pase aal2 no pueden leer, insertar, actualizar ni borrar en la tabla, ni ejecutar ninguna función (error 42501).
  - Un `tenant_id` distinto del de la plataforma falla el control.
- **Guardia 16:** sigue en verde, porque las funciones no identifican a la persona por la sesión.
- **Deshacer:** `tests/db/mfa-recovery-codes-rollback.test.ts` comprueba el md5 y los casos (b) a (d); además corre `npm run test:db:rollbacks`.

### Unitarias

- **`recovery-code.test.ts`:**
  - Genera 10 códigos de 12 símbolos, en el alfabeto correcto, todos distintos, usando `node:crypto` (simulado en la prueba).
  - El formato y la normalización: minúsculas, espacios, guiones, O por 0, I o L por 1, y los rechazos.
  - El mismo código en dos cuentas da huellas distintas.
- **`reauth.test.ts`:**
  - Usa el correo de la sesión aunque el formulario traiga otro.
  - Si la cuenta está bloqueada, no llama a Supabase.
  - Una contraseña incorrecta suma un fallo y deja auditoría.
  - Una correcta cierra la sesión desechable y limpia el contador.
  - Si la respuesta trae otra cuenta, se rechaza.
  - Un 429 no suma fallo.
  - La contraseña nunca llega a `serverLog` ni a la auditoría.
- **`second-step-actions.test.ts`,** ajustando sus 39 pruebas actuales:
  - Con la contraseña incorrecta no se gasta el código ni se da el permiso.
  - Con la correcta, todo funciona como hoy.
  - Los códigos se generan solo después de que salió el aviso.
  - Si la generación falla, se muestra el mensaje de 3.3.
  - La acción devuelve los códigos en vez de redirigir.
  - El caso de dos pestañas (M7) sigue funcionando.
- **`recovery-code-actions.test.ts`:**
  - Solo funciona con la sesión a medias.
  - Un código mal escrito no toca los contadores.
  - Si la cuenta está bloqueada, no se consulta la base.
  - Un `invalid` suma al contador del camino.
  - Con 5 intentos que mezclan código de la aplicación y de respaldo, el sexto queda bloqueado.
  - El orden exacto: tomar, cerrar las otras sesiones, quitar factores, aviso, cerrar las otras sesiones otra vez, completar, auditoría y redirección.
  - Si falla quitar el factor y el factor sigue puesto, se suelta el código; si el factor sí se borró, sigue por el camino de éxito.
  - Por el camino del correo usa los contadores «recovery» y lleva a elegir la contraseña.
- **`second-step-manage-actions.test.ts`:**
  - Desactivar: revisa la contraseña primero; acepta código de la aplicación o de respaldo; con D4, si el correo no sale no se quita nada y se suelta el código; cuando sale, quita el factor, borra los códigos, cierra las otras sesiones y deja auditoría en la plataforma y en las organizaciones.
  - Generar: pide el código de la aplicación y rechaza uno de respaldo.
- **El resto:** los correos nuevos (texto escapado, fecha, `APP_ORIGIN`, sin códigos), `labels.test.ts` y `guard-coverage.test.ts`, con una excepción justificada para cada acción nueva, porque son de la cuenta y no de una organización.

### Guardias estáticas (`tests/isolation/static-guards.test.ts`)

- **Guardia 14, ampliada, con un caso que confirma que muerde:**
  - `signInWithPassword` solo puede aparecer en `src/lib/auth/actions.ts` y `src/lib/auth/reauth.ts`.
  - `mfa.unenroll` y `challengeAndVerify` se permiten también en `second-step-manage-actions.ts`.
  - `auth.admin` sigue solo en las pasarelas.
  - Las funciones `mfa_recovery_*` solo se llaman desde `mfa-recovery-gateway.ts`.
- **Guardia 14b, ampliada** a `reauth.ts`, `recovery-code-actions.ts`, `second-step-manage-actions.ts` y `mfa-recovery-gateway.ts`: nunca la contraseña, `codes`, `recoveryCode`, el código normalizado ni su huella.

### Aislamiento entre organizaciones

- **`tests/isolation/registry.ts`:** registrar la tabla como `server-only` (también en `NON_BUSINESS_VISIBILITY`) y las 7 funciones en la lista de solo servidor. Las guardias G1, G3 y G4 lo exigen.
- **`tests/isolation/mfa-recovery.test.ts`:**
  - El código de la cuenta A usado desde la sesión a medias de B responde `invalid` y el juego de A queda intacto.
  - Cuando `mixta` desactiva, `session.mfa_disabled` aparece en sus dos organizaciones y en ninguna otra, tampoco en una que dejó.
  - El registro de actividad de B no muestra eventos de una persona de A.

### Punta a punta (`e2e/mfa-recovery.spec.ts`, con Mailpit, `E2E_PROD=1` y cuentas nuevas)

1. **Activar:**
   - Con la contraseña incorrecta sale un error y el mismo código sigue sirviendo.
   - Con la correcta aparecen los 10 códigos y «Listo» está deshabilitado hasta marcar la casilla.
   - Al recargar, los códigos no vuelven a aparecer.
2. **Entrar con un código:**
   - Uno malo muestra el mensaje.
   - Uno bueno lleva a `/cuenta/seguridad` con el aviso, la otra sesión (abierta en otro navegador) queda fuera y llega el correo a Mailpit.
   - El mismo código otra vez ya no sirve.
   - Al activar de nuevo hay códigos nuevos y los viejos no sirven.
3. **Olvidé la contraseña y perdí el teléfono:** enlace del correo, código de respaldo, elegir contraseña.
4. **Límite:** con la contraseña sola, 5 intentos mezclados y el sexto queda bloqueado; por el enlace del correo, la misma cuenta todavía puede entrar.
5. **Desactivar:**
   - Con contraseña mala y con código malo, sale el error correspondiente.
   - Funciona con el código de la aplicación y con uno de respaldo.
   - Llega el correo y la otra sesión queda fuera.
   - Si el correo no sale (destinatario fuera de la lista permitida), la verificación sigue activa (D4 = A).
6. **Generar códigos nuevos:** los viejos dejan de servir.
7. **Cuenta activada sin códigos** (activada por la API con el permiso, como hacen las pruebas de H-118): ve «No tienes códigos de respaldo» y los crea.
8. **Diseño y accesibilidad:** 375 px, teclado, «reducir movimiento», modo claro y oscuro, áreas táctiles de 44 px, y los códigos sin desplazamiento horizontal.

**Hay que ajustar las pruebas de punta a punta que ya activan por pantalla** (`e2e/mfa.spec.ts`, `e2e/mfa-enrollment-notice.spec.ts` y `e2e/mfa-annul.spec.ts`), porque ahora se pide la contraseña y aparece la pantalla de códigos. Conviene un ayudante común, `activateTwoStep(page, password)`, para no repetirlo.

### Antes de abrir el PR

- Correr la suite completa en local, una a la vez: `lint`, `typecheck`, `test`, `test:db`, `test:isolation`, e2e `chromium` con `E2E_PROD=1` e e2e `isolation`.
- Correr `test:db:rollbacks` y después `supabase db reset` y `npm run db:seed`.
- La descripción del PR dice qué se corrió y con qué resultado.

## 8. Pasos de construcción (para subagentes Sonnet)

**Un solo agente a la vez,** porque casi todo toca los mismos archivos delicados (`second-step-actions.ts`, `two-step-panel.tsx` y `/ingresar/codigo`). La base de datos la toca uno solo y en orden, y antes de tocarla se declara el entorno (PRUEBAS).

| Paso | Qué hace | Quién | Días |
|---|---|---|---|
| 0 | P0-1 a P0-7; si algo contradice el diseño, se detiene y vuelve al planificador | Sonnet | 0,5 |
| 1 (etapa A) | `reauth.ts` y sus pruebas; la contraseña en `confirmTotpEnrollmentAction` y en la pantalla; ajustar las pruebas de activar; guardias 14 y 14b | Sonnet | 0,5 |
| 2 (etapa B) | La migración, su deshacer, las pruebas de base y el registro de aislamiento | Sonnet (el único que toca la base) | 0,75 |
| 3 | `recovery-code.ts`, `mfa-recovery-gateway.ts`, `removeAllFactors`, el camino «manage», los correos, la auditoría con sus etiquetas, y las guardias | Sonnet | 0,75 |
| 4 | Los códigos al activar, «Los guardé», y crear o generar en `/cuenta/seguridad` | Sonnet | 0,75 |
| 5 | Entrar con un código de respaldo, por los dos caminos | Sonnet | 0,75 |
| 6 (etapa C) | Desactivar | Sonnet | 0,75 |
| 7 | Pruebas de punta a punta nuevas, aislamiento y documentos | Sonnet | 0,5 |
| 8 | Revisión de Opus normal y adversarial (dos rondas como máximo), correcciones, y prueba de Aarón en pantalla | Opus y Sonnet | 0,75 |

**Total:** unos 6 días (entre 5,5 y 6,5). Se suman 0,75 a 1 día si D7 = A, y 0,5 días si D2 = B.

## 9. Qué debe revisar Opus de forma adversarial

1. **La contraseña de nuevo:**
   - El correo sale de la sesión y la sesión desechable se cierra.
   - La contraseña no aparece en registros, en `FormState` ni en los errores.
   - No sirve para saltarse el límite del ingreso, y el 429 se trata bien.
2. **El orden al activar:** la contraseña se revisa **antes** del permiso de H-118, y no existe otro camino para conseguir ese permiso.
3. **Entrar con un código:**
   - Nunca queda completa una sesión mientras el factor sigue puesto.
   - Una caída no hace perder un código.
   - Las otras sesiones se cierran después de quitar el factor.
4. **Los contadores:**
   - No hay forma de probar códigos de respaldo fuera de la ventana compartida.
   - No existe un contador cruzado entre caminos.
5. **Dónde viajan los códigos:** que no aparezcan en la dirección, la auditoría, `serverLog`, Sentry, la caché, un estado guardado ni un componente de servidor, y que la descarga se arme solo en el navegador.
6. **La migración:**
   - Guardia 15, `search_path` vacío y solo `service_role`.
   - `tenant_id` de la plataforma, el md5 del deshacer, la cascada y la limpieza.
7. **Cuenta contra cuenta y organización contra organización:** el registro de aislamiento y la auditoría solo en las organizaciones activas.
8. **H-118:**
   - Nada invalida los enlaces de anulación.
   - Activar de nuevo pasa por el permiso y manda el aviso.
   - Cambiar el `redirect` por una respuesta no rompe la reversión ni el caso de dos pestañas (M7).
9. **D7:** confirmar el resultado de P0-5 y el riesgo que queda.
10. **Los mensajes** no revelan si el código existía, si ya se usó ni si la cuenta tiene códigos.

## 10. Qué NO hacer

- **Con los códigos:** no guardarlos en claro ni cifrados de forma reversible, no mostrarlos dos veces, no ponerlos en la dirección, las cookies, la auditoría ni los registros, y no pasarlos por un `redirect`.
- **Con la contraseña:** no verificarla con `crypt()` dentro de la base y no tomar el correo del formulario.
- **Con D1 = A:** no encender `auth.experimental.recoveryCodes` ni mezclar los dos sistemas.
- **No abrir un contador de intentos común a todos los caminos.**
- **No invalidar los enlaces de anulación de H-118** al desactivar ni al generar códigos.
- **No reescribir** `app.second_step_pending()`, `app.current_tenant_id()` ni `session.ts`: eso es de H-116 y H-117 (solo se tocaría con D2 = C).
- **No usar `auth.admin` fuera de la pasarela** ni la llave maestra en las acciones, y no relajar las guardias 14 y 14b: se amplían.
- **No permitir generar códigos** con la sesión sola ni con un código de respaldo.
- **No contar como fallo** un código mal escrito ni un error de la red.
- **No construir H-004c** (`app.effective_role`).
- **No prometer en pantalla** «aunque conozcan tu contraseña» (decisión 021 §4).

## 11. Documentos que hay que actualizar

- **`HISTORIAS.md`:** criterios afinados de H-004b, su tamaño y la partición (D8); en H-117, una nota de que la tabla se reutiliza.
- **`sprint-5-equipo-y-permisos.md`:** que §5b remita a este documento. El registro de construcción va al final de este documento.
- **`modelo-datos.md`:** la tabla nueva de la plataforma y sus funciones.
- **`PROYECTO.md` §11.2:** la fila de cuánto se guardan los códigos (4.3).
- **`DISENO.md`:** los componentes «Lista de códigos de respaldo» y «Confirmar con contraseña y código», y el botón de peligro.
- **`README.md`:** «Probar los códigos de respaldo».
- **`CLAUDE.md`:** el traspaso.
- **Lista «Antes del piloto»:** medir el cupo de ingresos por IP de Supabase en producción (`sign_in_sign_ups`), porque pedir la contraseña suma ingresos desde la IP del servidor. Si D1 = B, encender los códigos en el panel de Supabase.

## 12. Lo que no se pudo comprobar leyendo

- Si el Supabase local de la CLI 2.119 o el de producción traen los códigos de respaldo nativos, y cómo se encienden.
- Si `DELETE /factors/{id}` funciona con un pase aal2 (P0-5).
- Si `signOut others` funciona desde un pase aal1, y qué efectos deja la sesión desechable (P0-2 y P0-3).
- El cupo de ingresos por IP del Supabase de producción.
- Gmail, Outlook, iPhone real, Firefox, Safari y lector de pantalla.

---

**Archivos que leí para este diseño**

- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/docs/HISTORIAS.md` (H-004a, H-004b, H-004c, H-117 y H-118)
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/docs/arquitectura/sprint-5-equipo-y-permisos.md` (§5b, §7 y el registro de construcción de H-004a)
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/docs/arquitectura/h-118-anular-activacion.md`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/docs/decisiones/016-proveedor-de-correo.md`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/docs/decisiones/020-decisiones-mientras-aaron-no-esta.md`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/docs/decisiones/021-limite-de-intentos-del-segundo-paso.md`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/supabase/migrations/20261112100000_mfa_session_gate.sql`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/supabase/migrations/20261113100000_mfa_enrollment_alerts.sql`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/supabase/migrations/20261113110000_mfa_annul.sql`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/supabase/migrations/20261001140000_auth_rate_limits.sql`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/supabase/rollbacks/20261113100000_mfa_enrollment_alerts.down.sql`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/supabase/rollbacks/20261113110000_mfa_annul.down.sql`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/supabase/config.toml`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/src/lib/auth/second-step-actions.ts`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/src/lib/auth/session.ts`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/src/lib/auth/actions.ts`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/src/lib/security/login-rate-limit.ts`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/src/lib/security/mfa-admin-gateway.ts`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/src/lib/security/mfa-alerts-gateway.ts`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/src/lib/security/mfa-enrollment-notice.ts`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/src/lib/crypto/search-hash.ts`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/src/app/cuenta/seguridad/two-step-panel.tsx`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/src/app/(auth)/ingresar/codigo/page.tsx`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/tests/isolation/static-guards.test.ts` (guardia 14)
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/tests/isolation/registry.ts`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/tests/db/mfa-session-gate.test.ts`
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/node_modules/@supabase/auth-js/dist/main/lib/types.d.ts` (`AuthMFARecoveryCodesApi`)
- `/Users/josegutisilva/Developer/mainbrain/cotiza-prime/node_modules/@supabase/auth-js/dist/main/GoTrueClient.js`
---

## Registro de construcción

### Pasos 0 y 1 (etapa A) — 2026-11-16, Sonnet

**Paso 0** (`tests/db/mfa-recovery-gotrue.test.ts`, Supabase local, CLI 2.119; todo coincide con el diseño, nada cambia la arquitectura):

| Prueba | Resultado observado |
|---|---|
| P0-1 | Las rutas `/auth/v1/factors/recovery-codes` **existen pero están apagadas**: GET responde 404 `mfa_factor_not_found` y POST 422 `mfa_recovery_codes_enroll_not_enabled`. Con D1 = A no se usan. |
| P0-2 | `signInWithPassword` con un cliente sin cookies crea **una** fila en `auth.sessions` (pase aal1, con o sin factor verificado); `signOut({ scope: "local" })` borra exactamente esa fila y su refresh token y no toca las otras sesiones. **No sale ningún correo** (Mailpit en cero). El **429 no se pudo provocar en local** (ni con 80 ingresos seguidos con una IP propia en `x-forwarded-for`; el tope `sign_in_sign_ups` no se activó): se simuló la respuesta de GoTrue con un `fetch` falso y `classifyAuthError` la lee como `rate_limited`. |
| P0-3 | `signOut({ scope: "others" })` **funciona desde un pase aal1**, con y sin factor verificado: cierra todas las otras sesiones (403 `session_not_found`) y deja la propia. |
| P0-4 | Quitar el factor con la llave maestra: la sesión a medias que estaba abierta pasa a **completa** (`app.second_step_pending()` de verdadero a falso) y **no se cierra ninguna sesión**. |
| P0-5 | `DELETE /auth/v1/factors/{id}` con un pase aal2 responde **200** y borra el factor. Confirma la base de D7: quien tenga una sesión completa robada puede desactivar el segundo paso hablando directo con Supabase. |
| P0-6 | Tras ese `unenroll`, el pase aal2 ya entregado **sigue sirviendo** (GET /user 200) y la renovación siguiente da un pase **aal1**, con la cuenta sin factor. |
| P0-7 | Borrar la cuenta (API de administración) borra en cascada una tabla que cuelga de `auth.users` con `on delete cascade`. (La tabla real llega en la etapa B; aquí se probó con una temporal que se elimina.) |

**Paso 1 (etapa A)**: `src/lib/auth/reauth.ts` (`confirmPassword`), contraseña en `confirmTotpEnrollmentAction` (antes de los contadores y del permiso de H-118) y campo «Tu contraseña» en la pantalla de activar, `friendly_name` «Aplicación de códigos» al iniciar la activación, acción `session.reauth_failed` en la auditoría, guardias 14 / 14b ampliadas y nueva 14j. Activar sigue redirigiendo a `/cuenta/seguridad?aviso=activada` (la pantalla de códigos es el paso 4).

**Detalles de construcción (no estaban en el diseño):**
- Se valida primero la forma del código y de la contraseña; un código mal escrito o una contraseña vacía no consultan nada (ni siquiera a Supabase).
- Una contraseña incorrecta se muestra en el campo «Tu contraseña»; el bloqueo, el 429 y las caídas, como mensaje general.
- El plazo de la llamada a Supabase al comprobar la contraseña es de 10 s (un fallo por plazo no suma al contador).
- El campo oculto `autocomplete="username"` va **sin `name`**: no viaja en el envío; solo orienta al gestor de contraseñas.

### Paso 2 (etapa B, base de datos) — 2026-11-16, Sonnet

🟢 Entorno: PRUEBAS (Supabase local). Migración `20261116100000_mfa_recovery_codes.sql` (**54 archivos** en `supabase/migrations/` con ésta) y su deshacer `supabase/rollbacks/20261116100000_mfa_recovery_codes.down.sql`. Se aplicó con `npx supabase migration up --local`, sin reiniciar la base. Es solo código SQL: ninguna parte de la aplicación la usa todavía (la pasarela es del paso 3).

**Qué quedó, tal como §4.1:** tabla `public.mfa_recovery_codes` (de la plataforma: `tenant_id` con valor por defecto, control `= app.platform_tenant_id()`, llave a `tenants` y `app.forbid_tenant_change()`; `user_id` con cascada a `auth.users`; RLS con una política para `service_role` y `revoke all` a `anon`/`authenticated`; los cuatro índices de §4.1) y las siete funciones (`security definer`, `search_path` vacío, nombres completos, `revoke … from public, anon, authenticated`, `grant execute … to service_role`; ninguna usa la sesión). `set local lock_timeout = '3s'` es la primera sentencia y su verificador va justo después (guardia 15). Los nombres `app.platform_tenant_id()` y `app.forbid_tenant_change()` existen y son los que ya usan las migraciones de H-118: no hubo que adaptar nada del diseño.

**Detalles de construcción (no estaban en el diseño):**
- **Candado por cuenta:** `pg_advisory_xact_lock(hashtextextended('mfa_recovery|' || cuenta, 0))`, como el de `create_tenant`. Lo toman `replace`, `claim`, `complete` (lee antes la cuenta del código, sin candado, y después lo toma), `acknowledge` y `revoke`. `claim` además bloquea la fila (`for update`).
- **Limpieza** (en `replace`, `claim` y `status`): borra con `for update skip locked`, para que una llamada de una cuenta nunca espere filas de otra. El criterio «el factor ya no existe» se implementó como «ya no hay un factor TOTP verificado con ese id de esa cuenta» (el mismo que exige `claim`).
- **`complete` es más estricto que el diseño:** solo acepta un código tomado **con su plazo de 2 minutos vigente** (`used_at is null and claimed_until > now()`); si el plazo ya pasó, otra llamada pudo tomarlo y responde `invalid`. Consecuencia para los pasos 5 y 6: si entre tomar y completar pasan más de 2 minutos, `complete` da `invalid` (el factor ya se quitó, así que los códigos igual quedan inútiles) y hay que tratarlo sin romper la sesión.
- **`status` cuenta solo códigos sin usar:** un juego en el que ya se usó el único código (los demás se borran en `complete`) responde `{total: 0}`, no un juego fantasma. (Lo encontró la prueba ST1; la migración se corrigió antes de entregar, sin otra migración.)
- **`acknowledge` es idempotente** (repetirlo responde `true` y no cambia la fecha) y responde `false` con un juego viejo, ajeno o sin factor verificado.
- **`replace` responde `busy` solo con un código realmente tomado** (`claimed_until > now()` y sin usar).
- **Deshacer, condición (d):** «juego vigente» = códigos **sin usar** cuyo factor TOTP sigue verificado. Un código usado o uno cuyo factor ya no existe (solo rastro) no impide deshacer. La condición (b) busca el texto `mfa_recovery_code` en las demás funciones de `public` y `app`, lo que cubre las siete funciones y la tabla.
- **La lista de alcances de `auth_rate_limits` no se tocó** (como decía §1.2): no hace falta migración para los contadores.

**Pruebas nuevas** (todas contra la Supabase local, cuentas `@ejemplo.test`):

| Archivo | Qué cubre | Resultado |
|---|---|---|
| `tests/db/mfa-recovery-codes.test.ts` | 24 casos: `replace` (sin factor, factor sin verificar, de otro tipo o ajeno, 9/11/repetidas/malformadas/nulas, reemplazo, `busy`, dos `replace` a la vez), `claim` (todos los `invalid` iguales, plazo vencido, factor borrado por la API de Supabase con aal2, dos `claim` a la vez), `complete`, `release`, `acknowledge`, `status`, `revoke`, limpieza por `replace`/`claim`/`status`, tabla y cascada, `tenant_id`, atributos y permisos (base y API con pase aal1 y aal2) | 24 de 24 |
| `tests/db/mfa-recovery-codes-rollback.test.ts` | 9 casos: lock_timeout y verificador, md5 de las siete funciones, el deshacer quita todo y se puede volver a aplicar, se niega dos veces, función redefinida, otra función que las nombra (función y tabla), código tomado, juego vigente; lo que **no** impide deshacer. Todo dentro de transacciones que se deshacen; **no vacía ni borra nada persistente** (las filas ajenas que hubiera se quitan solo dentro de la transacción) | 9 de 9 |
| `tests/isolation/mfa-recovery.test.ts` | El código de A pedido para B da `invalid` y deja el juego de A intacto; la misma huella en dos cuentas son dos códigos; completar, soltar o borrar en una cuenta no toca la otra; ningún pase (B aal1 y aal2, una persona de A, sin sesión) lee ni escribe la tabla ni llama las siete funciones | 4 de 4, más 1 pendiente (`it.todo`) |

**Registro de aislamiento:** tabla `mfa_recovery_codes` como `server-only` (en `ISOLATION_TABLES` y en `NON_BUSINESS_VISIBILITY`), las siete funciones en `SERVER_ONLY_FUNCTIONS`, sus argumentos en `tests/isolation/rpc.test.ts`, una fila de la fixture (`mfaRecoveryCodeHash`) y una comprobación en `tables-read.test.ts` de que nadie con pase la lee.

**Pendiente de los pasos siguientes (anotado):** que `session.mfa_disabled` y `session.mfa_recovery_used` aparezcan solo en la plataforma y en las organizaciones donde la persona está **activa**, y que el registro de B no muestre eventos de una persona de A (necesitan el código de la aplicación que escribe esos eventos: pasos 3 a 6). Está como `it.todo` en `tests/isolation/mfa-recovery.test.ts`. También quedan para el paso 7 los documentos de §11 (`modelo-datos.md`, `PROYECTO.md` §11.2, etc.).

**No se tocó:** `app.second_step_pending()`, el disparador de H-118, `auth_rate_limits`, ninguna política ni función existente.

**Estado de la base local (ya reportado, no es de esta etapa):** las filas viejas `mfa_annul_ip` y `mfa_annul_token` de `auth_rate_limits` hacen fallar el `down` de `20261112100000` (violan su lista de alcances). Eso rompe, en esta base local, **30 pruebas de 7 archivos** de deshacer (`mfa-session-gate-rollback` MR3–MR6 y los de `invitation-*`, `member-*`, que parten de `tests/db/before-mfa-gate.ts`); `test:db:rollbacks` con la base vacía no las tiene.

### Paso 3 — 2026-11-16, Sonnet

🟢 Entorno: PRUEBAS. **Sin migraciones nuevas, sin pantallas y sin acciones de servidor** (son los pasos 4 a 6): solo las piezas que esas acciones usarán, con sus pruebas y sus guardias. Nada de esto se llama todavía desde la aplicación.

**Qué quedó:**

| Pieza | Archivo | Detalle |
|---|---|---|
| Códigos | `src/lib/auth/recovery-code.ts` | `generateRecoveryCodes()` (10 distintos, 12 símbolos Crockford sin I, L, O ni U, con `randomBytes` de `node:crypto` y los 5 bits bajos de cada byte: sin sesgo), `formatRecoveryCode` (grupos de 4), `normalizeRecoveryCode` (mayúsculas, quita espacios y toda clase de guiones, O→0, I y L→1; devuelve `null` si no quedan 12 símbolos del alfabeto o si lo escrito pasa de 64 caracteres), `recoveryCodeHash` y `recoveryCodeHashes` (`searchHash("mfa_recovery_code", PLATFORM_TENANT_ID, "<cuenta>\|<código normalizado>")`). `searchHash` recibe el campo como texto libre: **no hubo que registrar el propósito**. |
| Pasarela | `src/lib/security/mfa-recovery-gateway.ts` | Las siete funciones `mfa_recovery_*` con la llave maestra y un esquema zod por respuesta (`replaceRecoveryCodes`, `claimRecoveryCode`, `completeRecoveryCode`, `releaseRecoveryCode`, `acknowledgeRecoveryCodes`, `getRecoveryCodesStatus`, `revokeRecoveryCodes`). Errores `MfaRecoveryGatewayError` con solo el código de Postgres o `shape`. `claim` y `complete` devuelven `null` en `invalid` (la base no distingue el motivo y la pasarela tampoco). **No reintenta nada.** |
| Quitar factores | `src/lib/security/mfa-admin-gateway.ts` | `removeAllFactors(userId)`: lista y borra todos los factores (un 404 cuenta como hecho), sin tocar la contraseña ni cerrar sesiones. `lockAccountAndRemoveFactors` ahora cambia la contraseña y llama a `removeAllFactors` (mismo comportamiento; se probó que el orden se mantiene). |
| Contadores `manage` | `src/lib/security/login-rate-limit.ts` | `SecondStepContext` suma `"manage"`, con el sufijo `\|manage` (huella `<cuenta>\|manage`) sobre los mismos alcances `mfa_verify_user` y `mfa_verify_user_day`: **sin migración** y **sin contador común**. La prueba confirma cuatro familias distintas en la ventana de 15 minutos (ingreso, recuperación, activación y gestión) y que ninguna huella se repite entre caminos. |
| Correos | `src/lib/email/mfa-disabled-notice.ts`, `mfa-recovery-used-notice.ts`, `mfa-recovery-codes-created-notice.ts`, sobre una estructura común `mfa-account-notice.ts` | Texto escapado, fecha `dd-mm-aaaa hh:mm` hora de Chile, «Si fuiste tú, no hagas nada.» y «¿No fuiste tú? Cambia tu contraseña ahora.» con el botón «Cambiar mi contraseña». Son **constructores puros** (como `mfa-annulled-notice.ts`): quien envía pasa `forgotPasswordUrl: ${getAppOrigin()}${FORGOT_PASSWORD_PATH}` y el destinatario leído de la base. Se rechaza un enlace con consulta o «#». La prueba confirma que ninguno lleva algo con la forma de un código (12 símbolos, grupos de 4 o 6 números). El de desactivar va en presente («se pidió desactivar…»). |
| Auditoría | `src/lib/audit/log.ts`, `labels.ts` | `session.mfa_recovery_codes_created`, `session.mfa_recovery_used`, `session.mfa_disabled` (con su etiqueta en español y pruebas en `labels.test.ts`). `session.reauth_failed` ya existía. |
| Guardias | `tests/isolation/static-guards.test.ts` | **14** ampliada: `mfa.unenroll`/`challengeAndVerify`/etc. se permiten también en `src/lib/auth/second-step-manage-actions.ts`; las siete funciones solo desde `mfa-recovery-gateway.ts` y la tabla `mfa_recovery_codes` desde ninguna parte (`.from(...)`). **14b** ampliada: ahora prohíbe también `codes`, `recoveryCode…`, `normalized…`, `hash…` y `fingerprint…` en las llamadas a `serverLog` y `logAuditEvent`, y cubre `recovery-code.ts` y la pasarela (y, apenas existan, `recovery-code-actions.ts` y `second-step-manage-actions.ts`: la guardia ignora los que aún no existen y exige los tres que sí). **14d** con nueve llamadas nuevas que deben fallar y cuatro que deben pasar. **14k** (nueva): las siete funciones están en la pasarela y en ningún otro archivo, la pasarela no usa `auth.admin` ni `.mfa.` ni lee la tabla, ni ella ni `recovery-code.ts` registran ni escriben en consola, y un caso que confirma que muerde (llamar a una función o leer la tabla desde otro archivo se detecta; el propósito de la huella, un comentario o un nombre de auditoría no). |

**Desviaciones y detalles (no estaban en el diseño):**
- **`guard-coverage.test.ts` NO se tocó.** Su lista de excepciones es de **acciones de servidor** (`verifyRecoveryCodeAction`, `disableSecondStepAction`, `regenerateRecoveryCodesAction`, `acknowledgeRecoveryCodesAction`…), no de acciones de auditoría, y exige que cada excepción apunte a una acción que existe («la lista de excepciones no tiene acciones que ya no existen»). Esas acciones se crean en los pasos 4 a 6: **cada una trae su excepción justificada (de la cuenta, no de una organización) en el paso en que se crea.**
- **Los correos no tienen un `sendXxx`:** el diseño pide solo los textos; quien los envía (pasos 5 y 6) usa `loadEmailConfig`, `getEmailTransport` y `sendWithRetry` como `sendAnnulledNotice` de `mfa-annul.ts`. En el de desactivar (D4 = A) el envío debe devolver éxito o fallo, no tragarse el error.
- **`SecondStepContext = "manage"` y los mensajes:** `lockedDayMessageFor` (en `second-step-actions.ts`) solo conoce tres caminos; `manage` caería en el mensaje del enlace del correo. El paso 6 debe elegir su propio texto de bloqueo para ese camino.
- **La normalización tolera guiones de procesador de texto** (U+2010 a U+2015 y el signo menos U+2212), además del guion normal y cualquier espacio; no usa una expresión regular con esos caracteres porque el formateador del proyecto reescribía los escapes `\u…` de la clase y la dejaba mal.
- **`recoveryCodeHash` y `generateRecoveryCodes` van en un archivo marcado `server-only`** (usa `searchHash`). La pantalla de los códigos (paso 4) recibe los códigos ya formateados en la respuesta de la acción y no importa este archivo.

**Pruebas nuevas (todas en verde):** `recovery-code.test.ts` 14, `mfa-recovery-gateway.test.ts` 10, `mfa-account-notices.test.ts` 13, 4 más en `mfa-admin-gateway.test.ts`, 1 más en `login-rate-limit.test.ts`, 1 más en `labels.test.ts`, y las guardias 14, 14b, 14d y 14k.

### Paso 4 — 2026-11-16, Sonnet

🟢 Entorno: PRUEBAS (Supabase local). **Sin migraciones nuevas.** Activar devuelve los códigos de respaldo, hay una pantalla para verlos una sola vez, y se pueden crear o generar desde «Seguridad de tu cuenta». Entrar con un código (paso 5) y desactivar (paso 6) **no** se tocaron.

**Qué quedó:**

| Pieza | Archivo | Detalle |
|---|---|---|
| Activar devuelve los códigos | `src/lib/auth/second-step-actions.ts` | `confirmTotpEnrollmentAction` ya no redirige cuando la activación quedó en pie. Después de todo lo de antes (contraseña, contadores, permiso de H-118, `challengeAndVerify`, aviso, revertir si el aviso no salió, auditoría) llama a `issueRecoveryCodes` y devuelve `{ status: "enabled", recoveryCodes, setId }`, o `{ status: "enabled_without_codes" }` si crearlos falló (la verificación sigue activa). El caso de dos pestañas (M7) sigue redirigiendo a `/cuenta/seguridad`; la reversión de H-118 sigue devolviendo su error y **no** crea códigos. |
| Crear el juego | `src/lib/auth/recovery-code-issue.ts` | `issueRecoveryCodes(userId, factorId, "enrollment" \| "regenerate")`: genera, guarda las huellas con `mfa_recovery_codes_replace` y escribe `session.mfa_recovery_codes_created` con solo `{stage}`. Nunca lanza; devuelve `{ ok: false, reason }`. No es una acción de servidor (no se puede llamar desde el navegador). |
| Acciones de la cuenta | `src/lib/auth/recovery-code-actions.ts` | `regenerateRecoveryCodesAction` (crear o generar nuevos: forma → contraseña con `purpose: "regenerate"` → contadores del camino `manage` y bloqueo de código ya usado → factor TOTP verificado → `challengeAndVerify` → `issueRecoveryCodes` → correo de mejor esfuerzo) y `acknowledgeRecoveryCodesAction(setId)` («Listo»). |
| Lo que comparten | `src/lib/auth/second-step-checks.ts` | `checkCodeBeforeVerifying`, `failedVerification`, `auditFailure` y `lockedDayMessageFor` salieron de `second-step-actions.ts` (un archivo de acciones de servidor solo puede exportar acciones). Etapa nueva `manage` y mensaje de bloqueo del día propio (`MFA_LOCKED_DAY_MANAGE_MESSAGE`). Los pasos 5 y 6 usan lo mismo. |
| Aviso por correo | `src/lib/security/mfa-account-notice-send.ts` | `sendRecoveryCodesCreatedNotice(correo)`: pone remitente, enlace de «Cambiar mi contraseña» y plazo de 15 s al texto de `mfa-recovery-codes-created-notice.ts`, igual que `sendAnnulledNotice` de H-118. Devuelve si salió; nunca lanza. El paso 5 y el 6 agregan aquí su envío. |
| Pantalla de códigos | `src/app/cuenta/seguridad/recovery-codes-screen.tsx` | Lista numerada en Geist Mono (una columna en teléfono, dos desde 640 px), «Copiar todos», «Descargar (.txt)» (se arma en el navegador con un `Blob`, sin correo), texto «Solo los verás esta vez…», casilla «Guardé estos códigos en un lugar seguro» y «Listo» (deshabilitado hasta marcarla). No importa `recovery-code.ts`: recibe los códigos ya formateados. |
| Panel | `src/app/cuenta/seguridad/two-step-panel.tsx`, `page.tsx` | Los códigos viven en el estado de `TwoStepPanel` (que no se desmonta) y no en el formulario: al activar, la página se vuelve a pedir al servidor y el formulario desaparece. Sección «Códigos de respaldo» en la pantalla de la cuenta activada: sin códigos → «No tienes códigos de respaldo…» + «Crear códigos de respaldo»; con códigos → fecha de creación + «Generar códigos nuevos» («Los códigos anteriores dejarán de servir»); sin confirmar → «No confirmaste que guardaste tus códigos de respaldo…». La página lee el estado con `getRecoveryCodesStatus` (solo cuántos, si se confirmó y cuándo; nunca los códigos). |

**Desviaciones y detalles (no estaban en el diseño):**
- **`guard-coverage.test.ts`:** se agregaron las excepciones («de la cuenta, no de una organización») de `regenerateRecoveryCodesAction` y `acknowledgeRecoveryCodesAction`.
- **Guardia 14:** `.mfa.challengeAndVerify` y `.mfa.listFactors` ahora también se permiten en `recovery-code-actions.ts` (el diseño decía `second-step-manage-actions.ts`; la orden del paso 4 puso `regenerateRecoveryCodesAction` en `recovery-code-actions.ts`). **Guardia 14b** ampliada a `second-step-checks.ts`, `recovery-code-issue.ts` y `mfa-account-notice-send.ts`; el conteo mínimo de llamadas a `logAuditEvent` se cuenta ahora entre `second-step-actions.ts` y `second-step-checks.ts`. La 14b obliga a que el código de un registro venga de una variable llamada `error` o de `errorCodeOf(...)`: por eso esas dos piezas llaman así a sus variables.
- **La fecha del aviso y la pantalla tras «Listo»:** «Listo» lleva a `?aviso=activada` cuando venía de activar, y a un aviso nuevo `?aviso=codigos` («Listo: tus códigos de respaldo nuevos quedaron creados. Los anteriores ya no sirven.») cuando venía de crear o generar. `router.replace` y el borrado de los códigos de la memoria van juntos en una transición, para que no haya un parpadeo con el estado viejo.
- **Código de respaldo en el campo de la aplicación:** si lo escrito no son 6 números pero sí tiene la forma de un código de respaldo, el campo dice «Aquí va el código de 6 números de tu aplicación, no un código de respaldo.» y no se cuenta como intento ni se consulta nada.
- **Correo al regenerar:** el destinatario es el correo de la sesión verificada por Supabase Auth (`user.email`), no uno leído por la base como en `complete`. Nunca viene del formulario. Crear los primeros códigos también manda el aviso, que dice «los códigos anteriores ya no sirven»: es verdad pero poco natural cuando no había anteriores (menor; se puede afinar con un texto propio).
- **Si crear los códigos falla en `regenerate`,** el código de 6 números ya se gastó (Supabase lo aceptó): el mensaje pide «con el código siguiente de tu aplicación». No se libera.
- **El estado del juego** (`getRecoveryCodesStatus`) cuenta solo códigos sin usar: tras el paso 5 una cuenta sin factor tampoco tendrá juego.

**Pruebas nuevas y ajustadas (paso 4):** `recovery-code-actions.test.ts` 26, `recovery-code-issue.test.ts` 5, `mfa-account-notice-send.test.ts` 3, `recovery-codes-screen.test.tsx` 8 y `two-step-panel.test.tsx` 13 (jsdom: sin códigos, con códigos, sin confirmar, estado ilegible, formulario con contraseña y código de la aplicación, la pantalla de códigos con «Listo» y la que se mantiene cuando la página pasa a «activa»); `second-step-actions.test.ts` ajustado (la acción devuelve los códigos en vez de redirigir; se crean solo después del aviso y de la auditoría; con aviso fallido, contraseña o código malos no se crean; si fallan, `enabled_without_codes` sin revertir). E2E: `e2e/mfa-recovery.spec.ts` (3 pruebas: activar con contraseña mala y buena, 10 códigos, «Listo» deshabilitado, copiar, descargar, recargar sin que vuelvan, generar nuevos con los viejos invalidados en la base y el correo de aviso en Mailpit; una cuenta activada por la API sin códigos que los crea; teclado, 375 px y modo oscuro con captura y contraste) y `e2e/helpers.ts` (`finishRecoveryCodes`; `activateTwoStep` ahora pasa por la pantalla de códigos y «Listo»). La prueba de 375 px de `e2e/mfa.spec.ts` revisa también la pantalla de códigos (sin desplazamiento horizontal, botones y casilla de 44 px, los 10 códigos dentro del ancho).

**Verde local (2026-11-16):** `lint`, `typecheck` y `prettier` limpios; `npm test` 2.691 (1 omitida); `test:isolation` 1.401 (4 pendientes); e2e `chromium` con `E2E_PROD=1` y `--workers=1`: `mfa-recovery` 3 de 3, `mfa-enrollment-notice` 3 de 3, `password-reset` 2 de 3, `mfa-annul` 4 de 5 y `mfa.spec` 9 de 11 corridos (dos más no corridos, ver abajo).

**Lo que NO está verde y por qué (entorno, no el código de este paso):** tres pruebas que **piden el correo de recuperar la contraseña** fallan con «No llegó el correo de verificación» (`mfa-annul` «EL ATAQUE COMPLETO», `mfa.spec` «el límite…» y `password-reset` «recuperar la contraseña cierra las otras sesiones…»; con ellas, el modo `serial` deja sin correr «recuperar la contraseña con la verificación activa»). El Auth local que está corriendo responde **404** a `http://supabase_kong_cotiza-prime:8088/email/recovery.html`: la plantilla de recuperación de la PR #55 (`supabase/templates/recovery.html`, registrada en `config.toml`) no está cargada porque la base local se levantó antes de ese cambio y **no se reinició** (no se hizo `supabase stop/start` para no tocar el entorno). Todo lo anterior al correo de recuperación en esas pruebas (activar, pantalla de códigos y «Listo» con el helper nuevo) pasó. Hay que reiniciar Supabase local (`npx supabase stop && npx supabase start`, sin `db reset`) y repetir esas tres más las dos que quedaron sin correr.

### Paso 5 — 2026-11-16, Sonnet

🟢 Entorno: PRUEBAS (Supabase local, ya reiniciado con la plantilla de recuperación). **Sin migraciones nuevas.** Entrar con un código de respaldo, por los dos caminos (contraseña sola y enlace del correo de recuperar la contraseña). Desactivar (paso 6) **no** se tocó.

**Qué quedó:**

| Pieza | Archivo | Detalle |
|---|---|---|
| Acción | `src/lib/auth/recovery-code-actions.ts` | `verifyRecoveryCodeAction`, con el orden exacto de §3.4: 1) `requirePendingSecondStep()` y contadores «password» o «recovery» según `hasRecoverySession()`; 2) forma del código (6 números → «Eso parece el código de tu aplicación…»; vacío o mal formado → error en el campo; nada de esto toca la base ni los contadores); 3) límite compartido con el código de la aplicación; 4) `claim` por 2 minutos (si no sirve: suma fallo, `session.mfa_failed` con `{reason:"recovery_invalid", stage, factorType:"recovery_code"}` y UN solo mensaje); 5) `removeAllFactors` (si falla: `release`, auditoría `recovery_remove_failed` y «No pudimos terminar…», sin sumar fallo); 6) `signOut({scope:"others"})` después de quitar el factor; 7) `complete`; 8) limpiar los contadores de ese camino, `session.mfa_recovery_used` en la plataforma y en cada organización activa, `logTenantLogins` y el correo de mejor esfuerzo; 9) redirección. |
| Freno compartido | `src/lib/auth/second-step-checks.ts` | `blockedAttemptState` salió de `checkCodeBeforeVerifying`: bloqueo de la IP, tope del día y ventana de 15 minutos. Lo usan el código de 6 números y el de respaldo, así que dentro de un camino comparten los mismos contadores y entre caminos nunca. `AttemptStage` suma «recovery» a las etapas de la auditoría. |
| Aviso por correo | `src/lib/security/mfa-account-notice-send.ts` | `sendRecoveryUsedNotice` (mismo estilo que `sendRecoveryCodesCreatedNotice`; nunca lanza). |
| Pantalla del código | `src/app/(auth)/ingresar/codigo/second-step-form.tsx`, `page.tsx`, `src/components/auth/recovery-code-field.tsx` | Enlace «¿No tienes tu teléfono? Usa un código de respaldo» que cambia al formulario del código de respaldo (campo propio de 16 px, `autocomplete="off"`, `autocapitalize="characters"`, `spellcheck="false"`, sin `maxlength`; aviso de que desactiva la verificación; «Volver al código de mi aplicación»). El pie dice «Si no tienes la aplicación ni tus códigos de respaldo…». Tras un error el campo queda vacío y el foco vuelve a él. |
| Aviso en Seguridad | `src/lib/auth/paths.ts` (`ACCOUNT_SECURITY_NOTICES.recoveryUsed = "respaldo"`), `page.tsx` y `two-step-panel.tsx` de `/cuenta/seguridad` | El mensaje «Entraste con un código de respaldo. Desactivamos la verificación…» se ve (tono de advertencia) sobre el botón «Activar la verificación en dos pasos». |
| Guardias | `guard-coverage.test.ts`, `tests/isolation/static-guards.test.ts` | Excepción justificada de `verifyRecoveryCodeAction` («de la cuenta, no de una organización»); guardia 14b ya cubría `recovery-code-actions.ts` (el código escrito, el normalizado y la huella no llegan a un registro: se verificó con un texto de prueba); **14l nueva**: el orden de la acción (sesión a medias → límite → tomar → quitar factores → cerrar otras sesiones → completar → redirigir), sin llave maestra ni `unenroll` en el archivo, y una prueba de que muerde con cuatro órdenes rotos. |

**Desviaciones y detalles (no estaban en el diseño):**
- **El correo de aviso**: el destinatario es el que devuelve `complete` (leído de `auth.users` por la base); si `complete` responde `invalid` por plazo vencido (más de 2 minutos entre tomar y completar), se usa el de la sesión (`user.email`, verificado por Supabase Auth, nunca del formulario) para no dejar a la persona sin aviso. El factor ya se quitó, así que la sesión queda completa y no se rompe nada.
- **`stage` en la auditoría** vale «recovery» cuando llegó por el enlace del correo y «sign_in» si llegó con la contraseña, en `session.mfa_failed`, `session.mfa_locked` y `session.mfa_recovery_used`.
- **`session.mfa_recovery_used` lleva además `otherSessionsClosed`** (booleano), como `session.password_changed`. Si `signOut({scope:"others"})` falla, se anota en el registro y se sigue (el factor ya no está); la persona igual ve el mensaje de «cerramos tus otras sesiones». Límite conocido, poco probable; si importa, el siguiente paso es un aviso aparte.
- **Con una invitación pendiente y sin enlace del correo**, el destino es `/cuenta/seguridad?aviso=respaldo` (lo que pide §3.4), no la invitación. La invitación sigue guardada en el navegador y se retoma al volver a entrar.
- **El estado del formulario se conserva al cambiar de formulario** (el de respaldo y el de la aplicación viven en el componente padre): si la persona vuelve al de respaldo ve el último mensaje. Por eso las pruebas e2e esperan que el campo quede vacío (React lo vacía al terminar la acción) para saber que ese intento ya respondió.
- **La descripción de la pantalla** («escribe el código de 6 números de Cotiza Prime») no cambia al pasar al código de respaldo (es del servidor); el campo y su ayuda sí dicen qué se pide. Menor; se puede afinar.
- **«Aislamiento»: sigue pendiente** (`it.todo` de `tests/isolation/mfa-recovery.test.ts`) que `session.mfa_recovery_used` aparezca solo en las organizaciones donde la persona está activa y que no se vea en otra: la acción lo escribe con `activeTenantIdsOf` (como `session.mfa_enrolled`) y está cubierto por las unitarias, pero la prueba contra la base real con `mixta` queda para el paso 7.

**Pruebas nuevas y ajustadas (paso 5):** `recovery-code-actions.test.ts` +20 (46 en total: solo con sesión a medias, código mal escrito y 6 números sin tocar contadores, cuenta o IP bloqueada sin consultar la base, mensaje de bloqueo por camino, `invalid` suma al contador del camino, 5 intentos mezclados bloquean el sexto, orden exacto, auditoría en plataforma y organizaciones, ni código ni huella en registros, si falla quitar el factor se suelta el código, `complete` vencido no rompe, aviso de mejor esfuerzo, camino del correo); `second-step-form.test.tsx` 5 (render del formulario); `two-step-panel.test.tsx` +2 (el aviso `respaldo`); guardia 14l. E2E en `e2e/mfa-recovery.spec.ts` (+4): usar un código (malo, de 6 números, bueno en minúsculas y sin guiones; desactiva la verificación; la otra sesión queda fuera; llega el correo; el mismo código no sirve otra vez; al activar de nuevo salen códigos distintos y los viejos no sirven, los nuevos sí), olvidé la contraseña y perdí el teléfono (enlace del correo, código de respaldo, contraseña nueva), el límite (5 intentos mezclados, el sexto bloquea incluso con un código bueno sin gastarlo, y por el enlace del correo la misma cuenta aún entra) y la pantalla a 375 px, en claro y oscuro, con teclado, letra de 16 px y áreas de 44 px (capturas revisadas a ojo).

**Verde local (2026-11-16):** `lint`, `typecheck` y `prettier` limpios; `npm test` 2.719 (1 omitida); `test:isolation` 1.402 (4 pendientes); e2e `chromium` con `E2E_PROD=1` y `--workers=1` sobre `mfa-recovery`, `mfa`, `mfa-annul`, `password-reset` y `mfa-enrollment-notice`: **29 de 29** (esto incluye las tres pruebas que pedían el correo de recuperar la contraseña, que en el paso 4 fallaban por la plantilla sin cargar; ya con Supabase reiniciado pasan). **No corridos:** `test:db`, `test:db:rollbacks` (no hubo migraciones nuevas), e2e `isolation`, el resto de `chromium`, Firefox, Safari, iPhone real y lector de pantalla.

### Pasos 6 y 7 (etapa C: desactivar, y documentos) — 2026-11-16, Sonnet

🟢 Entorno: PRUEBAS (Supabase local). **Sin migraciones nuevas** (la base sigue en 54 archivos de migración).

**Qué quedó (paso 6):**

| Pieza | Archivo | Detalle |
| --- | --- | --- |
| Acción | `src/lib/auth/second-step-manage-actions.ts` | `disableSecondStepAction`, con el orden de §3.5 (lo vigila la guardia 14m): 1) `requireUser()` y estado de sesión (completa y con la verificación activa; si ya no lo está, vuelve a la pantalla de seguridad sin consultar ni avisar); 2) forma de los campos (6 números = código de la aplicación, 12 símbolos = código de respaldo, otra cosa = error en el campo; sin tocar contadores); 3) **contraseña** con `confirmPassword(purpose: "disable")`; 4) factor TOTP verificado de la persona (si no hay, está hecho) y **el código** con los contadores del camino «manage» (respaldo: `blockedAttemptState` + `mfa_recovery_code_claim`; aplicación: bloqueo de código ya usado + `challengeAndVerify`); 5) **el aviso por correo, OBLIGATORIO** (`sendDisabledNotice`, D4 = A): si no sale no se cambia nada, se suelta el código de respaldo y se dice «No pudimos enviarte el correo de aviso, así que no desactivamos la verificación…»; 6) `mfa.unenroll` con la **propia sesión** (sin llave maestra; un factor que ya no existe se da por hecho); 7) `complete` (si se usó un código de respaldo) y `revoke`; 8) `signOut({ scope: "others" })` **al final**; 9) auditoría `session.mfa_disabled` con `{ via: "totp" \| "recovery_code", otherSessionsClosed }` en la plataforma y en cada organización donde la persona está **activa**; 10) redirección a `/cuenta/seguridad?aviso=desactivada`. No toca `mfa_annul_links` de H-118. |
| Aviso por correo | `src/lib/security/mfa-account-notice-send.ts` | `sendDisabledNotice(correo)`: devuelve `true` solo si el proveedor aceptó el correo; nunca lanza y registra solo el código del error. A diferencia de los demás avisos de la etapa B, **quien llama DEBE mirar el resultado**. El destinatario es el correo de la sesión (`user.email`, verificado por Supabase Auth), nunca uno del formulario. |
| Pantalla | `src/app/cuenta/seguridad/two-step-panel.tsx`, `page.tsx` | Sección «Desactivar la verificación» al final de «Seguridad de tu cuenta» con el botón de peligro «Desactivar la verificación en dos pasos», que abre una tarjeta de superficie sólida con «Tu contraseña» y «Código de tu aplicación o código de respaldo» (campo nuevo `src/components/auth/any-code-field.tsx`: 16 px, sin `maxlength`, sin relleno automático). Tras desactivar, `?aviso=desactivada` muestra «Desactivamos la verificación en dos pasos y cerramos tu sesión en tus otros dispositivos. Te enviamos un aviso a <correo>.» sobre el botón «Activar». |
| Mensajes | `src/lib/auth/errors.ts`, `paths.ts` | `RECOVERY_CODE_INVALID_MESSAGE` (el mensaje único del código de respaldo, ahora compartido con `verifyRecoveryCodeAction`), `MFA_DISABLE_NOTICE_FAILED_MESSAGE` y `ACCOUNT_SECURITY_NOTICES.disabled`. El mensaje de bloqueo del día del camino «manage» ya existía (paso 4). |
| Guardias | `guard-coverage.test.ts`, `tests/isolation/static-guards.test.ts` | Excepción justificada de `disableSecondStepAction` (de la cuenta, no de una organización). Las guardias **14** y **14b** ya cubrían el archivo y siguen en verde. **14m nueva:** el orden de la acción (sesión → contraseña → código → aviso → quitar el factor → completar y borrar códigos → cerrar las otras sesiones → auditoría → redirección final), que se mire el resultado del aviso y se corte ANTES de quitar el factor, que el factor se quite con `supabase.auth.mfa.unenroll` (la sesión de la persona) y que el archivo no use la llave maestra ni la pasarela de factores; con casos que muerden (seis permutaciones de orden roto, quitar el corte del aviso, quitar el factor con `auth.admin` y faltar el primer paso). |

**Desviaciones y detalles (no estaban en el diseño):**
- **No hay `Sheet` en el proyecto** (no está en `src/components/ui/`), así que en el teléfono es la misma tarjeta dentro de la página, no una hoja que sube desde abajo; no se agregó un componente nuevo. Anotado en `DISENO.md`. Si Aarón quiere la hoja, es un cambio aparte.
- **`session.mfa_disabled` lleva además `otherSessionsClosed`** (booleano), como `session.mfa_recovery_used`. Si cerrar las otras sesiones falla, se anota y se sigue (el factor ya no está).
- **Los contadores se limpian al aceptarse el código** (antes del aviso), igual que en crear códigos nuevos. Si el aviso no sale, el intento ya contó en la ventana de 15 minutos y el siguiente intento necesita otro código de la aplicación (el de 6 números ya se gastó); el de respaldo, en cambio, se suelta y se puede reintentar.
- **Si el factor ya no existe al empezar** (otra pestaña lo quitó) o la sesión ya no tiene la verificación activa, la acción vuelve a `/cuenta/seguridad` sin avisar ni auditar: «un doble envío no rompe».
- **Si `complete` o `revoke` fallan** después de quitar el factor, se anota con el código del error y se sigue: sin factor, los códigos quedan inútiles y la limpieza de la base los borra después. Si `complete` responde `invalid` por el plazo de 2 minutos, no rompe nada.
- **Para el correo que no sale en las pruebas** hay que activar la cuenta por la API con el permiso (la pantalla revertiría la activación con un destinatario fuera de la lista permitida).

**Pruebas nuevas (paso 6):**
- `src/lib/auth/second-step-manage-actions.test.ts`: 38 (sesión completa y doble envío; formas del código; la contraseña primero y su error sin tocar nada; con el código de la aplicación y con uno de respaldo: contadores «manage», orden exacto, auditoría en la plataforma y en cada organización activa, código usado, incorrecto y error de Supabase; **correo que no sale = no se quita nada y se suelta el código**; quitar el factor falla o ya no existe; `complete` y `revoke` fallan; bloqueos y los 5 intentos mezclados; ni contraseña ni código ni huella llegan a un registro).
- `src/lib/security/mfa-account-notice-send.test.ts` +3 (`sendDisabledNotice`); `two-step-panel.test.tsx` +7 (el botón de peligro, la tarjeta, cancelar, errores, lo que viaja en el envío y el aviso de desactivada).
- **Aislamiento (`tests/isolation/mfa-recovery.test.ts`, el `it.todo` quedó completo, +3):** con el **código real** de `disableSecondStepAction` y `verifyRecoveryCodeAction` (base, GoTrue, pasarelas, auditoría y contadores reales; solo se reemplazan la sesión de Next, la contraseña, el correo y la verificación del código de 6 números), con cuentas nuevas activas en A y con la membresía de B quitada: `session.mfa_disabled` queda en la plataforma y en A, **no en B (que dejó) ni en C**; con un código de respaldo y dos organizaciones activas queda en las dos; `session.mfa_recovery_used` y el ingreso, solo en las activas; la dueña de A ve el evento de su miembro por la API y las de B y C no ven ninguno. El factor se quita de verdad con el pase de la persona (`DELETE /factors/{id}` con aal2).
- `e2e/mfa-recovery.spec.ts` +3 (caso 5 de §7): contraseña mala y código malo (de la aplicación y de respaldo) no cambian nada; con el código de la aplicación se desactiva, llega el correo, la otra sesión queda fuera, los códigos se borran, la contraseña sola entra directo y al activar de nuevo salen códigos distintos; con un código de respaldo (en minúsculas y sin guiones) se desactiva y el código ya no sirve; con el correo fuera de la lista permitida **no se desactiva**, la verificación sigue activa y los 10 códigos siguen libres.

**Paso 7 (documentos):** `modelo-datos.md` (la tabla y sus siete funciones), `PROYECTO.md` §11.2 (cuánto se guardan los códigos), `DISENO.md` (la lista de códigos de respaldo, «Confirmar con contraseña y código» y el botón de peligro), `README.md` («Probar los códigos de respaldo») y `HISTORIAS.md` (criterios afinados, tamaño, partición y la nota en H-117 de que la tabla se reutiliza). **No se editó `CLAUDE.md`** (lo hace la sesión principal; su conteo de «51 archivos» de migraciones debe decir **54**).

### Antes del piloto (H-004b)

- **Medir el cupo de ingresos por IP del Supabase de producción** (`sign_in_sign_ups`): pedir la contraseña de nuevo (`confirmPassword`) abre un ingreso desechable por cada activación, desactivación o creación de códigos, y todos salen de la IP del servidor. El 429 no se pudo provocar en local (paso 0).
- **Configurar el proveedor de correo de producción** para que el aviso de «Se pidió desactivar…» salga siempre: sin él **nadie puede desactivar la verificación** (D4 = A). Probar con Gmail y Outlook y definir qué se le dice a la persona si el proveedor está caído (hoy: «Inténtalo de nuevo en unos minutos»).
- **Plazo del hosting:** `/cuenta/seguridad` declara `maxDuration = 60`; desactivar manda un aviso de hasta 15 s, dentro de ese plazo.
- **Confirmar con Aarón** D1, D2, D4 y D7 (supuestos aplicados): sobre todo **D7 = B** (quien tenga una sesión completa robada puede quitar el factor hablando directo con Supabase hasta H-117; confirmado en P0-5) y **D4 = A** (si el correo falla, no se desactiva).
- **Sin probar:** correo real, iPhone real, Firefox, Safari y lector de pantalla.

**Verde local (2026-11-16, pasos 6 y 7):** `lint`, `typecheck` y `prettier` limpios; `npm test` 2.768 (1 omitida); `test:isolation` 1.406 (3 pendientes: el `it.todo` de la auditoría quedó completo); e2e `chromium` con `E2E_PROD=1` y `--workers=1` sobre `mfa-recovery`, `mfa`, `mfa-annul`, `password-reset` y `mfa-enrollment-notice`: **32 de 32** (la primera compilación abortó con el aviso de seguridad de Next.js, `SecurityFatalError`, y el mismo comando pasó al reintentarlo; no se tocó ninguna versión). `test:db`: **1.316 pasan y 30 fallan, las mismas 30 de siempre** en 7 archivos de deshacer (`mfa-session-gate-rollback`, `invitation-*`, `member-*`; ver «Estado de la base local» del paso 2): las filas viejas `mfa_annul_ip` (11) y `mfa_annul_token` (41) de `auth_rate_limits`, que dejaron las pruebas de punta a punta de H-118, rompen el `down` de `20261112100000`. No se borraron (sería tocar datos de la base local sin confirmación); con `delete from public.auth_rate_limits where scope in ('mfa_annul_ip', 'mfa_annul_token')` o con la base vacía no ocurre. **No corridos:** `test:db:rollbacks` (no hubo migraciones nuevas; vacía la base), e2e `isolation`, el resto de `chromium`, Firefox, Safari, iPhone real y lector de pantalla.

### Correcciones de las revisiones Opus (normal y adversarial) — 2026-11-16, Sonnet

🟢 Entorno: PRUEBAS. **Última ronda de correcciones.** La migración `20261116100000_mfa_recovery_codes.sql` se editó EN SU LUGAR (no está en `main`; no hay otra migración: siguen **54 archivos**). Las tres funciones cambiadas se volvieron a aplicar a la base local con `create or replace` (sin `db reset`) y se actualizaron sus md5 en el deshacer.

| Punto | Qué se hizo |
|---|---|
| **C1** quitar el factor «a medias» | `hasVerifiedFactor(userId)` nueva en `mfa-admin-gateway.ts` (con 4 pruebas). **Entrar con un código (`verifyRecoveryCodeAction`):** si `removeAllFactors` lanza, se vuelve a preguntar si queda algún factor verificado (`factorMayRemain`): solo si SIGUE puesto, o no se puede saber, se suelta el código y se muestra el error; si ya no queda, sigue por el camino de éxito (aviso, cerrar sesiones, completar, auditar, redirigir). **Desactivar (`disableSecondStepAction`):** igual con `unenroll`, volviendo a leer `mfa.listFactors()` de la propia sesión. Además, en entrar con un código: se cierran las otras sesiones ANTES de quitar el factor y otra vez después; y el aviso del código usado sale **apenas el factor está fuera** (al correo de la sesión; si la sesión no trae uno, con el que lee `complete`), no al final (sigue siendo de mejor esfuerzo, D5 = A). Guardias 14l y 14m reescritas (orden y «hay que volver a preguntar si queda el factor»), con casos que muerden. Pruebas «el factor sí se borró aunque falló la respuesta» para las dos acciones (con código de la aplicación y de respaldo; y «no se puede ni leer»). Lo que queda abierto si el servidor se cae: nueva fila en §6. |
| **C2** migración | (a) `replace` solo responde `busy` si hay un código tomado cuyo factor sigue siendo un TOTP verificado (un huérfano no bloquea). (b) La limpieza de `replace`, `claim` y `status` queda acotada a `limit 100` con `for update skip locked`. Pruebas nuevas en `tests/db/mfa-recovery-codes.test.ts`: RP4b (huérfano no bloquea; con el factor vivo sí) y LA (150 huérfanos: cada llamada borra como máximo 100, las siguientes terminan; con `replace`, `claim` y `status`). Guardia 15 y `schema-guards` en verde. **Decisión de implementación:** la limpieza NO se indexa por `created_at` (la rama «usado hace más de 30 días» no implica una creación anterior en las pruebas existentes): el tope de 100 acota lo que se borra y el trabajo de escribir, no el barrido de lectura de una tabla pequeña (códigos de respaldo ≈ 10 por persona con segundo paso). Si la tabla llegara a ser grande, el siguiente paso es un índice por `used_at`. |
| **C3** panel | `TwoStepPanel` limpia el aviso «activa pero sin códigos» cuando `active` pasa de verdadero a falso (se mira el CAMBIO, en el mismo render, sin parpadeo); si no, tras activar sin códigos y desactivar sin recargar se veía «está activa». Prueba de render agregada. |
| **C4** retención | `PROYECTO.md` §11.2, `modelo-datos.md` y §4.3 de este diseño dicen lo mismo y lo que hace el código: se borran al desactivar desde la pantalla, al entrar con uno y al activar de nuevo o generar otros; si el factor desaparece por otro camino dejan de servir al instante y se borran a más tardar con la limpieza (lotes de 100, solo con actividad). |
| **C5** textos | El campo dice «o un código de respaldo (12 letras y números)». El correo de códigos nuevos: asunto «Se crearon códigos de respaldo nuevos en tu cuenta» y «Si había otros códigos de respaldo, ya no sirven» (pruebas y e2e al día). En `verifySecondStepAction`: si lo escrito en el campo del código de la aplicación tiene la forma de uno de respaldo (12 símbolos), se orienta hacia el enlace «¿No tienes tu teléfono? Usa un código de respaldo» sin contar el intento ni consultar nada (prueba). El aviso en pantalla `?aviso=codigos` («Los anteriores ya no sirven») **no se tocó** (lo comprueba un e2e y no estaba en la lista). |
| **C6** móvil | El botón «Desactivar la verificación en dos pasos» puede pasar a dos líneas (`h-auto min-h-12 whitespace-normal`). Nuevo ayudante e2e `expectControlsInsideCard` (`e2e/helpers.ts`): compara el rectángulo de cada botón, enlace, campo, etiqueta y código con el de la tarjeta (`AuthCard` recorta con `overflow-hidden`, y el `scrollWidth` del documento no lo ve); se usa en `mfa.spec.ts` (`noOverflow`, con los formularios de desactivar y crear abiertos) y en `mfa-recovery.spec.ts` (los tres chequeos de 375 px). |
| **C7** guardias | **14b:** para los siete archivos de H-004b (`reauth.ts`, `recovery-code.ts`, `recovery-code-actions.ts`, `second-step-manage-actions.ts`, `mfa-recovery-gateway.ts`, `second-step-actions.ts`, `second-step-checks.ts`) hay una LISTA CERRADA de claves (`code` solo si viene de un error, `reason`, `stage`, `purpose`, `via`, `factorType`, `otherSessionsClosed`, `noticeSent`, `operation`, y el sobre `action`, `result`, `actorUserId`, `tenantId`, `details`) y de nombres en los valores; `{ value: typed }`, `{ rawCode }` y `readText(` en un registro se detectan, y también lo que se arma antes en `const details/used/disabled/enrolled = {…}`. **14k:** el nombre de una función armado por partes (`"mfa_recovery_code" + "_claim"`, `` `mfa_recovery_code${x}` ``, `[…].join`, `… + "_claim"`) se detecta en cualquier archivo. **14:** `const { mfa } = supabase.auth`, `const { auth: { mfa } } = …` y `auth["mfa"]` reciben el mismo trato que `auth.admin`. Cada cambio con casos que muerden y casos inofensivos. |
| **C8** | Al desactivar con un código de respaldo, si el factor del código tomado no coincide con el factor que se va a quitar, se suelta el código y se falla con el mensaje genérico (prueba). |
| **C9** | `session.mfa_recovery_used` lleva ahora `noticeSent` (booleano). **`session.mfa_disabled` no lo lleva: no aplica**, el aviso al desactivar es OBLIGATORIO (D4 = A), así que siempre vale verdadero. Sobre el deshacer en producción con juegos vigentes: ver §4.2. |
| **C10** | `OfflineNotice` en los formularios de desactivar y crear códigos y en la pantalla de códigos; `finish()` atrapa un error de red sin perder los códigos (los códigos siguen en pantalla y «Listo» se puede reintentar). Pruebas de render. |
| **C11** | **M8:** el test de «5 intentos mezclados» de `recovery-code-actions.test.ts` se renombró y su comentario dice lo que prueba (los de la aplicación se simulan llamando al contador; la mezcla real la prueba el e2e «el límite»); el título de `second-step-actions.test.ts` ya dice «emisor Cotiza Prime y el nombre «Aplicación de códigos»». **M9:** `sprint-5-equipo-y-permisos.md` §5b remite a este documento y corrige el «1,5 días» (≈ 6); el comentario de `maxDuration` de `page.tsx` cuenta los hasta 10 s de `confirmPassword` (peor caso teórico de activar: 10 + 3 × 15 = 55 s, toca el tope de 60 s; mitigación anotada, no se subió el tope porque depende del plan del hosting); el comentario suelto de `e2e/helpers.ts` quedó en su lugar. **M10:** `session.mfa_locked` anota `factorType: "recovery_code"` cuando el intento fue con un código de respaldo (parámetro nuevo de `blockedAttemptState`, con pruebas); el enlace de la descarga se suelta a los 10 s, no a 0 ms; en los formularios de **desactivar y de crear códigos** la contraseña va ANTES del código (con el foco inicial en la contraseña). **El paso de activar (`ConfirmStep`) se dejó con el código primero** y el título «2. Escribe el código de tu aplicación y tu contraseña»: varias pruebas e2e de `mfa.spec.ts` comprueban que el foco inicial es el campo del código, y cambiarlo era un cambio de comportamiento mayor que lo pedido. |

**No se hizo (marcado «para Aarón»):** D7, la llave de búsqueda (M-6), el aviso `mfa_factor_unenrolled` de Supabase y el cupo de Resend. Quedan anotados abajo.

### Para Aarón (decisiones o hechos que no se tocaron en esta ronda)

- **D7 = B (supuesto aplicado):** quien tenga una sesión completa robada puede quitar el factor hablando directo con Supabase hasta H-117 (confirmado en P0-5). Falta que Aarón lo acepte por escrito o pida cerrarlo (+0,75 a 1 día).
- **Llave de búsqueda (M-6):** las huellas de los códigos de respaldo usan `CP_SEARCH_KEY_V1` (la misma de las huellas de búsqueda): rotarla invalida todos los códigos de respaldo y las personas tendrían que generar otros. Decidir el procedimiento de rotación y si los códigos merecen una llave propia antes del piloto.
- **Aviso propio de Supabase `mfa_factor_unenrolled`:** al quitar el factor, Supabase puede mandar su propio correo; decidir si se apaga en producción (como `mfa_factor_enrolled`, que desde H-118 envía nuestro servidor) para que no se dupliquen avisos.
- **Cupo de Resend:** cada activación, desactivación o creación de códigos manda un correo, y entrar con un código de respaldo otro; medir contra el plan gratuito del piloto (decisión de A3 de H-116). Con D4 = A, si se agota el cupo **nadie puede desactivar** la verificación.
- **D1, D2 y D4** (supuestos aplicados, ver «Decisiones aplicadas»): confirmarlos.

**Verde local (2026-11-16, ronda de correcciones):** `lint`, `typecheck` y `prettier --check` (también los `.md`) limpios; `npm test` 2.791 pasan (1 omitida; 175 archivos); `test:isolation` 1.406 pasan (3 pendientes); `tests/db/mfa-recovery-codes.test.ts` y `mfa-recovery-codes-rollback.test.ts`: 37 de 37 (28 + 9), más `schema-guards.test.ts` 22 de 22 (guardia 15 incluida); las guardias estáticas (`static-guards.test.ts`) 42 de 42. e2e `chromium` con `E2E_PROD=1` y `--workers=1` sobre `mfa-recovery`, `mfa`, `mfa-annul`, `password-reset` y `mfa-enrollment-notice`: la primera compilación abortó con `SecurityFatalError` y el mismo comando pasó al reintentarlo. Una falla real (la de `mfa.spec.ts:358`: el ayudante nuevo `expectControlsInsideCard` medía la pantalla «Cargando…» recién navegada, sin controles) se corrigió esperando a que haya controles. Después, varias corridas tuvieron UNA falla distinta cada una, siempre un plazo de 5 s agotado por el servidor lento (botón en «Verificando…» o «Activando…»; una redirección tras cambiar la contraseña), nunca la misma ni en código tocado: `mfa-recovery.spec.ts` «si el correo de aviso no sale» (corrida 4), `mfa.spec.ts` «activar» (corrida 4) y `mfa.spec.ts` «recuperar la contraseña con la verificación activa» (corrida 6); cada una pasó en otra corrida. Corrida 6: 25 pasaron (todo `mfa-annul`, `mfa-enrollment-notice`, `mfa-recovery` y `password-reset`) y falló `mfa.spec.ts:319`; `mfa.spec.ts` completo, corrido aparte: **11 de 11**. **No hay una corrida única de los 32 en verde con el código final** (las pruebas de `mfa.spec.ts` son en serie y comparten cuenta, así que una falla de plazo salta las siguientes). **No corridos:** `test:db` completo, `test:db:rollbacks`, e2e `isolation`, el resto de `chromium`, Firefox, Safari, iPhone real y lector de pantalla.
