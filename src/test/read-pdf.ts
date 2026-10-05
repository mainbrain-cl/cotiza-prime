/**
 * Lector de PDF para pruebas (pdfjs-dist, Apache-2.0, solo desarrollo): saca el texto y la posición de
 * cada fragmento por página, para verificar el documento sin abrirlo a ojo.
 */
export type PdfTextItem = { text: string; x: number; y: number };
export type PdfPageInfo = { width: number; height: number; text: string; items: PdfTextItem[] };
export type ReadPdf = { pageCount: number; pages: PdfPageInfo[]; text: string };

export async function readPdf(data: Uint8Array | Buffer): Promise<ReadPdf> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
  });
  const doc = await task.promise;
  const pages: PdfPageInfo[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: PdfTextItem[] = [];
    for (const item of content.items) {
      if (!("str" in item) || item.str === "") continue;
      items.push({ text: item.str, x: item.transform[4], y: item.transform[5] });
    }
    pages.push({
      width: viewport.width,
      height: viewport.height,
      items,
      text: items.map((item) => item.text).join(" "),
    });
  }
  await task.destroy();
  return { pageCount: doc.numPages, pages, text: pages.map((page) => page.text).join("\n") };
}
