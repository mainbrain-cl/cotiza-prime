# 001 · País: solo Chile

**Estado:** aceptada · **Fecha:** 2026-09-28 · **Detalle en:** `PROYECTO.md` §0

## Contexto

La base técnica exige declarar el país antes de planificar: de él dependen la ley de datos, el identificador tributario, el impuesto y la moneda.

## Decisión

Cotiza Prime se construye **solo para Chile**: Ley 21.719, RUT, IVA 19% y CLP sin decimales.

## Por qué

Es el mercado donde está el equipo y sus clientes. Un solo país mantiene simples las validaciones, los formatos y el cumplimiento legal.

## Alternativas descartadas

- Chile primero con la base preparada para varios países
- Varios países desde el inicio

## Consecuencias

Como el producto es de autoservicio, una empresa extranjera podría registrarse. No se bloquea, pero los términos dicen que el servicio es para Chile.
