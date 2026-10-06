import "server-only";
import { getAppOrigin, getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { consumeShareQuota } from "@/lib/security/login-rate-limit";
import { hashShareToken, isWellFormedShareToken } from "./token";

/** Cabeceras de toda respuesta pública del enlace: nada se guarda en cachés ni en buscadores. */
export const PUBLIC_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

const RETRY_AFTER_SECONDS = 60;

export const TOO_MANY_REQUESTS_MESSAGE =
  "Hiciste muchas solicitudes en poco tiempo. Espera un minuto e inténtalo de nuevo.";

export function publicJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: PUBLIC_RESPONSE_HEADERS });
}

export function publicText(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { ...PUBLIC_RESPONSE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function tooManyRequests(): Response {
  return new Response(TOO_MANY_REQUESTS_MESSAGE, {
    status: 429,
    headers: {
      ...PUBLIC_RESPONSE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": String(RETRY_AFTER_SECONDS),
    },
  });
}

/**
 * Un POST público solo vale si viene de nuestra propia página: su cabecera `Origin` tiene que ser el
 * origen de la aplicación (`APP_ORIGIN`). Sin `Origin`, o con otro, se rechaza.
 */
export function isSameOriginPost(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(getAppOrigin()).origin;
  } catch {
    return false;
  }
}

export type TokenGate =
  { ok: true; tokenSha256: string } | { ok: false; reason: "malformed" | "rate_limited" };

/**
 * Las dos primeras puertas de toda petición al enlace, en este orden y antes de tocar la base de
 * datos: (1) el token tiene la forma de un token; (2) la IP y el enlace no pasaron su límite por
 * minuto. Los límites usan huellas: nunca el token ni la IP en claro.
 */
export async function passTokenGate(token: string): Promise<TokenGate> {
  if (!isWellFormedShareToken(token)) return { ok: false, reason: "malformed" };
  const tokenSha256 = hashShareToken(token);
  const { clientIp } = await getRequestContext();
  if (!(await consumeShareQuota(clientIp, tokenSha256))) {
    await serverLog("warn", "share_rate_limited");
    return { ok: false, reason: "rate_limited" };
  }
  return { ok: true, tokenSha256 };
}
