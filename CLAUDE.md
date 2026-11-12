# Cotiza Prime

## En una frase

**Cotiza Prime** es una plataforma web donde cada empresa crea su organización para cotizar con su
marca, sus precios y sus reglas, y seguir cada cotización hasta que se paga.

- **Objetivo:** que una pyme chilena pase de cotizar a mano y sin control a enviar cotizaciones
  profesionales en minutos, aprobadas por quien corresponde y con seguimiento hasta el pago.
- **Para quién:** pymes chilenas con más de una persona vendiendo; primer rubro especializado: logística.
- **Cómo se muestra:** profesional, confiable y simple. Hacia el cliente final manda la marca de cada
  empresa; hacia quien la usa, español de Chile y sin jerga técnica.
- **Qué no es:** no factura, no procesa pagos, no es CRM ni sistema de operación logística.

La ficha completa está al inicio de `docs/PROYECTO.md` ("Cotiza Prime en una página"), y el orden
de construcción en su sección 15.

## Documentos que mandan en este proyecto

@docs/00-base/STACK.md
@docs/00-base/SEGURIDAD.md
@docs/00-base/LEGAL.md
@docs/00-base/PROCESO.md
@docs/PROYECTO.md
@docs/DISENO.md

## Precedencia

`PROYECTO.md` puede ser **más exigente** que la base. Nunca menos. Relajar un control
de la base exige una decisión registrada en `docs/decisiones/`.

## Estado

**Fase 4 — Desarrollo.** Plan, historias y sprint 1 aprobados (Compuerta 3 cruzada el
2026-10-01). Forma de trabajo: decisión 013. Las decisiones están en `docs/decisiones/`.

## Para retomar (actualizado 2026-10-01)

Al abrir una sesión nueva, **parte por aquí**.

**Sprint 1 — ✅ cerrado el 2026-10-01** (Aarón lo probó en pantalla; cierre en `docs/sprints/001-base-segura.md`).
Las 10 historias están integradas en `main`, revisadas por Opus (H-012 por separado) y con los
hallazgos corregidos. Pruebas: `npm test`, `test:db`, `test:isolation` (504 ataques entre
organizaciones), `test:db:rollbacks`, `test:e2e`; todo en verde local y en GitHub Actions.

- **Base:** Next.js 16 + Supabase local en Docker (puertos **56320–56329**). 47 migraciones. Datos de
  prueba: `npm run db:seed` (`ana`, `beto`, `mixta`, `ex` `@ejemplo.test`, contraseña
  `Prueba-Cotiza-2026`; Negocio Demo 1 y 2). Cómo levantarlo: `README.md`.
- **Documentos de arquitectura:** `docs/arquitectura/modelo-datos.md` (aprobado) y
  `docs/arquitectura/h-012-aislamiento.md` (plan y registro de cierre).
- **Diseño:** `docs/DISENO.md` v1.0 aprobado. **Decisión 014:** licencias de `sharp` y `caniuse-lite`.
- **Historia nueva H-114** (IP de auditoría falsificable), en el sprint 6, antes del piloto.

**En curso: sprint 2** → `docs/sprints/002-primera-cotizacion-pdf.md` (orden de construcción y decisiones:
la plantilla 1 del PDF la propone la sesión principal con vista previa; PDF con `@react-pdf/renderer`).

### Traspaso del 2026-11-11 — lo más reciente (léelo antes que el del 2026-11-06)

**`main` está en el PR #44 (H-004a, mezclado el 2026-11-12). No hay PR abiertos.** 51 migraciones; la última es
`20261112100000_mfa_session_gate`. Desde el traspaso del 2026-11-06 entraron los PR #31 a #38 (#31, #32 y #34 por José bajo
la decisión 020 §5; #33, #35, #36, #37 y #38 por Aarón):
- **#33/#35/#37 (H-010):** al cancelar a un miembro se cancelan también las invitaciones que reenvió; el miembro queda a nombre de
  quien envió el enlace; `members.invitation_created_by` (FK a `auth.users`, legible por cualquier miembro activo).
- **#36/#38:** el intento de aceptar una invitación ajena, hecho desde fuera de la organización, queda **sin autor** en la auditoría de
  esa organización; la copia completa va a la organización «plataforma». Quien **fue** miembro conserva su id, pero su IP, navegador y
  correlación solo se guardan si hoy está `active`.
