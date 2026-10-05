import { renderToBuffer } from "@react-pdf/renderer";
import { registerPdfFonts } from "./fonts";
import { Template1 } from "./templates/template-1";
import type { QuoteDocumentData } from "./types";

/** Genera el PDF en el servidor (PROYECTO.md §13.7). Siempre la plantilla 1 hasta que haya más. */
export async function renderQuotePdf(data: QuoteDocumentData): Promise<Buffer> {
  registerPdfFonts();
  return renderToBuffer(<Template1 data={data} />);
}
