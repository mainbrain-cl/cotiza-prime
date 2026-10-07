import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { headers } from "next/headers";

const USER_AGENT_MAX_LENGTH = 300;
const APP_ORIGIN_VAR = "APP_ORIGIN";
/** Solo para desarrollo local: en producción la dirección sale siempre de `APP_ORIGIN`. */
const LOCAL_DEV_ORIGIN = "http://localhost:3000";

export type RequestContext = {
  /** Identificador para seguir una petición en los registros. Es el mismo durante toda la petición. */
  requestId: string;
  /**
   * IP del cliente: la primera de `x-forwarded-for`, que la plataforma de despliegue (Vercel)
   * reescribe en el borde. Es una pista para auditar y limitar intentos, no una prueba.
   * `null` si la cabecera falta o no es una IP válida.
   */
  clientIp: string | null;
  userAgent: string | null;
};

/**
 * Un contexto por petición, guardado por el objeto de cabeceras de ESA petición. Antes se usaba `cache` de
 * React, que memoiza al dibujar páginas pero NO en las rutas de la API: ahí cada llamada daba un
 * `requestId` distinto y el registro (`serverLog`) y la auditoría (`x-cp-request-id`) de una misma petición
 * no coincidían. Las cabeceras de la petición son el mismo objeto durante toda ella, en páginas y en rutas.
 */
const contexts = new WeakMap<object, RequestContext>();

/** Origen y correlación de la petición actual, para auditoría. Es el mismo durante toda la petición. */
export async function getRequestContext(): Promise<RequestContext> {
  const requestHeaders = await headers();
  const known = contexts.get(requestHeaders);
  if (known) return known;
  const forwarded = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const clientIp = forwarded && isIP(forwarded) !== 0 ? forwarded : null;
  const userAgent = requestHeaders.get("user-agent")?.slice(0, USER_AGENT_MAX_LENGTH) ?? null;
  const context: RequestContext = { requestId: randomUUID(), clientIp, userAgent };
  contexts.set(requestHeaders, context);
  return context;
}

/**
 * Dirección pública de la aplicación, para los enlaces de los correos.
 * Sale de la variable de entorno `APP_ORIGIN`, nunca de las cabeceras de la petición: así nadie
 * puede hacer que un correo de verificación apunte a un sitio ajeno.
 */
export function getAppOrigin(): string {
  const configured = process.env[APP_ORIGIN_VAR]?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production") return LOCAL_DEV_ORIGIN;
  throw new Error(`Falta la variable de entorno ${APP_ORIGIN_VAR}`);
}
