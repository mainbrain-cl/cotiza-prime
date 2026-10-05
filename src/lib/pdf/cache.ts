import { createHash } from "node:crypto";
import type { PdfPaperSize, QuoteDocumentData } from "./types";

/**
 * Caché en memoria de los PDF ya armados (H-028). Armar un PDF grande cuesta decenas de segundos y
 * cientos de MB; si nada cambió, se entrega el mismo archivo.
 *
 * - La clave lleva SIEMPRE la organización: nunca se comparte entre organizaciones.
 * - Además de (organización, cotización, revisión, tamaño de hoja), la clave lleva una huella del
 *   contenido exacto del documento (marca, logo, cliente, textos): cambiar el logo o el nombre de
 *   un cliente cambia el PDF sin tocar la revisión de la cotización, y el PDF viejo no debe salir.
 * - Acotada por bytes y por cantidad; al llenarse sale lo menos usado (LRU).
 * - Si dos personas piden lo mismo a la vez, se arma una sola vez.
 * - Vive en la memoria de un proceso: en un servidor sin estado cada instancia tiene la suya. Es
 *   una ayuda, no una garantía; el tope de pedidos (`consumePdfQuota`) es lo que protege.
 *
 * TODO: armar el PDF en `worker_threads` con un tiempo máximo, para que un documento enorme no
 * ocupe el servidor ni la memoria del proceso principal.
 */
export const PDF_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const PDF_CACHE_MAX_ENTRIES = 100;

export type PdfCacheKeyParts = {
  tenantId: string;
  quoteId: string;
  revision: number;
  paper: PdfPaperSize;
  data: QuoteDocumentData;
};

const sha256 = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");

/** Huella del contenido del documento: el logo cuenta por sus bytes, no por su ruta. */
export function documentFingerprint(data: QuoteDocumentData): string {
  const logo = data.organization.logo;
  const plain: QuoteDocumentData = {
    ...data,
    organization: { ...data.organization, logo: null },
  };
  return sha256(
    JSON.stringify(plain) + (logo ? `|logo:${logo.format}:${sha256(logo.data)}` : "|nologo"),
  );
}

export function pdfCacheKey(parts: PdfCacheKeyParts): string {
  return [
    parts.tenantId,
    parts.quoteId,
    parts.revision,
    parts.paper,
    documentFingerprint(parts.data),
  ].join(":");
}

export class PdfCache {
  private readonly entries = new Map<string, Buffer>();
  private readonly pending = new Map<string, Promise<Buffer | null>>();
  private bytes = 0;

  constructor(
    private readonly maxBytes: number = PDF_CACHE_MAX_BYTES,
    private readonly maxEntries: number = PDF_CACHE_MAX_ENTRIES,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  get(key: string): Buffer | undefined {
    const found = this.entries.get(key);
    if (found) {
      // Se vuelve a insertar para que quede como el más reciente.
      this.entries.delete(key);
      this.entries.set(key, found);
    }
    return found;
  }

  set(key: string, pdf: Buffer): void {
    if (pdf.length > this.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.length;
      this.entries.delete(key);
    }
    this.entries.set(key, pdf);
    this.bytes += pdf.length;
    for (const [oldest, buffer] of this.entries) {
      if (this.bytes <= this.maxBytes && this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
      this.bytes -= buffer.length;
    }
  }

  /**
   * Entrega el PDF de la caché; si no está, `admit` decide si se puede armar uno más (tope de
   * pedidos) y `render` lo arma. Quien llega mientras otro lo arma espera el mismo resultado.
   */
  async getOrRender(
    key: string,
    admit: () => Promise<boolean>,
    render: () => Promise<Buffer>,
  ): Promise<{ ok: true; pdf: Buffer; cached: boolean } | { ok: false; reason: "rate_limited" }> {
    const hit = this.get(key);
    if (hit) return { ok: true, pdf: hit, cached: true };
    const running = this.pending.get(key);
    if (running) {
      const pdf = await running;
      return pdf ? { ok: true, pdf, cached: true } : { ok: false, reason: "rate_limited" };
    }
    // El trabajo se registra de inmediato (antes de cualquier espera), para que un pedido que llega
    // un instante después se sume a este en vez de armar otro.
    const job = (async () => ((await admit()) ? render() : null))();
    this.pending.set(key, job);
    try {
      const pdf = await job;
      if (!pdf) return { ok: false, reason: "rate_limited" };
      this.set(key, pdf);
      return { ok: true, pdf, cached: false };
    } finally {
      this.pending.delete(key);
    }
  }
}

/** La caché del proceso. */
export const pdfCache = new PdfCache();
