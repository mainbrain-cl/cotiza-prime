import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { headers } from "next/headers";

const USER_AGENT_MAX_LENGTH = 300;

export type RequestContext = {
  /** Identificador para seguir una petición en los registros. */
  requestId: string;
  /** Orientativo: viene de la cabecera que agrega la plataforma de despliegue. */
  clientIp: string | null;
  userAgent: string | null;
};

/** Origen y correlación de la petición actual, para auditoría. No es una prueba, es una pista. */
export async function getRequestContext(): Promise<RequestContext> {
  const requestHeaders = await headers();
  const forwarded = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const clientIp = forwarded && isIP(forwarded) !== 0 ? forwarded : null;
  const userAgent = requestHeaders.get("user-agent")?.slice(0, USER_AGENT_MAX_LENGTH) ?? null;
  return { requestId: randomUUID(), clientIp, userAgent };
}

/** Dirección pública de la aplicación, para los enlaces de los correos. */
export async function getAppOrigin(): Promise<string> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (isLocal ? "http" : "https");
  return `${protocol}://${host}`;
}
