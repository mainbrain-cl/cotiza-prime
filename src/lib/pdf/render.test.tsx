// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPdf } from "@/test/read-pdf";
import { renderQuotePdf } from "./render";
import { buildQuoteDocumentData } from "./quote-document-model";
import { formatClp } from "@/lib/money/clp";
import {
  sampleDocument,
  sampleInput,
  sampleItem,
  sampleItems,
  sampleQuoteRow,
  sampleTotals,
} from "./sample-data";

const SAMPLE_PATH = path.join(process.cwd(), "tmp", "ejemplo-cotizacion.pdf");
const MAX_SECONDS_40_LINES = 2;
const TOTAL_4_LINES = formatClp(sampleTotals(sampleItems(4)).totalClp);
const TOTAL_40_LINES = formatClp(sampleTotals(sampleItems(40)).totalClp);

const TITLES = ["OBSERVACIONES", "CONDICIONES", "EXCLUSIONES", "FORMA DE PAGO", "NOTAS"];
// Los títulos llevan espaciado entre letras: el lector de PDF los entrega con espacios («O B S E R V…»), así que se comparan sin ellos.
const squashed = (value: string) => value.replace(/\s+/g, "");
const TITLES_SQUASHED = new Map(TITLES.map((title) => [squashed(title), title]));
/** La altura (en puntos, desde abajo) bajo la cual está el pie fijo de cada página (su texto está en y = 26). */
const FOOTER_TOP_Y = 40;
/** Los títulos de bloque que hay en el PDF, en orden de lectura, con su página (desde 0) y su altura. */
function titlesOf(read: Awaited<ReturnType<typeof readPdf>>) {
  return read.pages.flatMap((page, pageIndex) =>
    page.items.flatMap((item) => {
      const title = TITLES_SQUASHED.get(squashed(item.text));
      return title ? [{ title, page: pageIndex, y: item.y }] : [];
    }),
  );
}

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
    expect(text).toContain(TOTAL_4_LINES);
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
    expect(read.pages.at(-1)?.text).toContain(TOTAL_40_LINES);
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

  it("observaciones y condiciones larguísimas, con muchos saltos de renglón, salen completas", async () => {
    const longText = (tag: string) =>
      Array.from(
        { length: 80 },
        (_, i) => `${tag}${String(i).padStart(3, "0")} texto de relleno`,
      ).join("\n");
    const observations = longText("OBS");
    const conditions = longText("CON");
    const data = sampleDocument({ quote: sampleQuoteRow({ observations, conditions }) });
    const read = await readPdf(await renderQuotePdf(data));
    expect(read.pageCount).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < 80; i += 1) {
      expect(read.text).toContain(`OBS${String(i).padStart(3, "0")}`);
      expect(read.text).toContain(`CON${String(i).padStart(3, "0")}`);
    }
    expect(read.text).toContain(TOTAL_4_LINES);
  }, 30_000);

  it("con textos largos el total, el neto y el IVA nunca se pierden, sea cual sea el largo de la tabla", async () => {
    // Con observaciones y condiciones largas los totales pasan encima de las notas (modo «apilado»). Según dónde caía el corte de página,
    // el bloque de totales se dibujaba a medias y el PDF salía SIN total, neto ni IVA (solo quedaba «Subtotal»). Se recorren de 1 a 45
    // líneas, así que la prueba sigue cubriendo los cortes aunque cambien márgenes o tipografías.
    const long = Array.from(
      { length: 4 },
      () =>
        "La tarifa considera carga y descarga a pie de camión, un máximo de 2 horas de espera sin costo y rutas pavimentadas. Los valores se mantienen por la vigencia de la cotización; sobre ese plazo se reajustan según la variación del diésel.",
    ).join(" ");
    const failures: string[] = [];
    for (let lineCount = 1; lineCount <= 45; lineCount += 1) {
      const input = sampleInput({ lineCount });
      input.quote = sampleQuoteRow({ observations: long, conditions: long }, input.items);
      const data = buildQuoteDocumentData({ ...input, paper: "letter" });
      const text = (await readPdf(await renderQuotePdf(data))).text;
      const count = (pattern: RegExp) => (text.match(pattern) ?? []).length;
      const once = [
        ["Subtotal", count(/Subtotal/g)],
        ["Neto afecto", count(/Neto afecto/g)],
        ["IVA 19%", count(/IVA 19%/g)],
        ["Valores en pesos chilenos", count(/Valores en pesos chilenos/g)],
        [data.totals.total, count(new RegExp(data.totals.total.replace(/[$.]/g, "\\$&"), "g"))],
      ] as const;
      for (const [label, n] of once)
        if (n !== 1) failures.push(`${lineCount} líneas: «${label}» ×${n}`);
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it("los cinco bloques de texto salen en el orden del diseño y las notas van al final de la lista (H-048b)", async () => {
    const data = sampleDocument({
      quote: sampleQuoteRow({
        observations: "OBS-texto",
        conditions: "CON-texto",
        exclusions: "EXC-texto",
        footer_note: "NOT-texto",
        payment_terms: "split_50_50",
      }),
    });
    expect(data.exclusions).toBe("EXC-texto");
    expect(data.footerNote).toBe("NOT-texto");
    const text = (await readPdf(await renderQuotePdf(data))).text;
    const order = ["OBS-texto", "CON-texto", "EXC-texto", "50%", "NOT-texto"].map((marker) =>
      text.indexOf(marker),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // los títulos, en mayúscula y una sola vez cada uno
    const titles = titlesOf(await readPdf(await renderQuotePdf(data)));
    expect(titles.map((entry) => entry.title)).toEqual(TITLES);
  }, 30_000);

  it("sin exclusiones ni notas no aparece ninguno de los dos títulos, y la cotización queda como antes (H-048b)", async () => {
    const data = sampleDocument({
      quote: sampleQuoteRow({
        observations: "OBS-texto",
        conditions: null,
        exclusions: null,
        footer_note: "   ",
      }),
    });
    expect(data.exclusions).toBeNull();
    expect(data.footerNote).toBeNull();
    const titles = titlesOf(await readPdf(await renderQuotePdf(data))).map((entry) => entry.title);
    expect(titles).toEqual(["OBSERVACIONES"]);
  }, 30_000);

  it("con los cinco textos largos: el total sale una vez, ningún título queda solo al pie y no se pierde texto, de 1 a 45 líneas (H-048b)", async () => {
    // Cada bloque lleva un marcador propio al principio y otro al final para comprobar que el texto sale completo aunque se corte
    // entre páginas. Los títulos y su texto son hermanos del contenedor: si no, un título podía quedar solo al pie de una página.
    const sentence =
      "La tarifa considera carga y descarga a pie de camión, un máximo de 2 horas de espera sin costo y rutas pavimentadas. Los valores se mantienen por la vigencia de la cotización; sobre ese plazo se reajustan según la variación del diésel.";
    const block = (tag: string) =>
      `${tag}INICIO ${Array.from({ length: 4 }, () => sentence).join(" ")} ${tag}FIN`;
    const texts = { OBS: block("OBS"), CON: block("CON"), EXC: block("EXC"), NOT: block("NOT") };
    const failures: string[] = [];
    for (let lineCount = 1; lineCount <= 45; lineCount += 1) {
      const input = sampleInput({ lineCount });
      input.quote = sampleQuoteRow(
        {
          observations: texts.OBS,
          conditions: texts.CON,
          exclusions: texts.EXC,
          footer_note: texts.NOT,
          payment_terms: "split_50_50",
        },
        input.items,
      );
      const data = buildQuoteDocumentData({ ...input, paper: "letter" });
      const read = await readPdf(await renderQuotePdf(data));
      const squash = (value: string) => value.replace(/\s+/g, "");
      const flat = squash(read.text);
      const count = (pattern: RegExp) => (read.text.match(pattern) ?? []).length;
      for (const [label, n] of [
        ["Subtotal", count(/Subtotal/g)],
        ["Neto afecto", count(/Neto afecto/g)],
        ["IVA 19%", count(/IVA 19%/g)],
        [data.totals.total, count(new RegExp(data.totals.total.replace(/[$.]/g, "\\$&"), "g"))],
      ] as const)
        if (n !== 1) failures.push(`${lineCount} líneas: «${label}» ×${n}`);
      for (const tag of ["OBS", "CON", "EXC", "NOT"])
        for (const edge of ["INICIO", "FIN"])
          if (!flat.includes(`${tag}${edge}`))
            failures.push(`${lineCount} líneas: falta ${tag}${edge}`);
      const titles = titlesOf(read);
      if (titles.map((entry) => entry.title).join() !== TITLES.join())
        failures.push(
          `${lineCount} líneas: títulos ${titles.map((entry) => entry.title).join("/")}`,
        );
      for (const entry of titles) {
        const page = read.pages[entry.page];
        const below = page.items.filter((item) => item.y < entry.y - 1 && item.y > FOOTER_TOP_Y);
        if (below.length === 0)
          failures.push(
            `${lineCount} líneas: «${entry.title}» queda solo al pie de la página ${entry.page + 1}`,
          );
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  it("observaciones de 4.000 caracteres seguidos aparecen completas", async () => {
    const words = Array.from({ length: 500 }, (_, i) => `P${String(i).padStart(3, "0")}xx`);
    const data = sampleDocument({
      quote: sampleQuoteRow({ observations: words.join(" "), conditions: null }),
    });
    const read = await readPdf(await renderQuotePdf(data));
    for (const word of words) expect(read.text).toContain(word);
  }, 30_000);

  it("la descripción de una línea de 2.000 caracteres con saltos aparece completa", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => `D${String(i).padStart(3, "0")} detalle`);
    const description = rows.join("\n");
    const items = [sampleItem(0, { description })];
    const data = buildQuoteDocumentData({
      ...sampleInput({ lineCount: 1 }),
      items,
      paper: "letter",
    });
    const read = await readPdf(await renderQuotePdf(data));
    expect(read.pageCount).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < 150; i += 1) expect(read.text).toContain(`D${String(i).padStart(3, "0")}`);
  }, 30_000);
});
