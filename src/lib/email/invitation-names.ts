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
