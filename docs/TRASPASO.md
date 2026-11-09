# Cotiza Prime — Traspaso a José

> Escrito el 2026-10-27 por la sesión que venía llevando el proyecto, a pedido de Aarón. Si algo de
> aquí contradice a `CLAUDE.md` o a `docs/PROYECTO.md`, mandan esos dos; este documento es el mapa
> para ponerse al día rápido.

## 1. Qué es esto, en una frase

**Cotiza Prime** es una plataforma web donde cada empresa chilena crea su organización para cotizar
con su marca, sus precios y sus reglas, y seguir cada cotización hasta que se paga. Es un producto
de **Main Brain**; **Aarón** es quien decide qué entra y qué no. Ficha de una página: inicio de
[`PROYECTO.md`](PROYECTO.md).

**Qué no es:** no factura ni se conecta al SII, no procesa pagos (el dinero nunca pasa por la
plataforma), no es un CRM ni un sistema de operación logística.

## 2. Qué necesitas para trabajar (nada de esto son secretos)

| Qué | Cómo |
|---|---|
| **Acceso al repositorio** | `github.com/mainbrain-cl/cotiza-prime` (privado; desde el 2026-11-06, antes `avronygg/cotiza-prime`, que redirige). **Aarón tiene que invitarte** (Settings → Collaborators). Se trabaja desde un `git clone`; **no copies la carpeta de Aarón** (está en OneDrive, que no sincroniza este proyecto, y trae copias de trabajo viejas) |
| **Herramientas** | Node 24, npm 11, Docker Desktop abierto, Git. Claude Code para el flujo con agentes (ver §6) |
| **Variables de entorno** | **No necesitas ningún secreto.** Todo corre en local contra una base ficticia en Docker: `README.md` explica cómo generar tu propio `.env.local` y tus propias claves de cifrado de desarrollo. Las claves de Resend y de Turnstile no hacen falta (en local se usan el correo de pruebas y el verificador de prueba) |
| **Datos** | Solo ficticios. **Nunca datos reales en pruebas** (`LEGAL.md`) |

### Levantarlo (resumen; el detalle está en `README.md`)

1. `npm ci`
2. `npx supabase start` (puertos 56320–56329)
3. Crear `.env.local` desde `.env.example` con `npx supabase status -o env` y generar `CP_PII_KEY_V1` y
   `CP_SEARCH_KEY_V1` como dice el README.
4. Agrega a `.env.local`: `INTAKE_RENDER_SECRET` (cualquier texto aleatorio de 32 o más caracteres),
   `ANTIBOT_PROVIDER=memory` y `ANTIBOT_ALLOW_MEMORY=1` (solo desarrollo y pruebas).
5. `npm run db:seed` y `npm run dev` → http://localhost:3000. Correos de prueba: http://127.0.0.1:56324.

**Usuarios de prueba** (contraseña `Prueba-Cotiza-2026`): `ana@ejemplo.test` (Dueña de Negocio Demo 1),
`carla@ejemplo.test` (Comercial de Negocio Demo 1), `beto@ejemplo.test` (Dueño de Negocio Demo 2),
`mixta@ejemplo.test` (en las dos), `ex@ejemplo.test` (ya no es miembro).

## 3. Qué documentos leer, en orden

1. `CLAUDE.md` — reglas del proyecto y el estado más reciente. **Es lo primero que lee Claude Code.**
2. `docs/PROYECTO.md` — el plan aprobado (§6.0 es el recorrido completo de una cotización).
3. `docs/00-base/` — las reglas de la agencia: `STACK.md`, `SEGURIDAD.md`, `LEGAL.md`, `PROCESO.md`.
4. `docs/DISENO.md` — el sistema de diseño aprobado (colores, tipografía, vidrio, movimiento).
5. `docs/HISTORIAS.md` — las 92 historias de usuario, con criterios de aceptación.
6. `docs/sprints/001-base-segura.md` — la tabla de los 12 sprints.
7. `docs/decisiones/` — 20 decisiones en `main` (la 020, ratificada por Aarón el 2026-10-29). Las 016, 017, 018 y 019 son las recientes.
8. `docs/arquitectura/` — `modelo-datos.md`, y los planes detallados de los sprints 3, 4 y 5.

**Precedencia:** `PROYECTO.md` puede ser más exigente que la base, nunca menos. Relajar un control
de seguridad exige una decisión escrita en `docs/decisiones/`.

## 4. Dónde está el proyecto

