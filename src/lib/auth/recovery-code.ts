import "server-only";
import { randomBytes } from "node:crypto";
import { searchHash } from "@/lib/crypto/search-hash";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";

/**
 * Códigos de respaldo del segundo paso (H-004b, §3.2 del diseño): piezas PURAS, sin base de datos.
 *
 * - Un juego son 10 códigos de 12 símbolos (60 bits de azar cada uno), del alfabeto Crockford: 32 símbolos, sin I, L, O ni U
 *   (no se confunden al copiarlos a mano). Se muestran en grupos de 4 con guion: `7KQM-3XHP-W2RT`.
 * - Se generan con `node:crypto` (`randomBytes`). Como 256 es múltiplo de 32, tomar los 5 bits bajos de cada byte no sesga
 *   ningún símbolo.
 * - En la base solo queda la HUELLA del código (HMAC-SHA256 con la llave `CP_SEARCH_KEY_V1`), atada a la cuenta: el mismo
 *   código escrito en otra cuenta da otra huella, y sin la llave las huellas no sirven para adivinar nada.
 * - Nada de aquí se registra ni se audita: ni el código, ni su forma normalizada, ni su huella (guardia 14b).
 */

/** Cuántos códigos tiene un juego. Lo exige la base (`mfa_recovery_codes_replace`). */
export const RECOVERY_CODES_PER_SET = 10;
/** Símbolos de cada código (sin guiones). */
export const RECOVERY_CODE_LENGTH = 12;
/** Cuántos símbolos van en cada grupo al mostrarlo. */
const RECOVERY_CODE_GROUP_SIZE = 4;
/** Alfabeto Crockford: 32 símbolos, sin I, L, O ni U. */
export const RECOVERY_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ALPHABET_MASK = RECOVERY_CODE_ALPHABET.length - 1;
/** Propósito de la huella (el primer campo del HMAC): separa estas huellas de las de cualquier otro uso de la llave. */
const HASH_PURPOSE = "mfa_recovery_code";

/** Lo más largo que se acepta escrito (un código con guiones y espacios de sobra): más que eso ni se mira. */
const MAX_TYPED_LENGTH = 64;
const NORMALIZED_PATTERN = new RegExp(`^[${RECOVERY_CODE_ALPHABET}]{${RECOVERY_CODE_LENGTH}}$`);

function generateOneCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += RECOVERY_CODE_ALPHABET[byte & ALPHABET_MASK];
  return code;
}

/**
 * Genera un juego de 10 códigos distintos, SIN guiones (la forma normalizada). Muéstralos con `formatRecoveryCode`.
 */
export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODES_PER_SET) codes.add(generateOneCode());
  return [...codes];
}

/** `7KQM3XHPW2RT` → `7KQM-3XHP-W2RT`. */
export function formatRecoveryCode(code: string): string {
  const groups: string[] = [];
  for (let index = 0; index < code.length; index += RECOVERY_CODE_GROUP_SIZE) {
    groups.push(code.slice(index, index + RECOVERY_CODE_GROUP_SIZE));
  }
  return groups.join("-");
}

/** Guiones de Unicode (el de unir, el no separable, el medio, el largo, la barra horizontal) y el signo menos. */
const UNICODE_DASH_FIRST = 0x2010;
const UNICODE_DASH_LAST = 0x2015;
const MINUS_SIGN = 0x2212;

/** Espacios y toda clase de guiones: el normal y los que pega un procesador de texto. */
function isSeparator(symbol: string): boolean {
  const code = symbol.codePointAt(0) ?? 0;
  return (
    /\s/.test(symbol) ||
    symbol === "-" ||
    (code >= UNICODE_DASH_FIRST && code <= UNICODE_DASH_LAST) ||
    code === MINUS_SIGN
  );
}

/**
 * Lo que escribió la persona → la forma normalizada, o `null` si no es un código con la forma correcta. Pasa a mayúsculas,
 * quita espacios y guiones, y corrige las confusiones de Crockford (O → 0, I y L → 1). Si no quedan exactamente 12 símbolos
 * del alfabeto, devuelve `null`: así un texto mal escrito nunca llega a la base ni gasta un intento.
 */
export function normalizeRecoveryCode(input: string): string | null {
  if (typeof input !== "string" || input.length > MAX_TYPED_LENGTH) return null;
  const cleaned = [...input.normalize("NFKC")]
    .filter((symbol) => !isSeparator(symbol))
    .join("")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return NORMALIZED_PATTERN.test(cleaned) ? cleaned : null;
}

/** La huella (64 caracteres hexadecimales) de un código YA normalizado, atada a la cuenta. */
export function recoveryCodeHash(userId: string, normalizedCode: string): string {
  return searchHash(HASH_PURPOSE, PLATFORM_TENANT_ID, `${userId}|${normalizedCode}`);
}

/** Las huellas de un juego de códigos normalizados, en el mismo orden. */
export function recoveryCodeHashes(userId: string, normalizedCodes: readonly string[]): string[] {
  return normalizedCodes.map((code) => recoveryCodeHash(userId, code));
}
