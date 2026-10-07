/**
 * Caracteres que no pueden ir en lo que escribe un visitante: controles, de dirección invertida e
 * invisibles. Sirven para disfrazar texto, esconderlo o romper cabeceras y planillas. Las
 * expresiones se arman desde rangos numéricos para que el archivo no lleve caracteres invisibles
 * escritos a mano.
 */

type Range = readonly [from: number, to: number];

const CONTROL_EXCEPT_TAB_LF: readonly Range[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
];
const TAB_AND_LF: readonly Range[] = [[0x09, 0x0a]];
const INVISIBLE_OR_DIRECTIONAL: readonly Range[] = [
  [0x00ad, 0x00ad], // guion blando
  [0x034f, 0x034f], // unión de grafemas
  [0x115f, 0x1160], // rellenos de hangul
  [0x180e, 0x180e], // separador mongol
  [0x200b, 0x200f], // ancho cero y marcas de dirección
  [0x2028, 0x2029], // separadores de línea y de párrafo
  [0x202a, 0x202e], // anulaciones de dirección
  [0x2060, 0x2064], // unión de palabras y operadores invisibles
  [0x2066, 0x2069], // aislamientos de dirección
  [0x3164, 0x3164], // relleno de hangul
  [0xfeff, 0xfeff], // marca de orden de bytes
  [0xffa0, 0xffa0], // relleno de hangul de ancho medio
  [0xfff9, 0xfffb], // anotaciones entrelazadas
  [0xe0000, 0xe007f], // etiquetas
];

function classOf(ranges: readonly Range[]): RegExp {
  const hex = (code: number) => `\\u{${code.toString(16)}}`;
  const body = ranges
    .map(([from, to]) => (from === to ? hex(from) : `${hex(from)}-${hex(to)}`))
    .join("");
  return new RegExp(`[${body}]`, "u");
}

/** Para textos de una línea: tampoco se permiten tabulador ni salto de línea. */
export const SINGLE_LINE_UNSAFE = classOf([
  ...CONTROL_EXCEPT_TAB_LF,
  ...TAB_AND_LF,
  ...INVISIBLE_OR_DIRECTIONAL,
]);

/** Para el mensaje: se permiten tabulador y salto de línea. */
export const MULTI_LINE_UNSAFE = classOf([...CONTROL_EXCEPT_TAB_LF, ...INVISIBLE_OR_DIRECTIONAL]);

/** Un par de sustitución suelto (UTF-16 mal formado) tampoco es texto válido. */
export function hasLoneSurrogate(value: string): boolean {
  return !value.isWellFormed();
}
