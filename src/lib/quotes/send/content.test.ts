import { describe, expect, it } from "vitest";
import { parseBasicFormat } from "@/lib/email/basic-format";
import { defaultEmailBody, defaultEmailSubject, sendQuoteInputSchema } from "./content";

const VALID = {
  subject: "Cotización COT-2026-0001 de Negocio Demo",
  body: "Hola",
  expectedRevision: 3,
  sendKey: "6f0f5f4e-5d5e-4c43-9d4a-3c0a2f0b9a11",
};

describe("texto de partida del correo", () => {
  it("saluda al cliente por su nombre y firma con el autor y la organización", () => {
    const body = defaultEmailBody({
      customerName: "Transportes Ficticios SpA",
      authorName: "Ana Ficticia",
      organizationName: "Negocio Demo 1",
    });
    expect(body).toContain("Estimado/a Transportes Ficticios SpA:");
    expect(body).toContain("Le hacemos llegar la cotización correspondiente a su solicitud");
    expect(body).toContain("Saludos cordiales,\nAna Ficticia\nNegocio Demo 1");
  });

  it("siempre es un texto válido en el formato básico", () => {
    const body = defaultEmailBody({
      customerName: "Nombre\r\ncon salto",
      authorName: "—",
      organizationName: "Org",
    });
    expect(parseBasicFormat(body).ok).toBe(true);
    expect(body).not.toContain("—");
  });

  it("el asunto de partida cabe en el límite", () => {
    const subject = defaultEmailSubject("COT-2026-0001", "N".repeat(500));
    expect(subject.length).toBeLessThanOrEqual(150);
    expect(subject.startsWith("Cotización COT-2026-0001 de ")).toBe(true);
  });
});

describe("validación del envío", () => {
  it("acepta un envío válido", () => {
    expect(sendQuoteInputSchema.safeParse(VALID).success).toBe(true);
  });

  it("rechaza asuntos vacíos, largos o con saltos de línea (inyección de cabeceras)", () => {
    for (const subject of ["", "   ", "a".repeat(151), "Hola\r\nBcc: x@y.cl", "Hola\nBcc: x"]) {
      expect(sendQuoteInputSchema.safeParse({ ...VALID, subject }).success, subject).toBe(false);
    }
  });

  it("rechaza texto vacío o demasiado largo, revisión inválida y clave que no es uuid", () => {
    expect(sendQuoteInputSchema.safeParse({ ...VALID, body: "" }).success).toBe(false);
    expect(sendQuoteInputSchema.safeParse({ ...VALID, body: "a".repeat(5001) }).success).toBe(
      false,
    );
    expect(sendQuoteInputSchema.safeParse({ ...VALID, expectedRevision: 0 }).success).toBe(false);
    expect(sendQuoteInputSchema.safeParse({ ...VALID, sendKey: "uno" }).success).toBe(false);
  });
});
