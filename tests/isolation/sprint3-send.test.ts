// Sprint 3 · Ataques 1 y 2: las funciones de envío no actúan sobre datos de otra organización.
// Siempre con pases reales y `fetch` directo; `pg` solo sirve para verificar que B no cambió.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateQuote } from "@/lib/quotes/calc";
import { rpc } from "../support/local-supabase";
import { fingerprint, fixture, openDb, tenantHeader, tokenOf } from "./context";
import { FIXTURE_PDF } from "./fixture";
import { ISOLATION_TABLES } from "./registry";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const SPRINT3_TABLES = [
  "quotes",
  "quote_items",
  "quote_events",
  "quote_packages",
  "share_links",
  "share_link_views",
  "email_messages",
  "quote_responses",
  "audit_log",
];

const codeOf = (res: { json: unknown }) => (res.json as { code?: string } | null)?.code;

/** Una cotización nueva de Ana en A, con una línea, lista para enviar (por los caminos legítimos). */
async function anasFreshQuote(): Promise<{ quoteId: string; revision: number }> {
  const fx = fixture();
  const token = await tokenOf("ana");
  const headers = tenantHeader(fx.orgs.A.tenantId);
  const created = await rpc(
    token,
    "create_quote",
    { p_customer_id: fx.orgs.A.customerIds[0], p_creation_key: randomUUID() },
    headers,
  );
  expect(created.status, created.text).toBe(200);
  const quoteId = (created.json as { quote_id: string }[])[0].quote_id;
  const calc = calculateQuote({
    lines: [
      {
        quantityMilli: 1000,
        unitPriceClp: 10_000,
        taxTreatment: "taxable",
        discount: { kind: "none" },
      },
    ],
    globalDiscount: { kind: "none" },
    taxRateBp: 1900,
  });
  if (!calc.ok) throw new Error("cálculo de prueba inválido");
  const saved = await rpc(
    token,
    "save_quote_draft",
    {
      p_quote_id: quoteId,
      p_expected_revision: 1,
      p_save_id: randomUUID(),
      p_header: {
        customer_id: fx.orgs.A.customerIds[0],
        global_discount: { kind: "none", value: 0 },
      },
      p_items: [
        {
          id: randomUUID(),
          name: "Línea de Ana",
          description: null,
          unit: "service",
          tax_treatment: "taxable",
          quantity_milli: 1000,
          unit_price_clp: 10_000,
          discount_kind: "none",
          discount_value: 0,
        },
      ],
      p_expected_totals: calc.totals,
    },
    headers,
  );
  expect(saved.status, saved.text).toBe(200);
  return { quoteId, revision: (saved.json as { revision: number }).revision };
}

describe("Ataque 1 · Ana, desde A, llama las funciones de envío sobre datos de B", () => {
  it("todas responden 'no encontrado' y B queda idéntica", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const specs = ISOLATION_TABLES.filter((t) => SPRINT3_TABLES.includes(t.name));
    const before = new Map<string, string>();
    for (const spec of specs) before.set(spec.name, await fingerprint(db, spec));

    const b = fx.orgs.B;
    const calls: [string, object][] = [
      [
        "prepare_quote_send",
        {
          p_quote_id: b.quoteIds[0],
          p_expected_revision: 1,
          p_send_key: randomUUID(),
          p_package_id: randomUUID(),
          p_email_message_id: randomUUID(),
          p_share_link_id: randomUUID(),
          p_token_sha256: "a".repeat(64),
          p_email_subject: "Ataque",
          p_email_body_md: "Ataque",
          p_to_email_enc: "ataque",
          p_to_email_hash: "b".repeat(64),
          p_customer_snapshot_enc: "ataque",
        },
      ],
      [
        "prepare_quote_resend",
        {
          p_quote_id: b.share!.quoteId,
          p_resend_key: randomUUID(),
          p_email_message_id: randomUUID(),
          p_share_link_id: randomUUID(),
          p_token_sha256: "a".repeat(64),
          p_to_email_enc: "ataque",
          p_to_email_hash: "b".repeat(64),
        },
      ],
      ["revoke_quote_links", { p_quote_id: b.share!.quoteId }],
      [
        "attach_quote_package_document",
        {
          p_package_id: b.share!.packageId,
          p_pdf_path: b.share!.pdfPath,
          p_pdf_sha256: "a".repeat(64),
          p_pdf_bytes: 10,
          p_logo_path: null,
          p_document_snapshot: { ataque: true },
          p_content_sha256: "b".repeat(64),
        },
      ],
      [
        "confirm_email_dispatch",
        {
          p_email_message_id: b.share!.emailMessageId,
          p_provider: "memory",
          p_provider_message_id: "ataque",
        },
      ],
      [
        "fail_email_dispatch",
        { p_email_message_id: b.share!.emailMessageId, p_error_code: "ataque" },
      ],
    ];
    for (const [name, args] of calls) {
      const res = await rpc(token, name, args, headers);
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      expect(codeOf(res), `${name}: ${res.text}`).toBe("CP404");
      expect(res.text).not.toContain(b.canary);
    }
    for (const spec of specs) {
      expect(await fingerprint(db, spec), `${spec.name} cambió`).toBe(before.get(spec.name));
    }
  });
});

