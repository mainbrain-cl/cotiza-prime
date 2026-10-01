/**
 * RUT chileno: normalización, dígito verificador y formato.
 * Se usa en el navegador para avisar al instante; el servidor (la base de datos) siempre vuelve a
 * validar y es quien manda (`app.is_valid_rut`).
 */

const RUT_BODY_MAX_DIGITS = 8;

/** Forma canónica: sin puntos, con guion, dígito verificador en mayúscula, sin ceros a la izquierda. */
export function normalizeRut(raw: string): string | null {
  const compact = raw.replace(/[.\s-]/g, "").toUpperCase();
  if (!/^[0-9]+[0-9K]$/.test(compact)) return null;
  const body = compact.slice(0, -1).replace(/^0+/, "");
  if (body === "") return null;
  return `${body}-${compact.slice(-1)}`;
}

export function computeCheckDigit(body: string): string {
  let total = 0;
  let weight = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    total += Number(body[i]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const result = 11 - (total % 11);
  if (result === 11) return "0";
  if (result === 10) return "K";
  return String(result);
}

export function isValidRut(raw: string): boolean {
  const rut = normalizeRut(raw);
  if (rut === null) return false;
  const [body, digit] = rut.split("-");
  if (body.length > RUT_BODY_MAX_DIGITS) return false;
  return computeCheckDigit(body) === digit;
}

/** `761234567` o `76123456-7` pasan a `76.123.456-7`. Si no se puede normalizar, devuelve lo que hay. */
export function formatRut(raw: string): string {
  const rut = normalizeRut(raw);
  if (rut === null) return raw;
  const [body, digit] = rut.split("-");
  return `${body.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${digit}`;
}
