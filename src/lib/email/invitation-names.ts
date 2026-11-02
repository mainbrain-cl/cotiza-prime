import { HEADER_UNSAFE } from "./unsafe-characters";

/**
 * Los nombres que llevan los correos de invitación (el de quien invita y el de la organización) son TEXTO que
 * escribieron personas. Se limpian de caracteres de control y de caracteres invisibles; si después de limpiar no
 * queda nada (un nombre de puros espacios o de caracteres invisibles), se usa un texto de respaldo y el correo
 * SALE igual: un nombre raro nunca puede impedir un correo, y menos un aviso de seguridad al Dueño.
 * El respaldo vive aquí, en un solo lugar.
 */
export const FALLBACK_INVITER_NAME = "Un miembro del equipo";
export const FALLBACK_ORGANIZATION_NAME = "una organización";

const UNSAFE_GLOBAL = new RegExp(HEADER_UNSAFE.source, "g");

/** Texto limpio de una sola línea, o `fallback` si queda vacío. */
export function cleanName(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? "").replace(UNSAFE_GLOBAL, " ").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

/** Texto limpio de una sola línea (puede quedar vacío). Para los demás campos del correo. */
export function cleanText(value: string): string {
  return value.replace(UNSAFE_GLOBAL, " ").replace(/\s+/g, " ").trim();
}

const MAX_SUBJECT_LENGTH = 150;
/** Largos de nombre (en caracteres visibles, no en unidades) que se prueban para que el asunto quepa. */
const SUBJECT_NAME_LENGTHS = [50, 20, 10] as const;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Parte un texto en caracteres visibles: un emoji compuesto (bandera, tono de piel, familia) cuenta como uno. */
function visibleChars(value: string): string[] {
  return Array.from(graphemes.segment(value), (part) => part.segment);
}

/** Corta por caracteres visibles (nunca parte un emoji ni una bandera por la mitad) y agrega «…». */
export function shortenName(value: string, max: number): string {
  const chars = visibleChars(value);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
}

/** Último recurso: corta a `limit` unidades sin partir un carácter visible. */
function cutToLength(value: string, limit: number): string {
  let out = "";
  for (const char of visibleChars(value)) {
    if (out.length + char.length > limit) break;
    out += char;
  }
  return out;
}

/**
 * Arma el asunto con nombres recortados por caracteres visibles. Si con 50 por nombre no cabe en 150 unidades
 * (emojis y letras raras ocupan dos o más), se reintenta con nombres más cortos: un nombre raro NUNCA impide el correo.
 */
export function fitSubject(build: (shorten: (name: string) => string) => string): string {
  let subject = "";
  for (const max of SUBJECT_NAME_LENGTHS) {
    subject = build((name) => shortenName(name, max));
    if (subject.length <= MAX_SUBJECT_LENGTH) return subject;
  }
  return cutToLength(subject, MAX_SUBJECT_LENGTH);
}
