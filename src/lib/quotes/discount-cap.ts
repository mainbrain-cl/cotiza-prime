/**
 * El descuento máximo de los Comerciales (H-041): cómo se escribe, cómo se dice y cómo se muestra junto a cada descuento.
 * Puro, sin React ni base de datos. El valor se guarda en centésimas de punto (1.000 = 10 %); vacío (`null`) = sin tope.
 * La regla que lo hace cumplir vive en `line-rules.ts` y en la base de datos.
 */
import { formatPercentBp } from "./format";
import { MAX_DISCOUNT_BP_LIMIT } from "./line-rules";
import { parsePercent } from "./parse";

export type MaxDiscountParse = { ok: true; value: number | null } | { ok: false; message: string };

export const MAX_DISCOUNT_TOO_HIGH_MESSAGE =
  "El máximo debe ser menor que 100 %. Escribe, por ejemplo, 10 o 12,5.";

/** Lo que escribe la persona: vacío = «Sin tope»; si no, un porcentaje de 0 a 99,99 con coma para los decimales. */
export function parseMaxDiscountText(text: string): MaxDiscountParse {
  if (text.trim() === "") return { ok: true, value: null };
  const parsed = parsePercent(text);
  if (!parsed.ok) return parsed;
  if (parsed.value > MAX_DISCOUNT_BP_LIMIT) {
    return { ok: false, message: MAX_DISCOUNT_TOO_HIGH_MESSAGE };
  }
  return { ok: true, value: parsed.value };
}

/** El tope guardado como texto del campo: `1000` -> `10`; sin tope -> vacío. */
export function maxDiscountToText(bp: number | null): string {
  return bp === null ? "" : formatPercentBp(bp);
}

/** La frase en vivo de la tarjeta del catálogo («Así quedará»). */
export function describeMaxDiscount(bp: number | null): string {
  if (bp === null) return "Sin tope: los Comerciales pueden dar el descuento que quieran.";
  if (bp === 0) return "Los Comerciales no podrán dar ningún descuento.";
  return `Los Comerciales podrán dar hasta ${formatPercentBp(bp)} % de descuento, en cada línea y en el descuento general.`;
}

/** Lo que se lee junto a cada campo de descuento del editor; `null` si no hay nada que decir (sin tope). */
export function maxDiscountHint(bp: number | null): string | null {
  if (bp === null) return null;
  if (bp === 0) return "Tu organización no permite descuentos";
  return `Máximo ${formatPercentBp(bp)} %`;
}

/**
 * La ayuda de la casilla «Bloquear el precio» del catálogo. Dice con honestidad qué pasa con el descuento: el candado fija el PRECIO,
 * pero los Comerciales siguen pudiendo dar descuento hasta el máximo de la organización. `maxDiscountBp` `undefined` = no se sabe
 * el tope aquí (no se afirma nada del valor de hoy); `null` = sin tope.
 */
export function priceLockHelp(maxDiscountBp?: number | null): string {
  let today = "";
  if (maxDiscountBp === null) today = " (hoy: sin tope)";
  else if (maxDiscountBp === 0) today = " (hoy: ningún descuento)";
  else if (maxDiscountBp !== undefined) today = ` (hoy: ${formatPercentBp(maxDiscountBp)} %)`;
  return `Al cotizar, los Comerciales no podrán cambiar este precio, pero sí darle descuento hasta el descuento máximo de los Comerciales${today}. El Dueño y los Administradores sí pueden cambiar el precio, y queda registrado.`;
}

/**
 * El aviso de la tarjeta del tope cuando hay servicios con el precio bloqueado y no hay tope: ahí el candado no limita el descuento.
 * `null` si no hace falta decir nada.
 */
export function lockedWithoutCapNotice(
  maxDiscountBp: number | null,
  lockedServices: number,
): string | null {
  if (maxDiscountBp !== null || lockedServices <= 0) return null;
  return "Hay servicios con precio bloqueado y no hay tope: los Comerciales pueden darles cualquier descuento.";
}
