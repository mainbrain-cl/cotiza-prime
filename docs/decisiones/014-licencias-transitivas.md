# 014 · Licencias de dependencias indirectas: sharp (LGPL) y caniuse-lite (CC-BY)

**Estado:** aceptada · **Fecha:** 2026-10-01 · **Detalle en:** `LEGAL.md` §2.3

## Contexto

Al armar el esqueleto se revisaron las licencias. Ninguna dependencia directa es GPL. Dos
dependencias **indirectas** (las trae Next.js, no las elegimos nosotros) tienen licencias que
`LEGAL.md` pide dejar registradas:

- **`@img/sharp-*`** (optimización de imágenes de Next.js): Apache-2.0 y, en el binario de
  `libvips`, **LGPL-3.0 o posterior**.
- **`caniuse-lite`** (datos de compatibilidad de navegadores, usado al compilar): **CC-BY-4.0**.

## Decisión

Se aceptan las dos.

- **LGPL** permite usar la librería dentro de un producto cerrado mientras se enlace sin
  modificarla, que es lo que hace Next.js. No obliga a liberar el código de Cotiza Prime.
- **CC-BY-4.0** solo pide atribución, y aplica a datos que se usan al compilar, no a código que se
  entrega al cliente.

## Por qué

Son parte estándar de Next.js, que es el stack de la agencia (`STACK.md`). Reemplazarlas no aporta
nada y complica el proyecto.

## Condiciones

- **Nunca modificar ni redistribuir `sharp` o `libvips` por separado.** Si eso cambia, se revisa
  esta decisión.
- En cada actualización de dependencias se vuelve a correr la revisión de licencias.

## Alternativas descartadas

- Desactivar la optimización de imágenes de Next.js: empeora el rendimiento (`STACK.md` §6) sin
  ganancia legal real.
