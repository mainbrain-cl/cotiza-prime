// Ayudas de las pruebas de la regla de aprobación (H-040): armar una cotización con totales exactos y enviarla.
// Todo es ficticio. Se espera dentro de una transacción (withTx) o con organizaciones propias.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { calculateQuote, type Discount, type QuoteTotals } from "../../src/lib/quotes/calc";
import { actAsPostgres, type TestUser } from "./helpers";
import { asUser, line, newToken, sha256Hex } from "./send-helpers";

export type LineSpec = { price: number; qtyMilli?: number; discount?: Discount; exempt?: boolean };
export type QuoteSpec = { lines: LineSpec[]; globalDiscount?: Discount };

const toDb = (discount: Discount | undefined): { kind: string; value: number } =>
  !discount || discount.kind === "none"
    ? { kind: "none", value: 0 }
    : discount.kind === "percent"
      ? { kind: "percent", value: discount.bp }
      : { kind: "amount", value: discount.clp };

/** Crea una cotización de `user` con estas líneas y descuento general; devuelve su id, su revisión y los totales. */
export async function createQuoteWith(
  db: Client,
  user: TestUser,
  tenantId: string,
  customerId: string,
  spec: QuoteSpec,
): Promise<{ quoteId: string; revision: number; totals: QuoteTotals }> {
  const calc = calculateQuote({
    lines: spec.lines.map((l) => ({
      quantityMilli: l.qtyMilli ?? 1000,
      unitPriceClp: l.price,
      taxTreatment: l.exempt ? "exempt" : "taxable",
      discount: l.discount ?? { kind: "none" },
    })),
    globalDiscount: spec.globalDiscount ?? { kind: "none" },
    taxRateBp: 1900,
  });
  if (!calc.ok) throw new Error(`cálculo de prueba inválido: ${JSON.stringify(calc.issues)}`);
  await asUser(db, user, tenantId);
  const { rows } = await db.query<{ quote_id: string }>(
    "select * from public.create_quote($1, $2)",
    [customerId, randomUUID()],
  );
  const quoteId = rows[0].quote_id;
  const global = toDb(spec.globalDiscount);
  await db.query("select public.save_quote_draft($1, 1, $2, $3, $4, $5)", [
    quoteId,
    randomUUID(),
    JSON.stringify({
      customer_id: customerId,
      global_discount: { kind: global.kind, value: global.value },
    }),
    JSON.stringify(
      spec.lines.map((l) => {
        const d = toDb(l.discount);
        return line({
          unit_price_clp: l.price,
          quantity_milli: l.qtyMilli ?? 1000,
          tax_treatment: l.exempt ? "exempt" : "taxable",
          discount_kind: d.kind,
          discount_value: d.value,
        });
      }),
    ),
    JSON.stringify(calc.totals),
  ]);
  const { rows: revision } = await db.query<{ revision: number }>(
    "select revision from public.quotes where id = $1",
    [quoteId],
  );
  await actAsPostgres(db);
  return { quoteId, revision: revision[0].revision, totals: calc.totals };
}

export const PREPARE_SQL =
  "select public.prepare_quote_send($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as r";

export type PrepareIds = {
  sendKey: string;
  packageId: string;
  emailId: string;
  linkId: string;
  sha: string;
};

export function prepareIds(): PrepareIds {
  return {
    sendKey: randomUUID(),
    packageId: randomUUID(),
    emailId: randomUUID(),
    linkId: randomUUID(),
    sha: newToken().sha,
  };
}

export function prepareArgs(quoteId: string, revision: number, ids: PrepareIds): unknown[] {
  return [
    quoteId,
    revision,
    ids.sendKey,
    ids.packageId,
    ids.emailId,
    ids.linkId,
    ids.sha,
    "Su cotización",
    "Hola",
    "v1.to.to",
    sha256Hex("cliente@ejemplo.test"),
    "v1.snap.snap",
  ];
}

/** Cuántas filas dejó un envío en cada tabla que toca (paquete, enlace, correo) y si el candado quedó tomado. */
export async function sendFootprint(db: Client, tenantId: string, quoteId: string) {
  await actAsPostgres(db);
  const count = async (table: string) =>
    Number(
      (
        await db.query<{ n: string }>(
          `select count(*) as n from public.${table} where tenant_id = $1 and quote_id = $2`,
          [tenantId, quoteId],
        )
      ).rows[0].n,
    );
  const { rows } = await db.query<{ locked: boolean }>(
    "select send_lock_key is not null as locked from public.quotes where tenant_id = $1 and id = $2",
    [tenantId, quoteId],
  );
  return {
    packages: await count("quote_packages"),
    links: await count("share_links"),
    emails: await count("email_messages"),
    locked: rows[0].locked,
  };
}
