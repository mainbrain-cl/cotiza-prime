/**
 * Textos listos para usar (H-048a): lo que no depende de la base de datos ni del servidor.
 *
 * Aquí viven los topes, los tipos de texto, las cuatro variables que se pueden poner dentro del texto del
 * correo, la revisión de esas variables y la limpieza del valor que se inserta en cada una. Es puro (sin
 * `server-only`, sin base de datos) para que lo usen igual el servidor, el navegador y las pruebas.
 *
 * Las constantes y las reglas de este archivo tienen una GEMELA en la migración `text_snippets`
 * (`app.snippet_*`): `tests/db/text-snippets.test.ts` falla si alguna de las dos cambia sola.
 */

/** Cuántos textos guardados puede tener una organización. */
export const SNIPPETS_MAX_PER_TENANT = 50;
export const SNIPPET_NAME_MAX_LENGTH = 80;
/** Igual al máximo de las observaciones y condiciones de una cotización (`QUOTE_TEXT_MAX_LENGTH`). */
export const SNIPPET_BODY_MAX_LENGTH = 4_000;
/** Cuántas variables (contando las repetidas) puede llevar un texto del correo. */
export const SNIPPET_MAX_VARIABLES = 10;
/** Largo máximo de lo que se inserta en el lugar de cada variable. */
export const SNIPPET_VARIABLE_VALUE_MAX_LENGTH = 100;
/** Mayor número de revisión posible: el máximo de un entero de 32 bits de la base (`revision integer`). */
export const SNIPPET_REVISION_MAX = 2_147_483_647;

/** Los tipos de texto guardado. El orden es el de la pantalla y el del PDF. */
export const SNIPPET_KINDS = ["email_body", "conditions", "exclusions", "footer_note"] as const;
export type SnippetKind = (typeof SNIPPET_KINDS)[number];

/** Cómo se llama cada tipo en la pantalla. */
export const SNIPPET_KIND_LABELS: Readonly<Record<SnippetKind, string>> = {
  email_body: "Texto del correo",
  conditions: "Condiciones comerciales",
  exclusions: "Exclusiones",
  footer_note: "Notas al pie",
};

/** Solo el texto del correo admite variables y texto inicial. */
export const SNIPPET_KIND_WITH_VARIABLES: SnippetKind = "email_body";

export function isSnippetKind(value: unknown): value is SnippetKind {
  return typeof value === "string" && (SNIPPET_KINDS as readonly string[]).includes(value);
}

/** Las únicas variables que existen. Se escriben `{{cliente}}`, `{{numero}}`, etc. */
export const SNIPPET_VARIABLES = ["cliente", "numero", "remitente", "organizacion"] as const;
export type SnippetVariable = (typeof SNIPPET_VARIABLES)[number];

/** Qué es cada variable, para los botones de la pantalla. */
export const SNIPPET_VARIABLE_LABELS: Readonly<Record<SnippetVariable, string>> = {
  cliente: "Nombre del cliente",
  numero: "Número de la cotización",
  remitente: "Tu nombre",
  organizacion: "Nombre de tu organización",
};

/** Con qué se reemplaza una variable cuando no hay dato (`{{cliente}}` queda «cliente», como hoy). */
const VARIABLE_FALLBACKS: Readonly<Record<SnippetVariable, string>> = {
  cliente: "cliente",
  numero: "",
  remitente: "",
  organizacion: "",
};

/** La variable tal como se escribe dentro del texto. */
export const variableToken = (variable: SnippetVariable): string => `{{${variable}}}`;

export function isSnippetVariable(value: string): value is SnippetVariable {
  return (SNIPPET_VARIABLES as readonly string[]).includes(value);
}

// Una variable: dos llaves, algo sin llaves, dos llaves. La misma forma que usa la base (`app.snippet_*`).
const VARIABLE_PATTERN = /\{\{([^{}]*)\}\}/g;

// ---------------------------------------------------------------------------------------------------
// Caracteres que no se aceptan: los MISMOS de `app.intake_text_unsafe` en la base (control, invisibles,
// ancho cero, marcas de dirección). Se arman desde rangos para que el archivo no lleve caracteres
// invisibles escritos a mano. Es más estricto que el control de las observaciones y condiciones de la
// cotización (esas solo rechazan los de control), a propósito: estos textos se insertan en cotizaciones.
// `tests/db/text-snippets.test.ts` comprueba, carácter por carácter, que la base y este archivo coincidan.
// ---------------------------------------------------------------------------------------------------

type Range = readonly [from: number, to: number];

const BACKSLASH = String.fromCharCode(92);
const escapeCode = (code: number): string =>
  code > 0xffff
    ? `${BACKSLASH}u{${code.toString(16)}}`
    : `${BACKSLASH}u${code.toString(16).padStart(4, "0")}`;

