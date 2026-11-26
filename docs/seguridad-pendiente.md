# Seguridad pendiente antes del primer cliente real

> Criterio de Aarón (2026-11-17): en esta etapa Cotiza Prime lleva **la seguridad básica** que toda plataforma debe tener
> (ingreso, permisos por organización, segundo paso, nada de datos expuestos). Lo específico o avanzado se anota aquí y **no se
> construye ahora**, para avanzar y pulir el producto. **No se empiezan historias de seguridad nuevas** (H-117, H-004c u otras)
> hasta que el producto esté pulido.
>
> **Esta lista se revisa y se cierra antes del primer cliente real con datos reales**, no recién en el lanzamiento público.
> Lo básico no se recorta: una organización nunca ve datos de otra, los permisos por rol, la contraseña y el segundo paso, y no
> exponer datos personales.

Origen: revisión de Aarón al PR #56 (H-004b), 2026-11-17 (los números I-1, M-1… son los de esa revisión), y al PR #58 (H-041), 2026-11-18 (los de H-041 llevan el prefijo «H-041»).

## Riesgos aceptados hasta H-117

| # | Qué | Estado |
|---|---|---|
| D7 | Con una sesión completa robada se puede quitar el segundo paso hablando directo con Supabase (responde 200), sin contraseña ni aviso. Aceptado hasta H-117 (decisión 021, opción B antes del lanzamiento) | Aceptado |
| I-1 | Con `secure_password_change = true` (`supabase/config.toml:232`), una sesión completa robada de menos de 24 h podría cambiar la contraseña directo en GoTrue, quitar el factor (D7) y activar su propio teléfono pasando la contraseña pedida de nuevo. La dueña recibe los avisos y puede anular con el enlace de H-118. **Sin probar.** Variante más grave de D7 | Se cierra con H-117 |
| I-2 | Tras entrar con un código de respaldo la cuenta queda solo con contraseña hasta reactivar (D2 = A). Opción futura: pedir una contraseña nueva en ese paso (+0,5 día) | Pendiente |

## Pendientes menores

- **M-1:** «cerrar las otras sesiones» no corta la base al instante: un pase ya emitido sigue valiendo hasta 15 min (`jwt_expiry = 900`). (La frase del diseño de H-004b ya lo dice.)
- **M-2:** pedir la contraseña de nuevo gasta el cupo de ingresos por IP de Supabase (la IP del servidor). Falta un límite propio por cuenta en `confirmPassword`; medir el cupo en producción.
- **M-6:** las huellas de los códigos de respaldo usan la misma llave de búsqueda que el resto (`CP_SEARCH_KEY_V1`), con 60 bits por código.
- **Aviso propio de Supabase** `mfa_factor_unenrolled`: podría mitigar D7. Sin verificar en la CLI 2.119 ni en el alojado.
- `recovery-code-actions.ts` (rama de `removeAllFactors` + `hasVerifiedFactor` fallando seguidos): el factor pudo quitarse sin aviso. Mandar el aviso igual en esa rama.
- `mfa_recovery_code_release` no revisa `claimed_until` ni toma el candado por cuenta. Hoy no se puede alcanzar.
- La limpieza de juegos huérfanos puede hacer que `complete` responda `invalid` a mitad de un ingreso con código. No hace daño; tenerlo presente al leer `mfa_recovery_complete_not_applied`.

## De H-041 (precios bloqueados y tope de descuento), revisión de Aarón del 2026-11-18

Sin trabajo ahora; se cierran con la lista antes del primer cliente real.

