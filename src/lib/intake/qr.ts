import "server-only";
import qrcode from "qrcode-generator";
import sharp from "sharp";

/**
 * Código QR del formulario público (H-091). El SVG se arma aquí, módulo por módulo, y solo lleva
 * `<svg>`, `<rect>` y `<path>` con números: nada de texto de terceros, estilos ni scripts. El PNG
 * sale de ese mismo SVG con `sharp`.
 */
export const QR_ERROR_CORRECTION = "M";
/** Margen de silencio, en módulos (mínimo que pide la norma del QR). */
export const QR_MARGIN_MODULES = 4;
export const QR_PNG_SIZE_PX = 2_048;
export const QR_MAX_CONTENT_LENGTH = 500;
const SVG_BASE_DENSITY = 72;
const AUTO_TYPE_NUMBER = 0;

export class QrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QrError";
  }
}

export type QrMatrix = { size: number; isDark: (row: number, col: number) => boolean };

// Solo caracteres imprimibles de ASCII: una dirección web ya viene codificada así.
const PRINTABLE_ASCII = /^[!-~]+$/;

function checkContent(content: string): void {
  if (
    typeof content !== "string" ||
    content.length === 0 ||
    content.length > QR_MAX_CONTENT_LENGTH
  ) {
    throw new QrError("El contenido del código QR no es válido.");
  }
  if (!PRINTABLE_ASCII.test(content)) throw new QrError("El contenido del código QR no es válido.");
  let url: URL;
  try {
    url = new URL(content);
  } catch {
    throw new QrError("El contenido del código QR no es válido.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new QrError("El contenido del código QR no es válido.");
  }
}

/** Matriz de módulos (verdadero = oscuro) para una dirección web. Corrección de errores M. */
export function buildQrMatrix(content: string): QrMatrix {
  checkContent(content);
  const qr = qrcode(AUTO_TYPE_NUMBER, QR_ERROR_CORRECTION);
  qr.addData(content);
  qr.make();
  return { size: qr.getModuleCount(), isDark: (row, col) => qr.isDark(row, col) };
}

/** SVG del código con margen de 4 módulos. Solo `<svg>`, `<rect>` y `<path>`. */
export function buildQrSvg(content: string): string {
  const matrix = buildQrMatrix(content);
  const total = matrix.size + QR_MARGIN_MODULES * 2;

  // Una tira por cada serie horizontal de módulos oscuros: el dibujo queda corto y nítido.
  const segments: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.isDark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < matrix.size && matrix.isDark(row, col)) col += 1;
      const run = col - start;
      segments.push(`M${start + QR_MARGIN_MODULES} ${row + QR_MARGIN_MODULES}h${run}v1h-${run}z`);
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${total}" height="${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${segments.join("")}" fill="#000000"/>` +
    "</svg>"
  );
}

/** PNG cuadrado de 2.048 px a partir del SVG, sin suavizado en los bordes. */
export async function buildQrPng(content: string): Promise<Buffer> {
  const svg = buildQrSvg(content);
  const total = Number(/viewBox="0 0 (\d+) /.exec(svg)?.[1]);
  const density = (SVG_BASE_DENSITY * QR_PNG_SIZE_PX) / total;
  return sharp(Buffer.from(svg, "utf8"), { density })
    .resize(QR_PNG_SIZE_PX, QR_PNG_SIZE_PX, { fit: "fill", kernel: "nearest" })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}
