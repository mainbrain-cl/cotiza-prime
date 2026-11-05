import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext } from "@playwright/test";
import type { Client } from "pg";
import { generateRut } from "../src/lib/chile/rut";
import { consentFingerprint } from "../src/lib/intake/consent-fingerprint";
import { HONEYPOT_FIELD } from "../src/lib/intake/submit-schema";
import { TENANT_HEADER } from "../src/lib/tenant/constants";
import { connect } from "../tests/db/helpers";
import { localEnv, rest, rpc } from "../tests/support/local-supabase";
import { TEST_PASSWORD, createTenant, signUpAndVerify, uniqueEmail } from "./helpers";
import { expect, randomTestIp, test, type Page } from "./fixtures";

// Ayudantes de las pruebas de punta a punta de solicitudes (H-089, H-090). Todo ficticio. Organización propia
// por corrida (con su formulario publicado), personas con pase real, y el visitante que envía como el navegador:
// sello de tiempo ligado a la clave de envío, huella del aviso de privacidad, campo trampa y anti-robot de pruebas.

/** Sello de tiempo y clave de envío que el servidor entrega juntos (van seguidos en los datos de la página). */
const STAMP_IN_HTML =
  /(v1\.\d{9,12}\.[A-Za-z0-9_-]{43})\\*",\\*"submitKey\\*":\\*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
/** El sello de tiempo del formulario pide al menos 3 segundos entre mostrarlo y enviarlo. */
const AFTER_MIN_FILL_MS = 3_500;

export type Person = {
  email: string;
  userId: string;
  context: BrowserContext;
  page: Page;
  token: string;
};
export type Org = {
  tenantId: string;
  name: string;
  token: string;
  formId: string;
  publicId: string;
  revision: number;
};

export const header = (org: Org) => ({ [TENANT_HEADER]: org.tenantId });

export async function passwordToken(email: string): Promise<string> {
  const { apiUrl, publishableKey } = localEnv();
  const res = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

export async function ok<T>(
  promise: Promise<{ status: number; text: string; json: unknown }>,
  what: string,
) {
  const res = await promise;
  expect(res.status, `${what}: ${res.text}`).toBeLessThan(300);
  return res.json as T;
}

export async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Crea una cuenta nueva con sesión abierta en su propio navegador. */
export async function newPerson(
  browser: Browser,
  label: string,
  fullName: string,
): Promise<Person> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  const page = await context.newPage();
  const email = uniqueEmail(label);
  await signUpAndVerify(page, email, fullName);
  const userId = await withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>("select id from auth.users where email = $1", [
      email,
    ]);
    return rows[0].id;
  });
  return { email, userId, context, page, token: await passwordToken(email) };
}

export type FormItemSpec =
  | { name: string; unit: string; catalogItemId: string; quantityMode: "required" | "optional" }
  | {
      name: string;
      unit: string;
      catalogItemId: null;
      quantityMode: "required" | "optional" | "none";
    };

/** Organización nueva con un formulario publicado con los servicios indicados. */
export async function newOrg(
  owner: Person,
  name: string,
  itemsOrBuilder: FormItemSpec[] | ((tenantId: string) => Promise<FormItemSpec[]>),
  fields: Record<string, "off" | "optional" | "required"> = {},
): Promise<Org> {
  const tenantId = await createTenant(owner.page, name, generateRut());
  // Los servicios del catálogo se crean después de la organización y antes del formulario.
  const items =
    typeof itemsOrBuilder === "function" ? await itemsOrBuilder(tenantId) : itemsOrBuilder;
  const patched = await rest(owner.token, `tenants?tenant_id=eq.${tenantId}`, {
    method: "PATCH",
    headers: { [TENANT_HEADER]: tenantId, prefer: "return=representation" },
    body: { contact_email: `contacto-${randomUUID().slice(0, 6)}@ejemplo.test` },
  });
  expect(patched.status, patched.text).toBe(200);
  const org: Org = {
    tenantId,
    name,
    token: owner.token,
    formId: randomUUID(),
    publicId: "",
    revision: 0,
  };
  const created = await ok<{ public_id: string; revision: number }>(
    rpc(
      owner.token,
      "create_intake_form",
      { p_form_id: org.formId, p_name: `Fletes ${name.slice(-6)}` },
      header(org),
    ),
    "create_intake_form",
  );
  org.publicId = created.public_id;
  await ok(
    rpc(
      owner.token,
      "save_intake_form",
      {
        p_form_id: org.formId,
        p_expected_revision: created.revision,
        p_form: {
          title: "Pide tu cotización",
          intro: "Cuéntanos qué necesitas.",
          success_message: "Gracias, te escribiremos.",
          fields: {
            phone: "optional",
            company: "off",
            comuna: "off",
            serviceAddress: "off",
            desiredDate: "off",
            message: "optional",
            ...fields,
          },
        },
        p_items: items.map((item) => ({
          id: randomUUID(),
          kind: item.catalogItemId ? "catalog" : "free",
          ...(item.catalogItemId ? { catalog_item_id: item.catalogItemId } : {}),
          public_name: item.name,
          unit: item.unit,
          quantity_mode: item.quantityMode,
          ...(item.quantityMode === "none" ? {} : { min_qty_milli: 1000 }),
        })),
      },
      header(org),
    ),
    "save_intake_form",
  );
  await ok(
    rpc(
      owner.token,
      "set_intake_form_status",
      { p_form_id: org.formId, p_status: "published" },
      header(org),
    ),
    "publicar",
  );
  org.revision = await withDb(async (db) => {
    const { rows } = await db.query<{ revision: number }>(
      "select revision from public.intake_forms where id = $1",
      [org.formId],
    );
    return rows[0].revision;
  });
  return org;
}

