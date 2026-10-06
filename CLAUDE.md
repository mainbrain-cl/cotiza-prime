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

- **Base:** Next.js 16 + Supabase local en Docker (puertos **56320–56329**). 14 migraciones. Datos de
  prueba: `npm run db:seed` (`ana`, `beto`, `mixta`, `ex` `@ejemplo.test`, contraseña
  `Prueba-Cotiza-2026`; Negocio Demo 1 y 2). Cómo levantarlo: `README.md`.
- **Documentos de arquitectura:** `docs/arquitectura/modelo-datos.md` (aprobado) y
  `docs/arquitectura/h-012-aislamiento.md` (plan y registro de cierre).
- **Diseño:** `docs/DISENO.md` v1.0 aprobado. **Decisión 014:** licencias de `sharp` y `caniuse-lite`.
- **Historia nueva H-114** (IP de auditoría falsificable), en el sprint 6, antes del piloto.

**En curso: sprint 2** → `docs/sprints/002-primera-cotizacion-pdf.md` (orden de construcción y decisiones:
la plantilla 1 del PDF la propone la sesión principal con vista previa; PDF con `@react-pdf/renderer`).

### Estado al 2026-10-06 (noche) — empezar por aquí

**Recorrido de punta a punta ya funciona en local:** enviar la cotización por correo (Mailpit) → el cliente
la abre sin cuenta en `/c/[token]` → acepta o rechaza (motivo obligatorio) → el autor recibe un aviso.
Todo en `main`, CI en verde hasta H-030; la corrida de H-031 estaba en curso al escribir esto.

**Cambios de alcance de hoy (todos en `docs/PROYECTO.md` §6.0 y `docs/HISTORIAS.md`):** recorrido completo
como mapa del producto; formulario público **sin precios**, con vista previa en vivo, enlace **e incrustable**
en la v1 (nueva H-093, H-088 reescrita); motivo de rechazo obligatorio; **formulario público adelantado al
sprint 4** (12 sprints, 92 historias; tabla en `docs/sprints/001-base-segura.md`); **H-076** (3 plantillas de
PDF + selector) adelantada al sprint 3. Decisiones nuevas: 016 (proveedor de correo, propuesta Resend,
**pendiente de Aarón**), 017 (enlace del cliente con portero en el servidor), 018 (React Bits gratuito).

**Sprint 3 (~85 %):** hechas H-029, H-030, H-031, H-032, H-014 (más la capa de correo, las migraciones 21–26 y el
menú/tarjetas/contadores/fondos de React Bits). Revisadas por Opus: migraciones, H-029, H-030 (sin bloqueantes).
**En curso al cerrar el día:** (1) revisión de Opus de H-031; (2) un agente Sonnet con **H-033, H-034, H-035**
(rama `worktree-agent-afae94126bb586f12`, copia en `.claude/worktrees/`). Si no terminaron: mirar
`git worktree list`, revisar la rama, integrar con las pruebas y subir; si la copia quedó a medias, rehacer.
La copia `agent-a7b9e1375a7b27ce4` es vieja (de antes de hoy): preguntar si se borra.
**Falta del sprint 3:** H-033/034/035, **H-076** (esperando que Aarón apruebe el diseño de las plantillas 2 y 3:
`docs/diseno/plantillas-2-y-3-pdf-vista-previa.html`), y el lote de correcciones menores de la revisión de H-030
(`docs/arquitectura/sprint-3-envio-y-enlace.md` §12) más lo que salga de la revisión de H-031.

**Orden siguiente:** cerrar sprint 3 → **primera revisión grande de Aarón** (avisarle con: qué está listo, el
link `http://localhost:3000` y los accesos) → sprint 4 (formulario público) → 5 equipo y permisos → 6 aprobación
y datos de pago → 7 cobro → piloto privado.

**Aarón pidió (2026-10-06):** que avance solo y subiendo a `main`; él revisa **de corrido, en un bloque grande**,
no historia por historia. Cuando haya un lote importante: decirle «tenemos esto listo (…), revisa en este link,
estos son los accesos». Mirar siempre GitHub Actions tras cada subida.

**Cómo se prueba en pantalla:** `npm run dev` → http://localhost:3000. Accesos: `ana`, `beto`, `mixta`, `ex`
`@ejemplo.test`, contraseña `Prueba-Cotiza-2026` (Negocio Demo 1 y 2). Correos de prueba: http://127.0.0.1:56324.
Docker Desktop debe estar abierto y `npx supabase start` corrido. Si `supabase start` dice que faltan servicios
(Kong), un contenedor quedó atado a una copia de trabajo borrada: `npx supabase stop` y `start`. `test:db:rollbacks`
y `db reset` vacían la base local: volver a correr `npm run db:seed`. Playwright no corre con el servidor de
desarrollo abierto en la misma carpeta: cerrarlo antes (puerto 3000).

**Decisiones y pendientes de Aarón:** aprobar la plantilla 1 (https://claude.ai/artifact/Ckd62T8HreUpARrfXWLYdg)
y el diseño de las 2 y 3; **regla de enlaces ya respondidos** (rechazada: tras la vigencia solo aviso;
aceptada: activo hasta pagada + plazo), anotada en el plan §12; decisión 016 (proveedor y dominio de correo,
bloquea cerrar con clientes reales); si se puede revocar el enlace de una cotización ya aceptada; ratificar
decisión 015, el tope de 15 envíos/10 min y los topes de reenvío (5/día, 20 total); fecha propuesta
2026-11-13 para la reconciliación de envíos a medias; datos de Main Brain para los términos (29 marcadores);
abogado; custodia de claves de cifrado; quién responde un incidente; cuentas de Supabase y Vercel; GitHub Pro.

**Pruebas al último integrar:** 718 unitarias, 451 de base de datos, 869 de aislamiento, unas 55 de punta a punta;
26 migraciones. **Ojo con el consumo:** hoy hubo hasta 4 agentes a la vez; la regla sigue siendo 2 salvo que Aarón
pida más.

**Trampas de Windows:** `npm install` puede borrar de `package-lock.json` las entradas `node_modules/@emnapi/core`
y `@emnapi/runtime` (revisar antes de subir; `npm run lint` lo comprueba). Nunca enlazar `node_modules` de una
copia con un acceso directo a la carpeta principal: borrar la copia podría arrastrar los archivos reales
(si ocurre, quitar el enlace con `[System.IO.Directory]::Delete(ruta, $false)` antes de borrar). Los subagentes
dejan servidores abiertos que bloquean archivos: cerrarlos al integrar.

**Repositorio:** `github.com/avronygg/cotiza-prime`, privado, rama `main`.

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
