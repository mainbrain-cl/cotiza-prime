import { describe, expect, it } from "vitest";
import {
  buildLegalDocument,
  CURRENT_LEGAL_VERSIONS,
  hashLegalText,
  legalDocuments,
} from "./documents";

describe("documentos legales", () => {
  it("carga ambos textos con la versión vigente", () => {
    for (const kind of ["terms", "privacy"] as const) {
      const doc = legalDocuments[kind];
      expect(doc.version).toBe(CURRENT_LEGAL_VERSIONS[kind].version);
      expect(doc.publishedOn).toBe(CURRENT_LEGAL_VERSIONS[kind].publishedOn);
      expect(doc.content).toContain("Versión preliminar, pendiente de revisión legal.");
      expect(doc.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("el hash es estable para el mismo texto", () => {
    expect(hashLegalText("hola")).toBe(hashLegalText("hola"));
    expect(hashLegalText("hola")).toBe(
      "b221d9dbb083a7f33428d7c2a3c3198ae925614d70210e28716ccaa7cd4ddb79",
    );
  });

  it("el hash cambia si cambia el texto", () => {
    expect(hashLegalText("hola")).not.toBe(hashLegalText("hola."));
    const a = buildLegalDocument("terms", "v1", "2026-10-01", "texto");
    const b = buildLegalDocument("terms", "v1", "2026-10-01", "texto distinto");
    expect(a.contentSha256).not.toBe(b.contentSha256);
  });

  it("el hash no depende de los saltos de línea del sistema", () => {
    expect(hashLegalText("a\r\nb\r\n")).toBe(hashLegalText("a\nb\n"));
  });

  it("la privacidad vigente ya no nombra a Sentry (decisión 023)", () => {
    expect(legalDocuments.privacy.version).toBe("2026-11-27-preliminar");
    expect(legalDocuments.privacy.content).not.toMatch(/sentry/i);
  });

  it("los dos documentos tienen huellas distintas", () => {
    expect(legalDocuments.terms.contentSha256).not.toBe(legalDocuments.privacy.contentSha256);
  });
});