Fecha de este traspaso: **2026-10-27** (puesto al día el **2026-11-06**; el detalle está en `CLAUDE.md`, «Traspaso del 2026-11-06»). El último trabajo fue el **2026-10-07** (el proyecto estuvo 20
días sin moverse; no se perdió nada).

| | |
|---|---|
| **Historias construidas** | **38 de 92** (el total es anterior a partir H-004 y H-048; `HISTORIAS.md` tiene hoy 97 fichas: falta recontar) |
| **Sprints** | 1 cerrado · 2 construido (falta que Aarón lo pruebe y apruebe la plantilla 1) · 3 con 8 de 9 · 4 completo (H-092 construida y en `main` desde el 2026-10-28) · **5 (equipo y permisos) confirmado por José el 2026-10-28 y en construcción** (H-011a, H-008, H-009, H-048a y H-010 en `main`; sigue H-011b) · 6 a 12 sin partir |
| **Pruebas, la última vez** | 2026-11-06, local, sobre H-010 (PR #28; cifras informadas por Aarón): 2.160 unitarias · 999 de base de datos · 1.201 de aislamiento entre organizaciones · e2e `chromium` 149 de 149 · e2e `isolation` 19 de 19 · rollbacks OK |
| **Base de datos** | 42 migraciones, cada una con su deshacer |
| **Rama** | `main` estaba limpia en `1085ef1` (2026-10-27). El 2026-10-28 se mezclaron los PR #2, #8, #1, #6, #4 y #5 (ver §5); después, hasta el #28 (`a83cd42`, 2026-11-06). **Desde ahora el trabajo va por ramas y PR: nada directo a `main`** |

### Lo que funciona hoy (en local)

Registro y organizaciones; roles; catálogo y clientes; cotizador con totales e IVA; PDF con la
plantilla 1; **enviar por correo** con vista previa; **enlace del cliente** (ver, descargar el PDF,
aceptar o rechazar con motivo obligatorio); rebotes; vencimiento; revocar enlace; lista con estados;
registro de actividad; **formulario público** (constructor, página pública con anti-robot, límites y
consentimiento, resumen en vivo sin precios, código incrustable, QR); **solicitudes** (lista, asignar,
descartar, anonimizar, convertir en cotización).

### Lo que falta

- **H-076** (sprint 3): las tres plantillas de PDF con selector. Las plantillas 2 y 3 están
  **diseñadas** (`docs/diseno/plantillas-2-y-3-pdf-vista-previa.html`) pero esperan la aprobación de Aarón.
- **Sprints 5 a 12:** equipo y permisos (invitaciones), aprobaciones, cobro y datos de pago, **piloto
  privado**, búsqueda y filtros, modelos de cálculo, margen, onboarding y lanzamiento.
- **Pendientes técnicos anotados:** reconciliar envíos a medias (antes del piloto), agrupar las
  aperturas del enlace por IP y hora, aviso de privacidad al cliente final, historia H-114 (la IP de
  auditoría se puede falsificar), correr el envío en Firefox, y que `/c/[token]` responda 404 y 429 reales.
  Detalle en `docs/arquitectura/sprint-3-envio-y-enlace.md` §12–§13 y `sprint-4-formulario-publico.md` §11–§14.

## 5. Lo que pasó el 2026-10-28

**Mezclas.** Por orden explícita de José y **sin revisión de Aarón** entraron a `main` los PR #2 (Next 16.4.3,
zod 4.6.7, shadcn 4.23.0), #8 (quita el paquete `shadcn`; reemplaza al #3, que GitHub cerró solo al borrarse su
rama base), #1 (H-092), #6 (menores de H-092), #4 (esta guía) y #5 (diseño y borrador del sprint 5). Los de
código pasaron por el agente `revisor` (Opus). Desde ahora, todo por rama y PR.

**H-092 construida y en `main`; sprint 4 completo** (35 de 92 historias, 38 %). El borrador de la rama
`wip/h-092-bloqueos-y-tope` (commit `357560d`) se aprovechó: se verificó entero (tipos, lint, 1.388 unitarias,
`test:db`, `test:isolation` y 130 de punta a punta). La revisión independiente del `revisor` (Opus) se hizo el
2026-10-28 sobre los PR #1 y #6, sin hallazgos graves y con 6 menores (corregidos en el PR #6 los m8 y m10;
el resto en `docs/arquitectura/sprint-4-formulario-publico.md` §15). Contenido: panel de protección (contadores de
hoy, 7 y 30 días; solo Dueño y Administrador), control del tope diario (1 a 200) y aviso de tope alcanzado.

