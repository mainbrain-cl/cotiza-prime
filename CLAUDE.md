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

### Traspaso del 2026-10-01 (fin de sesión) — empezar por aquí

**Integrado en `main` del sprint 2:** H-021 (editar/desactivar servicios), H-003 (recuperar
contraseña), H-023 (lista paginada, búsqueda por nombre/RUT/correo y edición de clientes) y el **paso 1 de H-026** (cálculo puro: `src/lib/money/rounding.ts`,
`src/lib/quotes/calc.ts`, `calc-cases.ts` con K01–K39 exactos, `parse.ts`). 301 pruebas unitarias en
verde. La suite completa (`test:db`, `test:isolation`, `test:e2e`) **pasó en GitHub Actions** en
la corrida del último commit (verificado el 2026-10-05).

**H-007 quedó a medias:** el subagente se cortó por el **límite semanal de uso** (se reinició el
2026-10-04). Su trabajo (34 archivos, ~3.300 líneas: migración `20261001170000_tenant_branding`,
pantallas Configuración → Empresa y Marca, `src/lib/brand/`, ruta `src/app/api/v1/tenants/`, pruebas
de Storage en `tests/isolation/storage.test.ts`) se guardó **sin verificar** como commit `8b6e3cc`
en la rama `worktree-agent-a83e3c73c22f35487` (copia `.claude/worktrees/agent-a83e3c73c22f35487`).
Lo último que hacía: "agrego el helper de Storage y extiendo la fixture". **Para retomarlo:** lanzar
un subagente en esa misma copia para que termine H-007 desde ese punto (no desde cero), corra todas
las pruebas y responda si Storage entrega las cabeceras a la base; después integrar como siempre.

**Pendientes del sprint 2, en este orden:**
1. Integrar H-007 (arriba).
2. **H-003:** reiniciar Supabase local (`npx supabase stop && npx supabase start`) para cargar el
   aviso por correo de cambio de contraseña, y correr el e2e con
   `E2E_EXPECT_PASSWORD_CHANGED_MAIL=1`. En el límite de intentos reutiliza los alcances
   `login_email`/`signup_ip` de `auth_rate_limits`: darles alcance propio con una migración.
3. **Revisión de Opus en lote** de H-003, H-007, H-021, H-023.
4. **H-025 + H-026 🔒** según `docs/arquitectura/cotizaciones-y-calculo.md` (plan del planificador),
   desde su paso 2: migración Q1 (`app.quote_calc_v1`) + prueba de paridad con `calc-cases.ts`
   (el paso 1 dejó definido el orden de errores y el código extra `invalid_tax_rate`: la copia SQL
   debe seguirlo) → **revisión del cálculo por Opus** → Q2 (`quotes`, `quote_items`,
   `quote_events`, `create_quote`, `save_quote_draft`) → aislamiento → acciones → pantallas.
   Un solo agente, sin paralelo.
5. H-027 → H-028 (PDF con la plantilla 1, **cuando Aarón la apruebe**) → H-115 (pulido visual).

**Decisiones esperando a Aarón** (aplicar el supuesto si no responde):
- **Plantilla 1 del PDF:** vista previa en https://claude.ai/artifact/Ckd62T8HreUpARrfXWLYdg
  (archivo fuente en el scratchpad de la sesión; si se pierde, rehacerla desde la descripción del
  traspaso: franja de color principal, acento secundario, número grande en monoespaciada, bloque
  "Para", tabla con exentos marcados, totales con el total en el color de la marca, condiciones,
  pie "no es documento tributario", IBM Plex Sans, carta y A4, filas que no se cortan).
- Preguntas del plan de cotizaciones (§10): solo el autor edita su borrador; descuento global mayor
  que el subtotal se rechaza; topes de 200 líneas y $1 billón; vigencia en días desde el envío.
- GitHub Pro (~US$4/mes) para bloquear integraciones en rojo, o seguir con la regla del proceso.

**Avance estimado al cerrar:** sprint 2 ~45% · hasta el piloto (sprints 1–6) ~22% · construcción
completa ~13%.

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
