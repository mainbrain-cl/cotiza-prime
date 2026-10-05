import "server-only";
import { inspectLogo } from "@/lib/brand/logo";
import { serverLog } from "@/lib/log/server-log";
import type { PdfLogo } from "./types";

/** Alto del PNG al que se convierte un logo SVG: nítido al imprimir (el logo mide 39 pt en la hoja). */
const SVG_RASTER_HEIGHT_PX = 240;

/**
 * Logo listo para el PDF. Los bytes que bajan de Storage se vuelven a revisar con `inspectLogo`
 * (tipo real, tamaño y SVG limpio): nunca se confía en que el archivo haya pasado por la pantalla de
 * Marca. Si no pasa, el documento sale sin logo y queda un aviso en el registro, sin datos personales.
 *
 * PNG y JPG pasan tal cual; un SVG (que la plantilla no sabe dibujar) se convierte a PNG con `sharp`,
 * el motor de imágenes que trae Next.js (decisión 014). Si eso falla, también sale sin logo.
 */
export async function logoForPdf(bytes: Uint8Array): Promise<PdfLogo | null> {
  const checked = inspectLogo(bytes);
  if (!checked.ok) {
    await serverLog("warn", "pdf_logo_rejected");
    return null;
  }
  if (checked.kind === "png") return { format: "png", data: Buffer.from(checked.bytes) };
  if (checked.kind === "jpg") return { format: "jpg", data: Buffer.from(checked.bytes) };
  try {
    const { default: sharp } = await import("sharp");
    const png = await sharp(Buffer.from(checked.bytes), { density: 300 })
      .resize({ height: SVG_RASTER_HEIGHT_PX })
      .png()
      .toBuffer();
    return { format: "png", data: png };
  } catch {
    await serverLog("warn", "pdf_logo_svg_convert_failed");
    return null;
  }
}
