// Ayudas compartidas por las pruebas de base de datos del sprint 3 (enviar, enlace, responder).
// Todo es ficticio. La fixture se deja confirmada una vez; cada prueba corre dentro de `withTx`.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { calculateQuote } from "../../src/lib/quotes/calc";
import {
  TENANT_HEADER,
  actAs,
  actAsPostgres,
  createTenantAs,
  createUser,
  type TestUser,
} from "./helpers";

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Un token como los de producción (43 caracteres base64url) y su sello. */
export function newToken(): { token: string; sha: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, sha: sha256Hex(token) };
}

export interface World {
  owner: TestUser;
  admin: TestUser;
  sales: TestUser;
  sales2: TestUser;
  approver: TestUser;
  viewer: TestUser;
  ownerB: TestUser;
  tenantA: string;
  tenantB: string;
  customerA: string;
  customerAnon: string;
  customerB: string;
}

async function addMember(db: Client, tenantId: string, user: TestUser, role: string) {
  await db.query("insert into public.members (tenant_id, user_id, role) values ($1, $2, $3)", [
    tenantId,
    user.id,
    role,
  ]);
}

async function addCustomer(db: Client, tenantId: string, name: string, anonymized = false) {
  const id = randomUUID();
  await db.query(
    `insert into public.customers (id, tenant_id, kind, display_name, anonymized_at)
     values ($1, $2, 'company', $3, case when $4 then now() end)`,
    [id, tenantId, name, anonymized],
  );
  return id;
}

/** Dos organizaciones con sus roles, y clientes. Se confirma al terminar. */
export async function buildWorld(db: Client): Promise<World> {
  await db.query("begin");
  const users: TestUser[] = [];
  for (let n = 0; n < 7; n++) users.push(await createUser(db));
  const [owner, admin, sales, sales2, approver, viewer, ownerB] = users;
  const tenantA = await createTenantAs(db, owner);
  const tenantB = await createTenantAs(db, ownerB);
  await addMember(db, tenantA, admin, "admin");
  await addMember(db, tenantA, sales, "sales");
  await addMember(db, tenantA, sales2, "sales");
  await addMember(db, tenantA, approver, "approver");
  await addMember(db, tenantA, viewer, "viewer");
  const customerA = await addCustomer(db, tenantA, "Cliente A");
  const customerAnon = await addCustomer(db, tenantA, "Cliente anonimizado", true);
  const customerB = await addCustomer(db, tenantB, "Cliente B");
  await db.query("commit");
  return {
    owner,
    admin,
    sales,
    sales2,
    approver,
    viewer,
    ownerB,
    tenantA,
    tenantB,
    customerA,
    customerAnon,
    customerB,
  };
}

export const asUser = (db: Client, user: TestUser, tenantId: string) =>
  actAs(db, user, { [TENANT_HEADER]: tenantId });

export const line = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  name: "Servicio libre",
  description: null,
  unit: "service",
  tax_treatment: "taxable",
  quantity_milli: 1000,
  unit_price_clp: 10000,
  discount_kind: "none",
  discount_value: 0,
  ...over,
});

/** Crea una cotización como `user` y le guarda una línea (si `withLine`). Devuelve su id. */
export async function createQuote(
  db: Client,
  user: TestUser,
  tenantId: string,
  customerId: string,
  withLine = true,
): Promise<string> {
  await asUser(db, user, tenantId);
  const { rows } = await db.query<{ quote_id: string }>(
    "select * from public.create_quote($1, $2)",
    [customerId, randomUUID()],
  );
  const quoteId = rows[0].quote_id;
  if (withLine) {
    const calc = calculateQuote({
      lines: [
        {
          quantityMilli: 1000,
          unitPriceClp: 10000,
          taxTreatment: "taxable",
          discount: { kind: "none" },
        },
      ],
      globalDiscount: { kind: "none" },
      taxRateBp: 1900,
    });
    if (!calc.ok) throw new Error("cálculo de prueba inválido");
    await db.query("select public.save_quote_draft($1, 1, $2, $3, $4, $5)", [
      quoteId,
      randomUUID(),
      JSON.stringify({ customer_id: customerId, global_discount: { kind: "none", value: 0 } }),
      JSON.stringify([line()]),
      JSON.stringify(calc.totals),
    ]);
  }
  await actAsPostgres(db);
  return quoteId;
}

export interface PackageIds {
  id: string;
  sendKey: string;
}

/** Inserta un paquete en `preparing`, como postgres (montaje; la API de la aplicación usa las funciones). */
export async function insertPackage(
  db: Client,
  tenantId: string,
  quoteId: string,
  createdBy: TestUser,
  over: { id?: string; sendKey?: string; subject?: string } = {},
): Promise<PackageIds> {
  const id = over.id ?? randomUUID();
  const sendKey = over.sendKey ?? randomUUID();
  await db.query(
    `insert into public.quote_packages
       (id, tenant_id, quote_id, send_key, issue_date, valid_until, email_subject, email_body_md,
        customer_snapshot_enc, created_by)
     values ($1, $2, $3, $4, app.current_business_date(), app.current_business_date() + 10, $5, 'Hola', 'v1.x.y', $6)`,
    [id, tenantId, quoteId, sendKey, over.subject ?? "Su cotización", createdBy.id],
  );
  return { id, sendKey };
}

/** Pasa un paquete a `ready` con datos de PDF coherentes con su ruta. */
export async function readyPackage(
  db: Client,
  tenantId: string,
  quoteId: string,
  packageId: string,
): Promise<void> {
  await db.query(
    `update public.quote_packages set
       pdf_path = $1, pdf_sha256 = $2, pdf_bytes = 1234, document_snapshot = '{"ok":true}'::jsonb,
       content_sha256 = $3, state = 'ready'
     where tenant_id = $4 and id = $5`,
    [
      `${tenantId}/${quoteId}/${packageId}.pdf`,
      sha256Hex(packageId),
      sha256Hex(quoteId),
      tenantId,
      packageId,
    ],
  );
}