describe("Ataque 2 · adjuntar un documento con la ruta de otra organización", () => {
  it("Ana prepara su propio envío y luego apunta el PDF al archivo de B: se rechaza y B no cambia", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const { quoteId, revision } = await anasFreshQuote();
    const packageId = randomUUID();
    const emailId = randomUUID();
    const prepared = await rpc(
      token,
      "prepare_quote_send",
      {
        p_quote_id: quoteId,
        p_expected_revision: revision,
        p_send_key: randomUUID(),
        p_package_id: packageId,
        p_email_message_id: emailId,
        p_share_link_id: randomUUID(),
        p_token_sha256: "c".repeat(64),
        p_email_subject: "Mi cotización",
        p_email_body_md: "Hola",
        p_to_email_enc: "v1.x.y",
        p_to_email_hash: "d".repeat(64),
        p_customer_snapshot_enc: "v1.x.y",
      },
      headers,
    );
    expect(prepared.status, prepared.text).toBe(200);

    const pkg = ISOLATION_TABLES.find((t) => t.name === "quote_packages")!;
    const before = await fingerprint(db, pkg);
    const attach = (path: string) =>
      rpc(
        token,
        "attach_quote_package_document",
        {
          p_package_id: packageId,
          p_pdf_path: path,
          p_pdf_sha256: "a".repeat(64),
          p_pdf_bytes: FIXTURE_PDF.length,
          p_logo_path: null,
          p_document_snapshot: { ataque: true },
          p_content_sha256: "b".repeat(64),
        },
        headers,
      );
    // el PDF congelado de B existe de verdad en Storage: aun así, no se puede adoptar
    for (const path of [
      fx.orgs.B.share!.pdfPath,
      `${fx.orgs.B.tenantId}/${quoteId}/${packageId}.pdf`,
      `${fx.orgs.A.tenantId}/${fx.orgs.A.share!.quoteId}/${fx.orgs.A.share!.packageId}.pdf`, // otro envío, de la misma organización
    ]) {
      const res = await attach(path);
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(codeOf(res), path).toBe("CP422");
    }
    const { rows } = await db.query<{ state: string; pdf_path: string | null }>(
      "select state, pdf_path from public.quote_packages where id = $1",
      [packageId],
    );
    expect(rows[0]).toEqual({ state: "preparing", pdf_path: null });
    expect(await fingerprint(db, pkg)).toBe(before);

    // se limpia: el envío de la prueba falla y suelta el candado de la cotización
    const failed = await rpc(
      token,
      "fail_email_dispatch",
      { p_email_message_id: emailId, p_error_code: "test_cleanup" },
      headers,
    );
    expect(failed.status, failed.text).toBeLessThan(300);
  });
});
