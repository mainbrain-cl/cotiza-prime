import { randomUUID } from "node:crypto";
import { generateRut } from "../src/lib/chile/rut";
import { signWebhookPayload } from "../src/lib/email/delivery-events";
import { E2E_WEBHOOK_SECRET } from "../tests/support/webhook-secret";
import { connect } from "../tests/db/helpers";
import { expect, randomTestIp, test, type Page } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-033 (rebotes), H-034 (vencimiento visible) y H-035 (revocar el enlace). Los correos salen a Mailpit
// local (EMAIL_PROVIDER=mailpit en playwright.config.ts) y todo es ficticio, con direcciones @ejemplo.test.
// Un destinatario @rebota.ejemplo.test simula un rebote que entra por el mismo camino que el aviso real.

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";
const MOBILE = { width: 375, height: 812 };
const WEBHOOK_PATH = "/api/v1/webhooks/email";
const API_PREFIX = "/api/v1/public/quote-links";
const BOUNCE_DOMAIN = "rebota.ejemplo.test";
const SECONDS_PER_MINUTE = 60;
const STALE_MINUTES = 10;

type MailDetail = { ID: string; HTML: string; Text: string };

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

async function mailsTo(address: string): Promise<MailDetail[]> {
  const search = await fetch(
    `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
  );
  const { messages } = (await search.json()) as { messages?: { ID: string }[] };
  const details: MailDetail[] = [];
  for (const { ID } of [...(messages ?? [])].reverse()) {
    details.push((await (await fetch(`${MAILBOX_URL}/api/v1/message/${ID}`)).json()) as MailDetail);
  }
  return details;
}

/** Espera `count` correos a esa dirección y devuelve todos, del más viejo al más nuevo. */
async function waitForMails(address: string, count: number): Promise<MailDetail[]> {
  let found: MailDetail[] = [];
  await expect
    .poll(
      async () => {
        found = await mailsTo(address);
        return found.length;
      },
      { message: `Esperaba ${count} correo(s) a ${address}`, timeout: 30_000 },
    )
    .toBe(count);
  return found;
}

function linkOf(mail: MailDetail): { link: string; token: string } {
  const match = /href="(https?:\/\/[^"]*\/c\/([A-Za-z0-9_-]{43}))"/.exec(mail.HTML);
  if (!match) throw new Error("El correo no trae el enlace de la cotización");
  return { link: match[1], token: match[2] };
}

async function createCustomer(page: Page, tenantId: string, name: string, email: string) {
  await page.goto(`/o/${tenantId}/clientes/nuevo`);
  await page.getByLabel(/^(Nombre|Razón social)/).fill(name);
  await page.getByLabel("Correo (opcional)").fill(email);
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/clientes/[0-9a-f-]{36}(\\?creado=1)?$`));
}

async function setup(page: Page, label: string): Promise<{ tenantId: string; orgName: string }> {
  await signUpAndVerify(page, uniqueEmail(label), "Vendedora Ficticia");
  const orgName = `Entrega ${label} Ltda`;
  const tenantId = await createTenant(page, orgName, generateRut());
  await withDb((db) =>
    db.query(
      `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp, tax_treatment)
       values ($1, 'Servicio Alfa', 'service', 10000, 'taxable')`,
      [tenantId],
    ),
  );
  return { tenantId, orgName };
}

type Sent = {
  quoteId: string;
  quoteNumber: string;
  customerEmail: string;
  customerName: string;
  token: string;
  link: string;
};

