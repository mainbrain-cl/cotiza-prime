/** Mínimo de dígitos de un teléfono para considerarlo posible. */
export const PHONE_MIN_DIGITS = 6;
const PHONE_PATTERN = /^\+?[0-9()\s-]{1,30}$/;

/** Teléfono con forma razonable: dígitos, espacios, guiones, paréntesis y `+` inicial, con al menos 6 dígitos. */
export function isPlausiblePhone(value: string): boolean {
  if (!PHONE_PATTERN.test(value)) return false;
  return value.replace(/\D/g, "").length >= PHONE_MIN_DIGITS;
}

/** Máximo de dígitos de un número internacional (E.164). */
export const PHONE_MAX_DIGITS = 15;

/** Recorta, pasa a NFC y deja un solo espacio donde había varios. No cambia dígitos ni signos. */
export function normalizePhone(input: string): string {
  return input.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** Forma razonable (`isPlausiblePhone`) y no más de 15 dígitos. */
export function isValidPhone(value: string): boolean {
  return isPlausiblePhone(value) && value.replace(/\D/g, "").length <= PHONE_MAX_DIGITS;
}
