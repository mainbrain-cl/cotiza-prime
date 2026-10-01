/** Mínimo de dígitos de un teléfono para considerarlo posible. */
export const PHONE_MIN_DIGITS = 6;
const PHONE_PATTERN = /^\+?[0-9()\s-]{1,30}$/;

/** Teléfono con forma razonable: dígitos, espacios, guiones, paréntesis y `+` inicial, con al menos 6 dígitos. */
export function isPlausiblePhone(value: string): boolean {
  if (!PHONE_PATTERN.test(value)) return false;
  return value.replace(/\D/g, "").length >= PHONE_MIN_DIGITS;
}
