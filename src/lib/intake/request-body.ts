/**
 * Lectura del cuerpo de un envío público: solo `application/json` y con un tope de bytes. Se lee POR
 * PARTES y se corta apenas pasa el tope, así que una petición con `Content-Length` mentiroso, o sin él
 * (envío por trozos), no obliga al servidor a cargar todo en memoria.
 */

/** Tope del cuerpo de un envío del formulario público (plan del sprint 4, §2 paso 4). */
export const INTAKE_BODY_MAX_BYTES = 16 * 1024;

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "unsupported_type" | "too_large" | "malformed" };

const JSON_TYPE = /^application\/json\s*(;|$)/i;

export async function readLimitedJsonBody(
  request: Request,
  maxBytes: number = INTAKE_BODY_MAX_BYTES,
): Promise<BodyResult> {
  if (!JSON_TYPE.test(request.headers.get("content-type") ?? "")) {
    return { ok: false, reason: "unsupported_type" };
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large" };
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, reason: "malformed" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
