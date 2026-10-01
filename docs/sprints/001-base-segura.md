---
document_id: CP-SPRINT-001
title: Sprint 1 — Base segura, catálogo y clientes
version: 1.0
status: CONFIRMADO — Compuerta 3 cruzada el 2026-10-01
basado_en: PROYECTO.md v1.0 · HISTORIAS.md v1.1
last_updated: 2026-09-30
language: es-CL
---

# Sprint 1 — Base segura, catálogo y clientes

> **Estado: confirmado** por Aarón el 2026-10-01 (Compuerta 3 de `PROCESO.md`). Forma de trabajo:
> decisión 013 (`docs/decisiones/013-forma-de-desarrollo.md`).

Este documento tiene dos partes: **el orden completo** de las 91 historias en 11 sprints, con el
motivo de cada decisión, y **el detalle del primer sprint**.

---

## Supuestos

- **Sprint de 2 semanas**, con una capacidad de unos **9 días de trabajo**. Queda un día de margen
  para revisiones y correcciones.
- **Tamaños:** chico = ½ día · mediano = 1 día · grande = 2 días (`HISTORIAS.md`).
- **Son estimaciones.** Al cerrar el sprint 1 se compara lo planificado con lo real y se ajustan los
  sprints siguientes. Con desarrollo asistido por IA la velocidad puede ser distinta, y eso solo se
  sabe midiendo.

## Cómo se trabaja cada historia

| Paso | Quién |
|---|---|
| 1. Explicar qué se hará, en lenguaje simple | Sonnet |
| 2. Aprobación | **Aarón** |
| 3. Construir | Sonnet · las historias marcadas con 🔒 las **planifica Opus** antes |
| 4. Revisar contra criterios, seguridad y diseño | **Subagente revisor con Opus** |
| 5. Corregir y mostrar funcionando | Sonnet |
| 6. Cerrar | **Aarón** |

🔒 = historia delicada (separación entre empresas, permisos, dinero o pagos, superficie pública).
Un error ahí sale caro, así que Opus la planifica antes de construir.

**Una historia por conversación:** al cerrarla se usa `/clear`. El contexto no se pierde, porque
`CLAUDE.md` y los documentos se cargan solos, y así cada historia gasta muchos menos tokens.

## Estimación en modo vibecoding

Así trabaja el equipo: Aarón guía, Sonnet construye y Opus planifica y revisa. Incluye explicar,
construir, revisar, corregir y probar en pantalla.

| Tamaño | Historias | Tiempo por historia | Subtotal |
|---|---|---|---|
| Chica | 30 | ~30 min | 15 h |
| Mediana | 47 | ~1 h | 47 h |
| Grande | 14 | ~2,5 h | 35 h |
| Imprevistos (+35%) y preparación | | | ~45 h |
| **Total** | **91** | | **~140 h** |

| Dedicación diaria | Piloto privado | Todo construido |
|---|---|---|
| 3 h/día | ~5 semanas | ~9–10 semanas |
| 5 h/día | ~3 semanas | ~6 semanas |
| 8 h/día | ~2 semanas | ~3,5–4 semanas |

Cada sprint son **12 a 14 horas de trabajo**. El **lanzamiento público** tiene un piso de **6 a 8
semanas**, aunque se construya antes: el piloto necesita uso real y el abogado tiene sus plazos.

## Propuestas para acelerar — ✅ decididas el 2026-10-01: se aplican 1, 2, 3 y 5 (decisión 013)

| # | Propuesta | Ahorro | Recomendación |
|---|---|---|---|
| 1 | **Usar piezas existentes**: componentes de pantalla listos, lo que trae Supabase (sesión, dos pasos) y servicios hechos para correo, PDF y validación | ~15–20% | Aplicar |
| 2 | **Paralelo en copias aisladas** del proyecto para historias independientes. Los cambios de base de datos, uno solo y en orden; las 🔒 nunca en paralelo | ~25–35% del calendario | Aplicar |
| 3 | **Aprobar por sprint**: se explican todas las historias del sprint juntas y se aprueban una vez; revisión de Opus en lote para las chicas, una a una para las 🔒 | ~10–15% | Aplicar (se registra como decisión, ajusta `PROCESO.md`) |
| 4 | **Lanzar con menos**: mover después del lanzamiento historias no esenciales (candidatas: H-055, H-063, H-073, H-074, H-091, H-105) | ~15–20% | Decisión de Aarón |
| 5 | **Adelantar lo que no es código**: cuentas, dominio de correo, borradores al abogado | Evita esperas al final | Aplicar |

Con 1, 2 y 3 aplicadas, a 5 h/día: **todo construido en ~3,5–4 semanas** y **piloto en ~2 semanas**.

---

# Parte 1 — El orden completo

## Por qué este orden

1. **Primero, el camino más corto de punta a punta.** Los sprints 1 a 3 llevan a que **una
   cotización real llegue al cliente y este la acepte**, con una sola persona usando el sistema. Las
   invitaciones y los roles, que no hacen falta para ese recorrido, van después.
