import "server-only";
import { inspectLogo } from "@/lib/brand/logo";
import { serverLog } from "@/lib/log/server-log";
import type { PdfLogo } from "./types";

/** Alto del PNG al que se convierte un logo SVG: nítido al imprimir (el logo mide 39 pt en la hoja). */
const SVG_RASTER_HEIGHT_PX = 240;
const SVG_RASTER_MAX_WIDTH_PX = 1200;
/** Densidad (ppp) con la que se mide el tamaño declarado, y límites de la que se usa para dibujar. */
const SVG_BASE_DENSITY = 72;
const SVG_MIN_DENSITY = 1;
const SVG_MAX_DENSITY = 100_000;
const SVG_FALLBACK_WIDTH = 300;
const SVG_FALLBACK_HEIGHT = 150;

function positiveNumber(value: string | undefined): number | null {
  const parsed = value === undefined ? Number.NaN : Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Ancho y alto declarados en la etiqueta `<svg>` (o, si no, su `viewBox`), siempre positivos. */
export function declaredSvgSize(bytes: Uint8Array): { width: number; height: number } {
  const root = /<svg\b[^>]*>/i.exec(new TextDecoder().decode(bytes))?.[0] ?? "";
  const attribute = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(root)?.[1];
  const viewBox = attribute("viewBox")
    ?.trim()
    .split(/[\s,]+/);
  const width = positiveNumber(attribute("width")) ?? positiveNumber(viewBox?.[2]);
  const height = positiveNumber(attribute("height")) ?? positiveNumber(viewBox?.[3]);
  return { width: width ?? SVG_FALLBACK_WIDTH, height: height ?? SVG_FALLBACK_HEIGHT };
}

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
    const source = Buffer.from(checked.bytes);
    // El tamaño que declara el SVG puede ser descomunal (o minúsculo): se lee del propio archivo y
    // se elige la densidad para que el dibujo salga dentro del alto y ancho buscados, nunca de
    // miles de píxeles (eso hacía fallar a `sharp` y el PDF salía sin logo).
    const declared = declaredSvgSize(checked.bytes);
    const density = Math.min(
      SVG_MAX_DENSITY,
      Math.max(
        SVG_MIN_DENSITY,
        Math.floor(
          Math.min(
            (SVG_BASE_DENSITY * SVG_RASTER_HEIGHT_PX) / declared.height,
            (SVG_BASE_DENSITY * SVG_RASTER_MAX_WIDTH_PX) / declared.width,
          ),
        ),
      ),
    );
    const png = await sharp(source, { density })
      .resize({
        width: SVG_RASTER_MAX_WIDTH_PX,
        height: SVG_RASTER_HEIGHT_PX,
        fit: "inside",
        withoutEnlargement: false,
      })
      .png()
      .toBuffer();
    return { format: "png", data: png };
  } catch {
    await serverLog("warn", "pdf_logo_svg_convert_failed");
    return null;
  }
}
