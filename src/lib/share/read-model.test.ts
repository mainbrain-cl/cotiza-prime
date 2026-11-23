import { describe, expect, it } from "vitest";
import { isAvailable, shareReadSchema, type ShareReadResult } from "./read-model";

const UUID = "11111111-1111-4111-8111-111111111111";
const contact = { name: "Empresa Ficticia", detail_lines: ["contacto@ejemplo.test"] };

const snapshot = {
  paper: "letter",
  brand: {
    primary: "#2b54e0",
    secondary: "#0f1729",
    primaryText: "#2b54e0",
    onPrimary: "#ffffff",
    primaryTint: "#eaeefc",
  },
  organization: { name: "Empresa Ficticia", detailLines: [] },
  quote: {
    number: "COT-2026-0001",
    versionLabel: null,
    issueDate: "01-10-2026",
    validUntil: null,
    validityNote: null,
  },
  preparedBy: { name: "Vendedora", detailLines: [] },
  lines: [],
  totals: {
    subtotal: "$0",
    globalDiscount: null,
    netTaxable: "$0",
    exempt: null,
    taxLabel: "IVA 19%",
    tax: "$0",
    total: "$0",
  },
  observations: null,
  conditions: null,
  paymentTerms: null,
};

const available = {
  state: "ok",
  org_contact: contact,
  tenant_id: UUID,
  quote_id: UUID,
  package_id: UUID,
  share_link_id: UUID,
  quote_status: "sent",
  valid_until: "2026-12-31",
  response: null,
  document_snapshot: snapshot,
  customer_snapshot_enc: null,
  pdf_path: null,
  pdf_sha256: null,
  logo_path: null,
};

describe("lo que devuelve share_link_read", () => {
  it("acepta cada estado con su forma", () => {
    expect(shareReadSchema.safeParse({ state: "not_found" }).success).toBe(true);
    for (const state of ["expired", "revoked", "superseded"]) {
      expect(shareReadSchema.safeParse({ state, org_contact: contact }).success).toBe(true);
    }
    expect(shareReadSchema.safeParse(available).success).toBe(true);
    expect(shareReadSchema.safeParse({ ...available, state: "responded" }).success).toBe(true);
  });

  it("rechaza una copia del documento que no calza (no se dibuja nada a medias)", () => {
    expect(shareReadSchema.safeParse({ ...available, document_snapshot: {} }).success).toBe(false);
    expect(shareReadSchema.safeParse({ ...available, tenant_id: "no-es-un-uuid" }).success).toBe(
      false,
    );
    expect(shareReadSchema.safeParse({ state: "otro" }).success).toBe(false);
  });

  it("una cotización enviada ANTES de H-048b (sin exclusiones ni notas en la copia) sigue abriendo, con los dos campos vacíos", () => {
    // `snapshot` no trae las claves nuevas: es exactamente lo que guardaron los envíos antiguos.
    expect(snapshot).not.toHaveProperty("exclusions");
    expect(snapshot).not.toHaveProperty("footerNote");
    const parsed = shareReadSchema.parse(available);
    if (parsed.state !== "ok") throw new Error("debía estar disponible");
    expect(parsed.document_snapshot.exclusions).toBeNull();
    expect(parsed.document_snapshot.footerNote).toBeNull();
  });

  it("una copia nueva trae sus exclusiones y notas; nulas o con texto valen; pasar de 5.000 caracteres se rechaza", () => {
    const parse = (extra: Record<string, unknown>) =>
      shareReadSchema.safeParse({
        ...available,
        document_snapshot: { ...snapshot, ...extra },
      });
    const withTexts = parse({ exclusions: "No incluye embalaje.", footerNote: "Valores en CLP." });
    expect(withTexts.success).toBe(true);
    const data = withTexts.data;
    if (data?.state !== "ok") throw new Error("debía estar disponible");
    expect(data.document_snapshot).toMatchObject({
      exclusions: "No incluye embalaje.",
      footerNote: "Valores en CLP.",
    });
    expect(parse({ exclusions: null, footerNote: null }).success).toBe(true);
    expect(parse({ exclusions: "x".repeat(5_000) }).success).toBe(true);
    expect(parse({ exclusions: "x".repeat(5_001) }).success).toBe(false);
    expect(parse({ footerNote: "x".repeat(5_001) }).success).toBe(false);
    expect(parse({ exclusions: 5 }).success).toBe(false);
  });

  it("un enlace vencido, revocado o reemplazado no trae la cotización", () => {
    const parsed = shareReadSchema.parse({
      state: "expired",
      org_contact: contact,
      document_snapshot: snapshot,
    });
    expect(parsed).not.toHaveProperty("document_snapshot");
  });

  it("isAvailable distingue lo que muestra la cotización", () => {
    const ok = { state: "ok" } as ShareReadResult;
    const responded = { state: "responded" } as ShareReadResult;
    const expired: ShareReadResult = {
      state: "expired",
      contact: { name: "", detailLines: [] },
    };
    expect([isAvailable(ok), isAvailable(responded), isAvailable(expired)]).toEqual([
      true,
      true,
      false,
    ]);
  });
});
