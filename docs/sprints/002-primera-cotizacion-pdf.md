---
document_id: CP-SPRINT-002
title: Sprint 2 — La primera cotización en PDF
version: 1.0
status: EN CURSO — Aarón dio luz verde el 2026-10-01 ("avancemos nomás")
basado_en: PROYECTO.md v1.0 · HISTORIAS.md · sprint 1 (orden de los 11 sprints)
language: es-CL
---

# Sprint 2 — La primera cotización en PDF

## Objetivo

Que Aarón arme una **cotización real con su logo**, con totales e IVA correctos, y **descargue el
PDF**. Es el sprint del dinero: el cálculo tiene que cuadrar al peso, siempre.

## Qué entra

| Historia | Tamaño | Notas |
|---|---|---|
| H-003 · Recuperar mi contraseña | chico | |
| H-007 · Logo y colores de mi empresa | mediano | Primer uso de archivos (Storage): rutas con `tenant_id`, tipo real del archivo, SVG limpio |
| H-021 · Editar o desactivar un servicio | chico | |
| H-023 · Ver y editar mis clientes | mediano | Búsqueda por nombre parcial y por RUT o correo completos (huella) |
| H-025 · Crear una cotización con servicios del catálogo | grande | Tablas `quotes` y `quote_items`; número asignado por la base; precio copiado |
| 🔒 H-026 · Cantidades, precios y descuentos | grande | **La planifica Opus antes.** Cálculo en el servidor, enteros, orden fijo, tabla de casos conocidos |
| H-027 · Descuento global, vigencia y observaciones | chico | |
| H-028 · Ver la cotización como la verá el cliente | grande | PDF en el servidor con la **plantilla 1** |
| H-115 · Pulido visual | mediano | Pedido de Aarón: esqueletos, transiciones, avisos animados |

## Orden de construcción

1. **En paralelo:** H-003, H-007 (único que toca la base en esta tanda: Storage), H-021, H-023.
   Al mismo tiempo, el planificador (Opus) diseña H-025 + H-026 (modelo de cotización y cálculo).
2. **H-025** (migración de cotizaciones, un solo agente).
3. **H-026 🔒** sola, según el plan de Opus; revisión por separado.
4. **H-027**.
5. **H-028**, con la plantilla 1 aprobada por Aarón.
6. **H-115** sobre todas las pantallas del sprint.

## Decisiones tomadas para este sprint

| Qué | Decisión | Por qué |
|---|---|---|
| **Quién diseña la plantilla 1 del PDF** (decisión pendiente 2) | La propone la sesión principal con una **vista previa visual** que Aarón aprueba antes de H-028, igual que se hizo con `DISENO.md` | Aarón pidió avanzar; un diseñador externo se puede sumar para las plantillas 2 y 3 (sprint 8) |
| **Librería de PDF** | `@react-pdf/renderer` 4.9.0, licencia MIT (verificada el 2026-10-01) | Genera el PDF en el servidor desde componentes con variables cerradas, sin HTML libre ni un navegador completo; liviana para Vercel. Alternativas: `pdfmake` (MIT, más limitada en diseño), Chromium sin cabeza (pesado en Vercel) |

## Qué se podrá mostrar

> Aarón entra a Negocio 1, sube su logo y elige sus colores. Crea una cotización para un cliente,
> agrega tres servicios del catálogo y una línea libre, aplica un 10% de descuento a una línea y un
> descuento global, fija la vigencia y ve el total con IVA. Abre la vista previa y descarga el PDF con
> su marca, el número `COT-2026-0001` y todo cuadrando al peso.

## Fuera

Enviar por correo, enlace del cliente y aceptar (sprint 3); plantillas 2 y 3 (sprint 8).

---

## Estado al 2026-10-05

| Historia | Estado |
|---|---|
| H-003 · Recuperar contraseña | ✅ Integrada, revisada por Opus y corregida (solo por enlace del correo); aviso por correo verificado |
| H-007 · Logo y colores | ✅ Integrada (Storage sí entrega las cabeceras a la base; el logo se sirve por el servidor) |
| H-021 · Editar o desactivar un servicio | ✅ Integrada, revisada y corregida |
| H-023 · Ver y editar clientes | ✅ Integrada, revisada y corregida (búsqueda sin datos en la URL; auditoría solo de lo cambiado) |
| H-025 · Crear una cotización | ✅ Integrada y aprobada por Opus. Falta que Aarón la pruebe |
| 🔒 H-026 · Cantidades, precios y descuentos | ✅ Integrada; cálculo y fase B aprobados por Opus (sin bloqueantes), hallazgo corregido. Falta que Aarón la pruebe |
| H-027 · Descuento global, vigencia, observaciones | ✅ Integrada (vigencia por defecto de la organización). Falta revisión de Opus en lote |
| H-028 · PDF | 🔵 En construcción con la plantilla 1 propuesta (Aarón aún no la aprueba; vista previa en `docs/diseno/plantilla-1-pdf-vista-previa.html`) |
| H-115 · Pulido visual | ✅ Integrada (esqueletos, transiciones, avisos; móvil 87–89) |

**Decisión nueva:** 015 (vulnerabilidades sin corrección en herramientas de desarrollo), pendiente de ratificación de Aarón.
