import path from "node:path";
import { Font } from "@react-pdf/renderer";

/**
 * Tipografías del documento: IBM Plex Sans (texto) e IBM Plex Mono (número de cotización), licencia
 * SIL OFL 1.1 (`fonts/LICENSE-IBM-Plex.txt`). Los archivos viven en el repositorio (versión 5.3.0 de
 * `@fontsource`, subconjunto latino) y se incrustan en cada PDF: el documento se ve igual en
 * cualquier equipo y no depende de ningún servicio externo.
 */
export const PDF_SANS = "IBM Plex Sans";
export const PDF_MONO = "IBM Plex Mono";

const FONT_DIR = path.join(process.cwd(), "src", "lib", "pdf", "fonts");
const file = (family: "sans" | "mono", weight: number) =>
  path.join(FONT_DIR, `ibm-plex-${family}-latin-${weight}-normal.woff`);

let registered = false;

export function registerPdfFonts(): void {
  if (registered) return;
  registered = true;
  Font.register({
    family: PDF_SANS,
    fonts: [400, 500, 600, 700].map((weight) => ({
      src: file("sans", weight),
      fontWeight: weight,
    })),
  });
  Font.register({
    family: PDF_MONO,
    fonts: [400, 500].map((weight) => ({ src: file("mono", weight), fontWeight: weight })),
  });
  // Sin cortes de palabra con guion: un monto o un nombre propio nunca se parte.
  Font.registerHyphenationCallback((word) => [word]);
}
