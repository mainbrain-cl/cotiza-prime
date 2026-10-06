import { describe, expect, it } from "vitest";
import { sampleDocument } from "@/lib/pdf/sample-data";
import { buildCustomerSnapshot, buildDocumentSnapshot, contentSha256 } from "./snapshot";

describe("copia congelada del envío", () => {
  const document = sampleDocument();

  it("el modelo del documento no lleva el logo ni los datos del cliente", () => {
    const snapshot = buildDocumentSnapshot({
      ...document,
      organization: {
        ...document.organization,
        logo: { format: "png", data: Buffer.from([1, 2, 3]) },
      },
    });
    const json = JSON.stringify(snapshot);
    expect(snapshot).not.toHaveProperty("customer");
    expect(snapshot.organization).not.toHaveProperty("logo");
    expect(json).not.toContain(document.customer.name);
    for (const line of document.customer.detailLines) expect(json).not.toContain(line);
    // Pero sí lo que dibuja la pantalla del cliente: las mismas cifras del PDF.
    expect(snapshot.totals).toEqual(document.totals);
    expect(snapshot.lines).toEqual(document.lines);
    expect(snapshot.organization.name).toBe(document.organization.name);
  });

  it("cabe en el tope de la base de datos (256 kB) incluso con 200 líneas", () => {
    const big = buildDocumentSnapshot(sampleDocument({ lineCount: 200 }));
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThan(256 * 1024);
  });

  it("la copia del cliente trae sus datos de contacto", () => {
    const snapshot = buildCustomerSnapshot({
      id: "x",
      kind: "company",
      displayName: "Cliente Ficticio SpA",
      email: "cliente@ejemplo.test",
      phone: "+56912345678",
      rut: "76086428-5",
      address: "Calle 1",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: null,
    });
    expect(snapshot).toEqual({
      kind: "company",
      name: "Cliente Ficticio SpA",
      rut: "76086428-5",
      email: "cliente@ejemplo.test",
      phone: "+56912345678",
      address: "Calle 1",
    });
  });

  it("el sello del contenido cambia con cualquier cosa que cambie", () => {
    const snapshot = buildDocumentSnapshot(document);
    const base = {
      subject: "Asunto",
      body: "Texto",
      issueDate: "2026-10-06",
      validUntil: "2026-10-21",
      pdfSha256: "a".repeat(64),
      snapshot,
    };
    const sha = contentSha256(base);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(contentSha256(base)).toBe(sha);
    expect(contentSha256({ ...base, body: "Texto." })).not.toBe(sha);
    expect(contentSha256({ ...base, subject: "Otro" })).not.toBe(sha);
    expect(contentSha256({ ...base, validUntil: "2026-10-22" })).not.toBe(sha);
    expect(contentSha256({ ...base, pdfSha256: "b".repeat(64) })).not.toBe(sha);
  });
});
