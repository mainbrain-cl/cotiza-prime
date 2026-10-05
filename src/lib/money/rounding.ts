/**
 * Redondeo de dinero: el ÚNICO del producto (cotizaciones-y-calculo.md §3.1).
 *
 * Medio peso hacia arriba, con enteros grandes (`bigint`) para no perder exactitud ni usar decimales
 * flotantes. La copia en la base de datos (`app.round_half_up_div`) hace exactamente lo mismo.
 * Solo vale para números mayores o iguales a cero.
 */

const ZERO = BigInt(0);
const TWO = BigInt(2);

/** `n / d` redondeado al entero más cercano; si queda justo en la mitad, sube. Requiere `n >= 0` y `d > 0`. */
export function roundHalfUpDiv(n: bigint, d: bigint): bigint {
  if (n < ZERO)
    throw new RangeError("roundHalfUpDiv solo acepta numeradores mayores o iguales a 0.");
  if (d <= ZERO) throw new RangeError("roundHalfUpDiv solo acepta denominadores mayores que 0.");
  return (TWO * n + d) / (TWO * d);
}
