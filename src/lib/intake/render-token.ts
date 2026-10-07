import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Sello de tiempo del formulario público: se entrega al mostrar el formulario y se devuelve al
 * enviarlo. Sirve de trampa contra robots que envían al instante o reutilizan un sello viejo.
 *
 * Formato: `v1.<segundos desde 1970>.<firma base64url>`. La firma es HMAC-SHA256 de
 * `render|v1|<formPublicId>|<segundos>`, así un sello de un formulario no vale en otro.
 */
export const MIN_FILL_SECONDS = 3;
export const MAX_RENDER_AGE_SECONDS = 24 * 60 * 60;
/** Tolerancia entre relojes de servidores distintos antes de llamar «del futuro» a un sello. */
export const CLOCK_SKEW_SECONDS = 5;
export const MIN_RENDER_SECRET_LENGTH = 32;

const SECRET_VAR = "INTAKE_RENDER_SECRET";
const VERSION = "v1";
const MAX_TOKEN_LENGTH = 200;
const TOKEN_PATTERN = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

export class RenderTokenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderTokenConfigError";
  }
}

export type RenderTokenFailure = "malformed" | "bad_signature" | "too_fast" | "expired" | "future";

export type RenderTokenResult =
  { ok: true; issuedAt: number } | { ok: false; reason: RenderTokenFailure };

export type RenderTokenOptions = {
  /** Solo para pruebas; por defecto se lee `INTAKE_RENDER_SECRET`. */
  secret?: string;
  /** Segundos desde 1970. Solo para pruebas. */
  nowSeconds?: number;
};

function resolveSecret(secret: string | undefined): string {
  const value = secret ?? process.env[SECRET_VAR];
  if (!value || value.length < MIN_RENDER_SECRET_LENGTH) {
    throw new RenderTokenConfigError(
      `Falta ${SECRET_VAR} o es demasiado corta (mínimo ${MIN_RENDER_SECRET_LENGTH} caracteres).`,
    );
  }
  return value;
}

function nowSeconds(options: RenderTokenOptions): number {
  return options.nowSeconds ?? Math.floor(Date.now() / 1000);
}

function sign(secret: string, formPublicId: string, issuedAt: number): string {
  return createHmac("sha256", secret)
    .update(`render|${VERSION}|${formPublicId}|${issuedAt}`, "utf8")
    .digest("base64url");
}

/** Crea el sello para un formulario, con la hora actual. */
export function createRenderToken(formPublicId: string, options: RenderTokenOptions = {}): string {
  const secret = resolveSecret(options.secret);
  const issuedAt = nowSeconds(options);
  return `${VERSION}.${issuedAt}.${sign(secret, formPublicId, issuedAt)}`;
}

/** Comprueba firma, formulario y tiempo transcurrido. La firma se compara en tiempo constante. */
export function verifyRenderToken(
  token: unknown,
  formPublicId: string,
  options: RenderTokenOptions = {},
): RenderTokenResult {
  const secret = resolveSecret(options.secret);
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return { ok: false, reason: "malformed" };
  const issuedAt = Number(match[1]);
  if (!Number.isSafeInteger(issuedAt)) return { ok: false, reason: "malformed" };

  const expected = Buffer.from(sign(secret, formPublicId, issuedAt), "utf8");
  const received = Buffer.from(match[2], "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: "bad_signature" };
  }

  const age = nowSeconds(options) - issuedAt;
  if (age < -CLOCK_SKEW_SECONDS) return { ok: false, reason: "future" };
  if (age < MIN_FILL_SECONDS) return { ok: false, reason: "too_fast" };
  if (age > MAX_RENDER_AGE_SECONDS) return { ok: false, reason: "expired" };
  return { ok: true, issuedAt };
}