- **Guardia 15** (`modelo-datos.md` §9.1 y §9.4): toda migración y todo deshacer desde `20261109120000` empieza con
  `set local lock_timeout = '3s'`; desde `20261109130000` también traen justo después un `do $$ … current_setting('lock_timeout') <> '3s' …`
  que lo verifica. La CLI de Supabase sí respeta el `set local`; `psql -f` necesita `-1`.
- **`tests/isolation/tables-read.test.ts`** (aprobado por Aarón): calcula la visibilidad al momento de leer y quita del texto el nombre exacto de
  las personas visibles antes de buscar el canario de otra organización (causa real del rojo «CANARIO-C»).
- **Decisión 15 resuelta por Aarón:** la regla de aprobación es **por organización** y aplica a todos los que envían, incluido el
  Dueño y el Administrador; la excepción por persona viene después.

**Verde local sobre el #38 (Aarón, sin CI):** 2.183 unitarias, `test:db` 1.075, `test:isolation` 1.204 (3 pendientes), `test:db:rollbacks`
OK. **No se corrió e2e.** Falta una corrida completa limpia de `chromium` con `E2E_PROD=1` en una máquina libre (no afirmar
«149/149» sin ella).

**H-040 — mezclado (PR #40, 2026-11-11).** Tabla `approval_rules`, función de decisión (SQL y TypeScript), pantalla
Configuración → Aprobaciones y control al enviar. Migraciones `20261110110000`, `20261110120000` y `20261111100000` (esta última, la rebaja de
precio). Diseño y riesgos: `docs/arquitectura/sprint-5-h-040-aprobaciones.md` (§12). **Decisiones de Aarón (2026-11-11):**
1. La regla por descuento **también cuenta la rebaja contra el precio de catálogo** (no se espera a H-041), en el servidor (`send-block`) y en la
   puerta de envío de la base. **Ajuste de José tras las revisiones Opus (Aarón debe confirmarlo):** el catálogo de referencia es el **menor entre el
   precio guardado en la línea y el precio de hoy del servicio**, para que una baja del catálogo no bloquee la venta. Solo se calcula cuando la regla
   mira el descuento.
2. **Hueco que queda (Aarón debe aceptarlo con este alcance):** escribir el servicio a mano como línea libre con precio menor, **agregar un servicio
   más barato del catálogo y cambiarle el nombre al de uno caro**, o bajar la cantidad. H-042 no lo cubre (D2: ordena, no controla); lo cerraría H-041
   (pregunta 18) fijando también el nombre de las líneas de catálogo.
3. Un Administrador cambia la regla sin aviso al Dueño: **aceptado hasta H-047** (queda en el registro de actividad y en `quote_packages.approval_rule_id`).
4. Todo miembro lee la regla y el Comercial ve el umbral en `/enviar`: está bien.
5. Bloqueo largo de la migración 2 sobre `quote_packages`: aceptado (se aplica sobre la base vacía).
- **Estado (2026-11-11):** mezclado en `main` **por decisión de José (agencia), sin revisión previa de Aarón**, con las revisiones Opus normal y
  adversarial hechas (sin bloqueantes) y las correcciones aplicadas. José vio la pantalla en local: con la regla «descuento sobre 10 %», bajar el precio de
  una línea de $6.500 a $3.000 bloquea el envío (53,85 %, «incluye $3.500 por precios más bajos que los del catálogo») y devolver el precio lo desbloquea.
  Verde local tras traer `main`: lint y tipos limpios, 2.321 unitarias (1 omitida), `test:db` 1.206, `test:isolation` 1.257 (3 pendientes),
  `test:db:rollbacks` OK; **sin e2e `chromium` completo ni CI**. **A Aarón le queda confirmar** el ajuste del punto 1 (menor entre catálogo guardado y de
  hoy) y aceptar el hueco del punto 2. Con la regla en «Siempre», un monto o un descuento, lo que la cumpla **no se puede enviar hasta el sprint 6**
  («Solicitar aprobación»), tampoco las cotizaciones del Dueño.
- **Menores del #38: mezclados (PR #41, 2026-11-11, también por decisión de José).**
- **Mejora de uso anotada (sin historia aún):** el editor de cotizaciones no avisa que bajar el precio de una línea bajo el de catálogo cuenta como
  descuento, ni por qué el campo «Monto del descuento» está deshabilitado con «Sin descuento» (hay que elegir el tipo primero).

**H-004a (verificación en dos pasos): mezclada el 2026-11-12 (PR #44) por decisión de José (agencia), SIN revisión de Aarón** (decisión 020: historia delicada; Aarón debe revisarla después). Con la base también exigiendo el segundo
paso (D1 = B de Aarón) y sin H-004b (D2). Pasó revisión Opus normal y adversarial (ronda 1) y una ronda 2 sobre los cambios, sin bloqueantes. **Verde local sobre el código mezclado:** lint, tipos y formato limpios; 2.449 unitarias (1 omitida); `test:db` 1.247; `test:isolation` 1.267 (3 pendientes); e2e `chromium` 171 de 171 y `isolation` 48 de 48 (app compilada, `--workers=1`); `test:db:rollbacks` OK (sobre la ronda 1; la ronda 2 no tocó migraciones). José la probó en escritorio con una app de códigos en iPhone; el móvil emulado (390 px, claro y oscuro) se revisó en capturas. **NO probado: el ingreso con código en un iPhone real, Firefox, Safari ni lector de pantalla.** Migración `20261112100000_mfa_session_gate` (**51 archivos
en `supabase/migrations/` con ésta**; las cuentas de «42 migraciones» de los traspasos de abajo estaban desactualizadas). Como todavía no está en `main`, las
correcciones de la ronda 1 se editaron EN la misma migración (no hay otra). Cómo probarla: `README.md`, «Probar la verificación en dos pasos». Detalle, lo comprobado de
Supabase Auth y los riesgos: `docs/arquitectura/sprint-5-equipo-y-permisos.md`, «Registro de construcción — H-004a». Cerrado en la ronda 1: con la contraseña sola
tampoco se puede crear una organización, ni ver o aceptar invitaciones, ni aceptar términos, ni leer o cambiar el perfil (funciones y políticas con
`app.second_step_pending()`; una guardia vigila que no aparezca otra), y los contadores de intentos del camino de recuperación por correo son aparte de los del ingreso.
- **Antes del piloto, nuevo por H-004a:** en el proyecto de Supabase de producción, el segundo paso por aplicación de códigos (TOTP) debe estar ACTIVO, el aviso «MFA agregado» (`mfa_factor_enrolled`) configurado y en español, y hay que **medir el cupo de verificaciones de Supabase Auth** (todas salen de la IP del servidor). **Apagar en el panel de Supabase de producción los factores por teléfono y WebAuthn**: la base cuenta CUALQUIER factor verificado, pero la aplicación solo maneja TOTP (una cuenta con otro tipo de factor quedaría sin forma de pasar). **Definir, con la decisión pendiente 8 (quién responde un incidente), el procedimiento para verificar la identidad de la persona ANTES de que soporte le quite un factor** (si no, quitar el segundo paso es la puerta de atrás). **Riesgo conocido (decisión 021, Aarón 2026-11-12): opción C para el piloto** (riesgo aceptado por escrito: con la contraseña se pueden probar códigos directo contra Supabase, que no limita los incorrectos; no se paga el plan Team) **y opción B antes del lanzamiento público** (historia H-117). **Prioritario antes del piloto: H-118** (diseño: `docs/arquitectura/h-118-anular-activacion.md`; decidido por José el 2026-11-12: enlace de 72 h, se cierra en la base la activación directa por la API, si el correo no sale se revierte, tras anular un segundo correo de recuperación), enlace de un solo uso en el correo de aviso para anular una activación que la persona no hizo (quien conoce la contraseña de una cuenta sin segundo paso puede activar el suyo y dejar fuera al dueño). Mientras no exista, vale el procedimiento de soporte de la decisión 021: la solicitud llega desde el correo registrado, la confirma el Dueño, 24 horas de espera con aviso al correo de la cuenta, y durante el piloto lo hace solo Aarón. Incidentes: responde Aarón, días hábiles de 9 a 19 h. Al crear el proyecto de Supabase de producción, en la misma lista que Confirm email y Secure email change de H-009: apagar factores por teléfono y WebAuthn, medir el cupo de verificaciones y dejar listo el proveedor de correo (el aviso del segundo paso lo enviará nuestro servidor con H-118; el de Supabase se apaga).

**Decisiones de Aarón del 2026-11-12** (comentarios del #44 y del #11): **021 = C para el piloto y B antes del lanzamiento** (no se paga Team); decisión pendiente **8**
resuelta (responde Aarón, hábiles de 9 a 19 h); **CI**: endurecer a `--audit-level=high` y marcar la 015 como superada; **`AGENTS.md`**: versionar el que genera Next y dejar en
`CLAUDE.md` solo `@AGENTS.md`; **decisión #17**: ruta HTTP protegida con un secreto, llamada por el programador de tareas del hosting (antes del piloto; falta construirla);
`npm audit` (34 moderados): sin acción; **H-116**: A1 sí, A2 sí, A3 Resend con su plan gratuito para el piloto, A4 Turnstile, A5 no hace falta lista de correos, A6 los textos los propone
José y Aarón los ve en pantalla antes de mezclar; **H-042, D10**: ya estaba fijada el 2026-11-05 (sale de pendientes); **frase de privacidad del #36**: aprobada, pero no se publica sola:
va en la próxima versión legal, antes del piloto, junto con el aviso de privacidad al cliente final (H-030, menor 9) y después del abogado (decisión pendiente 9).

**Pendientes:**
- **Seguimientos del segundo paso (Aarón, 2026-11-12), en este orden:** H-118 (enlace para anular la activación; antes del piloto) → pedir la contraseña de nuevo antes
  de activar (H-004b) → «Cambiar contraseña» dentro de una sesión completa → leer `auth.sessions.aal` → espera creciente en lugar del bloqueo de 24 h (con la opción B,
  H-117) → correo de aviso cuando la contraseña es correcta y el código falla (decisión 016). **9 menores de la revisión de Aarón al #44** (en su último comentario) van en un PR aparte.
- Orden siguiente: H-004b → H-041 → H-042 / H-048b → H-116 (después de H-004a/b: ambas tocan el ingreso) → H-004c. **H-117** (hook del segundo paso, decisión 021) se construye antes del lanzamiento; Aarón decide cuándo.
- La frase de la política de privacidad del #36 (aprobada por Aarón el 2026-11-12) va en la próxima versión legal con el abogado (editar `privacy.md` cambia su huella y exige versión nueva en
  `legal_documents`). Del issue #11, ya decidido por Aarón (arriba) y por implementar: CI a `--audit-level=high` y 015 superada, `AGENTS.md` versionado, ruta de la decisión #17. El CI sigue apagado.
- Anotado fuera de alcance: el Dueño ve `audit_log.id` en `select=*`; la secuencia es común a todas las organizaciones y deja ver
  cuánta actividad hay. Se cierra con un permiso de lectura por columna, si se quiere.

### Traspaso del 2026-11-06 — histórico (lo del 2026-11-11 lo actualiza; léelo antes que el del 2026-11-04)

**Repositorio nuevo:** `github.com/mainbrain-cl/cotiza-prime` (organización de Main Brain, privado). La dirección
antigua `avronygg/cotiza-prime` solo redirige: no se usa más. Quien tenga una copia vieja corre una vez
`git remote set-url origin https://github.com/mainbrain-cl/cotiza-prime.git`.

**`main` está en `a83cd42` (PR #28) y no hay PR abiertos.** Entraron los PR #25 a #29, revisados y corregidos por Aarón:
- **#29** arregla el CI en rojo: dos e2e de formularios dependían de la semilla, que el CI no carga; ahora crean sus
  propios usuarios y organizaciones (`prepareOrgForForms` en `e2e/intake-support.ts`).
- **#25** diseño de **H-116** (registro seguro, `docs/arquitectura/h-116-registro-seguro.md`): registro en dos pasos y
  cambio de correo bloqueado hasta H-109.
- **#26** diseño de **H-042** (servicios por comercial, `docs/arquitectura/h-042-servicios-por-comercial.md`): el límite
  **ordena** la lista del comercial pero no controla lo que vende (D2); dos tablas (D13).
- **#27** H-009: la vista previa de una invitación es de solo lectura. A quien no es el invitado le responde
  `wrong_email` y todas las rutas tardan lo mismo, para no revelar el estado de la invitación.
- **#28** **H-010** (cambiar el rol de un miembro o quitarlo). Revisión importante: un Administrador podía meter a un
  cómplice como Administrador sin que el Dueño se enterara; ahora **solo el Dueño** da, cambia, quita, invita o reenvía
  roles con `team.manage`. Además: tope de 30 cambios de equipo por hora para quien no es Dueño
  (`app.member_change_max_per_hour()`) y helper `app.current_tenant_people()`. 42 migraciones.

**Verde local de #28 (informado por Aarón):** `test:db` 999, `test:isolation` 1.201, e2e `chromium` 149, e2e `isolation`
19, rollbacks OK y 2.160 unitarias. **Nada está en producción:** todo corre en local.

**El CI está apagado** (cuota gratuita de minutos de la organización casi agotada; no es lo mismo que el problema de
facturación anotado antes). Lo enciende Aarón y avisa; quizá pronto con pago, o hacia el 2026-12-01 cuando se reinicie la
cuota. **No reactivar Actions ni cambiar los workflows para esquivarlo.** Mientras tanto, antes de abrir o actualizar un
PR se corre en local lo que toca el cambio; si toca base de datos, permisos o RLS, la suite completa (`lint`,
`typecheck`, `test`, `test:db`, `test:isolation`, `test:e2e`) y, con migraciones, `test:db:rollbacks` (vacía la base
local: después `supabase db reset` y `npm run db:seed`). **La descripción del PR dice qué se corrió y el resultado.**

**Reglas vigentes:**
- Cada migración nueva lleva fecha posterior a la última en `main`, su rollback al día en `supabase/rollbacks/`, y las
  funciones `SECURITY DEFINER` usan `set search_path = ''` y nombres completos (`public.tabla`, `app.funcion`).
- `team.manage`: Dueño y Administrador. `tenant.transfer`: solo el Dueño. Cualquier acción que dé o quite poder de
  Administrador queda reservada al Dueño.
- Una rama por tarea, PR contra `main`, integración con merge commit. Todo PR se revisa; lo de seguridad, permisos o datos
  lleva además revisión adversarial.
- Si una decisión cambia el alcance de una historia, se anota en `docs/arquitectura/` como «decisión por defecto aplicada».

**Pendientes conocidos:**
- `e2e/intake-convert.spec.ts:206` falló 1 de 9 veces en el CI (no se sabe si es la prueba o la app).
- **Riesgo aceptado y documentado:** dentro del tope de 30 por hora, un Administrador puede quitar o bajar a quien no es
  Administrador, o cambiar precios y datos bancarios, sin que el Dueño reciba un correo; solo queda en el registro de
  actividad. Se cierra con los correos de aviso (decisión nº 17 y proveedor de correo, decisión 016).
- ~~La decisión 15 (quién envía sin aprobación) sigue sin resolverse~~ **Resuelta** (ver el traspaso del 2026-11-10): H-040 ya se puede construir.
- Las historias que ya tienen diseño aprobado son H-116 y H-042; cuál se construye primero lo decide José.
- **Antes de la primera ida a producción:** toda migración y todo deshacer desde `20261109120000` empieza con `set local lock_timeout = '3s'` (guardia 15), y las migraciones anteriores que toman bloqueos fuertes se aplican sobre la base vacía antes de abrir el tráfico o en una ventana tranquila con `lock_timeout` desde la conexión: lista y forma en `docs/arquitectura/modelo-datos.md` §9.4.

### Traspaso del 2026-11-04 — histórico (lo del 2026-11-06 lo actualiza)

**Quedó en `main` (`42a1fff`):** PR #19, #21, #20 (H-009), #22 y #23 (H-048a), en ese orden, por pedido de Aarón.
No hay PR abiertos. Ya se puede invitar y aceptar de punta a punta, y existe Configuración → «Textos listos».

**Cómo se mezcló, para no repetir el trabajo:**
- **#20 entró antes que #22**, no después como sugería José: su migración tiene fecha anterior y la regla pide que
  cada una sea posterior a la última integrada.
- **#23 se cambió de base a `main`** antes de mezclarlo. Sin eso habría quedado en la rama de #22.
- **Se subieron commits de mezcla a las ramas de José** `feat/h-048a-textos-base` y `feat/h-048a-textos-pantallas`
  para juntar `registry.ts`, `labels.ts` y `sprint-5-h-048-textos.md`. Los tres choques eran solo adiciones y quedaron
  ambos lados. Quien tenga esas ramas abiertas debe partir de `main`.

**Verificado en local, con los cinco juntos:** tipos, lint y formato limpios; 2.050 unitarias (1 omitida), 907 de base
de datos, 1.188 de aislamiento (3 pendientes), e2e `chromium` 141 de 141 y `isolation` 19 de 19, ambos con
`E2E_PROD=1`. En `main` ya mezclado solo se repitieron tipos, formato, unitarias y las guardias de aislamiento: quedó
igual salvo el orden de unas líneas. Ahí `guards.test.ts` y `render.test.tsx` fallaron por tiempo con la máquina
cargada y pasaron al correrlas solas.

**Lo que NO se hizo:**
- **Sin CI** (facturación de GitHub) y sin `test:db:rollbacks` sobre el conjunto (vacía la base local; José lo pasó
  en la rama de #23, sin H-009).
- **Aarón no lo probó en pantalla.** Mezcló #20 (delicado) por pedido expreso, sin revisarlo él. Lo revisó el agente
  `revisor` en las rondas que cuenta cada PR; aquí se leyó la migración de H-009, no todo el código de los PR.
- **La regla cero de Aarón (2026-11-03) pide CI verde y revisión adversarial aparte de lo delicado antes de integrar.**
  El CI no corre, y para esta tanda no se lanzó una revisión adversarial nueva.
- Firefox, lector de pantalla e iPhone real, sin probar.

**Antes del piloto, nuevo por H-009:** en el proyecto de Supabase de producción, Confirm email ON, Secure email change
ON y sin proveedores externos ni ingreso anónimo. Si no, la regla «solo con el mismo correo» no vale. Además, el
código de la invitación viaja en la URL antes de la redirección y puede quedar en registros de acceso.

**Qué sigue:** **H-010** (cambiar el rol o quitar a un miembro; ya no está bloqueada) → H-011b → H-004a/b → H-041 →
H-048b → H-004c. Tras aceptar, nadie ve al nuevo miembro en «Tu equipo» hasta H-010. H-040 se puede construir, pero
no mezclar hasta la decisión 15.

**Le toca a Aarón:** decisión 15 (quién envía sin aprobación; supuesto: la regla aplica a todos los que envían, con
excepción por persona más adelante), facturación de GitHub, y las opciones del issue #11 (decisión 015 y CI,
`AGENTS.md`, decisión #17). Probar en pantalla: `npm run dev`, `ana@ejemplo.test`, «Equipo» y «Configuración → Textos
listos»; los correos llegan a http://127.0.0.1:56324. Si los textos de ejemplo no aparecen, correr `npm run db:seed`.

**Ojo con dos cosas de esta máquina:** al caerse VS Code, las pruebas en segundo plano pueden seguir vivas y ocupar
el puerto 3100 (mirar antes de reintentar). Y el 2026-11-04 había otra app en `C:\dev\wt\lote` con `next start -p 3000`;
no es de esta tanda y no se tocó, pero si usa la misma base puede cargar la máquina o ensuciar las pruebas.

### Estado al 2026-11-04 — empezar por aquí (traspaso a José)

**Lee primero `docs/TRASPASO.md`**: es la guía para ponerse al día (cómo levantarlo, qué leer, dónde
quedó todo, trampas, qué decide Aarón y cómo trabaja). Este bloque es solo el resumen.

**Dónde está:** 38 historias construidas de 92 (el total es anterior a partir H-004 y H-048; `HISTORIAS.md` tiene hoy 97 fichas: falta recontar). Sprint 1 cerrado; sprint 2 construido (falta que
Aarón lo pruebe y apruebe la plantilla 1); sprint 3 con 8 de 9 (falta **H-076**, las tres plantillas de
PDF con selector, que espera la aprobación del diseño de las plantillas 2 y 3); **sprint 4 completo**
(H-092 construida y en `main`). **Sprint 5 (equipo y permisos) confirmado por José el 2026-10-28**
(Compuerta 3) y en construcción: **H-011a (matriz única de permisos) en `main` desde el 2026-10-29**
(PR #12), **H-008 (invitar, PR #15)**, **H-009 (aceptar, PR #20)** y **H-048a (textos listos, PR #22 y #23)**; siguen
H-010 y H-011b (H-010 entró el 2026-11-06, PR #28). Documentos: `docs/sprints/005-equipo-y-permisos.md` y
`docs/arquitectura/sprint-5-equipo-y-permisos.md`. Sprints 6 a 12 sin partir. 40 migraciones. Pruebas (2026-11-04, local): 2.050 unitarias (1 omitida), 907 de base de
datos, 1.188 de aislamiento (3 pendientes), e2e `isolation` 19 de 19 y e2e `chromium` 141 de 141 con la app compilada.
`test:db:rollbacks` no se corrió sobre el conjunto (vacía la base local).

**Lo que ya funciona (en local):** registro y organizaciones, catálogo y clientes, cotizador con PDF,
enviar por correo, enlace del cliente (aceptar o rechazar con motivo obligatorio), rebotes, vencimiento,
revocar enlace, registro de actividad, formulario público (constructor, página pública con anti-robot,
resumen en vivo sin precios, incrustable, QR), solicitudes (asignar, descartar, anonimizar, convertir en
cotización), panel de protección con tope diario (H-092), «Tu equipo» para invitar, reenviar y cancelar (H-008),
aceptar una invitación (H-009) y «Textos listos» en Configuración (H-048a; todavía no se usan al cotizar, eso es
H-048b). Menú flotante vertical, tarjetas, contadores y
fondos animados (React Bits, decisión 018).

**Mezclas del 2026-10-28.** Por orden explícita de José y **sin revisión de Aarón** se mezclaron en `main`
los PR #2 (Next 16.4.3, zod 4.6.7, shadcn 4.23.0), #8 (quita el paquete `shadcn`; reemplaza al #3, que
GitHub cerró solo al borrarse su rama base), #1 (H-092), #6 (menores de H-092), #4 (guía de orientación) y
#5 (diseño del sprint 5). Los de código pasaron por el agente `revisor` (Opus). **Desde ahora el trabajo va
por ramas y PR: nada directo a `main`.** La rama remota `wip/h-092-bloqueos-y-tope` ya no hace falta, pero
sigue ahí: se puede borrar cuando José lo ordene.

**Decisión 020** (en `main`): quién decide mientras Aarón no esté disponible. Aprobada por José el
2026-10-28 y **ratificada por Aarón el 2026-10-29**; plazo de aviso 24 h. José decide lo corriente; Aarón
sigue decidiendo producto, dinero, proveedores y lo que ve el cliente final; y lo delicado (permisos,
aislamiento entre organizaciones, dinero, superficie pública) **no se mezcla sin Aarón**.

**El CI de GitHub no corre** (hasta el 2026-11-04, por la facturación de la cuenta: las corridas fallaban en 2 s con
«recent account payments have failed…»; desde el 2026-11-06 está apagado por la cuota de minutos, ver arriba). Mientras
tanto se verifica todo en local y,
**en cada integración grande, se corre la suite completa de punta a punta** (`E2E_PROD=1 npx playwright
test --project=chromium` y `npx playwright test --project=isolation`), no solo las pruebas de la zona
tocada. **El `chromium` se corre con `E2E_PROD=1`** (app compilada, unos 8 minutos): con el servidor de
desarrollo cada pantalla se compila al abrirla y supera la espera de 5 s de las pruebas, y fallan 5 o más
pruebas distintas en cada corrida (2026-10-30: 91 de 112 con el servidor de desarrollo, 111 de 112 compilada).

**Mezclas del 2026-10-29.** Aarón revisó y mezcló los PR #7 (decisión 020), #9 (estado al día, `sharp`
declarado), #10 (menores de H-092) y #12 (H-011a). Verificado en local con los cuatro juntos: 1.593
unitarias, 665 de base de datos, 1.063 de aislamiento, e2e `isolation` 18 de 18 y `chromium` con fallas
inestables que pasan al repetirse. La única que se repite, `intake-embed.spec.ts:506` (incrustado a 375 px),
falla igual en `main` sin los PR (sospecha: tope diario del formulario de prueba, sin confirmar). Además,
`src/lib/permissions/guards.test.ts` a veces pasa el límite de 5 s con la máquina cargada.

**Aclaración del 2026-10-30.** Esas fallas «inestables» eran en su mayoría el servidor de desarrollo (ver
arriba). Con la app compilada queda 1 de 112: un salto de redirección del ingreso que una vez pasó los 5 s
(`intake-form-builder.spec.ts:136`, pasa 3 de 3 sola); `intake-embed.spec.ts:506` no falló. La del botón
«Guardando…» de `intake-protection.spec.ts` era un error real (el campo del tope diario pisaba lo que se
escribía mientras se guardaba) y se corrigió en el PR #14.

**Mezclas del 2026-11-02.** Aarón pidió mezclar los PR #15 (H-008), #16 (diseños de H-040 y H-048, sin
construir) y #17 (tope diario privado). Se probaron juntos antes de mezclar, con las cifras de arriba; sin CI y
sin prueba en pantalla. Se leyeron las migraciones y el código más delicado, no todo el PR #15.

**Decisiones de Aarón pendientes** (el código aplica un supuesto): quién puede enviar sin aprobación (nº 15 de
`PROYECTO.md` §16.2) y cómo se programa la tarea de avisos al Dueño (nº 17); aprobar las plantillas de PDF; regla de
enlaces ya respondidos (rechazada: tras la vigencia solo aviso; aceptada: activo hasta pagada más un plazo);
proveedor y dominio de correo (decisión 016, propuesta Resend); anti-robot real (decisión 019, propuesta
Turnstile o ALTCHA; antes de correos reales, además, que un nombre de organización con una dirección web no se
vuelva enlace en la invitación); dominio y marca; facturación de GitHub; antes del piloto, abogado, datos de Main Brain
para los términos (29 marcadores), custodia de claves de cifrado y quién responde un incidente.

**Qué sigue** (H-010 ya está en `main` desde el 2026-11-06): terminar el sprint 5 (H-011b y el resto de su lista) → revisión grande de Aarón (decirle qué está listo, el link
`http://localhost:3000` y los accesos) → 6 aprobación y datos de pago → 7 cobro → piloto privado. Estimación: unas 2 a 3 semanas hasta el piloto y 4 a 6 hasta el lanzamiento.

**Cómo se prueba en pantalla:** `npm run dev` → http://localhost:3000 (Docker abierto y `npx supabase
start`). Usuarios `ana`, `carla` (Comercial), `beto`, `mixta`, `ex` `@ejemplo.test`, contraseña
`Prueba-Cotiza-2026` (Negocio Demo 1 y 2). Correos de prueba: http://127.0.0.1:56324. En `.env.local` hacen
falta también `INTAKE_RENDER_SECRET` (32+ caracteres), `ANTIBOT_PROVIDER=memory` y `ANTIBOT_ALLOW_MEMORY=1`
(solo desarrollo). `db reset` y `test:db:rollbacks` vacían la base local: después, `npm run db:seed`.

**Aarón pidió:** que se avance solo y se integre a `main` (desde el 2026-10-28, por rama y PR); él revisa **en un bloque grande**, no historia por
historia. Mirar el CI tras cada subida cuando esté encendido (hoy está apagado: ver el traspaso del 2026-11-06).

**Trampas de Windows:** `npm install` puede borrar de `package-lock.json` las entradas
`node_modules/@emnapi/core` y `@emnapi/runtime` (`npm run lint` lo comprueba). Nunca enlazar `node_modules`
de una copia con un acceso directo a otra carpeta. Playwright no corre con `npm run dev` abierto en la misma
carpeta. Si Supabase no arranca con «ports are not available» o queda sin puertos publicados, Windows reservó
el rango (`netsh interface ipv4 show excludedportrange protocol=tcp`): `net stop winnat` y `net start winnat`
como administrador, y de nuevo `npx supabase start` (pasó el 2026-10-30; no borra datos).

**Repositorio:** `github.com/mainbrain-cl/cotiza-prime` (antes `avronygg/cotiza-prime`, que redirige), privado, rama `main`.

## Cómo se trabaja cada historia

Según la decisión 013: la sesión principal coordina y no programa directo. Subagentes con
**Sonnet** construyen, 2 o 3 en paralelo en copias aisladas cuando las historias no se tocan entre
sí; los cambios de base de datos, uno solo y en orden. Las historias 🔒 las diseña antes el
subagente `planificador` (Opus) y nunca van en paralelo. El subagente `revisor` (Opus) revisa cada
🔒 por separado y las chicas en lote. Aarón aprueba el sprint de una vez y prueba cada historia en
pantalla al cerrarla. Antes de tocar la base de datos, declarar el entorno (`/entorno`).

## Recordatorio permanente

- `tenant_id` (UUID, columna propia, ese nombre exacto) en **toda** tabla.
- Direcciones de API con `/api/v1/` desde el inicio.
- Validación del pase de sesión en **un solo archivo**.
- Resolución del cliente (de dónde sale el `tenant_id`) en **un solo punto**.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
