/**
 * Límite por IP, propio y barato, para las lecturas del marco incrustable (H-093): se aplica en `src/proxy.ts`
 * ANTES de consultar la base por la lista de sitios. Es un contador aparte del de la página (`intake_read_ip`):
 * no gasta su cupo ni lo comparte.
 *
 * Limitación declarada: vive en la memoria de cada instancia. En un despliegue sin servidor (varias instancias
 * a la vez) el tope real es «por instancia», no global, y se reinicia con cada arranque en frío. Aun así acota
 * el daño del caso que importa (una IP golpeando `/f/<id>/incrustar` con identificadores distintos para gastar
 * lecturas de la base); la lectura además se recuerda 60 s por formulario (`readFrameAncestors`). Un límite
 * global exigiría una tabla nueva o un almacén externo; queda como mejora si el uso lo pide. (`auth_rate_limits`
 * no sirve sin migración: su columna `scope` es una lista cerrada de tres valores de ingreso y registro.)
 */

import { isIP } from "node:net";

export const EMBED_READ_WINDOW_MS = 60_000;
export const EMBED_READ_MAX_PER_WINDOW = 300;
export const EMBED_READ_MAX_KEYS = 5_000;
/** Clave compartida de las peticiones sin IP válida: entre todas comparten un solo cupo. */
export const UNKNOWN_IP_KEY = "unknown";

export class FixedWindowLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly maxPerWindow: number,
    private readonly maxKeys: number,
  ) {}

  /** Cuenta una petición y dice si todavía está dentro del cupo de su ventana. */
  allow(key: string, now = Date.now()): boolean {
    const current = this.windows.get(key);
    if (current && now - current.startedAt < this.windowMs) {
      current.count += 1;
      return current.count <= this.maxPerWindow;
    }
    this.windows.delete(key);
    if (this.windows.size >= this.maxKeys) {
      for (const [other, entry] of this.windows) {
        if (now - entry.startedAt >= this.windowMs) this.windows.delete(other);
      }
      while (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next().value;
        if (oldest === undefined) break;
        this.windows.delete(oldest);
      }
    }
    this.windows.set(key, { startedAt: now, count: 1 });
    return true;
  }

  clear(): void {
    this.windows.clear();
  }

  get size(): number {
    return this.windows.size;
  }
}

const embedReadLimiter = new FixedWindowLimiter(
  EMBED_READ_WINDOW_MS,
  EMBED_READ_MAX_PER_WINDOW,
  EMBED_READ_MAX_KEYS,
);

/** IP del cliente según `x-forwarded-for` (la primera, reescrita por la plataforma); si no es válida, la clave común. */
export function embedClientKey(forwardedFor: string | null): string {
  const first = forwardedFor?.split(",")[0]?.trim() ?? "";
  return first !== "" && isIP(first) !== 0 ? first : UNKNOWN_IP_KEY;
}

/** ¿Esta IP todavía puede pedir que se lea la lista de sitios de un formulario? */
export function allowEmbedRead(forwardedFor: string | null, now = Date.now()): boolean {
  return embedReadLimiter.allow(embedClientKey(forwardedFor), now);
}

export function clearEmbedReadLimiter(): void {
  embedReadLimiter.clear();
}
