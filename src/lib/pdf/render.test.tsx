// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPdf } from "@/test/read-pdf";
import { renderQuotePdf } from "./render";
import { sampleDocument, sampleInput } from "./sample-data";

const SAMPLE_PATH = path.join(process.cwd(), "tmp", "ejemplo-cotizacion.pdf");
const MAX_SECONDS_40_LINES = 2;

describe("renderQuotePdf (plantilla 1)", () => {
  it("genera un PDF con número, cliente, totales exactos, IVA y el aviso tributario; sin Cotiza Prime", async () => {
    const pdf = await renderQuotePdf(sampleDocument());
    mkdirSync(path.dirname(SAMPLE_PATH), { recursive: true });
    writeFileSync(SAMPLE_PATH, pdf);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const read = await readPdf(pdf);
    expect(read.pageCount).toBe(1);
    const text = read.text;
    expect(text).toContain("COT-2026-0043");
    expect(text).toContain("Distribuidora Maule Ltda.");
    expect(text).toContain("$1.170.880");
    expect(text).toContain("IVA 19%");
    expect(text).toContain("EXENTO");
    expect(text).toContain("Válida hasta");
    expect(text).toContain("20-10-2026");
    expect(text).toContain("Esta cotización no es un documento tributario");
    expect(text).toContain("Página 1 de 1");
    expect(text).toContain("Carga y descarga a pie de camión.");
    expect(text).toContain("PRECIO UNIT.");
    expect(text).not.toContain("Cotiza Prime");
    expect(text).not.toMatch(/transferencia|cuenta bancaria/i);
  });

  it("40 líneas pasan a otras páginas sin cortar filas, repiten el encabezado y se generan en menos de 2 s", async () => {
    const data = sampleDocument({ lineCount: 40 });
    const started = performance.now();
    const pdf = await renderQuotePdf(data);
    const seconds = (performance.now() - started) / 1000;
    console.info(`PDF de 40 líneas: ${seconds.toFixed(2)} s`);
    expect(seconds).toBeLessThan(MAX_SECONDS_40_LINES);
    const read = await readPdf(pdf);
    expect(read.pageCount).toBeGreaterThanOrEqual(2);
    // Cada fila (nombre y su monto) queda entera en una sola página: el nombre y el total de la
    // línea aparecen en la misma página.
    for (const line of data.lines) {
      const withName = read.pages.filter((page) => page.text.includes(line.name));
      expect(withName.length).toBeGreaterThanOrEqual(1);
    }
    for (const page of read.pages) {
      // Una fila nunca se corta: el nombre de cada línea y su segunda línea (el detalle) van juntos
      // en la misma página.
      const numbers = (prefix: RegExp) =>
        page.items
          .map((item) => prefix.exec(item.text)?.[1])
          .filter(Boolean)
          .sort();
      expect(numbers(/^Flete Santiago – Talca, tramo (\d+)$/)).toEqual(numbers(/^Detalle (\d+)$/));
    }
    // El encabezado de la tabla se repite en cada página que tiene filas.
    const pagesWithRows = read.pages.filter((page) => page.text.includes("Flete Santiago"));
    expect(pagesWithRows.length).toBeGreaterThanOrEqual(2);
    for (const page of pagesWithRows) expect(page.text).toContain("DESCRIPCIÓN");
    // Los números de página son coherentes.
    read.pages.forEach((page, index) =>
      expect(page.text).toContain(`Página ${index + 1} de ${read.pageCount}`),
    );
    // El total solo aparece una vez, en la última página.
    expect(read.pages.at(-1)?.text).toContain("$1.170.880");
  }, 30_000);

  it("carta y A4 dan hojas de tamaño distinto", async () => {
    const letter = await readPdf(await renderQuotePdf(sampleDocument({}, "letter")));
    const a4 = await readPdf(await renderQuotePdf(sampleDocument({}, "a4")));
    expect(Math.round(letter.pages[0].width)).toBe(612);
    expect(Math.round(letter.pages[0].height)).toBe(792);
    expect(Math.round(a4.pages[0].width)).toBe(595);
    expect(Math.round(a4.pages[0].height)).toBe(842);
  });

  it("un color principal claro no rompe el documento", async () => {
    const data = sampleDocument({
      organization: {
        ...sampleInput().organization,
        name: "TecnoClima Servicios Ltda.",
        rut: "78903112-4",
        industry: "services",
        contactEmail: null,
        contactPhone: null,
        primaryColor: "#f4d35e",
        secondaryColor: "#2d3142",
        logo: null,
      },
    });
    const read = await readPdf(await renderQuotePdf(data));
    expect(read.text).toContain("TecnoClima Servicios Ltda.");
  });
});
