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

Al abrir una sesión nueva, **parte por aquí**. Hay esqueleto técnico, pero todavía no hay
funcionalidad del producto.

**Paso 1 — Preparación del sprint 1: ✅ terminado el 2026-10-01.**

- **Esqueleto:** Next.js 16 + TypeScript + Tailwind 4 + shadcn/ui, Supabase local en Docker
  (puertos **56320–56329**, porque `fidelidad-prime` usa los por defecto), Vitest, Playwright,
  ESLint, Prettier, CI en GitHub Actions. Cómo levantarlo: `README.md`.
- **Modelo de datos y RLS: aprobado** → `docs/arquitectura/modelo-datos.md` (respuestas por
  defecto de su §12). El archivo de resolución de la organización se llama ahí
  `src/lib/tenant/active-tenant.ts`; el esqueleto dejó `resolve.ts`: renombrar al construir H-005.
- **`docs/DISENO.md`: aprobado** (v1.0), con vista previa visual. Fondos animados en CSS propio;
  React Bits solo con aprobación de Aarón.
- **Decisión 014:** licencias indirectas de `sharp` (LGPL) y `caniuse-lite` (CC-BY) aceptadas.

**Paso 2 — Construir el sprint 1** según `docs/sprints/001-base-segura.md`, con la forma de trabajo
de la decisión 013. Antes de la migración 1, verificar contra la documentación vigente de Supabase
los tres puntos marcados al final de `modelo-datos.md`.

**Repositorio:** `github.com/avronygg/cotiza-prime`, privado, rama `main` (creado el 2026-10-01).
Docker Desktop ya está abierto.

**Pendientes de Aarón (no bloquean el sprint 1):** crear el correo de la agencia y la cuenta de
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
