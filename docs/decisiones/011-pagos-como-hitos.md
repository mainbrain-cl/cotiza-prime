# 011 · Pagos guardados como hitos

**Estado:** aceptada · **Fecha:** 2026-09-30 · **Detalle en:** `PROYECTO.md` §11.1, §13.7

## Contexto

Al inicio solo se ofrece pago del 100% o 50/50, pero es probable que después se pidan otros esquemas.

## Decisión

Cada pago esperado se guarda como una **fila propia (hito)**, con su porcentaje, monto y estado, no como un campo de la cotización.

## Por qué

Agregar después 30/70 o cuotas será agregar una opción en la pantalla, no rehacer la base de datos. Es gratis hoy y caro después.

## Alternativas descartadas

- Un campo "condición de pago" en la cotización

## Consecuencias

Si el total es impar, el peso sobrante va al último hito, para que la suma sea siempre exacta.
