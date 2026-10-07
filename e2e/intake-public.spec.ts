import "../tests/support/stub-server-only"; // debe ir primero
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import sharp from "sharp";
import { generateRut } from "../src/lib/chile/rut";
import { decryptPii } from "../src/lib/crypto/pii";
import { consentFingerprint } from "../src/lib/intake/consent-fingerprint";
import { createRenderToken } from "../src/lib/intake/render-token";
import { HONEYPOT_FIELD } from "../src/lib/intake/submit-schema";
import { TENANT_HEADER } from "../src/lib/tenant/constants";
import { connect } from "../tests/db/helpers";
import { localEnv, rest, rpc, storage } from "../tests/support/local-supabase";
import { TEST_PASSWORD, createTenant, signUpAndVerify, uniqueEmail } from "./helpers";
import { expect, randomTestIp, test, type Page } from "./fixtures";

// H-087: pedir una cotización por el formulario público (primera superficie pública que ESCRIBE datos de un
// desconocido). Todo ficticio. Se arma una organización nueva por corrida (cuenta propia en `ejemplo.test`):
// así los topes del día y de avisos de las cuentas de la semilla no se tocan ni se agotan.
// El formulario sin sesión, a 375 px: sin precios, sin identificadores internos, con todas sus protecciones.

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";
const MOBILE = { width: 375, height: 812 };
/** Precio del servicio del catálogo de esta corrida: no puede aparecer en NINGUNA respuesta pública. */
const CATALOG_PRICE = 45_000;
const PRICE_TEXTS = ["45.000", "45000", "unit_price", "unitPrice", "price"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Sello de tiempo y clave de envío que el servidor entrega juntos (van seguidos en los datos de la página). */
const STAMP_IN_HTML =
  /(v1\.\d{9,12}\.[A-Za-z0-9_-]{43})\\*",\\*"submitKey\\*":\\*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
/** El sello de tiempo pide al menos 3 segundos entre mostrar el formulario y enviarlo. */
const AFTER_MIN_FILL_MS = 3_500;
const XSS_NAME = "<img src=x onerror=alert(1)>";
const XSS_MESSAGE = 'Hola\n<script>alert(1)</script>\n& "comillas"';

type Stamp = { token: string; submitKey: string };

type FormInfo = {
  id: string;
  publicId: string;
  revision: number;
  catalogItemId: string;
  freeItemId: string;
  name: string;
  successMessage: string;
};

const ctx = {} as {
  tenantId: string;
  tenantName: string;
  ownerEmail: string;
  token: string;
  catalogId: string;
  main: FormInfo;
  cap: FormInfo;
  paused: FormInfo;
};

const header = () => ({ [TENANT_HEADER]: ctx.tenantId });

async function passwordToken(email: string): Promise<string> {
  const { apiUrl, publishableKey } = localEnv();
  const res = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function ok<T>(
  promise: Promise<{ status: number; text: string; json: unknown }>,
  what: string,
) {
  const res = await promise;
  expect(res.status, `${what}: ${res.text}`).toBeLessThan(300);
  return res.json as T;
}

async function createForm(options: {
  name: string;
  dailyCap?: number;
  successMessage: string;
  publish?: boolean;
}): Promise<FormInfo> {
  const id = randomUUID();
  const catalogItemId = randomUUID();
  const freeItemId = randomUUID();
  const created = await ok<{ public_id: string; revision: number }>(
    rpc(ctx.token, "create_intake_form", { p_form_id: id, p_name: options.name }, header()),
    "create_intake_form",
  );
  const saved = await ok<{ revision: number }>(
    rpc(
      ctx.token,
      "save_intake_form",
      {
        p_form_id: id,
        p_expected_revision: created.revision,
        p_form: {
          title: "Pide tu cotización de flete",
          intro: "Cuéntanos qué necesitas.",
          success_message: options.successMessage,
          fields: {
            phone: "optional",
            company: "off",
            comuna: "off",
            serviceAddress: "off",
            desiredDate: "off",
            message: "optional",
          },
          ...(options.dailyCap ? { daily_cap: options.dailyCap } : {}),
        },
        p_items: [
          {
            id: catalogItemId,
            kind: "catalog",
            catalog_item_id: ctx.catalogId,
            public_name: "Flete urbano",
            public_description: "Dentro de la Región Metropolitana",
            unit: "service",
            quantity_mode: "none",
          },
          {
            id: freeItemId,
            kind: "free",
            public_name: "Traslado por kilómetro",
            unit: "km",
            quantity_mode: "required",
            min_qty_milli: 1000,
          },
        ],
      },
      header(),
    ),
    "save_intake_form",
  );
  if (options.publish !== false) {
    await ok(
      rpc(ctx.token, "set_intake_form_status", { p_form_id: id, p_status: "published" }, header()),
      "publicar",
    );
  }
  return {
    id,
    publicId: created.public_id,
    revision: saved.revision,
    catalogItemId,
    freeItemId,
    name: options.name,
    successMessage: options.successMessage,
  };
}

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

const requestsOf = (formId: string) =>
  withDb(async (db) => {
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.intake_requests where form_id = $1",
      [formId],
    );
    return rows[0].n;
  });

const counters = (formId: string) =>
  withDb(async (db) => {
    const { rows } = await db.query<Record<string, number>>(
      `select coalesce(sum(accepted),0)::int as accepted, coalesce(sum(blocked_captcha),0)::int as blocked_captcha,
              coalesce(sum(blocked_rate),0)::int as blocked_rate, coalesce(sum(blocked_cap),0)::int as blocked_cap,
              coalesce(sum(blocked_paused),0)::int as blocked_paused, coalesce(sum(blocked_invalid),0)::int as blocked_invalid
         from public.intake_daily_counters where form_id = $1`,
      [formId],
    );
    return rows[0];
  });

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

type Mail = { Subject: string; Text: string; HTML: string };

async function mailsTo(to: string, subject?: string): Promise<Mail[]> {
  const query = encodeURIComponent(subject ? `to:${to} subject:"${subject}"` : `to:${to}`);
  const search = await fetch(`${MAILBOX_URL}/api/v1/search?query=${query}`);
  const { messages } = (await search.json()) as { messages?: { ID: string }[] };
  const out: Mail[] = [];
  for (const message of messages ?? []) {
    const detail = await fetch(`${MAILBOX_URL}/api/v1/message/${message.ID}`);
    out.push((await detail.json()) as Mail);
  }
  return out;
}

async function openForm(page: Page, form: FormInfo) {
  await page.goto(`/f/${form.publicId}`);
  await expect(page.getByTestId("form-view")).toBeVisible();
}

async function fillAndPick(
  page: Page,
  form: FormInfo,
  data: { name: string; email: string; message?: string; phone?: string; km?: string },
) {
  await page.locator("#pf-name").fill(data.name);
  await page.locator("#pf-email").fill(data.email);
  if (data.phone) await page.locator("#pf-phone").fill(data.phone);
  if (data.message) await page.locator("#pf-message").fill(data.message);
  await page.locator(`#pf-item-${form.freeItemId}`).check();
  await page.locator(`#pf-qty-${form.freeItemId}`).fill(data.km ?? "12,5");
}

const fingerprints = new Map<string, string>();

/** La huella del aviso de privacidad que ve la persona, igual que la calcula el navegador. */
async function consentFingerprintOf(page: Page, form: FormInfo): Promise<string> {
  const known = fingerprints.get(form.publicId);
  if (known) return known;
  const reader = await page.context().newPage();
  try {
    await reader.goto(`/f/${form.publicId}`);
    const text = await reader.locator('label[for="pf-consent"]').textContent();
    expect(text, "el aviso de privacidad está a la vista").toBeTruthy();
    const fingerprint = consentFingerprint(text!, null);
    fingerprints.set(form.publicId, fingerprint);
    return fingerprint;
  } finally {
    await reader.close();
  }
}

/** Hace como si fuera el navegador: sello de tiempo de la página y envío directo a la API. */
async function apiSubmit(
  page: Page,
  form: FormInfo,
  overrides: Record<string, unknown> = {},
  stampArg?: Stamp,
) {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const stamp = stampArg ?? (await renderTokenOf(page, form));
  return page.request.post(`/api/v1/public/forms/${form.publicId}/requests`, {
    headers: { origin },
    data: {
      name: "Visitante Ficticio",
      email: `visitante-${randomUUID().slice(0, 8)}@ejemplo.test`,
      items: [{ formItemId: form.freeItemId, quantity: "3" }],
      consent: true,
      submitKey: stamp.submitKey,
      consentFingerprint: overrides.consentFingerprint ?? (await consentFingerprintOf(page, form)),
      formRevision: form.revision,
      [HONEYPOT_FIELD]: "",
      renderToken: stamp.token,
      antibotToken: "test-pass",
      ...overrides,
    },
  });
}

/** El sello y la clave de envío de la página, recién pedidos (sin esperar el mínimo de 3 segundos). */
async function freshStamp(page: Page, form: FormInfo): Promise<Stamp> {
  const html = await (await page.request.get(`/f/${form.publicId}`)).text();
  const found = STAMP_IN_HTML.exec(html);
  expect(found, "la página trae el sello de tiempo y su clave de envío").toBeTruthy();
  return { token: found![1], submitKey: found![2] };
}

/** Igual, pero esperando lo que pide el sello para poder enviarse. */
async function renderTokenOf(page: Page, form: FormInfo): Promise<Stamp> {
  const stamp = await freshStamp(page, form);
  await page.waitForTimeout(AFTER_MIN_FILL_MS);
  return stamp;
}

test.describe.configure({ mode: "serial" });

test.describe("H-087 · pedir una cotización por el formulario público", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
    });
    const page = await context.newPage();
    ctx.ownerEmail = uniqueEmail("formulario");
    ctx.tenantName = `Negocio Formulario ${randomUUID().slice(0, 6)}`;
    await signUpAndVerify(page, ctx.ownerEmail, "Dueña Formulario");
    ctx.tenantId = await createTenant(page, ctx.tenantName, generateRut());
    await context.close();

    ctx.token = await passwordToken(ctx.ownerEmail);
    // Para publicar y para el aviso de privacidad, la organización necesita un correo de contacto.
    const patched = await rest(ctx.token, `tenants?tenant_id=eq.${ctx.tenantId}`, {
      method: "PATCH",
      headers: { ...header(), prefer: "return=representation" },
      body: { contact_email: `contacto-${randomUUID().slice(0, 6)}@ejemplo.test` },
    });
    expect(patched.status, patched.text).toBe(200);
    ctx.catalogId = randomUUID();
    const catalog = await rest(ctx.token, "catalog_items", {
      method: "POST",
      headers: { ...header(), prefer: "return=minimal" },
      body: {
        id: ctx.catalogId,
        name: "Flete urbano",
        unit: "service",
        unit_price_clp: CATALOG_PRICE,
        tax_treatment: "taxable",
      },
    });
    expect(catalog.status, catalog.text).toBeLessThan(300);

    const suffix = randomUUID().slice(0, 6);
    ctx.main = await createForm({
      name: `Fletes web ${suffix}`,
      successMessage: "¡Gracias! Te escribiremos hoy.",
    });
    ctx.cap = await createForm({
      name: `Mudanzas con tope ${suffix}`,
      dailyCap: 2,
      successMessage: "Listo, recibimos tu solicitud.",
    });
    ctx.paused = await createForm({
      name: `Formulario en pausa ${suffix}`,
      successMessage: "Gracias.",
    });
    await ok(
      rpc(
        ctx.token,
        "set_intake_form_status",
        { p_form_id: ctx.paused.id, p_status: "paused" },
        header(),
      ),
      "pausar",
    );
  });

  test("lo abre un visitante sin sesión a 375 px: con la marca, sin precios ni identificadores internos y con sus cabeceras", async ({
    page,
  }) => {
    const bodies: Promise<{ url: string; text: string }>[] = [];
    page.on("response", (response) => {
      const { pathname } = new URL(response.url());
      if (!pathname.startsWith("/f/")) return;
      bodies.push(response.text().then((text) => ({ url: response.url(), text })));
    });
    await page.setViewportSize(MOBILE);
    const document = await page.goto(`/f/${ctx.main.publicId}`);
    await expect(page.getByTestId("form-view")).toBeVisible();

    // La marca de la organización, no el diseño de Cotiza Prime
    const view = page.getByTestId("form-view");
    await expect(view).toHaveClass(/customer-light/);
    await expect(view).toContainText(ctx.tenantName);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pide tu cotización de flete");
    await expect(view).toContainText("Cuéntanos qué necesitas.");
    await expect(view).toContainText("Flete urbano");
    await expect(view).toContainText("Dentro de la Región Metropolitana");
    await expect(view).toContainText("Traslado por kilómetro");
    // la cantidad dice de qué servicio es (con lector de pantalla hay varias «Cantidad»)
    await expect(page.getByLabel("Cantidad de Traslado por kilómetro")).toBeVisible();
    await expect(view).toContainText("Tus datos los recibirá " + ctx.tenantName);
    await expect(page.locator("#pf-phone")).toBeVisible();
    await expect(page.locator("#pf-message")).toBeVisible();
    await expect(page.locator("#pf-company")).toHaveCount(0);
    // sin RUT ni precios
    await expect(page.getByLabel(/RUT/i)).toHaveCount(0);
    const visible = await page.locator("body").innerText();
    expect(visible, "ningún signo $ a la vista").not.toContain("$");
    await expectNoHorizontalScroll(page);
    // campo de texto a 16 px (el iPhone no hace zoom)
    const fontSize = await page.locator("#pf-name").evaluate((el) => getComputedStyle(el).fontSize);
    expect(Number.parseFloat(fontSize)).toBeGreaterThanOrEqual(16);

    // Nada del formulario sale con identificadores internos, nombre interno ni precios
    const { formId, internalName } = await withDb(async (db) => {
      const { rows } = await db.query<{ id: string; name: string }>(
        "select id, name from public.intake_forms where public_id = $1",
        [ctx.main.publicId],
      );
      return { formId: rows[0].id, internalName: rows[0].name };
    });
    const responses = await Promise.all(bodies);
    expect(responses.length).toBeGreaterThan(0);
    const allowedUuids = new Set([ctx.main.catalogItemId, ctx.main.freeItemId]);
    // la clave de envío que el servidor entrega con el sello también es un UUID permitido (solo esa)
    const deliveredKeys = responses.flatMap(({ text }) => STAMP_IN_HTML.exec(text)?.[2] ?? []);
    expect(deliveredKeys.length, "la página trae su clave de envío").toBeGreaterThan(0);
    for (const key of deliveredKeys) allowedUuids.add(key);
    for (const { url, text } of responses) {
      for (const secret of [ctx.tenantId, formId, ctx.catalogId, internalName, ...PRICE_TEXTS]) {
        expect(text, `${url} no puede contener «${secret}»`).not.toContain(secret);
      }
      // ningún monto en pesos (`$45.000`). El «$» suelto no se puede prohibir en el texto crudo: el protocolo
      // interno de React usa referencias como «$L1»; lo visible en pantalla sí se revisa arriba.
      expect(text, `${url}: monto`).not.toMatch(/\$\s?\d{1,3}(?:[.,]\d{3})+/);
      for (const uuid of text.match(UUID) ?? []) {
        expect(allowedUuids.has(uuid), `${url}: UUID interno ${uuid}`).toBe(true);
      }
    }

    // Cabeceras de la página pública
    const headers = document!.headers();
    // (el servidor de desarrollo reescribe la cabecera como «no-cache»; en producción es «private, no-store»)
    expect(headers["cache-control"]).toMatch(/no-store|no-cache/);
    expect(headers["cache-control"]).not.toMatch(/public|s-maxage|max-age=[1-9]/);
    expect(headers["x-robots-tag"]).toContain("noindex");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-frame-options"]).toBe("DENY");
    const csp = headers["content-security-policy"];
    expect(csp).toContain("frame-ancestors 'none'");
    // con el anti-robot de pruebas no se abre nada a Cloudflare
    expect(csp).not.toContain("challenges.cloudflare.com");
  });

  test("no se puede enviar sin consentimiento ni sin verificación anti-robot, y no sale ninguna petición", async ({
    page,
  }) => {
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/requests"))
        posts.push(request.url());
    });
    await page.setViewportSize(MOBILE);
    await openForm(page, ctx.main);
    await fillAndPick(page, ctx.main, { name: "Ana Prueba", email: "ana@cliente.test" });

    await page.getByTestId("antibot-memory-pass").click();
    await page.getByTestId("submit-request").click();
    await expect(
      page.getByText("Para enviar tienes que aceptar el aviso de privacidad."),
    ).toBeVisible();
    await expect(page.locator("#pf-consent")).toHaveAttribute("aria-invalid", "true");

    await page.locator("#pf-consent").check();
    // la verificación anti-robot sirve una vez: sin ella tampoco se envía
    await page.reload();
    await fillAndPick(page, ctx.main, { name: "Ana Prueba", email: "ana@cliente.test" });
    await page.locator("#pf-consent").check();
    await page.getByTestId("submit-request").click();
    await expect(page.getByTestId("intake-banner")).toContainText("Confirma que no eres un robot");

    expect(posts).toEqual([]);
    expect(await requestsOf(ctx.main.id)).toBe(0);
    await expectNoHorizontalScroll(page);
  });

  test("un envío correcto muestra la confirmación, queda cifrado en la base y avisa al dueño sin datos del visitante; el HTML queda como texto", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    const visitorEmail = `visitante-${randomUUID().slice(0, 8)}@ejemplo.test`;
    await page.setViewportSize(MOBILE);
    await openForm(page, ctx.main);
    await fillAndPick(page, ctx.main, {
      name: XSS_NAME,
      email: visitorEmail,
      phone: "+56 9 1234 5678",
      message: XSS_MESSAGE,
    });
    await page.locator(`#pf-item-${ctx.main.catalogItemId}`).check();
    await page.locator("#pf-consent").check();
    await page.getByTestId("antibot-memory-pass").click();
    await page.getByTestId("submit-request").click();

    const success = page.getByTestId("intake-success");
    await expect(success).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("intake-success-message")).toHaveText(ctx.main.successMessage);
    await expect(success).toContainText("Recibimos tu solicitud");
    await expectNoHorizontalScroll(page);
    expect(dialogs, "ningún alert se ejecutó").toEqual([]);
    // nada de lo escrito se repite en pantalla
    expect(await page.locator("body").innerText()).not.toContain(visitorEmail);

    // En la base: cifrado, con huella del correo, consentimiento y servicios sin precios
    const row = await withDb(async (db) => {
      const { rows } = await db.query(
        `select id, tenant_id, contact_name_enc, contact_email_enc, contact_phone_enc, message_enc,
                contact_email_hash, items, consent_template_version, consent_text, consent_text_sha256,
                consent_ip_enc, form_revision, status
           from public.intake_requests where form_id = $1`,
        [ctx.main.id],
      );
      return rows;
    });
    expect(row).toHaveLength(1);
    const saved = row[0];
    expect(saved.tenant_id).toBe(ctx.tenantId);
    expect(saved.status).toBe("new");
    expect(saved.form_revision).toBe(ctx.main.revision);
    for (const column of [
      "contact_name_enc",
      "contact_email_enc",
      "contact_phone_enc",
      "message_enc",
    ]) {
      expect(saved[column], column).toMatch(/^v\d+\./);
    }
    const dump = JSON.stringify(saved);
    for (const plain of [XSS_NAME, visitorEmail, "1234 5678", "alert(1)"]) {
      expect(dump, `«${plain}» no puede estar en claro en la base`).not.toContain(plain);
    }
    expect(saved.contact_email_hash).toMatch(/^[0-9a-f]{64}$/);
    const seal = (field: string) => ({
      table: "intake_requests",
      field,
      tenantId: ctx.tenantId,
      rowId: saved.id as string,
    });
    // lo escrito se guardó TAL CUAL, como texto (nada interpretado ni escapado)
    expect(decryptPii(saved.contact_name_enc, seal("contact_name"))).toBe(XSS_NAME);
    expect(decryptPii(saved.contact_email_enc, seal("contact_email"))).toBe(visitorEmail);
    expect(decryptPii(saved.message_enc, seal("message"))).toBe(XSS_MESSAGE);
    expect(saved.consent_template_version).toBe("intake-v1");
    expect(saved.consent_text).toContain(`Tus datos los recibirá ${ctx.tenantName}`);
    expect(saved.consent_text_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.consent_ip_enc).toMatch(/^v\d+\./);
    const items = saved.items as Record<string, unknown>[];
    expect(items.map((item) => item.name).sort()).toEqual([
      "Flete urbano",
      "Traslado por kilómetro",
    ]);
    const km = items.find((item) => item.name === "Traslado por kilómetro");
    expect(km?.quantity_milli).toBe(12_500);
    expect(JSON.stringify(items)).not.toMatch(/price|precio|clp|45000/i);
    expect((await counters(ctx.main.id)).accepted).toBe(1);

    // Aviso al dueño: solo el nombre del formulario y un botón, sin nada del visitante
    await expect
      .poll(async () => (await mailsTo(ctx.ownerEmail, "Llegó una solicitud")).length, {
        message: "debe llegar el aviso «Llegó una solicitud»",
        timeout: 45_000,
      })
      .toBe(1);
    const [mail] = await mailsTo(ctx.ownerEmail, "Llegó una solicitud");
    const content = `${mail.Text}\n${mail.HTML}`;
    expect(content).toContain(ctx.main.name);
    expect(content).toContain(`/o/${ctx.tenantId}/solicitudes`);
    for (const secret of [
      XSS_NAME,
      "<img",
      "alert(1)",
      visitorEmail,
      "Visitante",
      "1234 5678",
      "12,5",
    ]) {
      expect(content, `el aviso no puede llevar «${secret}»`).not.toContain(secret);
    }
    // y no hay correo automático al visitante
    expect((await mailsTo(visitorEmail)).length).toBe(0);
  });

  test("la sexta solicitud seguida desde la misma IP recibe 429 y se cuenta como bloqueo", async ({
    page,
  }) => {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const before = await counters(ctx.main.id);
    const url = `/api/v1/public/forms/${ctx.main.publicId}/requests`;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await page.request.post(url, { headers: { origin }, data: {} });
      expect(res.status(), `intento ${attempt}`).not.toBe(429);
    }
    const sixth = await page.request.post(url, { headers: { origin }, data: {} });
    expect(sixth.status()).toBe(429);
    expect(sixth.headers()["retry-after"]).toBeTruthy();
    expect(((await sixth.json()) as { status: string }).status).toBe("rate_limited");
    expect((await counters(ctx.main.id)).blocked_rate).toBeGreaterThan(before.blocked_rate);

    // Un POST sin el Origin de la aplicación ni siquiera llega a contar
    const noOrigin = await page.request.post(url, { data: {} });
    expect(noOrigin.status()).toBe(403);
    const foreign = await page.request.post(url, {
      headers: { origin: "https://malo.test" },
      data: {},
    });
    expect(foreign.status()).toBe(403);
  });

  test("con tope de 2 la tercera persona ve «no recibe más solicitudes hoy» y el dueño recibe un solo aviso", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    for (let n = 1; n <= 2; n += 1) {
      // cada envío con su propio sello: el sello queda atado a una sola clave de envío
      const res = await apiSubmit(page, ctx.cap);
      expect(res.status(), await res.text()).toBe(200);
    }
    expect(await requestsOf(ctx.cap.id)).toBe(2);

    // La tercera, por la pantalla
    await page.setViewportSize(MOBILE);
    await openForm(page, ctx.cap);
    await fillAndPick(page, ctx.cap, { name: "Tercera Persona", email: "tercera@cliente.test" });
    await page.locator("#pf-consent").check();
    await page.getByTestId("antibot-memory-pass").click();
    await page.getByTestId("submit-request").click();
    await expect(page.getByTestId("intake-banner")).toContainText("no recibe más solicitudes hoy", {
      timeout: 30_000,
    });
    await expectNoHorizontalScroll(page);
    expect(await requestsOf(ctx.cap.id)).toBe(2);

    // Una cuarta intenta: la base no vuelve a pedir aviso
    const fourth = await apiSubmit(page, ctx.cap);
    expect(fourth.status()).toBe(409);
    expect(((await fourth.json()) as { status: string }).status).toBe("cap_reached");
    const count = await counters(ctx.cap.id);
    expect(count.accepted).toBe(2);
    expect(count.blocked_cap).toBe(2);
    // el tope lo cuenta la base dentro del envío: nunca como un «bloqueo de robot» ni de pausa
    expect(count.blocked_captcha).toBe(0);
    expect(count.blocked_paused).toBe(0);

    await expect
      .poll(
        async () => (await mailsTo(ctx.ownerEmail, "Tu formulario llegó al tope de hoy")).length,
        { message: "debe llegar el aviso del tope", timeout: 45_000 },
      )
      .toBe(1);
    await page.waitForTimeout(4_000);
    const capMails = await mailsTo(ctx.ownerEmail, "Tu formulario llegó al tope de hoy");
    expect(capMails).toHaveLength(1);
    expect(capMails[0].Text).toContain(ctx.cap.name);
    expect(capMails[0].Text).not.toContain("tercera@cliente.test");
  });

  test("un token anti-robot fallido se bloquea y se cuenta, sin guardar nada", async ({ page }) => {
    const before = await counters(ctx.main.id);
    const savedBefore = await requestsOf(ctx.main.id);
    await page.setViewportSize(MOBILE);
    await openForm(page, ctx.main);
    await fillAndPick(page, ctx.main, { name: "Robot Ficticio", email: "robot@cliente.test" });
    await page.locator("#pf-consent").check();
    await page.getByTestId("antibot-memory-fail").click();
    await page.getByTestId("submit-request").click();
    await expect(page.getByTestId("intake-banner")).toContainText(
      "No pudimos confirmar que eres una persona",
      { timeout: 30_000 },
    );
    expect(await requestsOf(ctx.main.id)).toBe(savedBefore);
    expect((await counters(ctx.main.id)).blocked_captcha).toBe(before.blocked_captcha + 1);
    // la verificación se reinicia: hay que volver a confirmarla para el siguiente intento
    await expect(page.getByTestId("antibot-memory-state")).toHaveText("Sin verificar.");

    // el campo trampa lleno (un robot que llena todo) y un sello falso también se bloquean y cuentan
    const stamp = await renderTokenOf(page, ctx.main);
    const trap = await apiSubmit(page, ctx.main, { [HONEYPOT_FIELD]: "http://spam.test" }, stamp);
    expect(trap.status()).toBe(403);
    const forged = await apiSubmit(
      page,
      ctx.main,
      {},
      {
        token: "v1.1700000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        submitKey: randomUUID(),
      },
    );
    expect(forged.status()).toBe(403);
    // un sello auténtico pero con OTRA clave de envío (está atado a la suya)
    const otherKey = await apiSubmit(page, ctx.main, { submitKey: randomUUID() }, stamp);
    expect(otherKey.status()).toBe(403);
    // demasiado rápido: un sello de este mismo instante
    const tooFast = await apiSubmit(page, ctx.main, {}, await freshStamp(page, ctx.main));
    expect(tooFast.status()).toBe(403);
    expect(await requestsOf(ctx.main.id)).toBe(savedBefore);
    expect((await counters(ctx.main.id)).blocked_captcha).toBeGreaterThanOrEqual(
      before.blocked_captcha + 5,
    );
  });

  test("un formulario pausado muestra el contacto de la organización; uno inventado o mal escrito, el mismo mensaje genérico", async ({
    page,
  }) => {
    await page.goto(`/f/${ctx.paused.publicId}`);
    await expect(page.getByTestId("intake-unavailable")).toContainText(ctx.tenantName);
    await expect(page.getByTestId("intake-contact")).toContainText("@ejemplo.test");
    await expect(page.getByTestId("form-view")).toHaveCount(0);

    // y la API tampoco lo recibe, sin contar un bloqueo de pausa como robot
    // (la página en pausa no trae sello: se firma uno con el mismo secreto del servidor de la prueba)
    const submitKey = randomUUID();
    const stamp = {
      token: createRenderToken(ctx.paused.publicId, submitKey, {
        nowSeconds: Math.floor(Date.now() / 1000) - 10,
      }),
      submitKey,
    };
    // (la página en pausa no muestra el aviso de privacidad: se manda una huella cualquiera con su forma)
    const res = await apiSubmit(
      page,
      ctx.paused,
      { consentFingerprint: "0123456789abcdef" },
      stamp,
    );
    expect(res.status()).toBe(409);
    expect(((await res.json()) as { status: string }).status).toBe("paused");
    expect(await requestsOf(ctx.paused.id)).toBe(0);
    expect((await counters(ctx.paused.id)).blocked_captcha).toBe(0);

    await page.goto(`/f/${"A".repeat(22)}`);
    await expect(page.getByTestId("intake-not-found")).toBeVisible();
    const inventedText = await page.getByTestId("intake-not-found").innerText();
    await page.goto("/f/corto");
    await expect(page.getByTestId("intake-not-found")).toHaveText(inventedText);
    await page.goto(`/f/${"A".repeat(22)}x`);
    await expect(page.getByTestId("intake-not-found")).toHaveText(inventedText);
    const body = await page.locator("body").innerText();
    expect(body).not.toContain(ctx.tenantName);

    const origin = new URL(test.info().project.use.baseURL!).origin;
    const inventedPost = await page.request.post(
      `/api/v1/public/forms/${"A".repeat(22)}/requests`,
      {
        headers: { origin },
        data: {},
      },
    );
    expect([404, 422]).toContain(inventedPost.status());
    const malformed = await page.request.post("/api/v1/public/forms/corto/requests", {
      headers: { origin },
      data: {},
    });
    expect(malformed.status()).toBe(404);
  });

  test("doble envío con la misma clave: una sola solicitud, también tras un corte de red", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    // (1) por la API: la misma clave dos veces
    const stamp = await renderTokenOf(page, ctx.main);
    const before = await requestsOf(ctx.main.id);
    const body = { email: `doble-${randomUUID().slice(0, 6)}@ejemplo.test` };
    const first = await apiSubmit(page, ctx.main, body, stamp);
    const second = await apiSubmit(page, ctx.main, body, stamp);
    expect(first.status(), await first.text()).toBe(200);
    expect(second.status()).toBe(200);
    expect(await requestsOf(ctx.main.id)).toBe(before + 1);

    // (2) por la pantalla: se corta la red en el primer intento y el reintento lleva LA MISMA clave
    const keys: string[] = [];
    let aborted = false;
    await page.route("**/api/v1/public/forms/*/requests", async (route) => {
      const sent = route.request().postDataJSON() as { submitKey: string };
      keys.push(sent.submitKey);
      if (!aborted) {
        aborted = true;
        await route.abort("connectionreset");
        return;
      }
      await route.continue();
    });
    await page.setViewportSize(MOBILE);
    await openForm(page, ctx.main);
    await fillAndPick(page, ctx.main, { name: "Corte de Red", email: "corte@ejemplo.test" });
    await page.locator("#pf-consent").check();
    await page.getByTestId("antibot-memory-pass").click();
    await page.getByTestId("submit-request").click();
    await expect(page.getByTestId("intake-banner")).toContainText("no se duplicará", {
      timeout: 30_000,
    });
    // el widget pide una verificación nueva y se reenvía
    await page.getByTestId("antibot-memory-pass").click();
    await page.getByTestId("submit-request").click();
    await expect(page.getByTestId("intake-success")).toBeVisible({ timeout: 30_000 });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(await requestsOf(ctx.main.id)).toBe(before + 2);
  });

  test("si el administrador cambia el formulario mientras se llena, se muestra el nuevo sin perder lo escrito", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(MOBILE);
    await openForm(page, ctx.main);
    await fillAndPick(page, ctx.main, {
      name: "Persona Constante",
      email: "constante@ejemplo.test",
      message: "Mi mensaje largo",
    });
    await page.locator("#pf-consent").check();

    // Otra persona edita el formulario (cambia el título): la revisión sube
    const current = await withDb(async (db) => {
      const { rows } = await db.query<{ revision: number }>(
        "select revision from public.intake_forms where id = $1",
        [ctx.main.id],
      );
      return rows[0].revision;
    });
    const saved = await ok<{ revision: number }>(
      rpc(
        ctx.token,
        "save_intake_form",
        {
          p_form_id: ctx.main.id,
          p_expected_revision: current,
          p_form: { title: "Título nuevo del formulario" },
          p_items: null,
        },
        header(),
      ),
      "editar el formulario",
    );
    ctx.main.revision = saved.revision;

    await page.getByTestId("antibot-memory-pass").click();
    await page.getByTestId("submit-request").click();
    await expect(page.getByTestId("intake-banner")).toContainText("actualizó el formulario", {
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Título nuevo del formulario");
    // lo escrito sigue ahí
    await expect(page.locator("#pf-name")).toHaveValue("Persona Constante");
    await expect(page.locator("#pf-email")).toHaveValue("constante@ejemplo.test");
    await expect(page.locator("#pf-message")).toHaveValue("Mi mensaje largo");
    await expect(page.locator(`#pf-item-${ctx.main.freeItemId}`)).toBeChecked();
    // y se puede enviar con el formulario nuevo
    await page.getByTestId("antibot-memory-pass").click();
    await page.getByTestId("submit-request").click();
    await expect(page.getByTestId("intake-success")).toBeVisible({ timeout: 30_000 });
  });

  test("un servicio de otro formulario no entra: se rechaza sin guardar nada", async ({ page }) => {
    const before = await requestsOf(ctx.main.id);
    const stamp = await renderTokenOf(page, ctx.main);
    const res = await apiSubmit(
      page,
      ctx.main,
      {
        items: [{ formItemId: ctx.cap.freeItemId, quantity: "1" }],
        formRevision: ctx.main.revision,
      },
      stamp,
    );
    expect(res.status()).toBe(422);
    expect(await res.text()).toContain("ya no está disponible");
    expect(await requestsOf(ctx.main.id)).toBe(before);
    expect(await requestsOf(ctx.cap.id)).toBe(2);
  });
  test("la respuesta «el formulario cambió» de la API tampoco trae precios ni identificadores internos", async ({
    page,
  }) => {
    const { formId, internalName } = await withDb(async (db) => {
      const { rows } = await db.query<{ id: string; name: string }>(
        "select id, name from public.intake_forms where public_id = $1",
        [ctx.main.publicId],
      );
      return { formId: rows[0].id, internalName: rows[0].name };
    });
    const before = await requestsOf(ctx.main.id);
    // (a) otra revisión; (b) el aviso de privacidad cambió (huella distinta con la misma revisión)
    const cases: Record<string, unknown>[] = [
      { formRevision: ctx.main.revision + 1 },
      { consentFingerprint: "ffffffffffffffff" },
    ];
    for (const overrides of cases) {
      const res = await apiSubmit(page, ctx.main, overrides);
      const text = await res.text();
      expect(res.status(), text).toBe(409);
      const json = JSON.parse(text) as {
        status: string;
        content: { items: { id: string }[] };
        renderToken: string;
      };
      expect(json.status).toBe("form_changed");
      expect(json.renderToken).toMatch(/^v1\.\d{9,12}\.[A-Za-z0-9_-]{43}$/);
      for (const secret of [ctx.tenantId, formId, ctx.catalogId, internalName, ...PRICE_TEXTS]) {
        expect(text, `la respuesta no puede contener «${secret}»`).not.toContain(secret);
      }
      expect(text, "ningún monto en pesos").not.toMatch(/\$\s?\d{1,3}(?:[.,]\d{3})+/);
      const allowed = new Set([ctx.main.catalogItemId, ctx.main.freeItemId]);
      for (const uuid of text.match(UUID) ?? []) {
        expect(allowed.has(uuid), `UUID interno ${uuid}`).toBe(true);
      }
    }
    expect(await requestsOf(ctx.main.id)).toBe(before);
  });

  test("los errores de tipeo se ven sin llamar al servidor y el foco va al primer error", async ({
    page,
  }) => {
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") posts.push(request.url());
    });
    await page.setViewportSize(MOBILE);
    await openForm(page, ctx.main);
    await page.locator("#pf-name").fill("Ana Prueba");
    await page.locator("#pf-email").fill("esto-no-es-un-correo");
    await page.locator("#pf-consent").check();
    await page.getByTestId("antibot-memory-pass").click();

    // sin servicio elegido y con un correo mal escrito
    await page.getByTestId("submit-request").click();
    await expect(page.getByText("Elige al menos un servicio.")).toBeVisible();
    await expect(page.getByText(/Escribe un correo válido/)).toBeVisible();
    // el error de «ningún servicio» está atado al grupo y el foco va ahí (es lo primero de la pantalla)
    const group = page.locator('fieldset[data-invalid-group="true"]');
    await expect(group).toHaveAttribute("aria-describedby", "pf-items-error");
    await expect(group).toBeFocused();

    // con el servicio elegido, el primer error es el correo
    await page.locator(`#pf-item-${ctx.main.freeItemId}`).check();
    await page.locator(`#pf-qty-${ctx.main.freeItemId}`).fill("3");
    await page.getByTestId("submit-request").click();
    await expect(page.locator("#pf-email")).toBeFocused();
    await expect(page.locator("#pf-email")).toHaveAttribute("aria-invalid", "true");

    // nada salió hacia el servidor, así que tampoco se gastó la prueba anti-robot
    expect(posts).toEqual([]);
    await expect(page.getByTestId("antibot-memory-state")).not.toHaveText("Sin verificar.");
  });

  test("sin JavaScript no se puede enviar: la dirección no cambia y ninguna petición lleva datos", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      javaScriptEnabled: false,
      extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
    });
    try {
      const page = await context.newPage();
      const requests: { method: string; url: string; body: string | null }[] = [];
      page.on("request", (request) =>
        requests.push({ method: request.method(), url: request.url(), body: request.postData() }),
      );
      await page.goto(`/f/${ctx.main.publicId}`);
      // Sin JavaScript Next no puede cambiar el esqueleto por el formulario armado: el aviso se ve ahí.
      await expect(page.getByTestId("intake-noscript")).toBeVisible();
      await expect(page.getByTestId("intake-noscript")).toHaveText(
        "Para enviar este formulario necesitas activar JavaScript.",
      );
      // El formulario viene en la página, pero con el botón desactivado y sin `name` en los campos
      const submit = page.getByTestId("submit-request");
      await expect(submit).toBeDisabled();
      const urlBefore = page.url();

      // Lo peor que puede pasar: el navegador envía el formulario por su cuenta. Se llena por la pantalla
      // (sin scripts de la página) y se fuerza el envío.
      await page.locator("form").evaluate((form, itemId) => {
        const set = (selector: string, value: string) => {
          (form.querySelector(selector) as HTMLInputElement).value = value;
        };
        set("#pf-name", "Persona Secreta");
        set("#pf-email", "secreta@cliente.test");
        (form.querySelector(`#pf-item-${itemId}`) as HTMLInputElement).checked = true;
        (form.querySelector("#pf-consent") as HTMLInputElement).checked = true;
      }, ctx.main.freeItemId);
      const posted = page.waitForRequest((request) => request.method() === "POST");
      await page.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
      const post = await posted;
      expect(new URL(post.url()).search).toBe("");
      expect(post.postData() ?? "").not.toMatch(/Persona|Secreta|secreta@|cliente\.test/);
      // el servidor lo rechaza sin leerlo: la página no manda Referer, así que el navegador envía `Origin: null`
      // y la puerta del origen responde 403 (si llegara con el origen correcto, 415 por no ser JSON)
      expect([403, 415]).toContain((await post.response())?.status());

      expect(urlBefore).not.toContain("?");
      for (const request of requests) {
        expect(request.url).not.toMatch(/pf-|secret|cliente\.test|Persona/i);
        if (request.method !== "POST") expect(request.body).toBeNull();
      }
    } finally {
      await context.close();
    }
  });

  test("tocar «Enviar» antes de que cargue la página tampoco manda datos por la dirección", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
    });
    // Los scripts de la página se retienen: la página se ve, pero todavía no es interactiva.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const page = await context.newPage();
      await page.route("**/_next/static/**/*.js", async (route) => {
        await gate;
        await route.continue().catch(() => undefined);
      });
      const requests: { method: string; url: string; body: string | null }[] = [];
      page.on("request", (request) =>
        requests.push({ method: request.method(), url: request.url(), body: request.postData() }),
      );
      await page.goto(`/f/${ctx.main.publicId}`, { waitUntil: "commit" });
      await expect(page.getByTestId("form-view")).toBeVisible();
      const submit = page.getByTestId("submit-request");
      await expect(submit).toBeDisabled();

      await page.locator("#pf-name").fill("Persona Veloz");
      await page.locator("#pf-email").fill("veloz@cliente.test");
      await page.locator(`#pf-item-${ctx.main.freeItemId}`).check();
      await page.locator("#pf-consent").check();
      const urlBefore = page.url();

      // tocar el botón (desactivado) y apretar Enter en un campo: no pasa nada
      await submit.click({ force: true });
      await page.locator("#pf-name").press("Enter");
      await page.waitForTimeout(500);
      expect(page.url()).toBe(urlBefore);

      // lo peor que puede hacer el navegador: enviar el formulario por su cuenta. Es POST y los
      // campos no llevan `name`, así que ni la dirección ni el cuerpo llevan lo escrito.
      const posted = page.waitForRequest((request) => request.method() === "POST");
      await page.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
      const request = await posted;
      expect(new URL(request.url()).search).toBe("");
      expect(new URL(request.url()).pathname).toBe(
        `/api/v1/public/forms/${ctx.main.publicId}/requests`,
      );
      expect(request.postData() ?? "").not.toMatch(/Persona|Veloz|veloz@|cliente\.test/);
      for (const sent of requests) {
        expect(sent.url).not.toMatch(/pf-|veloz|cliente\.test|Persona/i);
      }
      // el servidor lo rechaza sin leerlo (`Origin: null` por no mandar Referer: 403; con el origen correcto: 415)
      const response = await request.response();
      expect([403, 415]).toContain(response?.status());
    } finally {
      release();
      await context.close();
    }
  });

  test("el logo se achica en el servidor (256 px) y el encabezado no lo repite como dato", async ({
    page,
  }) => {
    // Un logo grande de verdad: 1.600 x 900 con ruido para que pese
    const raw = Buffer.alloc(1_600 * 900 * 3);
    for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 31 + (i >> 7)) % 251;
    const png = await sharp(raw, { raw: { width: 1_600, height: 900, channels: 3 } })
      .png()
      .toBuffer();
    expect(png.byteLength).toBeLessThan(1_048_576);
    const path = `${ctx.tenantId}/logo-${randomUUID().replaceAll("-", "").slice(0, 12)}.png`;
    const { secretKey } = localEnv();
    const uploaded = await storage(secretKey, "POST", `object/tenant-logos/${path}`, {
      headers: { apikey: secretKey },
      body: new Uint8Array(png),
      contentType: "image/png",
    });
    expect(uploaded.status, uploaded.text).toBeLessThan(300);
    await withDb((db) =>
      db.query("update public.tenants set logo_path = $1 where tenant_id = $2", [
        path,
        ctx.tenantId,
      ]),
    );

    const html = await (await page.request.get(`/f/${ctx.main.publicId}`)).text();
    const logos = html.match(/data:image\/webp;base64,[A-Za-z0-9+/=]+/g) ?? [];
    expect(logos.length, "el logo reducido está en la página").toBeGreaterThan(0);
    expect(html, "ya no viaja el original").not.toContain("data:image/png;base64,");
    const thumb = Buffer.from(logos[0]!.split(",")[1] ?? "", "base64");
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(256);
    expect(thumb.byteLength).toBeLessThan(png.byteLength / 4);
    // El encabezado de la marca lo dibuja el servidor: se ve el logo y el nombre
    await openForm(page, ctx.main);
    await expect(page.getByRole("img", { name: `Logo de ${ctx.tenantName}` })).toBeVisible();
    // el logo viaja UNA sola vez en la respuesta (no se repite como dato del formulario del navegador)
    const occurrences = html.split(logos[0]!).length - 1;
    expect(occurrences).toBe(1);
  });
});