2. **Lo riesgoso, temprano:**
   - La separación entre empresas entra en el **sprint 1**.
   - El cálculo del dinero y el PDF, en el **sprint 2**.
   - La entrega del correo y el enlace público, en el **sprint 3**.

   Son las tres cosas que más pueden fallar.
3. **Por dependencia:** los roles (sprint 4) van antes que la aprobación (sprint 5), y la aprobación
   antes que el cobro.
4. **Lo cómodo, al final:** búsqueda avanzada, plantillas extra y onboarding.
5. **El piloto privado va después del sprint 6**, cuando el ciclo completo funciona y las empresas
   piloto tienen lo básico del día a día: versiones, duplicar, reenviar e historia de la cotización.

## Los 11 sprints

| Sprint | Nombre | Historias | Días | Qué se puede mostrar al cerrar |
|---|---|---|---|---|
| **1** | **Base segura, catálogo y clientes** | H-110, H-013, H-001, H-002, H-005, H-006, 🔒H-012, H-020, H-022, H-024 | 9 | Aarón se registra, crea **Negocio 1 y Negocio 2**, carga servicios y clientes en cada uno, y **uno nunca ve los datos del otro** (prueba automática en verde) |
| **2** | **La primera cotización en PDF** | H-003, H-007, H-021, H-023, H-025, 🔒H-026, H-027, H-028 | 9½ | Aarón arma una **cotización real con su logo**, con totales e IVA correctos, y **descarga el PDF** |
| **3** | **El cliente la recibe y responde** | 🔒H-029, 🔒H-030, H-031, H-032, H-033, H-034, H-035, H-014 | 9 | La cotización **llega al correo** de un cliente de prueba, que la **abre en su teléfono y la acepta**. **Primer recorrido de punta a punta completo** |
| **4** | **Equipo y permisos** | H-004, H-008, H-009, H-010, 🔒H-011, H-040, H-041, H-042, H-048 | 9 | Aarón invita a Juan como Comercial; Juan cotiza con precios bloqueados y no ve la configuración |
| **5** | **Aprobación y datos de pago** | H-043, 🔒H-044, H-045, H-046, H-047, 🔒H-050, 🔒H-051, 🔒H-052, 🔒H-053 | 9 | Juan pide aprobación, Aarón aprueba y **el correo sale solo**; al aceptar, el cliente recibe los **datos de transferencia** |
| **6** | **Cobro completo y listo para el piloto** | 🔒H-054, H-055, H-056, H-057, H-060, H-061, H-069, H-070, H-071, H-072, H-075, H-114 | 8 | Ciclo completo hasta **Pagada**, en 100% y 50/50, con historia de la cotización, versiones y WhatsApp |
| ⭐ | **Piloto privado** | — | — | 1 a 3 empresas reales. **Requisito:** decisiones 7, 8 y 9 resueltas (plazos de conservación, incidentes, abogado) y un respaldo restaurado |
| **7** | **Encontrar y seguir** | H-062, H-063, H-064, H-065, H-066, H-067, H-068, H-073, H-074 | 8½ | Inicio con "lo que requiere mi atención", búsqueda con `Ctrl + K`, filtros, ficha del cliente y alertas |
| **8** | **Plantillas y modelos de cálculo** | H-076, H-080, H-081, H-082, H-083 | 8 | Tres plantillas a elegir; el comercial ingresa horas o km y se proponen las líneas con precio |
| **9** | **Margen y formulario público** | H-084, H-085, 🔒H-086, 🔒H-087, H-088, H-089, H-090, H-091, 🔒H-092 | 9 | Un desconocido pide cotización por el formulario (o su QR), ve un estimado y la solicitud se convierte en cotización |
| **10** | **Onboarding y autoservicio** | H-100, H-101, H-102, H-103, H-104, H-105, H-109, H-111, H-113 | 8 | Una empresa nueva queda **configurada sola** con el recorrido guiado y recibe su cotización de prueba |
| **11** | **Cumplimiento y lanzamiento** | 🔒H-106, 🔒H-107, H-108, H-112 + listas de salida a producción | 4 + tareas | **Lanzamiento público** |

**Total:** 91 historias en 11 sprints, unas **22 semanas**, más la preparación. Es una estimación
que se recalibra al cerrar el sprint 1.

## Preparación que cada sprint necesita antes de partir

No son historias, pero sin ellas el sprint no puede empezar:

| Antes de | Qué tiene que estar listo |
|---|---|
| **Sprint 1** | Repositorio git (privado en GitHub); **Docker Desktop abierto** para la base de datos local; **`DISENO.md` con lo básico** según la dirección visual aprobada; diseño del modelo de datos y de RLS; subagentes revisor y planificador configurados ✅. Supabase en la nube, Vercel y Sentry se configuran cuando haga falta publicar |
| **Sprint 2** | **Plantilla 1 del PDF** diseñada |
| **Sprint 3** | **Dominio de correo** verificado con SPF, DKIM y DMARC (decisión pendiente 1) |
| **Sprint 4** | Canal de los avisos internos confirmado (decisión pendiente 5) |
| **Sprint 5** | ¿Una o varias cuentas bancarias? (decisión pendiente 6) |
| **Piloto** | Decisiones 7, 8 y 9; **Supabase de producción en un plan con respaldos automáticos**; respaldo restaurado |
| **Sprint 8** | Plantillas 2 y 3 diseñadas |
| **Sprint 9** | ¿El comercial ve costos o solo el semáforo? (decisión pendiente 10) |
| **Sprint 10** | Modo de cobro y tope de uso (decisiones 12 y 13) |
| **Sprint 11** | Revisión final del abogado; prueba con 50.000 cotizaciones |
| **En paralelo, desde ya** | Estudio de costeo logístico (decisión pendiente 4), para que logística detallada (M20) parta apenas se lance |