/** Crea una cotización para un cliente nuevo, la envía con la pantalla de siempre y devuelve su enlace. */
async function sendQuote(
  page: Page,
  tenantId: string,
  label: string,
  customerEmail: string = uniqueEmail(label),
): Promise<Sent> {
  const customerName = `Cliente ${label}`;
  await createCustomer(page, tenantId, customerName, customerEmail);
  await page.goto(`/o/${tenantId}/cotizaciones/nueva`);
  await page.getByRole("button", { name: new RegExp(customerName) }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));
  const quoteId = page.url().split("/").pop()!;
  await page.getByRole("button", { name: "Agregar Servicio Alfa", exact: true }).click();
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");
  const quoteNumber = await page.getByTestId("quote-number").innerText();

  await page.getByTestId("go-send").click();
  await page.getByTestId("send-submit").click();
  await expect(page).toHaveURL(new RegExp(`/cotizaciones/${quoteId}$`), { timeout: 120_000 });
  await expect(page.getByText("Enviada", { exact: true }).first()).toBeVisible();

  const [mail] = await waitForMails(customerEmail, 1);
  return { quoteId, quoteNumber, customerEmail, customerName, ...linkOf(mail) };
}

type EmailRow = { id: string; provider: string; provider_message_id: string; status: string };

async function emailRows(quoteId: string): Promise<EmailRow[]> {
  return withDb(async (db) => {
    const { rows } = await db.query<EmailRow>(
      `select id, provider, provider_message_id, status from public.email_messages
        where quote_id = $1 order by created_at desc`,
      [quoteId],
    );
    return rows;
  });
}

async function quoteStatus(quoteId: string): Promise<string> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ status: string }>(
      `select status from public.quotes where id = $1`,
      [quoteId],
    );
    return rows[0].status;
  });
}

async function newClient(page: Page, browser: import("@playwright/test").Browser) {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL!,
    viewport: MOBILE,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  return { context, client: await context.newPage() };
}

function bounceBody(providerMessageId: string, createdAt = new Date()): string {
  return JSON.stringify({
    type: "email.bounced",
    created_at: createdAt.toISOString(),
    data: { email_id: providerMessageId, bounce: { type: "Permanent" } },
  });
}