function classOf(ranges: readonly Range[]): RegExp {
  const body = ranges
    .map(([from, to]) => (from === to ? escapeCode(from) : `${escapeCode(from)}-${escapeCode(to)}`))
    .join("");
  return new RegExp(`[${body}]`, "u");
}

const INVISIBLE_AND_DIRECTIONAL: readonly Range[] = [
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x115f, 0x1160],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0x3164, 0x3164],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
];

/** Texto de varias líneas: se permiten el tabulador (09) y el salto de línea (0A). */
export const SNIPPET_UNSAFE_MULTILINE = classOf([
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  ...INVISIBLE_AND_DIRECTIONAL,
]);

/** Texto de una sola línea (el nombre): tampoco tabuladores ni saltos de línea. */
export const SNIPPET_UNSAFE_SINGLE_LINE = classOf([[0x0000, 0x001f], ...INVISIBLE_AND_DIRECTIONAL]);

export const hasUnsafeSnippetCharacters = (text: string, multiline: boolean): boolean =>
  (multiline ? SNIPPET_UNSAFE_MULTILINE : SNIPPET_UNSAFE_SINGLE_LINE).test(text);

/** Largo como lo cuenta la base (`char_length`): por carácter, no por unidad de UTF-16. */
export const snippetLength = (text: string): number => Array.from(text).length;

const EDGE_WHITESPACE = /^[ \t\n]+|[ \t\n]+$/g;

/** Quita espacios, tabuladores y saltos de línea de los bordes (igual que `btrim(x, ' ' || tab || newline)` en la base). */
export const trimSnippetEdges = (text: string): string => text.replace(EDGE_WHITESPACE, "");

/** Nombre listo para guardar: en forma NFC (la tilde unida a la letra) y sin espacios en los bordes. */
export const normalizeSnippetName = (raw: string): string => trimSnippetEdges(raw.normalize("NFC"));

/**
 * Texto listo para guardar: en forma NFC, los saltos de línea de Windows pasan a uno solo y sin espacios en los
 * bordes.
 */
export const normalizeSnippetBody = (raw: string): string =>
  trimSnippetEdges(raw.normalize("NFC").replace(/\r\n?/g, "\n"));

// ---------------------------------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------------------------------

export type SnippetVariableProblem =
  "variables_not_allowed" | "unknown_variable" | "too_many_variables" | "variable_in_link";

/** Mensajes para quien escribe el texto (la base responde con el mismo código en `message`). */
export const SNIPPET_VARIABLE_PROBLEM_MESSAGES: Readonly<Record<SnippetVariableProblem, string>> = {
  variables_not_allowed:
    "Las variables entre llaves ({{ }}) solo se pueden usar en el texto del correo. Quita las llaves dobles de este texto.",
  unknown_variable: `Hay una variable que no existe o llaves sueltas. Las variables disponibles son ${SNIPPET_VARIABLES.map(variableToken).join(", ")}.`,
  too_many_variables: `El texto tiene demasiadas variables: el máximo es ${SNIPPET_MAX_VARIABLES}.`,
  variable_in_link:
    "No puedes poner una variable dentro de la dirección de un enlace: el nombre del cliente decidiría adónde lleva. Escribe la dirección completa, o deja la variable fuera del paréntesis del enlace.",
};

export type VariableCheck =
  | { ok: true; variables: SnippetVariable[] }
  | { ok: false; problem: SnippetVariableProblem; message: string };

const fail = (problem: SnippetVariableProblem): VariableCheck => ({
  ok: false,
  problem,
  message: SNIPPET_VARIABLE_PROBLEM_MESSAGES[problem],
});

/**
 * ¿Hay una variable dentro de la dirección de un enlace, como `[texto]({{cliente}})` o `[texto](https://{{cliente}}/x)`? El nombre del
 * cliente puede venir del formulario público (lo escribe cualquiera) y el de la organización lo escribe quien la administra: ninguno
 * debe decidir adónde lleva un enlace del correo (revisión de Aarón al PR #67). Gemela de la revisión de `app.snippet_variables_problem`: busca `](` y, antes de cerrar el paréntesis o
 * cambiar de línea, unas llaves dobles.
 */