---

# Parte 2 — Sprint 1: Base segura, catálogo y clientes

## Objetivo

Dejar **los cimientos que sostienen todo lo demás** y probar lo más riesgoso del producto: que dos
empresas en la misma plataforma nunca vean los datos de la otra. Encima de eso, cargar los datos que
la primera cotización necesitará en el sprint 2: catálogo, clientes y numeración.

## Qué entra

| Orden | Historia | Tamaño | Por qué entra y en este orden |
|---|---|---|---|
| 1 | **H-013** · Franja de entorno de pruebas | chico | Va primero: desde el primer día se tiene que ver si se trabaja en pruebas |
| 2 | **H-110** · Términos y política de privacidad (versión preliminar) | chico | El registro exige aceptarlos; esta versión preliminar se reemplaza por la revisada por el abogado |
| 3 | **H-001** · Registrarme con mi correo | mediano | Sin cuenta no hay nada |
| 4 | **H-002** · Iniciar y cerrar sesión | chico | Completa el ciclo de identidad |
| 5 | **H-005** · Crear mi organización | mediano | Nace el `tenant_id` y con él la regla de todas las tablas |
| 6 | **H-006** · Cambiar entre mis organizaciones | mediano | Una persona en varias empresas es el caso que define el producto, y el que más riesgo de filtración tiene |
| 7 | 🔒 **H-012** · Que ninguna otra organización vea mis datos | grande | **El riesgo número uno.** Se construye y se prueba ahora, antes de que existan datos que proteger |
| 8 | **H-024** · Configurar la numeración | chico | La cotización del sprint 2 la necesita |
| 9 | **H-020** · Cargar servicios en el catálogo | mediano | La cotización del sprint 2 la necesita. Además, la prueba de aislamiento gana datos reales que intentar filtrar |
| 10 | **H-022** · Registrar un cliente | mediano | Ídem, y es la primera historia con **datos personales cifrados**: conviene resolverlo temprano |

**Total: 9 días.**

## Qué se va a poder mostrar funcionando

> Aarón entra a la plataforma, se registra y verifica su correo. Crea **Negocio 1** con su RUT y
> configura la numeración `COT-2026-0001`. Carga tres servicios y dos clientes. Crea **Negocio 2**,
> cambia a él con el selector y ve que está vacío: **ni los servicios ni los clientes de Negocio 1
> aparecen**. Si intenta abrir un cliente de Negocio 1 por dirección directa, ve "No encontrado".
> Arriba de la pantalla se ve la franja `PRUEBAS`. La prueba automática de aislamiento corre y
> está en verde.

## Qué queda fuera, explícitamente

| Queda fuera | Por qué | Va en |
|---|---|---|
| Logo y colores (H-007) | No se ven hasta que exista el PDF | Sprint 2 |
| Recuperar contraseña (H-003) | Útil, pero no bloquea la demostración | Sprint 2 |
| Editar y desactivar servicios, lista de clientes (H-021, H-023) | Cargar basta para esta demo; editar se completa junto a la cotización | Sprint 2 |
| Invitaciones, roles y permisos (H-008 a H-011) | En el camino más corto el Dueño trabaja solo; los permisos entran cuando hay equipo | Sprint 4 |
| Verificación en dos pasos (H-004) | Se vuelve obligatoria cuando existan datos bancarios | Sprint 4 |
| Registro de actividad visible (H-014) | El registro **se graba desde este sprint**; la pantalla para verlo va después | Sprint 3 |

## Riesgos de este sprint

| Riesgo | Qué se hace |
|---|---|
| Que el aislamiento tenga un hueco que nadie ve | H-012 marcada 🔒: Opus la planifica, el revisor la audita y la prueba intenta filtrar por todos los caminos |
| Que el cifrado impida buscar clientes | La "huella" buscable se diseña en H-022, no después (`PROYECTO.md` §13.11) |
| Que `DISENO.md` no esté listo y las pantallas se hagan con valores inventados | Es requisito para partir el sprint (tabla de preparación) |
| Que la estimación de 9 días esté lejos de la realidad | Se mide y se recalibra al cerrar |

## Recordatorio de entorno

Todo el sprint trabaja contra **🟢 PRUEBAS**, con datos ficticios. Ninguna migración toca
producción sin la confirmación explícita de `/entorno`.

---

> ### ✅ COMPUERTA 3 — cruzada
> Sprint 1 confirmado por Aarón el 2026-10-01.
