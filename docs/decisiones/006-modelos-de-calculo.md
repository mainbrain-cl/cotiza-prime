# 006 · Modelos de cálculo cerrados, sin editor de fórmulas

**Estado:** aceptada · **Fecha:** 2026-09-30 · **Detalle en:** `PROYECTO.md` §9

## Contexto

Se quiere que la plataforma estime el valor de una cotización según el rubro, sin partir desde cero.

## Decisión

Cotiza Prime ofrece **modelos de cálculo cerrados**: define qué datos se piden y cómo se combinan, y cada organización pone sus tarifas. Al inicio: por unidad, servicio por tiempo y productos.

## Por qué

Un editor de fórmulas libre es, en la práctica, un lenguaje de programación pequeño: difícil de usar, riesgoso en seguridad y caro de construir. Los modelos dan la mayor parte del valor con una fracción del riesgo.

## Alternativas descartadas

- Editor de fórmulas libre
- Solo catálogo, sin cálculo

## Consecuencias

Cada rubro especializado es trabajo de desarrollo. El editor libre queda como condicional (M28).
