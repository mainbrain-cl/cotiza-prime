/**
 * Caracteres que no pueden ir en cabeceras ni en el texto de un correo: sirven para inyectar
 * cabeceras (CR, LF), esconder texto o disfrazarlo (marcas de dirección, ancho cero).
 * Las expresiones se arman desde rangos numéricos para que el archivo no lleve caracteres
 * invisibles escritos a mano.
 */

type Range = readonly [from: number, to: number];

const BACKSLASH = String.fromCharCode(92);
const hex = (code: number) => `${BACKSLASH}u${code.toString(16).padStart(4, "0")}`;

function classOf(ranges: readonly Range[]): RegExp {
  const body = ranges
    .map(([from, to]) => (from === to ? hex(from) : `${hex(from)}-${hex(to)}`))
    .join("");
  return new RegExp(`[${body}]`);
}

const C0_AND_C1_EXCEPT_TAB_LF: readonly Range[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
];
const TAB_AND_LF: readonly Range[] = [[0x09, 0x0a]];
const LINE_SEPARATORS: readonly Range[] = [[0x2028, 0x2029]];
const HIDDEN_OR_DIRECTIONAL: readonly Range[] = [
  [0x200b, 0x200f], // ancho cero y marcas de dirección
  [0x202a, 0x202e], // anulaciones bidi
  [0x2060, 0x2069], // unión de palabras e isolates bidi
  [0xfeff, 0xfeff], // BOM
];

/** Para cabeceras (asunto, nombres, direcciones): también prohíbe tabulador y saltos de línea. */
export const HEADER_UNSAFE = classOf([
  ...C0_AND_C1_EXCEPT_TAB_LF,
  ...TAB_AND_LF,
  ...LINE_SEPARATORS,
  ...HIDDEN_OR_DIRECTIONAL,
]);

/** Para el cuerpo: se permiten tabulador y salto de línea. */
export const BODY_UNSAFE = classOf([
  ...C0_AND_C1_EXCEPT_TAB_LF,
  ...LINE_SEPARATORS,
  ...HIDDEN_OR_DIRECTIONAL,
]);
