import "server-only";
import sharp from "sharp";

/**
 * Logo reducido para la página pública del formulario. El archivo original puede pesar hasta 1 MB y tener
 * 4.096 px de lado; en una cabecera de 48 px de alto eso es un peso inútil que, además, viaja dentro de la
 * página. Aquí se achica en el servidor a 256 px de lado como máximo y se entrega como WebP (con
 * transparencia). Un SVG se rasteriza: la salida es una imagen, nunca código.
 *
 * Si algo falla (archivo dañado, formato raro), no hay logo y la cabecera muestra solo el nombre.
 */
export const LOGO_THUMBNAIL_MAX_SIDE_PX = 256;
export const LOGO_THUMBNAIL_MIME = "image/webp";
const WEBP_QUALITY = 88;
/** Alto y ancho máximos del original (los mismos que acepta la subida del logo). */
const MAX_INPUT_SIDE_PX = 4_096;
const MAX_INPUT_PIXELS = MAX_INPUT_SIDE_PX * MAX_INPUT_SIDE_PX;
/** Resolución con que se dibuja un SVG antes de reducirlo, para que quede nítido. */
const SVG_DENSITY = 288;

export type LogoSourceKind = "png" | "jpg" | "svg";

export type LogoThumbnail = { bytes: Buffer; mime: typeof LOGO_THUMBNAIL_MIME };

/** Reduce un logo. Devuelve `null` si no se puede leer como imagen. */
export async function shrinkLogo(
  source: Uint8Array,
  kind: LogoSourceKind,
): Promise<LogoThumbnail | null> {
  try {
    const bytes = await sharp(source, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "error",
      ...(kind === "svg" ? { density: SVG_DENSITY } : {}),
    })
      .rotate()
      .resize({
        width: LOGO_THUMBNAIL_MAX_SIDE_PX,
        height: LOGO_THUMBNAIL_MAX_SIDE_PX,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    return { bytes, mime: LOGO_THUMBNAIL_MIME };
  } catch {
    return null;
  }
}

/** El logo reducido como dirección `data:`, o `null`. */
export async function shrinkLogoToDataUrl(
  source: Uint8Array,
  kind: LogoSourceKind,
): Promise<string | null> {
  const thumbnail = await shrinkLogo(source, kind);
  return thumbnail ? `data:${thumbnail.mime};base64,${thumbnail.bytes.toString("base64")}` : null;
}
