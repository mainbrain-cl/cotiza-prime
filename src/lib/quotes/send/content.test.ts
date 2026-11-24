import { describe, expect, it } from "vitest";
import { parseBasicFormat } from "@/lib/email/basic-format";
import { hasUnresolvedVariables } from "@/lib/snippets/model";
import {
  DEFAULT_EMAIL_BODY_CLOSING,
  DEFAULT_EMAIL_BODY_INTRO,
  defaultEmailBody,
  defaultEmailSubject,
  sendQuoteInputSchema,
} from "./content";

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

describe("defaultEmailBody con nombres hostiles (revisión de Aarón al PR #67)", () => {
  const body = (customerName: string, organizationName = "Org SpA", authorName = "Ana") =>
    defaultEmailBody({ customerName, authorName, organizationName });

  it("un cliente u organización con una variable en el nombre no deja el correo con una variable sin completar", () => {
    for (const hostile of [
      "{{cliente}}",
      "Pérez {{numero}} y Cía.",
      "{{remitente}}",
      "{{organizacion}}",
    ]) {
      for (const text of [
        body(hostile),
        body("Cliente", hostile),
        body("Cliente", "Org", hostile),
      ]) {
        expect(hasUnresolvedVariables(text), hostile).toBe(false);
        // y el correo se puede enviar tal cual: pasa el formato básico
        expect(parseBasicFormat(text).ok, hostile).toBe(true);
      }
    }
    // el nombre sigue legible (las llaves quedan separadas, no desaparecen)
    expect(body("{{cliente}}")).toContain("Estimado/a { { cliente } }:");
  });

  it("un nombre con enlace o negrita no se vuelve enlace ni negrita", () => {
    const text = body("[Paga aquí](https://malo.ejemplo)", "**Org**", "*Ana*");
    expect(text).not.toContain("](");
    expect(text).not.toContain("**");
    const formatted = parseBasicFormat(text);
    expect(formatted.ok).toBe(true);
    if (formatted.ok) expect(formatted.html).not.toContain("<a ");
  });

  it("los nombres largos llegan completos hasta el máximo de la aplicación (cliente 200, organización y persona 120): no se cortan a mitad de palabra", () => {
    // nombres de exactamente `n` caracteres, que no empiezan ni terminan con espacio
    const nameOf = (n: number): string => {
      const text = Array.from({ length: n }, (_, i) => `Palabra${String(i).padStart(2, "0")}`)
        .join(" ")
        .slice(0, n);
      return text.endsWith(" ") ? `${text.slice(0, -1)}x` : text;
    };
    const customer = nameOf(200);
    const organization = nameOf(120);
    const author = nameOf(120);
    expect(customer).toHaveLength(200);
    expect(organization).toHaveLength(120);
    const text = body(customer, organization, author);
    expect(text).toContain(`Estimado/a ${customer}:`);
    expect(text).toContain(`Saludos cordiales,\n${author}\n${organization}`);
  });

  it("no deja espacios de más en el saludo ni en la firma, aunque el nombre empiece o termine con (, [ o *", () => {
    const text = body("(Sucursal Norte) Ltda.", "Constructora [ACME]", "*Ana*");
    expect(text).toContain("Estimado/a (Sucursal Norte) Ltda.:");
    expect(text).not.toMatch(/ {2}/);
    expect(text).not.toContain(" :");
    expect(text).toContain("Saludos cordiales,\n*Ana*\nConstructora [ACME]");
    expect(body("[ACME]", "(Ex) Transportes")).toContain("\n(Ex) Transportes");
  });

  it("los nombres normales quedan igual que antes", () => {
    expect(body("Distribuidora Maule Ltda.", "Transportes Andes SpA", "Juan Pérez")).toBe(
      [
        "Estimado/a Distribuidora Maule Ltda.:",
        DEFAULT_EMAIL_BODY_INTRO,
        DEFAULT_EMAIL_BODY_CLOSING,
        "Saludos cordiales,\nJuan Pérez\nTransportes Andes SpA",
      ].join("\n\n"),
    );
  });
});
