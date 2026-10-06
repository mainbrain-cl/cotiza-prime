# Plantillas 2 y 3 del PDF: notas de diseño (H-076)

Vista previa: `docs/diseno/plantillas-2-y-3-pdf-vista-previa.html` (autocontenida; muestra la 1, la 2 y la 3 lado a lado).
Estado: propuesta, pendiente de aprobación de Aarón. Nada está implementado en `@react-pdf` todavía.

## Qué las distingue

| | Plantilla 1 (existe) | Plantilla 2, clásica | Plantilla 3, moderna |
|---|---|---|---|
| Carácter | Limpio, franja fina | Formal, de oficina | Minimalista, con aire |
| Marca | Franja superior, bloque "Para" teñido, total sobre color | Banda de color a todo el ancho, encabezado de tabla en color, total sobre color | Sin fondos de color: barra vertical junto al título, línea bajo el encabezado de tabla, total en texto de marca |
| Tabla | Líneas horizontales y zebra | Rejilla completa con bordes | Solo líneas horizontales finas, filas altas, sin zebra |
| Total | Abajo, recuadro de color | Abajo, fila de color en tabla de totales | Grande arriba a la derecha y repetido abajo |
| Logo | Junto al nombre | Dentro de un recuadro blanco sobre la banda | Pequeño, arriba a la izquierda |

## Reglas de color (las mismas de `brand-colors.ts`)

- `primary` solo para formas: banda, encabezado de tabla, barra, líneas, fila de total.
- `onPrimary` para todo texto sobre `primary` (banda, encabezado de tabla, fila de total de la 2). Es blanco o negro, el que más contraste dé: con un amarillo claro da 14,3:1; con un azul oscuro, 9:1.
- `primaryText` para todo texto de marca sobre blanco o sobre `primaryTint` (títulos de sección, número de cotización y total de la 3, etiquetas de caja). Se oscurece solo si el color no llega a 4,5:1.
- `secondary` solo decora (filete bajo la banda en la 2, punto antes de las etiquetas y remate de la barra en la 3). Nunca lleva texto, así que no necesita regla de contraste.
- `primaryTint` fondo de las cabeceras de caja en la 2 (reemplaza al bloque "Para" de la 1).

## Logo

- Cuadrado u horizontal: misma regla que la 1 (alto fijo, ancho máximo, `objectFit: contain`).
- Sin logo: solo el nombre en texto (la 2 no dibuja el recuadro blanco si no hay logo).
- En la 2 el logo va siempre sobre un recuadro blanco: así un logo oscuro no se pierde sobre una banda oscura ni un logo claro sobre una banda clara.

## Páginas, tamaños y cortes

- Carta y A4: solo cambia el tamaño de la página; las medidas se expresan en puntos, igual que la 1.
- Filas con `wrap={!isCompactLine(line)}`, encabezado de tabla `fixed` y totales con `wrap={false}`, como la 1. Se reutilizan `estimateLines` e `isCompactLine` (conviene moverlas a un archivo común de plantillas al construir).
- Páginas siguientes: la 2 usa una banda fina con nombre y número; la 3 un encabezado de una línea con el número; ambos `fixed` con `render` por número de página, igual que la 1.
- Textos largos envuelven (descripción, observaciones, condiciones). Si las notas son largas, mismo criterio de la 1: totales primero y notas debajo a todo el ancho.
- Cifras: IBM Plex Sans con `tabular-nums` equivalente (los montos van en columnas de ancho fijo alineadas a la derecha); número de cotización en IBM Plex Mono. Solo se usan las fuentes ya incluidas (Sans 400/500/600/700, Mono 400/500). Sin fuentes nuevas.

## Datos que usa del modelo existente (`QuoteDocumentData`)

Las dos usan los mismos campos que la 1; **no hace falta ningún campo nuevo**:

- `paper`, `brand` (`primary`, `secondary`, `primaryText`, `onPrimary`, `primaryTint`)
- `organization.name`, `organization.logo`, `organization.detailLines`
- `quote.number`, `quote.versionLabel`, `quote.issueDate`, `quote.validUntil`, `quote.validityNote`
- `customer.name`, `customer.detailLines`; `preparedBy.name`, `preparedBy.detailLines`
- `lines[]` completo (`name`, `description`, `exempt`, `quantity`, `unit`, `unitPrice`, `discount`, `total`)
- `totals` completo (`subtotal`, `globalDiscount`, `netTaxable`, `exempt`, `taxLabel`, `tax`, `total`)
- `observations`, `conditions`, `paymentTerms`

Detalles de uso:

- Plantilla 2: la caja de fecha repite el número de cotización y la versión (tercera celda); `validityNote` va bajo "Válida hasta".
- Plantilla 3: el total del encabezado es `totals.total`, el mismo valor del pie de totales. El texto "IVA incluido" es fijo porque `total` siempre incluye IVA; si la cotización es toda exenta, mostrar "Exento de IVA" (derivable de `totals.tax` y `totals.exempt`, sin campo nuevo). En el encabezado solo se imprimen las líneas de contacto de `organization.detailLines` (todas menos la primera, que es RUT y giro); conviene decidir al implementar si se prefiere pasar todas.
- La vista previa muestra una sola organización con un dato ficticio; las orgs reales llegan por el mismo modelo.

## Para implementar después de aprobar

1. Dos módulos: `src/lib/pdf/templates/template-2/index.tsx` y `template-3/index.tsx`, con la misma firma `({ data }: { data: QuoteDocumentData })`.
2. Un registro `templates/index.ts` con las tres (`id`, nombre, componente) para el selector de H-076.
3. Pruebas de render (como `render.test.tsx`): carta y A4, con y sin logo (cuadrado, horizontal), 1 y 2 páginas, color claro y oscuro.
4. Extraer lo común (`estimateLines`, `isCompactLine`, columnas) a `templates/shared.ts` sin cambiar la plantilla 1.

## Riesgos y decisiones abiertas

- Marca muy clara (amarillo) en la 2: la banda se ve bien con texto negro, pero se pierde menos contraste visual entre banda y fondo blanco. El filete secundario ayuda; es aceptable.
- La 3 depende más del texto de marca: con un color muy claro, `primaryText` se oscurece bastante y se parece menos al color de la organización (ocurre con el amarillo, 5,4:1 tras oscurecer).
- Aarón decide los nombres comerciales de las tres ("Franja", "Clásica", "Moderna" son de trabajo).
