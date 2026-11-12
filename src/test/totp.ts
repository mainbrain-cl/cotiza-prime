/**
 * Generador de códigos de 6 números (TOTP, RFC 6238) SOLO para pruebas: calcula el código que mostraría
 * la aplicación de la persona a partir de la clave que entrega Supabase al activar la verificación en dos
 * pasos. Usa `node:crypto`; no es una dependencia nueva. No se importa desde código de la aplicación.
 */
import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BITS_PER_BASE32_CHAR = 5;
const BITS_PER_BYTE = 8;
const DEFAULT_STEP_SECONDS = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_MIN_SECONDS_LEFT = 5;
const MS_PER_SECOND = 1000;
const DYNAMIC_TRUNCATION_MASK = 0x0f;
const POSITIVE_INT32_MASK = 0x7fffffff;
const COUNTER_BYTES = 8;
const HIGH_WORD_DIVISOR = 2 ** 32;

/** Clave en base32 (se ignoran espacios, guiones y el relleno `=`) a bytes. */
export function base32ToBuffer(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Carácter fuera de base32: ${char}`);
    value = (value << BITS_PER_BASE32_CHAR) | index;
    bits += BITS_PER_BASE32_CHAR;
    if (bits >= BITS_PER_BYTE) {
      bits -= BITS_PER_BYTE;
      bytes.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

type TotpOptions = { step?: number; digits?: number };

/** El código que corresponde al instante `unixSeconds` (HMAC-SHA1 con truncado dinámico). */
export function totpAt(
  secret: string,
  unixSeconds: number,
  { step = DEFAULT_STEP_SECONDS, digits = DEFAULT_DIGITS }: TotpOptions = {},
): string {
  const counter = Math.floor(unixSeconds / step);
  const message = Buffer.alloc(COUNTER_BYTES);
  message.writeUInt32BE(Math.floor(counter / HIGH_WORD_DIVISOR), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", base32ToBuffer(secret)).update(message).digest();
  const offset = hmac[hmac.length - 1] & DYNAMIC_TRUNCATION_MASK;
  const binary = hmac.readUInt32BE(offset) & POSITIVE_INT32_MASK;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export type FreshTotp = { code: string; step: number };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Un código que sirva ahora. Si al período actual le quedan menos de `minSecondsLeft` segundos, o es el
 * período a evitar (`avoidStep`: el de un código ya usado), espera al siguiente. Devuelve también el número
 * de período, para pasarlo como `avoidStep` la próxima vez.
 */
export async function freshTotp(
  secret: string,
  {
    avoidStep,
    minSecondsLeft = DEFAULT_MIN_SECONDS_LEFT,
    step = DEFAULT_STEP_SECONDS,
    digits = DEFAULT_DIGITS,
    now = () => Date.now(),
    wait = sleep,
  }: {
    avoidStep?: number;
    minSecondsLeft?: number;
    step?: number;
    digits?: number;
    /** Solo para probar la espera sin esperar de verdad. */
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<FreshTotp> {
  for (;;) {
    const seconds = now() / MS_PER_SECOND;
    const current = Math.floor(seconds / step);
    const left = (current + 1) * step - seconds;
    if (current !== avoidStep && left >= minSecondsLeft) {
      return { code: totpAt(secret, seconds, { step, digits }), step: current };
    }
    // Hasta el comienzo del período siguiente (más un margen para no caer justo en el borde).
    await wait(Math.ceil(left * MS_PER_SECOND) + 50);
  }
}
