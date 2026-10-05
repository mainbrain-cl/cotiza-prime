/**
 * Revisión del archivo del logo (SEGURIDAD.md §3: tamaño y tipo REAL, no solo la extensión).
 *
 * El tipo sale de los primeros bytes del archivo, nunca del nombre ni del tipo que declara el
 * navegador. Un PNG o JPG se revisa por su estructura (y su alto y ancho, contra imágenes
 * descomunales); un SVG se limpia con `sanitizeSvg`. Es lógica pura: sirve en el servidor y, para
 * avisar antes, en el navegador.
 */
import { sanitizeSvg } from "./svg";

/** Tamaño máximo del archivo. Debe coincidir con `file_size_limit` del bucket (migración 13). */
export const LOGO_MAX_BYTES = 1_048_576;
export const LOGO_MAX_LABEL = "1 MB";
/** Alto y ancho máximos de un PNG o JPG, en píxeles. */
export const LOGO_MAX_DIMENSION = 4_096;
export const LOGO_ACCEPT = "image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg";
export const LOGO_HELP = `PNG, JPG o SVG, de hasta ${LOGO_MAX_LABEL}.`;

export const LOGO_KINDS = {
  png: { ext: "png", mime: "image/png" },
  jpg: { ext: "jpg", mime: "image/jpeg" },
  svg: { ext: "svg", mime: "image/svg+xml" },
} as const;

export type LogoKind = keyof typeof LOGO_KINDS;

export type LogoCheck =
  | { ok: true; kind: LogoKind; mime: string; ext: string; bytes: Uint8Array }
  | { ok: false; message: string };

export const LOGO_TOO_BIG_MESSAGE = `El archivo pesa demasiado. El máximo es ${LOGO_MAX_LABEL}.`;
const NOT_AN_IMAGE_MESSAGE = "El archivo no es una imagen PNG, JPG o SVG válida.";
const CORRUPT_MESSAGE = "La imagen está dañada o incompleta. Prueba exportándola de nuevo.";
const TOO_LARGE_DIMENSIONS_MESSAGE = `La imagen es demasiado grande: el máximo es ${LOGO_MAX_DIMENSION} × ${LOGO_MAX_DIMENSION} píxeles.`;
const EMPTY_MESSAGE = "El archivo está vacío.";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_IHDR_LENGTH = 13;

const startsWith = (bytes: Uint8Array, signature: number[]) =>
  signature.every((value, index) => bytes[index] === value);

const readUint32 = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>>
  0;
const readUint16 = (bytes: Uint8Array, offset: number) => (bytes[offset] << 8) | bytes[offset + 1];

const failure = (message: string): LogoCheck => ({ ok: false, message });

function checkPng(bytes: Uint8Array): LogoCheck {
  // Primer bloque: IHDR, con alto y ancho.
  if (bytes.length < 33 || readUint32(bytes, 8) !== PNG_IHDR_LENGTH)
    return failure(CORRUPT_MESSAGE);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return failure(CORRUPT_MESSAGE);
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (width === 0 || height === 0) return failure(CORRUPT_MESSAGE);
  if (width > LOGO_MAX_DIMENSION || height > LOGO_MAX_DIMENSION) {
    return failure(TOO_LARGE_DIMENSIONS_MESSAGE);
  }
  // Recorre los bloques hasta IEND: un archivo cortado no pasa.
  let offset = 8;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    offset += 12 + length;
    if (offset > bytes.length) return failure(CORRUPT_MESSAGE);
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  return sawEnd ? { ok: true, kind: "png", ...LOGO_KINDS.png, bytes } : failure(CORRUPT_MESSAGE);
}