/** Servicios con precio, los mismos de la semilla (`scripts/seed.ts`): nombre, unidad y monto. */
export const PRICED_SERVICES = [
  { name: "Flete urbano", unit: "service", price: 45000 },
  { name: "Mudanza completa", unit: "day", price: 280000 },
  { name: "Traslado por kilómetro", unit: "km", price: 1200 },
  { name: "Instalación técnica", unit: "hour", price: 18000 },
  { name: "Embalaje de muebles", unit: "unit", price: 6500 },
] as const;

/**
 * Deja lista para formularios una organización recién creada por pantalla: correo de contacto (publicar
 * lo pide) y los servicios con precio en su catálogo. Devuelve el pase de su Dueño.
 */
export async function prepareOrgForForms(ownerEmail: string, tenantId: string): Promise<string> {
  const token = await passwordToken(ownerEmail);
  const headers = { [TENANT_HEADER]: tenantId, prefer: "return=minimal" };
  const patched = await rest(token, `tenants?tenant_id=eq.${tenantId}`, {
    method: "PATCH",
    headers,
    body: { contact_email: `contacto-${randomUUID().slice(0, 6)}@ejemplo.test` },
  });
  expect(patched.status, patched.text).toBeLessThan(300);
  const catalog = await rest(token, "catalog_items", {
    method: "POST",
    headers,
    body: PRICED_SERVICES.map(({ name, unit, price }) => ({ name, unit, unit_price_clp: price })),
  });
  expect(catalog.status, catalog.text).toBeLessThan(300);
  return token;
}

export async function addMember(
  org: Pick<Org, "tenantId">,
  person: Pick<Person, "userId">,
  role: "admin" | "sales" | "viewer",
) {
  await withDb((db) =>
    db.query("insert into public.members (tenant_id, user_id, role) values ($1, $2, $3)", [
      org.tenantId,
      person.userId,
      role,
    ]),
  );
}

/** Id de cada servicio del formulario, por el nombre público. */
export async function formItemIds(org: Org): Promise<Map<string, string>> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ id: string; public_name: string }>(
      "select id, public_name from public.intake_form_items where form_id = $1",
      [org.formId],
    );
    return new Map(rows.map((row) => [row.public_name, row.id]));
  });
}

export type VisitorRequest = {
  name: string;
  email: string;
  phone?: string;
  serviceAddress?: string;
  message?: string;
  /** Nombre público del servicio → cantidad escrita («12,5»), o `null` si no lleva cantidad. */
  items: Record<string, string | null>;
};

/**
 * Varios visitantes envían directo a la API, como lo haría el navegador. Se piden todos los sellos de
 * tiempo primero, se espera una sola vez el mínimo de llenado y se envía desde IP distintas (así no se
 * agota el límite de envíos seguidos por conexión).
 */
export async function visitorsSubmit(
  page: Page,
  org: Org,
  requests: VisitorRequest[],
): Promise<void> {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  // La huella del aviso de privacidad que ve la persona, igual que la calcula el navegador.
  const reader = await page.context().newPage();
  let fingerprint: string;
  try {
    await reader.goto(`/f/${org.publicId}`);
    const consentText = await reader.locator('label[for="pf-consent"]').textContent();
    expect(consentText, "el aviso de privacidad está a la vista").toBeTruthy();
    fingerprint = consentFingerprint(consentText!, null);
  } finally {
    await reader.close();
  }
  const ids = await formItemIds(org);
  const stamps: { token: string; submitKey: string; ip: string }[] = [];
  for (let i = 0; i < requests.length; i += 1) {
    const ip = randomTestIp();
    const html = await (
      await page.request.get(`/f/${org.publicId}`, { headers: { "x-forwarded-for": ip } })
    ).text();
    const found = STAMP_IN_HTML.exec(html);
    expect(found, "la página trae el sello de tiempo y su clave de envío").toBeTruthy();
    stamps.push({ token: found![1], submitKey: found![2], ip });
  }
  await page.waitForTimeout(AFTER_MIN_FILL_MS);
  for (const [index, request] of requests.entries()) {
    const { token, submitKey, ip } = stamps[index];
    const response = await page.request.post(`/api/v1/public/forms/${org.publicId}/requests`, {
      headers: { origin, "x-forwarded-for": ip },
      data: {
        name: request.name,
        email: request.email,
        phone: request.phone,
        serviceAddress: request.serviceAddress,
        message: request.message,
        items: Object.entries(request.items).map(([name, quantity]) => ({
          formItemId: ids.get(name),
          quantity,
        })),
        consent: true,
        submitKey,
        consentFingerprint: fingerprint,
        formRevision: org.revision,
        [HONEYPOT_FIELD]: "",
        renderToken: token,
        antibotToken: "test-pass",
      },
    });
    expect(response.status(), await response.text()).toBeLessThan(300);
  }
}

/** Las solicitudes del formulario, en el orden en que llegaron. */
export async function requestIdsOf(org: Org): Promise<string[]> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.intake_requests where form_id = $1 order by created_at, id",
      [org.formId],
    );
    return rows.map((row) => row.id);
  });
}

export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}
