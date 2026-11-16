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
5. Quita todos los factores con la pasarela, usando `removeAllFactors(userId)`, nueva en `mfa-admin-gateway.ts`: es la parte de `lockAccountAndRemoveFactors` que borra factores, sin el cambio de contraseña. Si falla:
   - Suelta el código con `mfa_recovery_code_release`, así la persona no lo pierde.
   - Muestra «No pudimos terminar. Intenta de nuevo en unos minutos.» y lo deja en la auditoría.
6. Cierra las otras sesiones con `signOut({ scope: "others" })`. Va después de quitar el factor, para alcanzar también una sesión abierta en ese mismo momento.
7. Completa con `mfa_recovery_code_complete`: marca el código como usado, borra el resto del juego y devuelve el correo leído de `auth.users`.
8. Limpia los contadores de la ventana de ese camino; escribe `session.mfa_recovery_used` en la plataforma y en cada organización donde la persona está activa; anota el ingreso en cada organización (`logTenantLogins`); envía el correo (3.9).
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
   - Si la cuenta tiene un código tomado en ese momento, responde `{result: 'busy'}`.
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

**Limpieza:** va dentro de `replace`, `claim` y `status`. Borra los juegos cuyo factor ya no existe y tienen más de 1 día, y los códigos usados con más de 30 días. No hace falta una tarea programada, con la misma salvedad de H-118: solo corre cuando hay actividad.

**La pasarela nueva** `src/lib/security/mfa-recovery-gateway.ts` es el único archivo que llama a estas funciones (con la llave maestra), y valida cada respuesta con esquemas zod, como `mfa-alerts-gateway.ts`.

### 4.2 Deshacer: `supabase/rollbacks/<fecha>_mfa_recovery_codes.down.sql`

Lleva la guardia 15 y se niega a correr si:
- (a) alguna de las 7 funciones ya no es la de la migración (compara el md5 de su cuerpo);
- (b) otra función de `public` o `app` las nombra, o nombra la tabla;
- (c) hay códigos tomados en ese momento (un uso en curso);
- (d) hay juegos vigentes: borrarlos dejaría sin respaldo a personas que no lo saben.

El archivo lleva una advertencia: con la aplicación de H-004b funcionando, entrar con un código de respaldo deja de servir, así que solo se deshace con la aplicación vuelta atrás.

### 4.3 Cuánto se guardan (anotar en `PROYECTO.md` §11.2)

«Códigos de respaldo (solo huellas): mientras la verificación esté activa. Se borran al desactivar, al entrar con uno, al generar otros y cuando su factor ya no existe (la limpieza va dentro de las funciones).» No se guarda el correo ni el código.

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
| Falla quitar el factor después de tomar el código | Se suelta el código: no se pierde |
| El servidor se cae entre quitar el factor y completar | El código queda tomado 2 minutos y después ya no sirve (su factor no existe). La sesión ya quedó completa, así que no se pierde el acceso |
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
  - El orden exacto: tomar, quitar factores, cerrar las otras sesiones, completar, auditoría, correo y redirección.
  - Si falla quitar el factor, se suelta el código.
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
