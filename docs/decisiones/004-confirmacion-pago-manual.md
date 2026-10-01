# 004 · Confirmación de pago manual

**Estado:** aceptada · **Fecha:** 2026-09-30 · **Detalle en:** `PROYECTO.md` §6.6, §13.4

## Contexto

Sin pasarela no hay forma automática de saber si el cliente transfirió.

## Decisión

Un **Administrador o el Dueño** marca el pago como recibido, a mano. Revertirlo exige motivo y no borra el registro original.

## Por qué

Es gratis, simple y seguro. Restringirlo a esos roles evita que un comercial marque como pagado algo que no lo está.

## Alternativas descartadas

- Comprobante subido por el cliente (queda para después, M21)
- Conexión automática con el banco (condicional, M28)

## Consecuencias

El comprobante de pago entra después como mejora. La conexión bancaria se evalúa solo si el volumen lo justifica.
