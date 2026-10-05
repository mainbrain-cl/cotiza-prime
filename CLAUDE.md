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

**Fase 4 — Desarrollo.** Plan (v1.0), historias (v1.1) y sprint 1 aprobados (Compuerta 3 cruzada el
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

### Estado al 2026-10-05 — empezar por aquí

**Sprint 2 (~90%):** todas las historias integradas en `main` salvo **H-028 (PDF)**, en construcción
con la plantilla 1 propuesta. Detalle por historia: `docs/sprints/002-primera-cotizacion-pdf.md`.
Revisiones de Opus hechas: H-003, H-021, H-023, cálculo de H-026, H-025/H-026 fase B. **Falta revisar:**
H-007, H-027, H-028, H-115 (en lote). Luego Aarón prueba en pantalla y se cierra el sprint 2.

**Pruebas al último integrar:** 482 unitarias, 334 de base de datos, 656 de aislamiento, 42+ de punta
a punta, todo en verde. 19 migraciones.

**Decisiones esperando a Aarón:** aprobar la plantilla 1 del PDF (vista previa
https://claude.ai/artifact/Ckd62T8HreUpARrfXWLYdg, copia en `docs/diseno/plantilla-1-pdf-vista-previa.html`);
ratificar la decisión 015; GitHub Pro o regla del proceso. Preguntas del plan de cotizaciones (§10):
se aplicaron los supuestos por defecto.

**Ojo con el consumo:** el 2026-10-01 se alcanzó el límite semanal de uso con 5–6 agentes en paralelo.
Trabajar con 2 a la vez como máximo.

**Cómo se integra el trabajo de los subagentes:** cada uno trabaja en una copia aislada y hace commit
en su rama; la sesión principal cierra servidores abiertos, une la rama, corre todas las pruebas,
sube a `main` y borra la copia. Los cambios de base de datos, de a uno. Las 🔒, solas.

**Repositorio:** `github.com/avronygg/cotiza-prime`, privado, rama `main` (creado el 2026-10-01).
Docker Desktop ya está abierto.

**Pendientes de Aarón:** aprobar la vista previa de la plantilla 1 del PDF (antes de H-028); dominio de correo (antes del sprint 3); GitHub Pro o regla del proceso para bloquear integraciones en rojo; datos de Main Brain para los términos (29 marcadores `[POR COMPLETAR]`); crear el correo de la agencia y la cuenta de
Supabase (pruebas y producción); Vercel cuando haya que publicar; decisiones pendientes de
`PROYECTO.md` §16.2 (dominio, quién diseña las plantillas, estudio logístico); **custodia de las
claves de cifrado** (gestor de contraseñas y dos personas, antes del piloto; `modelo-datos.md` §12
pregunta 5).

**Trampa de Windows:** `npm install` en este equipo puede borrar de `package-lock.json` las
entradas `node_modules/@emnapi/core` y `node_modules/@emnapi/runtime`, y entonces `npm ci` falla en
GitHub Actions. Antes de subir, confirmar que siguen ahí. Los subagentes dejan servidores de prueba
abiertos que bloquean archivos: cerrarlos al integrar.

**Notas:** OneDrive no está sincronizando esta carpeta (verificado el 2026-10-01); no activarlo. La
carpeta `base-tecnica/` de la raíz es la copia original de la base; preguntar si se elimina.

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
