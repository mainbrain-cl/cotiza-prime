// RUT chileno: normalizar, validar, formatear y generar. Debe coincidir con app.normalize_rut /
// app.is_valid_rut de la base de datos (hay una prueba en tests/db/rut-parity.test.ts).

const MAX_BODY_DIGITS = 8;
const MOD = 11;
const FIRST_WEIGHT = 2;
const LAST_WEIGHT = 7;
const CANONICAL_PATTERN = new RegExp(`^[1-9][0-9]{0,${MAX_BODY_DIGITS - 1}}-[0-9K]$`);

/** Dígito verificador (módulo 11) de la parte numérica del RUT. */
export function computeCheckDigit(body: string): string {
  let total = 0;
  let weight = FIRST_WEIGHT;
  for (let i = body.length - 1; i >= 0; i--) {
    total += Number(body[i]) * weight;
    weight = weight === LAST_WEIGHT ? FIRST_WEIGHT : weight + 1;
  }
  const calc = MOD - (total % MOD);
  if (calc === 11) return "0";
  if (calc === 10) return "K";
  return String(calc);
}

/** Forma canónica `76123456-7`, o null si no tiene forma de RUT. No valida el dígito. */
export function normalizeRut(input: string | null | undefined): string | null {
  const cleaned = (input ?? "").replace(/[.\s-]/g, "").toUpperCase();
  if (!/^[0-9]+[0-9K]$/.test(cleaned)) return null;
  const body = cleaned.slice(0, -1).replace(/^0+/, "");
  if (body === "") return null;
  return `${body}-${cleaned.slice(-1)}`;
}

/** Verdadero solo si la entrada está en forma canónica y el dígito verificador calza. */
export function isValidRut(canonical: string | null | undefined): boolean {
  if (canonical == null || !CANONICAL_PATTERN.test(canonical)) return false;
  const [body, dv] = canonical.split("-");
  return computeCheckDigit(body) === dv;
}

/** Normaliza y valida: devuelve el RUT canónico o null si no es válido. */
export function parseRut(input: string | null | undefined): string | null {
  const canonical = normalizeRut(input);
  return isValidRut(canonical) ? canonical : null;
}

/** Formato de pantalla `76.123.456-7`. Devuelve null si el RUT no es válido. */
export function formatRut(input: string): string | null {
  const canonical = parseRut(input);
  if (!canonical) return null;
  const [body, dv] = canonical.split("-");
  return `${body.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${dv}`;
}

/** RUT válido y ficticio para pruebas. `random` permite resultados repetibles. */
export function generateRut(random: () => number = Math.random): string {
  const min = 1_000_000;
  const max = 99_999_999;
  const body = String(min + Math.floor(random() * (max - min + 1)));
  return `${body}-${computeCheckDigit(body)}`;
}
