# Muestra del PDF de H-048b — para aprobación de Aarón

> **Qué es.** La plantilla 1 del PDF de la cotización con los dos bloques que agrega **H-048b**: **EXCLUSIONES** y **NOTAS**. H-048b es delicada y no se construye hasta que Aarón apruebe esta muestra (decisión del 2026-11-19; `docs/arquitectura/sprint-5-h-048-textos.md`, «Puesta al día»).
> **Datos:** todo ficticio (organización y cliente de ejemplo).

## Qué mirar
Orden de los bloques, como lo fija el diseño: **OBSERVACIONES → CONDICIONES → EXCLUSIONES → FORMA DE PAGO → NOTAS**.

- Las **notas van al final de la lista**, no en el pie fijo de cada página: el pie tiene alto fijo y se repite en todas las hojas, y 4.000 caracteres no caben.
- «Exclusiones» y «Notas al pie» son **texto simple** (sin formato), con saltos de renglón.
- Con más texto, la plantilla pasa al modo «totales arriba y notas debajo» más seguido (los totales a la derecha y las notas a todo el ancho, que pueden seguir en la página siguiente sin perder ni una línea).
- El total aparece **una sola vez** y los números de página son coherentes.

## Archivos
| Archivo | Qué es |
|---|---|
| `muestra-h048b-tipica.pdf` | Cotización de 4 líneas con los cinco textos (2 páginas). Imágenes: `…-tipica-p1.png`, `…-tipica-p2.png` |
| `muestra-h048b-estres-40-lineas.pdf` | 40 líneas y los cinco textos largos (5 páginas): la prueba más exigente. Imágenes: `…-estres-40-lineas-p1.png` a `p5.png` |

## Lo que NO es
- No es H-048b construida: es un **prototipo local** de la plantilla 1 (dos campos opcionales y dos bloques más en `Summary`), generado con el mismo código del PDF de producción. Sin base de datos, sin pantallas, sin migraciones.
- La muestra de estrés se generó **con el arreglo del PR #62** (el PDF podía salir sin neto, IVA ni total con textos largos).

## Qué se pide
**Aprobar o ajustar** el orden y el aspecto de los dos bloques. Basta un comentario en el PR. Con su visto bueno empieza H-048b (≈4,5 días), seguida de H-042, H-116, H-119 y H-120.

**Defecto anterior que se arregla en el mismo PR del PDF de H-048b:** un título de las notas puede quedar solo al pie de una página (la muestra típica de 4 líneas no lo muestra; aparece con ciertos largos de tabla). Detalle en `docs/arquitectura/sprint-5-h-048-textos.md`.