export const hasVariableInLinkTarget = (text: string): boolean => /\]\([^)\n]*\{\{/.test(text);

/** Las variables que aparecen en el texto, en orden y con repetidas (sin revisar que existan). */
export function findVariableTokens(text: string): string[] {
  return Array.from(text.matchAll(VARIABLE_PATTERN), (match) => match[1]);
}

/**
 * Revisa las variables de un texto. Las reglas (la base aplica las mismas):
 *  - Fuera del texto del correo no se aceptan llaves dobles (`{{` ni `}}`).
 *  - En el texto del correo solo valen las cuatro variables, escritas exactamente (`{{cliente}}`, sin espacios),
 *    hasta 10 en total. Cualquier llave que no forme parte de una variable es un error: así lo que se
 *    inserte después jamás puede formar una variable nueva.
 *  - Una variable no puede ir dentro de la dirección de un enlace (`hasVariableInLinkTarget`).
 */
export function checkSnippetVariables(kind: SnippetKind, text: string): VariableCheck {
  if (kind !== SNIPPET_KIND_WITH_VARIABLES) {
    return text.includes("{{") || text.includes("}}")
      ? fail("variables_not_allowed")
      : { ok: true, variables: [] };
  }
  const names = findVariableTokens(text);
  if (!names.every(isSnippetVariable)) return fail("unknown_variable");
  const rest = text.replace(VARIABLE_PATTERN, "");
  if (rest.includes("{") || rest.includes("}")) return fail("unknown_variable");
  if (names.length > SNIPPET_MAX_VARIABLES) return fail("too_many_variables");
  if (hasVariableInLinkTarget(text)) return fail("variable_in_link");
  return { ok: true, variables: names as SnippetVariable[] };
}

// Tabulador, saltos de línea y separadores de línea o de párrafo: pasan a un espacio.
const LINE_BREAKS_AND_TABS = new RegExp(
  `[${[0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029].map(escapeCode).join("")}]+`,
  "gu",
);
const REPEATED_SPACES = / {2,}/g;

/**
 * Limpia lo que se va a insertar en el lugar de una variable (por ejemplo, el nombre de un cliente).
 *
 *  - Los saltos de línea y tabuladores pasan a un espacio; los demás caracteres de control e invisibles se quitan.
 *  - `**` pasa a `*` y `](` pasa a `] (`: un nombre no puede volverse negrita ni enlace.
 *  - Cada llave queda separada de la siguiente (`{ {`): lo insertado no puede formar una variable nueva.
 *  - Los bordes también se protegen, porque dos valores pueden quedar pegados (`{{organizacion}}{{cliente}}`):
 *    si empieza con `(` o `*` se le antepone un espacio, y si termina en `]` o `*` se le agrega uno al final.
 *    Así `[Org]` junto a `(https://...)` no forma un enlace, ni `Ana*` junto a `*Juan` una negrita.
 *  - Se corta a `maxLength` caracteres (por defecto `SNIPPET_VARIABLE_VALUE_MAX_LENGTH`), contando esos espacios.
 * Si no queda nada, devuelve texto vacío (el que llama decide qué poner).
 */
export function sanitizeVariableValue(
  value: string,
  maxLength: number = SNIPPET_VARIABLE_VALUE_MAX_LENGTH,
): string {
  const cleaned = trimSnippetEdges(
    value
      .replace(LINE_BREAKS_AND_TABS, " ")
      .replace(new RegExp(SNIPPET_UNSAFE_SINGLE_LINE.source, "gu"), "")
      .replace(REPEATED_SPACES, " "),
  )
    .replace(/\*{2,}/g, "*")
    .replaceAll("](", "] (")
    // Toda `{` queda seguida de un espacio y toda `}` precedida de uno: ni dentro del valor ni entre dos
    // valores pegados pueden quedar dos llaves iguales juntas.
    .replaceAll("{", "{ ")
    .replaceAll("}", " }");
  const characters = Array.from(cleaned);
  let limit = maxLength;
  while (limit > 0) {
    // Si el corte dejó una `{` o un espacio al final, se quitan (junto a ellos iría el valor que sigue).
    const core = characters
      .slice(0, limit)
      .join("")
      .replace(/[\s{]+$/u, "");
    const lead = /^[(*]/.test(core) ? " " : "";
    const trail = /[\]*]$/.test(core) ? " " : "";
    const overflow = snippetLength(core) + lead.length + trail.length - maxLength;
    if (overflow <= 0) return `${lead}${core}${trail}`;
    limit -= overflow;
  }
  return "";
}

export type SnippetVariableValues = Readonly<Record<SnippetVariable, string | null | undefined>>;

/**
 * Completa las variables de un texto del correo. UN SOLO paso: lo que se inserta no se vuelve a revisar, así
 * que un cliente que se llame `{{numero}}` aparece tal cual (con las llaves separadas) y no se reemplaza.
 * Una variable que no es una de las cuatro se deja como está (la revisión la rechaza antes de guardar).
 */
export function renderVariables(text: string, values: SnippetVariableValues): string {
  return text.replace(VARIABLE_PATTERN, (match, name: string) => {
    if (!isSnippetVariable(name)) return match;
    const clean = sanitizeVariableValue(values[name] ?? "");
    return clean === "" ? VARIABLE_FALLBACKS[name] : clean;
  });
}

/** ¿Le queda alguna variable sin completar? (para no enviar un correo con `{{cliente}}` escrito). */
export const hasUnresolvedVariables = (text: string): boolean =>
  findVariableTokens(text).some(isSnippetVariable);