function signedHeaders(body: string, options: { secret?: string; ageSeconds?: number } = {}) {
  const id = `msg_${randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000) - (options.ageSeconds ?? 0);
  return {
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": signWebhookPayload(options.secret ?? E2E_WEBHOOK_SECRET, id, timestamp, body),
  };
}

test("un correo que rebota se ve en la cotización y en la lista; se corrige el correo, se reenvía y queda entregado", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const { tenantId } = await setup(page, "rebote");
  const bounceEmail = `cliente-${randomUUID().slice(0, 8)}@${BOUNCE_DOMAIN}`;
  const sent = await sendQuote(page, tenantId, "rebote", bounceEmail);
  const detailPath = `/o/${tenantId}/cotizaciones/${sent.quoteId}`;

  // El rebote simulado entró por el mismo camino que el aviso real: la base lo anotó.
  expect((await emailRows(sent.quoteId))[0].status).toBe("bounced");

  // En la cotización: insignia de entrega (punto + texto + color) y aviso con qué hacer.
  const alert = page.getByTestId("bounce-alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("la dirección del cliente rebotó");
  const badge = page.locator('[data-slot="delivery-badge"]');
  await expect(badge).toHaveAttribute("data-delivery", "bounced");
  await expect(badge).toHaveText("Correo rebotado");
  await expect(page.getByTestId("quote-timeline")).toContainText("El correo rebotó");
  // El reenvío vive dentro del aviso (una sola opción, no dos).
  await expect(page.getByTestId("resend-quote")).toHaveCount(1);

  // En la lista: el aviso junto al estado.
  await page.goto(`/o/${tenantId}/cotizaciones`);
  const row = page.getByTestId("quote-row").filter({ hasText: sent.quoteNumber });
  await expect(row.getByTestId("list-bounce")).toContainText("Correo rebotado");

  // Corregir el correo desde el aviso y reenviar.
  await page.goto(detailPath);
  await page.getByTestId("fix-customer-email").click();
  await expect(page).toHaveURL(/\/clientes\/[0-9a-f-]{36}\/editar$/);
  const fixedEmail = uniqueEmail("corregido");
  await page.getByLabel("Correo (opcional)").fill(fixedEmail);
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page.getByText("Cliente guardado.")).toBeVisible();

  await page.goto(detailPath);
  await page.getByTestId("resend-quote").click();
  await expect(page.getByText("Cotización reenviada con un enlace nuevo.")).toBeVisible();
  // El reenvío fue al correo corregido, no al que rebotó.
  await waitForMails(fixedEmail, 1);
  await expect(page.getByTestId("bounce-alert")).toHaveCount(0);
  await expect(badge).toHaveAttribute("data-delivery", "sent");

  // El aviso real de entrega llega después (aquí, la misma función de la base que usa la ruta de avisos).
  const [latest] = await emailRows(sent.quoteId);
  expect(latest.status).toBe("sent");
  await withDb((db) =>
    db.query(`select public.record_email_event($1, $2, 'delivered', now(), null)`, [
      latest.provider,
      latest.provider_message_id,
    ]),
  );
  await page.reload();
  await expect(badge).toHaveAttribute("data-delivery", "delivered");
  await expect(badge).toHaveText("Correo entregado");
  await page.goto(`/o/${tenantId}/cotizaciones`);
  await expect(row.getByTestId("list-bounce")).toHaveCount(0);
});

test("el aviso del proveedor solo vale con firma válida; antes de confirmar el envío pide reintentar", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const { tenantId } = await setup(page, "aviso");
  const sent = await sendQuote(page, tenantId, "aviso");
  const [mail] = await emailRows(sent.quoteId);
  expect(mail.status).toBe("sent");
  const url = `${WEBHOOK_PATH}/resend`;
  const body = bounceBody(mail.provider_message_id);
  const unchanged = async () => expect((await emailRows(sent.quoteId))[0].status).toBe("sent");

  // Sin firma, con firma falsa, con otro secreto o demasiado vieja: 401 y nada cambia.
  expect((await request.post(url, { data: body })).status()).toBe(401);
  const forged = {
    ...signedHeaders(body),
    "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };
  expect((await request.post(url, { data: body, headers: forged })).status()).toBe(401);
  const otherSecret = signedHeaders(body, {
    secret: "whsec_" + Buffer.from("otro-secreto").toString("base64"),
  });
  expect((await request.post(url, { data: body, headers: otherSecret })).status()).toBe(401);
  const stale = signedHeaders(body, { ageSeconds: STALE_MINUTES * SECONDS_PER_MINUTE });
  expect((await request.post(url, { data: body, headers: stale })).status()).toBe(401);
  // Firma buena de otro cuerpo: el cuerpo alterado no pasa.
  const swapped = signedHeaders(bounceBody("otro-id"));
  expect((await request.post(url, { data: body, headers: swapped })).status()).toBe(401);
  await unchanged();

  // Firma válida de un correo que todavía no existe para ese proveedor: error recuperable, no 200.
  const early = bounceBody(`todavia-no-${randomUUID()}`);
  const earlyResponse = await request.post(url, { data: early, headers: signedHeaders(early) });
  expect(earlyResponse.status()).toBe(503);
  expect(Number(earlyResponse.headers()["retry-after"])).toBeGreaterThan(0);
  // Un correo de otro proveedor (el nuestro salió por mailpit) tampoco calza: mismo error recuperable.
  const mismatch = await request.post(url, { data: body, headers: signedHeaders(body) });
  expect(mismatch.status()).toBe(503);
  await unchanged();

  // Proveedor desconocido, cuerpo roto con firma buena y tipos de aviso que no usamos.
  expect(
    (
      await request.post(`${WEBHOOK_PATH}/otro`, { data: body, headers: signedHeaders(body) })
    ).status(),
  ).toBe(404);
  const broken = "esto no es json";
  expect((await request.post(url, { data: broken, headers: signedHeaders(broken) })).status()).toBe(
    400,
  );
  const opened = JSON.stringify({ type: "email.opened", data: {} });
  expect((await request.post(url, { data: opened, headers: signedHeaders(opened) })).status()).toBe(
    200,
  );
  // Un GET no hace nada (solo POST).
  expect((await request.get(url)).status()).toBe(405);
  await unchanged();
});

test("una cotización sin respuesta vence sola: se ve Vencida en la lista y el detalle, y el enlace ya no deja aceptar", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const { tenantId, orgName } = await setup(page, "vence");
  const sent = await sendQuote(page, tenantId, "vence");
  await withDb(async (db) => {
    await db.query(
      `update public.quotes set valid_until = app.current_business_date() - 1 where id = $1`,
      [sent.quoteId],
    );
    // La tarea programada de cada hora (pg_cron), ejecutada a mano.
    await db.query("select app.expire_due_quotes()");
  });
  expect(await quoteStatus(sent.quoteId)).toBe("expired");

  await page.goto(`/o/${tenantId}/cotizaciones`);
  const row = page.getByTestId("quote-row").filter({ hasText: sent.quoteNumber });
  await expect(row.locator('[data-slot="status-badge"]')).toHaveAttribute("data-status", "expired");
  await expect(row).toContainText("Vencida");

  await page.goto(`/o/${tenantId}/cotizaciones/${sent.quoteId}`);
  await expect(page.locator('[data-slot="status-badge"]')).toHaveAttribute(
    "data-status",
    "expired",
  );
  await expect(page.getByTestId("quote-timeline")).toContainText("La cotización venció");
  // Vencida: ya no se reenvía ni se revoca.
  await expect(page.getByTestId("resend-quote")).toHaveCount(0);
  await expect(page.getByTestId("revoke-link")).toHaveCount(0);

  // El cliente ve que la oferta venció, con el contacto de la empresa, y no puede aceptar.
  const { context, client } = await newClient(page, browser);
  try {
    await client.goto(new URL(sent.link).pathname);
    await expect(client.getByTestId("share-unavailable-title")).toHaveText(
      "Esta cotización ya no está vigente",
    );
    await expect(client.getByTestId("share-contact")).toContainText(orgName);
    await expect(client.getByTestId("response-accept-open")).toHaveCount(0);
    await expect(client.getByTestId("share-quote")).toHaveCount(0);
    expect((await context.request.get(`${API_PREFIX}/${sent.token}/pdf`)).status()).toBe(404);
  } finally {
    await context.close();
  }
});

test("revocar el enlace: pide confirmación, el cliente ya no puede abrirlo, queda registrado y se puede reenviar con enlace nuevo", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const { tenantId, orgName } = await setup(page, "revoca");
  const sent = await sendQuote(page, tenantId, "revoca");
  const detailPath = `/o/${tenantId}/cotizaciones/${sent.quoteId}`;
  const oldPath = new URL(sent.link).pathname;
  const { context, client } = await newClient(page, browser);
  try {
    await client.goto(oldPath);
    await expect(client.getByTestId("share-quote")).toBeVisible();

    // Cancelar no cambia nada.
    await page.goto(detailPath);
    await page.getByTestId("revoke-link").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("¿Revocar el enlace del cliente?");
    await expect(dialog).toContainText("ya no podrá abrir esta cotización");
    await expect(dialog).toContainText("reenviarla");
    await page.getByTestId("revoke-cancel").click();
    await expect(dialog).toHaveCount(0);
    await client.reload();
    await expect(client.getByTestId("share-quote")).toBeVisible();

    // Confirmar la revoca.
    await page.getByTestId("revoke-link").click();
    await page.getByTestId("revoke-confirm").click();
    await expect(page.getByText(/Enlace revocado/)).toBeVisible();
    await expect(page.getByTestId("revoke-link")).toHaveCount(0);
    await expect(page.getByTestId("link-revoked-note")).toBeVisible();

    // Quién y cuándo, en el historial de la cotización y en el registro de actividad.
    const entry = page
      .getByTestId("timeline-entry")
      .filter({ hasText: "Se revocó el enlace del cliente" });
    await expect(entry).toContainText("Vendedora Ficticia");
    await expect(entry).toContainText(/\d{2}-\d{2}-\d{4}|\d{1,2}:\d{2}/);
    const audit = await withDb(async (db) => {
      const { rows } = await db.query<{ actor_user_id: string | null; actor_type: string }>(
        `select actor_user_id, actor_type from public.audit_log
          where resource_id = $1 and action = 'share_link.revoked'`,
        [sent.quoteId],
      );
      return rows;
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: "user" });
    expect(audit[0].actor_user_id).not.toBeNull();
    await page.goto(`/o/${tenantId}/configuracion/actividad`);
    await expect(page.getByText("Se revocó el enlace de una cotización").first()).toBeVisible();

    // El cliente (sin sesión, con el enlace del correo) ya no puede verla ni bajar el PDF.
    await client.goto(oldPath);
    await expect(client.getByTestId("share-unavailable-title")).toHaveText(
      "Este enlace ya no está disponible",
    );
    await expect(client.getByTestId("share-contact")).toContainText(orgName);
    await expect(client.getByTestId("share-quote")).toHaveCount(0);
    await expect(client.getByTestId("response-accept-open")).toHaveCount(0);
    expect((await context.request.get(`${API_PREFIX}/${sent.token}/pdf`)).status()).toBe(404);

    // Reenviar crea un enlace nuevo que sí funciona; el viejo sigue sin servir.
    await page.goto(detailPath);
    await page.getByTestId("resend-quote").click();
    await expect(page.getByText("Cotización reenviada con un enlace nuevo.")).toBeVisible();
    const mails = await waitForMails(sent.customerEmail, 2);
    const fresh = linkOf(mails[1]);
    expect(fresh.token).not.toBe(sent.token);
    await client.goto(new URL(fresh.link).pathname);
    await expect(client.getByTestId("share-quote")).toBeVisible();
    await client.goto(oldPath);
    await expect(client.getByTestId("share-unavailable-title")).toBeVisible();
    // Con enlace activo otra vez, la opción de revocar vuelve y el aviso se va.
    await page.reload();
    await expect(page.getByTestId("revoke-link")).toBeVisible();
    await expect(page.getByTestId("link-revoked-note")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("una cotización aceptada no vence y no ofrece revocar el enlace", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const { tenantId } = await setup(page, "acepta");
  const sent = await sendQuote(page, tenantId, "acepta");
  const { context, client } = await newClient(page, browser);
  try {
    await client.goto(new URL(sent.link).pathname);
    await client.getByTestId("response-accept-open").click();
    await client.getByTestId("accept-name").fill("Carolina Cliente Ficticia");
    await client.getByTestId("accept-confirm").check();
    await client.getByTestId("accept-submit").click();
    await expect(client.getByTestId("response-confirmation")).toContainText(
      "Aceptaste esta cotización",
    );
  } finally {
    await context.close();
  }
  expect(await quoteStatus(sent.quoteId)).toBe("accepted");

  // Aunque pase la vigencia y corra la tarea de vencimiento, sigue aceptada.
  await withDb(async (db) => {
    await db.query(
      `update public.quotes set valid_until = app.current_business_date() - 1 where id = $1`,
      [sent.quoteId],
    );
    await db.query("select app.expire_due_quotes()");
  });
  expect(await quoteStatus(sent.quoteId)).toBe("accepted");

  await page.goto(`/o/${tenantId}/cotizaciones`);
  const row = page.getByTestId("quote-row").filter({ hasText: sent.quoteNumber });
  await expect(row.locator('[data-slot="status-badge"]')).toHaveAttribute(
    "data-status",
    "accepted",
  );
  // La opción de revocar no aparece (el cliente perdería los datos de pago): decisión pendiente de Aarón.
  await page.goto(`/o/${tenantId}/cotizaciones/${sent.quoteId}`);
  await expect(page.locator('[data-slot="status-badge"]')).toHaveAttribute(
    "data-status",
    "accepted",
  );
  await expect(page.getByTestId("revoke-link")).toHaveCount(0);
  await expect(page.getByTestId("link-revoked-note")).toHaveCount(0);
});