- **H-041-1:** cuando un Dueño o un Administrador da un descuento **sobre el tope**, no queda evento ni auditoría: `locked_price_overridden` solo cubre el precio bloqueado. Posible evento `discount_cap_overridden` (mismo patrón, a lo más 20 líneas, sin nombres de línea).
- **H-041-2:** el tope mide el descuento de cada línea y el general **por separado**; con un tope de 10 % se llega a 19 % efectivo sumando los dos (supuesto 17, aprobado). Si algún día se quiere cerrar, medir el descuento total (línea + general) contra el subtotal bruto: sería parte de H-041b.
- **H-041-3 (para H-042):** el permiso por servicio solo se revisa al guardar una línea **nueva**, no al enviar. Además, si H-042 reemplaza `app.can_quote_catalog_item` con `create or replace` sin repetir `security definer set search_path = ''`, el gancho pierde esa protección: la prueba de contrato (`tests/db/save-quote-draft-contract.test.ts`) tiene que verificar también `prosecdef` y `proconfig` del gancho.
- **H-041-4:** con la opción C de la pregunta 20 (aprobada), un Comercial puede agregar servicios a varios borradores antes de una subida de precio y enviarlos después al precio anterior. Aceptado.

- **H-048b-1** (informativo, revisión de Aarón al PR #67, 2026-11-23): «Exclusiones» y «Notas al pie» aceptan marcas de dirección invertida e invisibles (U+202E y parecidas); los textos guardados de H-048a sí las bloquean. No cruza organizaciones y pasaba igual con observaciones y condiciones. Cierre, si se quiere: aplicar a los cuatro textos de la cotización la misma regla de caracteres que a los textos guardados (`app.intake_text_unsafe`). *(Una entrada anterior de esta lista decía que la página del cliente falla con emoji; era incorrecta: Zod cuenta caracteres reales y una copia con 4.000 emoji abre bien. Lo que sí pasa es que el contador del editor, la validación que apaga «Guardar» y el «No cabe» del menú «Insertar texto guardado» cuentan en UTF-16 y frenan antes que el servidor cuando hay emoji: son más estrictos, no es un riesgo.)*

- **H-048b-2** (revisión Opus del PR de seguimiento, 2026-11-24): un cliente llamado `https://malo.ejemplo/pago`, escrito por quien llena el formulario público, aparece tal cual en el correo de la cotización (por `{{cliente}}` o por el saludo de partida). Gmail y Outlook convierten solos una dirección en enlace. La nota M3 de `docs/arquitectura/sprint-5-equipo-y-permisos.md` cubre solo el correo de invitación. El destinatario es esa misma persona, así que el riesgo es bajo, pero conviene resolverlo **antes de enviar correos reales**: por ejemplo, separar el esquema de las direcciones que aparecen en los nombres (`https:// `) al armar el correo.

## Antes del piloto (de H-004b, sin trabajo ahora)

- Medir el cupo de Resend (plan gratuito: 100 correos al día; con el día agotado nadie puede activar ni desactivar, D4 = A).
- Medir el cupo de ingresos por IP de Supabase en producción (`sign_in_sign_ups`).
- Proveedor de correo de producción listo (sin el aviso nadie puede desactivar).
- Las demás listas «Antes del piloto» de `CLAUDE.md` (H-004a, H-118, plantilla de recuperación, `CRON_SECRET`) siguen vigentes.

## De H-116 (registro seguro), etapas 1 a 3 (2026-11-24 y 2026-11-25)

Sin trabajo ahora; se cierran con la lista antes del primer cliente real. Lo que H-116 SÍ cierra (el ataque de «registro previo con el correo de otra persona», con el registro público de Supabase apagado, la pasarela del servidor y las barreras de la base) está en `docs/arquitectura/h-116-registro-seguro.md`.

- **H-116-1 (pase de una sesión cerrada):** `app.session_alive()` cierra en la base todo lo que toca una organización (`app.current_tenant_id()`, `app.my_tenant_ids()`, `profiles_update`, `profiles_select`, `members_select`, las seis funciones del registro). Un pase de una sesión ya cerrada **todavía puede**, hasta que vence (15 minutos): leer `public.my_last_tenant_id()` (el id de la última organización usada), leer sus propias aceptaciones de términos (`legal_acceptances_select`) y llamar `accept_current_legal_documents()` sobre su propia cuenta. Ninguna da datos de una organización. Cierre: agregar `app.session_alive()` a esas tres, si Aarón lo quiere.
- **H-116-2 (puertas de correos no pedidos):** `/otp` (enlace mágico), `/recover`, `/resend` y `PUT /auth/v1/user` siguen abiertos con la llave pública de Supabase y permiten mandar correos a un tercero. Con el disparador puesto, `PUT /auth/v1/user { email }` falla pero GoTrue **sí alcanza a enviar los dos avisos** antes de fallar (medido en la etapa 1 y comprobado en `e2e/account-prehijack.spec.ts`); esos avisos son la plantilla «El cambio de correo no está disponible», **sin ningún enlace**. La plantilla de `magic_link` no se tocó (no es parte del registro). Acotado por los límites de Supabase; la molestia no es un ataque. Cierre posible: SMTP propio con límite por destinatario, o un proxy delante de Supabase.
- **H-116-3 (tope por IP en «Continuar»):** `confirmEmailLinkAction` no tiene un tope propio por IP. Lo cubren el código de 10 caracteres (`otp_length = 10`) y el límite de verificaciones de GoTrue (`token_verifications`, 30 cada 5 minutos por IP). Sumar un tope propio si se ve abuso.
- **H-116-4 (el tope por correo permite molestar):** un tercero que pida 3 enlaces para el correo de otra persona (3 por hora y 1 por minuto) la deja sin poder pedir el suyo durante esa hora (verá «Demasiados intentos»). Lo acota el tope por IP del atacante (10) y la prueba anti-robot; es el mismo patrón de «Olvidé mi contraseña». No toca la cuenta de nadie. Cierre posible: un tope que no cuente los pedidos de otras IP, o un enlace de «no fui yo».
- **H-116-5 (quien confirmó y no terminó):** por la decisión A2, `/registro` no reenvía el enlace a una cuenta con el correo ya verificado; su camino es «¿Olvidaste tu contraseña?», que la lleva a `/crear-cuenta` (probado). Si Aarón prefiere que `/registro` también le reenvíe el enlace, revelaría que existe una cuenta sin terminar para ese correo.
- **H-116-6 (cuentas sin verificar o sin terminar):** quedan en `auth.users` con solo el correo (ya no con nombre ni consentimiento escritos por un tercero). La limpieza (propuesta: 7 días sin verificar; 30 verificadas sin terminar) es la historia aparte J3, que depende de la decisión nº 17 (tareas programadas). Antes del piloto: cero cuentas sin verificar (consulta a mano, §5 punto 15).
- **H-116-7 (`signup-open-guard`):** solo se comprueba al mostrar o enviar `/registro` (lectura guardada 5 minutos por proceso); no hay una comprobación en segundo plano ni al arrancar. Bloquear nuestro formulario **no frena el ataque** (va directo a `POST /auth/v1/signup`): lo que defiende es el registro apagado en Supabase y la base. Lo vigila de verdad `npm run check:auth-config`, que lo corre quien opera el proyecto.
- **H-116-8 (`check:auth-config`):** los nombres de los campos de la API de gestión salen de la documentación de Supabase y **no se contrastaron con un proyecto real** (todavía no hay producción). Un campo que cambie de nombre deja la regla «sin dato» y el guion falla (nunca la aprueba). La primera corrida real puede pedir ajustar nombres en `src/lib/auth/auth-config-rules.ts`.
- **H-116-9 (concurrencia):** dos «Crear mi cuenta» a la vez (doble clic en dos pestañas) tienen un candado por cuenta (`pg_advisory_xact_lock`) pero no hay una prueba con dos conexiones reales.
- **H-116-10 (variantes que dependen del Supabase alojado):** que una función `security definer` pueda leer `auth.sessions` y `auth.mfa_factors`, y que se permita el disparador `before update` en `auth.users`, no se pudo verificar en local (§8 puntos 8 y 9). Si el alojado no lo permite, la segunda barrera (correo de alta) sigue en pie, pero el disparador no.
