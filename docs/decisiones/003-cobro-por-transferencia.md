# 003 · Sin pasarela de pago: cobro por transferencia

**Estado:** aceptada · **Fecha:** 2026-09-30 · **Detalle en:** `PROYECTO.md` §3, §6.6, §13.2

## Contexto

El flujo pide que, al aceptar, el cliente pueda pagar el total o un anticipo.

## Decisión

**No hay pasarela de pago.** Cotiza Prime envía los datos de transferencia de la organización y registra si se pagó. El dinero nunca pasa por Cotiza Prime.

## Por qué

Una pasarela cobra una comisión por transacción que no conviene en cotizaciones de montos altos, y convertiría a Cotiza Prime en intermediario del dinero, con la carga legal y de soporte que eso trae.

## Alternativas descartadas

- Pasarela de pago integrada

## Consecuencias

No hay confirmación automática del pago (ver 004). Los datos bancarios se vuelven blanco de fraude y necesitan controles especiales (§13.2).
