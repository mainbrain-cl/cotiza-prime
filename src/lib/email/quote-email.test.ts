import { describe, expect, it } from "vitest";
import { contrastRatio, MIN_TEXT_CONTRAST } from "@/lib/brand/colors";
import { cleanSenderName, buildQuoteEmail, type QuoteEmailInput } from "./quote-email";

const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);

function input(overrides: Partial<QuoteEmailInput> = {}): QuoteEmailInput {
  return {
    organizationName: "Negocio Demo 1",
    brandPrimary: "#2b54e0",
    brandSecondary: null,
    recipientAddress: "cliente@ejemplo.test",
    quoteNumber: "COT-2026-0043",
    body: "Hola, adjuntamos tu cotización.",
    viewUrl: "https://app.ejemplo.cl/c/abc123",
    fromAddress: "cotizaciones@ejemplo.test",
    pdf: { filename: "COT-2026-0043.pdf", bytes: pdfBytes },
    idempotencyKey: "id-1",
    ...overrides,
  };
}

function built(overrides: Partial<QuoteEmailInput> = {}) {
  const result = buildQuoteEmail(input(overrides));
  if (!result.ok) throw new Error(`esperaba ok, vino ${result.code}`);
  return result.message;
}

describe("buildQuoteEmail", () => {
  it("arma remitente, asunto, botón, enlace y PDF adjunto", () => {
    const message = built();
    expect(message.from).toEqual({ name: "Negocio Demo 1", address: "cotizaciones@ejemplo.test" });
    expect(message.to).toBe("cliente@ejemplo.test");
    expect(message.subject).toBe("Cotización COT-2026-0043 de Negocio Demo 1");
    expect(message.html).toContain("Revisar y aceptar la cotización");
    expect(message.html).toContain('href="https://app.ejemplo.cl/c/abc123"');
    expect(message.text).toContain(
      "Revisar y aceptar la cotización: https://app.ejemplo.cl/c/abc123",
    );
    expect(message.attachments).toEqual([
      { filename: "COT-2026-0043.pdf", contentType: "application/pdf", content: pdfBytes },
    ]);
    expect(message.idempotencyKey).toBe("id-1");
  });

  it("no incluye datos bancarios", () => {
    const { html, text } = built();
    for (const word of [/banco/i, /cuenta/i, /transferencia/i, /titular/i]) {
      expect(html).not.toMatch(word);
      expect(text).not.toMatch(word);
    }
  });

  it("el botón y el texto de marca cumplen contraste AA con cualquier color", () => {
    for (const color of ["#ffff00", "#808080", "#000000", "#ffffff", "#2b54e0", "#ff6600"]) {
      const message = built({ brandPrimary: color });
      const background = /background:(#[0-9a-f]{6});color:(#[0-9a-f]{6});text-decoration:none/.exec(
        message.html,
      );
      expect(background, color).not.toBeNull();
      expect(contrastRatio(background![1], background![2]), color).toBeGreaterThanOrEqual(
        MIN_TEXT_CONTRAST,
      );
    }
  });

  it("usa colores de respaldo si la marca es inválida", () => {
    expect(built({ brandPrimary: "rojo;}</style>" }).html).not.toContain("rojo");
  });

  it("escapa el nombre de la organización en el HTML", () => {
    const html = built({ organizationName: "<img src=x onerror=1> & Cía" }).html;
    expect(html).not.toContain("<img");
  });

  it("limpia el nombre del remitente: comillas, saltos, < > @ y largo", () => {
    expect(cleanSenderName('Mi "Empresa"\r\nBcc: x@y.cl')).toBe("Mi Empresa Bcc xy.cl");
    expect(cleanSenderName("ceo@banco.cl <ceo@banco.cl>")).toBe("ceobanco.cl ceobanco.cl");
    expect(cleanSenderName("a".repeat(100))).toHaveLength(60);
    expect(cleanSenderName('""<>')).toBe("Cotizaciones");
    expect(cleanSenderName("😀".repeat(100))).toBe("😀".repeat(60));
  });

  it("rechaza asuntos con saltos de línea o demasiado largos", () => {
    expect(buildQuoteEmail(input({ subject: "Hola\r\nBcc: x@y.cl" }))).toEqual({
      ok: false,
      code: "invalid_subject",
    });
    expect(buildQuoteEmail(input({ subject: "a".repeat(151) })).ok).toBe(false);
    expect(buildQuoteEmail(input({ subject: "a".repeat(150) })).ok).toBe(true);
  });

  it("rechaza enlaces que no son https (salvo localhost) y con credenciales", () => {
    for (const viewUrl of [
      "http://app.ejemplo.cl/c/x",
      "javascript:alert(1)",
      "https://u:p@app.ejemplo.cl/c/x",
      "no es una url",
    ]) {
      expect(buildQuoteEmail(input({ viewUrl })), viewUrl).toEqual({
        ok: false,
        code: "invalid_link",
      });
    }
    expect(buildQuoteEmail(input({ viewUrl: "http://localhost:3000/c/x" })).ok).toBe(true);
  });

  it("rechaza un adjunto que no es PDF y sanea el nombre del archivo", () => {
    expect(
      buildQuoteEmail(
        input({ pdf: { filename: "a.pdf", bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) } }),
      ),
    ).toEqual({ ok: false, code: "invalid_pdf" });
    const message = built({ pdf: { filename: '../..\\"x"\r\n.exe', bytes: pdfBytes } });
    expect(message.attachments?.[0].filename).toMatch(/^[A-Za-z0-9._-]+\.pdf$/);
  });

  it("rechaza destinatarios inválidos o con saltos de línea", () => {
    for (const recipientAddress of ["x", "a@b.cl\r\nBcc: z@z.cl", ""]) {
      expect(buildQuoteEmail(input({ recipientAddress })).ok).toBe(false);
    }
  });

  it("propaga los errores del formato básico", () => {
    expect(buildQuoteEmail(input({ body: "" }))).toEqual({ ok: false, code: "empty" });
    expect(buildQuoteEmail(input({ body: "<script>" })).ok).toBe(true);
    expect(built({ body: "<script>alert(1)</script>" }).html).not.toContain("<script>");
  });
});
