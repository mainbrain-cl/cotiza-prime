# 005 · Se aprueba el paquete completo y sale solo

**Estado:** aceptada · **Fecha:** 2026-09-30 · **Detalle en:** `PROYECTO.md` §6.4, §13.3

## Contexto

El administrador quiere que ninguna cotización salga sin su visto bueno cuando así lo configure.

## Decisión

Se aprueba el **paquete completo**: texto del correo, PDF y condición de pago. Al solicitar la aprobación el paquete se congela; si algo cambia, la aprobación se anula. **Al aprobarse, el correo sale automáticamente.**

## Por qué

El aprobador aprueba exactamente lo que recibirá el cliente, no una idea de la cotización.

## Alternativas descartadas

- Aprobar solo los montos
- Aprobar y que el comercial envíe a mano

## Consecuencias

Hay que guardar una copia congelada del paquete, y el servidor rechaza cualquier envío sin aprobación válida (§13.3).
