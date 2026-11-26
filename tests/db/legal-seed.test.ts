import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { legalDocuments, type LegalDocumentKind } from "@/lib/legal/documents";
import { connect } from "./helpers";

// Si cambia el texto de los términos o de la privacidad, la huella del código deja de coincidir con
// la de la base: hay que publicar una versión nueva con una migración (no editar la anterior).
describe("documentos legales vigentes: código y base coinciden", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect();
  });
  afterAll(async () => {
    await client.end();
  });

  for (const kind of ["terms", "privacy"] as LegalDocumentKind[]) {
    it(`${kind}: la versión y la huella de la base son las del código`, async () => {
      const { rows } = await client.query<{ version: string; content_sha256: string }>(
        "select version, content_sha256 from public.legal_documents where kind = $1 and is_current",
        [kind],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe(legalDocuments[kind].version);
      expect(rows[0].content_sha256).toBe(legalDocuments[kind].contentSha256);
    });
  }

  // Decisión 023: la privacidad 2026-11-27 (sin Sentry) reemplaza a la 2026-10-01, que se conserva (hay aceptaciones que la
  // nombran) pero ya no está vigente.
  it("privacy: la versión anterior se conserva sin estar vigente", async () => {
    const { rows } = await client.query<{ version: string; is_current: boolean }>(
      "select version, is_current from public.legal_documents where kind = 'privacy' order by version",
    );
    expect(rows).toEqual([
      { version: "2026-10-01-preliminar", is_current: false },
      { version: "2026-11-27-preliminar", is_current: true },
    ]);
  });
});
