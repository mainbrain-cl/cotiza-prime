/**
 * Lo que no necesita el servidor para descargar el QR de un formulario (H-091): los formatos que se
 * aceptan y el nombre del archivo. Se separa de `qr.ts` para poder probarlo sin generar el código.
 */
export const QR_FORMATS = ["svg", "png"] as const;
export type QrFormat = (typeof QR_FORMATS)[number];

/** `null` si falta o no es uno de los formatos permitidos. */
export function parseQrFormat(value: string | null): QrFormat | null {
  return (QR_FORMATS as readonly string[]).includes(value ?? "") ? (value as QrFormat) : null;
}

const MAX_NAME_PART_LENGTH = 60;
const FALLBACK_NAME_PART = "formulario";

/**
 * Nombre de archivo seguro a partir del nombre interno del formulario: solo letras minúsculas sin
 * tilde, números y guiones, con la extensión del formato. Nunca lleva rutas, comillas ni saltos de línea.
 */
export function qrFileName(formName: string, format: QrFormat): string {
  const slug = formName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_PART_LENGTH)
    .replace(/-+$/g, "");
  return `qr-${slug === "" ? FALLBACK_NAME_PART : slug}.${format}`;
}
