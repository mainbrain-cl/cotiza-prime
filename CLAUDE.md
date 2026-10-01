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

Al abrir una sesión nueva, **parte por aquí**. Todavía no se ha escrito código del producto.

**Paso 1 — Preparación del sprint 1, en paralelo:**
- **Esqueleto del proyecto** (subagente Sonnet): Next.js + TypeScript + Tailwind + shadcn/ui,
  Supabase local con Docker, Vitest, Playwright, linter y formateador, estructura `/api/v1/`,
  repositorio git. Revisar antes que Docker Desktop esté abierto.
- **Modelo de datos y RLS** (subagente `planificador`, Opus): tablas del sprint 1 y siguientes con
  `tenant_id`, reglas RLS, resolución de la organización activa en un solo punto, huella buscable
  para datos cifrados. Queda en `docs/arquitectura/modelo-datos.md` para que Aarón lo apruebe.
- **`docs/DISENO.md`** (sesión principal): proponer tokens (colores, tipografía, espaciado, radios,
  vidrio, movimiento) según la dirección visual aprobada, con una **vista previa visual** para que
  Aarón la apruebe. Verificar las licencias de las librerías candidatas.

**Paso 2 — Construir el sprint 1** según `docs/sprints/001-base-segura.md`, con la forma de trabajo
de la decisión 013.

**Pendientes de Aarón (no bloquean el paso 1):** crear el correo de la agencia y la cuenta de
Supabase; confirmar la creación del repositorio privado en GitHub (cuenta avronygg); decisiones
pendientes de `PROYECTO.md` §16.2 (dominio, quién diseña las plantillas, estudio logístico).

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
