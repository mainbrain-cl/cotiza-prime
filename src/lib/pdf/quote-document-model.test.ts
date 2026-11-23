import { describe, expect, it } from "vitest";
import { buildQuoteDocumentData, validityOf } from "./quote-document-model";
import { formatClp } from "@/lib/money/clp";
import { sampleInput, sampleItems, sampleQuoteRow, sampleTotals } from "./sample-data";

describe("buildQuoteDocumentData: lee lo guardado, no recalcula", () => {
  it("los datos de ejemplo cuadran con el cálculo de la aplicación", () => {
    const items = sampleItems(4);
    const totals = sampleTotals(items);
    const data = buildQuoteDocumentData(sampleInput());
    expect(data.totals.total).toBe(formatClp(totals.totalClp));
    expect(data.totals.tax).toBe(formatClp(totals.taxClp));
    expect(data.totals.subtotal).toBe(formatClp(totals.subtotalClp));
    expect(items.reduce((sum, item) => sum + item.line_total_clp, 0)).toBe(totals.subtotalClp);
  });

  it("los totales son exactamente los guardados, aunque no cuadren con las líneas", () => {
    const quote = sampleQuoteRow({ total_clp: 999_999, tax_clp: 12_345, subtotal_clp: 777_777 });
    const data = buildQuoteDocumentData(sampleInput({ quote }));
    expect(data.totals.total).toBe("$999.999");
    expect(data.totals.tax).toBe("$12.345");
    expect(data.totals.subtotal).toBe("$777.777");
  });

  it("la etiqueta del IVA sale de la tasa guardada", () => {
    expect(buildQuoteDocumentData(sampleInput()).totals.taxLabel).toBe("IVA 19%");
    const data = buildQuoteDocumentData(
      sampleInput({ quote: sampleQuoteRow({ tax_rate_bp: 1950 }) }),
    );
    expect(data.totals.taxLabel).toBe("IVA 19,5%");
  });

  it("solo muestra descuento global y exento cuando hay", () => {
    const none = buildQuoteDocumentData(
      sampleInput({ quote: sampleQuoteRow({ global_discount_clp: 0, net_exempt_clp: 0 }) }),
    );
    expect(none.totals.globalDiscount).toBeNull();
    expect(none.totals.exempt).toBeNull();
    const some = buildQuoteDocumentData(sampleInput());
    expect(some.totals.globalDiscount).toBe("−$10.000");
    expect(some.totals.exempt).toBe(formatClp(sampleTotals(sampleItems(4)).netExemptClp));
  });

  it("marca los exentos, formatea cantidades y descuentos", () => {
    const { lines } = buildQuoteDocumentData(sampleInput());
    expect(lines[2].exempt).toBe(true);
    expect(lines[1].quantity).toBe("2");
    expect(lines[1].unit).toBe("día");
    expect(lines[3].discount).toBe("−10%");
    expect(lines[0].discount).toBe("—");
    expect(lines[3].total).toBe("$189.000");
  });

  it("número, versión, fecha chilena y datos del cliente", () => {
    const data = buildQuoteDocumentData(sampleInput({ quote: sampleQuoteRow({ version: 2 }) }));
    expect(data.quote.number).toBe("COT-2026-0043");
    expect(data.quote.versionLabel).toBe("Versión 2");
    expect(data.quote.issueDate).toBe("05-10-2026");
    expect(data.customer.detailLines[0]).toBe("RUT 77.120.554-K");
  });

  it("no incluye datos de transferencia ni la marca de la plataforma", () => {
    const json = JSON.stringify(buildQuoteDocumentData(sampleInput()));
    expect(json).not.toMatch(/transferencia|Cotiza Prime|cuenta/i);
  });

  it("la forma de pago, si existe, avisa que los datos se envían al aceptar", () => {
    const data = buildQuoteDocumentData(
      sampleInput({ quote: sampleQuoteRow({ payment_terms: "split_50_50" }) }),
    );
    expect(data.paymentTerms).toContain("50% al aceptar");
  });
});

describe("buildQuoteDocumentData: exclusiones y notas (H-048b)", () => {
  it("las toma de lo guardado, sin espacios a los lados; vacío o solo espacios es nulo", () => {
    const data = buildQuoteDocumentData(
      sampleInput({
        quote: sampleQuoteRow({
          exclusions: "  No incluye embalaje.  ",
          footer_note: "Valores en CLP.",
        }),
      }),
    );
    expect(data.exclusions).toBe("No incluye embalaje.");
    expect(data.footerNote).toBe("Valores en CLP.");
    const empty = buildQuoteDocumentData(
      sampleInput({ quote: sampleQuoteRow({ exclusions: "   \n ", footer_note: null }) }),
    );
    expect(empty.exclusions).toBeNull();
    expect(empty.footerNote).toBeNull();
  });
});

describe("validityOf", () => {
  it("con fecha, la usa", () => {
    expect(validityOf(sampleQuoteRow({ valid_until: "2026-10-20" }), "2026-10-05")).toEqual({
      validUntil: "20-10-2026",
      validityNote: null,
    });
  });
  it("en días, muestra la fecha estimada si se envía hoy y la nota", () => {
    const quote = sampleQuoteRow({ valid_until: null, validity_mode: "days", validity_days: 15 });
    expect(validityOf(quote, "2026-10-05")).toEqual({
      validUntil: "20-10-2026",
      validityNote: "15 días desde su envío",
    });
    expect(validityOf({ ...quote, validity_days: 1 }, "2026-10-05").validityNote).toBe(
      "1 día desde su envío",
    );
  });
  it("sin vigencia, no muestra nada", () => {
    const quote = sampleQuoteRow({ valid_until: null, validity_mode: null, validity_days: null });
    expect(validityOf(quote, "2026-10-05")).toEqual({ validUntil: null, validityNote: null });
  });
});
