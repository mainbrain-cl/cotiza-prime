// Ayudas compartidas por las pruebas de base de datos del sprint 4 (formulario público y solicitudes).
// Todo es ficticio. El mundo se confirma una vez; cada prueba corre dentro de `withTx` (se deshace).
import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { actAsPostgres, connect, type TestUser } from "./helpers";
import { actAsService, asUser, buildWorld, type World } from "./send-helpers";

export interface IntakeWorld extends World {
  catalogA: string;
  catalogB: string;
}

/** `buildWorld` más correo de contacto en las dos organizaciones (para publicar) y un servicio de catálogo en cada una. */
export async function buildIntakeWorld(db: Client): Promise<IntakeWorld> {
  const w = await buildWorld(db);
  await db.query("begin");
  await db.query(
    "update public.tenants set contact_email = 'contacto@ejemplo.test' where tenant_id = any($1::uuid[])",
    [[w.tenantA, w.tenantB]],
  );
  const catalog = async (tenantId: string, name: string) => {
    const id = randomUUID();
    await db.query(
      `insert into public.catalog_items (id, tenant_id, name, unit, unit_price_clp)
       values ($1, $2, $3, 'service', 12345)`,
      [id, tenantId, name],
    );
    return id;
  };
  const catalogA = await catalog(w.tenantA, "Servicio de catálogo A");
  const catalogB = await catalog(w.tenantB, "Servicio de catálogo B");
  await db.query("commit");
  return { ...w, catalogA, catalogB };
}

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Un servicio libre válido para `save_intake_form`. */
export const freeItem = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  kind: "free",
  public_name: "Flete dentro de la ciudad",
  public_description: "Traslado de carga",
  unit: "service",
  quantity_mode: "optional",
  ...over,
});

/** Un servicio del catálogo (la aplicación copia nombre, descripción y unidad). */
export const catalogItem = (catalogItemId: string, over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  kind: "catalog",
  catalog_item_id: catalogItemId,
  public_name: "Servicio de catálogo A",
  public_description: null,
  unit: "service",
  quantity_mode: "required",
  min_qty_milli: 1000,
  max_qty_milli: 50000,
  ...over,
});

type Json = Record<string, unknown>;

/** Llama una función como una persona de una organización y deja la sesión como `postgres`. */
export async function callAs<T = Json>(
  db: Client,
  user: TestUser,
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  await asUser(db, user, tenantId);
  const { rows } = await db.query<{ r: T }>(sql, params);
  // Si la llamada falla, la transacción queda abortada y la prueba la deshace: no se toca la sesión.
  await actAsPostgres(db);
  return rows[0].r;
}

/** Llama una función como el servidor de la aplicación (llave maestra) y deja la sesión como `postgres`. */
export async function callAsServer<T = Json>(
  db: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  await actAsService(db);
  const { rows } = await db.query<{ r: T }>(sql, params);
  await actAsPostgres(db);
  return rows[0].r;
}

export interface MadeForm {
  formId: string;
  publicId: string;
  revision: number;
  itemIds: string[];
}

/** Crea un formulario (como `user`), le pone sus servicios y, si se pide, lo publica. */
export async function makeForm(
  db: Client,
  user: TestUser,
  tenantId: string,
  options: {
    items?: object[];
    publish?: boolean;
    form?: Json;
    name?: string;
  } = {},
): Promise<MadeForm> {
  const formId = randomUUID();
  const created = await callAs<{ public_id: string; revision: number }>(
    db,
    user,
    tenantId,
    "select public.create_intake_form($1, $2) as r",
    [formId, options.name ?? "Formulario de prueba"],
  );
  const items = options.items ?? [freeItem()];
  const saved = await callAs<{ revision: number }>(
    db,
    user,
    tenantId,
    "select public.save_intake_form($1, $2, $3::jsonb, $4::jsonb) as r",
    [formId, created.revision, JSON.stringify(options.form ?? {}), JSON.stringify(items)],
  );
  const revision = saved.revision;
  if (options.publish ?? true) {
    await callAs(db, user, tenantId, "select public.set_intake_form_status($1, 'published') as r", [
      formId,
    ]);
  }
  const ids = (items as { id: string }[]).map((i) => i.id);
  return { formId, publicId: created.public_id, revision, itemIds: ids };
}

/** Los argumentos de `intake_request_submit`, con valores válidos que cada prueba puede cambiar. */
export interface SubmitArgs {
  publicId: string;
  requestId?: string;
  submitKey?: string;
  revision: number;
  items: { form_item_id: string; quantity_milli: number | null }[];
  name?: string;
  email?: string;
  over?: Partial<{
    desiredDate: string | null;
    consentVersion: string;
    consentSha: string;
    consentIp: string | null;
  }>;
}

export const SUBMIT_SQL = `select public.intake_request_submit($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) as r`;

/** Parámetros en el orden de SUBMIT_SQL (ver la migración 31). */
export function submitParams(a: SubmitArgs): unknown[] {
  return [
    a.publicId,
    a.requestId ?? randomUUID(),
    a.submitKey ?? randomUUID(),
    a.revision,
    JSON.stringify(a.items),
    `v1.nombre.${a.name ?? "cifrado"}`,
    `v1.correo.${a.email ?? "cifrado"}`,
    "v1.telefono.cifrado",
    null,
    null,
    null,
    null,
    sha256Hex(a.email ?? "correo"),
    a.over && "desiredDate" in a.over ? a.over.desiredDate : null,
    a.over?.consentVersion ?? "v1",
    a.over?.consentSha ?? sha256Hex("texto de consentimiento"),
  ];
}

export { actAsPostgres, asUser, connect };