- La rama remota `wip/h-092-bloqueos-y-tope` ya no hace falta, pero **no se ha borrado**: borrable cuando José lo ordene.

**Sprint 5 (equipo y permisos).** Confirmado por José el 2026-10-28 (Compuerta 3; Aarón queda avisado y puede
objetar). En construcción: H-011a (PR #12), H-008 (PR #15), H-009 (PR #20), H-048a (PR #22 y #23) y H-010 (PR #28) en `main`. Sigue
H-011b. Documentos: `docs/sprints/005-equipo-y-permisos.md` y `docs/arquitectura/sprint-5-equipo-y-permisos.md`.

**Decisión 020** (en `main`): aprobada por José el 2026-10-28 y ratificada por Aarón el 2026-10-29; plazo de
aviso 24 h. En corto: qué decide José mientras Aarón no esté; qué sigue siendo de Aarón (producto, dinero,
proveedores, lo que ve el cliente final); y lo delicado (permisos, aislamiento, dinero, superficie pública) no se
mezcla sin Aarón.

## 6. Cómo se ha trabajado (decisión 013) y cómo seguir

El proyecto se ha construido con **Claude Code y subagentes**: la sesión principal coordina; agentes
**Sonnet** construyen, de a 1 o 2 en copias aisladas (`git worktree`); el agente **Opus** diseña lo
delicado antes (`planificador`) y revisa después (`revisor`). Cada historia 🔒 (separación entre
organizaciones, permisos, dinero, superficie pública) se diseña antes y se revisa **por separado**. Las
revisiones de Opus encontraron fallos reales antes de que llegaran a pantalla; **no las saltes**.

Si trabajas de otra forma, no hay problema, pero la decisión 013 tendría que actualizarse.

### Ciclo de cada historia

1. Leer la historia y su plan; si es 🔒, diseñarla antes.
2. Construir con pruebas. Antes de subir, correr **todo**: `npm run typecheck`, `npm run lint`,
   `npm run format:check`, `npm test`, `npm run test:db`, `npm run test:isolation` y las pruebas de
   punta a punta (`E2E_PROD=1 npx playwright test --project=chromium`, con la app compilada, y
   `npx playwright test --project=isolation`). Sin `E2E_PROD=1` el servidor de desarrollo compila cada
   pantalla al abrirla y fallan pruebas distintas en cada corrida.
3. Revisión adversarial de las 🔒.
4. Integrar a `main`, y **mirar el CI** (ver §8).

### Las compuertas de `PROCESO.md` no se cruzan en silencio

No se escribe código sin historias aprobadas, y el contenido de cada sprint lo confirma Aarón. Lo que
cambie el alcance se vuelve historia y entra a la lista; no se agrega a escondidas.

## 7. Reglas que nunca se relajan

- `tenant_id` (UUID, columna propia, ese nombre exacto) en **toda** tabla, con RLS.
- Direcciones de API con `/api/v1/`.
- Validación del pase de sesión en **un solo archivo**; resolución de la organización en **un solo punto**.
- **El navegador nunca habla con la base de datos en las superficies públicas:** pasa por un portero en
  el servidor que solo llama a unas pocas funciones (decisión 017).
- **Ningún precio ni identificador interno en lo que ve el visitante** del formulario público.
- Todo permiso se verifica en el servidor. Datos personales cifrados; nunca en logs.
- Si una prueba de aislamiento entre organizaciones falla, **es el riesgo número uno del producto**:
  se arregla antes que cualquier otra cosa.
- Español de Chile y sin jerga para todo texto que lee una persona; código en inglés.

## 8. Trampas que ya nos mordieron

- **El CI de GitHub no está corriendo.** Hasta el 2026-11-04 fue por la facturación de la cuenta (corridas que
  fallaban en 2 segundos con "recent account payments have failed…"); desde el 2026-11-06 está **apagado** porque la
  cuota gratuita de minutos de la organización está casi agotada. **Lo enciende Aarón** (pago de minutos, o cuando se
  reinicie la cuota, cerca del 2026-12-01) y avisa. No reactivar Actions ni cambiar los workflows para esquivarlo, y
  escribir en cada PR qué se corrió en local. Mientras tanto, todo se verifica en local, y **cada pantalla nueva debe
  correr las pruebas de punta a punta completas**: una vez pasó que un agente corría solo las de su zona
  y rompía otra.
- **`db reset` y `test:db:rollbacks` vacían la base local**: después, `npm run db:seed`. Si otra persona
  está usando la app contra esa base, no las corras.
- **Playwright no corre con `npm run dev` abierto** en la misma carpeta: cerrar el servidor (puerto 3000).
- **Supabase no arranca («ports are not available») o queda sin puertos publicados:** Windows reservó el rango
  (`netsh interface ipv4 show excludedportrange protocol=tcp`). Como administrador, `net stop winnat` y
  `net start winnat`; luego `npx supabase start`. No borra datos.
- **Windows:** `npm install` puede borrar de `package-lock.json` las entradas `node_modules/@emnapi/core` y
  `@emnapi/runtime`, y entonces `npm ci` falla en CI. `npm run lint` lo comprueba: no subas con eso en rojo.
- **No enlaces `node_modules` de una copia de trabajo con un acceso directo hacia otra carpeta:** al borrar
  la copia se pueden llevar los archivos reales. Usa `npm ci` en cada copia.
- La prueba del PDF (`src/lib/pdf/render.test.tsx`) puede fallar por tiempo si la máquina está cargada;
  suele pasar sola al repetirla.
- La insignia flotante de Next en modo desarrollo tapaba el botón «Cerrar sesión» del menú: ya está
  oculta (`devIndicators: false`).
- Hay **18 copias de trabajo viejas** en `.claude/worktrees/` de la carpeta de Aarón, de agentes ya
  integrados. En tu clon no existen; no las traigas.

## 9. Las decisiones que son de Aarón (no las tomes por defecto)

Están todas esperando respuesta suya. Mientras tanto el código aplica el supuesto indicado.

| Decisión | Supuesto actual | Bloquea |
|---|---|---|
| **Aprobar las plantillas de PDF** (la 1 y el diseño de la 2 y la 3) | Se construyen como están en la vista previa | Cerrar el sprint 3 (H-076) |
| **Regla de enlaces ya respondidos** | Rechazada: tras la vigencia solo un aviso; aceptada: activo hasta pagada más un plazo | El cobro (H-053) |
| **Proveedor y dominio de correo** (decisión 016; propuesta Resend) | Correo de pruebas local | Cerrar con clientes reales y el piloto |
| **Anti-robot real** (decisión 019; propuesta Cloudflare Turnstile, alternativa ALTCHA) | Verificador de prueba | Publicar el formulario |
| **Dominio y marca** (¿`cotizaprime.cl`?, ¿bajo Main Brain?) | — | Los códigos incrustados y los QR impresos dependen del dominio |
| **Facturación de GitHub** | — | El CI |
| **Antes del piloto:** abogado, datos de Main Brain para los términos (hay 29 marcadores `[POR COMPLETAR]`), custodia de las claves de cifrado, quién responde un incidente, plazos de conservación | Los plazos propuestos en `PROYECTO.md` §11.2 | Piloto privado |

## 10. Cómo trabaja Aarón (importa para no frenarlo)

- **Revisa en un bloque grande**, no historia por historia. Cuando haya un lote importante integrado y
  verificado, hay que decirle: «tenemos esto listo (…), revisa en este link, estos son los accesos».
- Prefiere que **se avance solo** y se le pregunte únicamente lo importante: producto, dinero,
  proveedores, el diseño de lo que ve el cliente final.
- No es desarrollador de profesión: **explica todo término técnico en la misma frase**.
- Todo lo que cambie el alcance o una regla queda escrito en `docs/` (el plan se actualiza, no se deja
  desactualizado).
- Le gusta ver porcentajes, qué está terminado, qué falta y cuánto.

## 11. Primeros pasos recomendados

1. ~~Pedirle a Aarón el acceso y la copia de H-092~~ (hecho: ya se tiene el repositorio y H-092 está en `main`).
2. Clonar, levantar el entorno (§2) y **recorrer la app** como Ana y como Carla: es la mejor forma de
   entender el producto.
3. Correr toda la batería de pruebas para confirmar que el entorno funciona.
4. ~~Cerrar H-092 y el sprint 4~~ (hecho el 2026-10-28; mezclado en `main` con el PR #1).
5. Con Aarón: su revisión grande del recorrido, y sus respuestas a las decisiones de §9.
6. Terminar el sprint 5 (equipo y permisos, en construcción), que habilita aprobaciones y cobro.

Estimación de lo que falta, con el ritmo de las primeras semanas: unas **2 a 3 semanas hasta el piloto
privado** y **4 a 6 hasta el lanzamiento**, sin contar los plazos de las decisiones de Aarón ni la
revisión del abogado.