/** Marcas de JPEG que describen la imagen (SOF), sin las que no son de tamaño. */
const isStartOfFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function checkJpeg(bytes: Uint8Array): LogoCheck {
  let offset = 2;
  let dimensions: { width: number; height: number } | null = null;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return failure(CORRUPT_MESSAGE);
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1; // relleno
      continue;
    }
    if (marker === 0xd9) break; // fin de la imagen
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2; // marcas sin contenido
      continue;
    }
    const length = readUint16(bytes, offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return failure(CORRUPT_MESSAGE);
    if (isStartOfFrame(marker)) {
      if (length < 8) return failure(CORRUPT_MESSAGE);
      dimensions = { height: readUint16(bytes, offset + 5), width: readUint16(bytes, offset + 7) };
      break;
    }
    offset += 2 + length;
  }
  if (!dimensions || dimensions.width === 0 || dimensions.height === 0) {
    return failure(CORRUPT_MESSAGE);
  }
  if (dimensions.width > LOGO_MAX_DIMENSION || dimensions.height > LOGO_MAX_DIMENSION) {
    return failure(TOO_LARGE_DIMENSIONS_MESSAGE);
  }
  // Una imagen completa termina en la marca de fin (se toleran ceros de relleno al final).
  let end = bytes.length;
  while (end > 2 && bytes[end - 1] === 0x00) end -= 1;
  if (bytes[end - 2] !== 0xff || bytes[end - 1] !== 0xd9) return failure(CORRUPT_MESSAGE);
  return { ok: true, kind: "jpg", ...LOGO_KINDS.jpg, bytes };
}

function checkSvg(bytes: Uint8Array): LogoCheck {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failure(NOT_AN_IMAGE_MESSAGE);
  }
  text = text.replace(/^﻿/, "");
  if (!/^\s*</.test(text) || !/<svg[\s>/]/.test(text)) return failure(NOT_AN_IMAGE_MESSAGE);
  const result = sanitizeSvg(text);
  if (!result.ok) return failure(result.reason);
  const clean = new TextEncoder().encode(result.svg);
  if (clean.length > LOGO_MAX_BYTES) return failure(LOGO_TOO_BIG_MESSAGE);
  return { ok: true, kind: "svg", ...LOGO_KINDS.svg, bytes: clean };
}

/**
 * Revisa los bytes de un archivo subido. Si pasa, entrega los bytes que hay que guardar (para un
 * SVG, la versión limpia) y el tipo que corresponde por contenido.
 */
export function inspectLogo(bytes: Uint8Array): LogoCheck {
  if (bytes.length === 0) return failure(EMPTY_MESSAGE);
  if (bytes.length > LOGO_MAX_BYTES) return failure(LOGO_TOO_BIG_MESSAGE);
  if (startsWith(bytes, PNG_SIGNATURE)) return checkPng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return checkJpeg(bytes);
  return checkSvg(bytes);
}

/** Extensión (por lo que guardamos) → tipo para responder. Solo las tres que aceptamos. */
export function mimeForLogoPath(logoPath: string): string | null {
  const ext = logoPath.split(".").pop();
  const entry = Object.values(LOGO_KINDS).find((kind) => kind.ext === ext);
  return entry?.mime ?? null;
}

const LOGO_FILE_PATTERN = /^[0-9a-f-]{36}\/logo-([0-9a-f]{12})\.(?:png|jpg|svg)$/;

/** Nombre nuevo para un logo: siempre la carpeta de la organización más un código al azar. */
export function newLogoPath(tenantId: string, ext: string): string {
  const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `${tenantId}/logo-${code}.${ext}`;
}

/** Código de versión de un logo (para que el navegador lo pida de nuevo al cambiarlo). */
export function logoVersion(logoPath: string): string | null {
  return LOGO_FILE_PATTERN.exec(logoPath)?.[1] ?? null;
}

/** Dirección con la que la aplicación entrega el logo (pasa siempre por el servidor). */
export function logoUrl(tenantId: string, logoPath: string | null | undefined): string | null {
  if (!logoPath) return null;
  const version = logoVersion(logoPath);
  return `/api/v1/tenants/${tenantId}/logo${version ? `?v=${version}` : ""}`;
}
