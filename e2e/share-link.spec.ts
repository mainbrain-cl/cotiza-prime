import { createHash, randomBytes } from "node:crypto";
import { generateRut } from "../src/lib/chile/rut";
import { TENANT_HEADER, actAs, connect } from "../tests/db/helpers";
import { expect, randomTestIp, test, type Page } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-030: ver la cotización desde el enlace del correo, sin cuenta. Los correos salen a Mailpit local
// (EMAIL_PROVIDER=mailpit en playwright.config.ts) y todo es ficticio, con direcciones @ejemplo.test.

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";
const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1440, height: 900 };
const API_PREFIX = "/api/v1/public/quote-links";
const ANTIVIRUS_USER_AGENT =
  "Mozilla/5.0 (compatible; SafeLinks-Scanner/1.0; +https://antivirus.test)";
const NOT_FOUND_TEXT = "No encontramos esta cotización";
const IP_LIMIT = 60;
const LINK_LIMIT = 30;

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

async function waitForMail(address: string): Promise<MailDetail> {
  let found: MailDetail[] = [];
  await expect
    .poll(
      async () => {
        found = await mailsTo(address);
        return found.length;
      },
      { message: `Esperaba un correo a ${address}`, timeout: 30_000 },
    )
    .toBe(1);
  return found[0];
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
  const orgName = `Enlace ${label} Ltda`;
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

type Sent = { quoteId: string; quoteNumber: string; token: string; link: string };

/** Crea una cotización para un cliente nuevo, la envía con la pantalla de siempre y devuelve su enlace. */
async function sendQuote(page: Page, tenantId: string, label: string): Promise<Sent> {
  const customerName = `Cliente ${label}`;
  const customerEmail = uniqueEmail(label);
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

  const mail = await waitForMail(customerEmail);
  const match = /href="(https?:\/\/[^"]*\/c\/([A-Za-z0-9_-]{43}))"/.exec(mail.HTML);
  if (!match) throw new Error("El correo no trae el enlace de la cotización");
  return { quoteId, quoteNumber, token: match[2], link: match[1] };
}

async function quoteRow(quoteId: string) {
  return withDb(async (db) => {
    const quote = await db.query<{ status: string; first_viewed_at: string | null }>(
      `select status, first_viewed_at from public.quotes where id = $1`,
      [quoteId],
    );
    const link = await db.query<{ view_count: number }>(
      `select view_count from public.share_links where quote_id = $1`,
      [quoteId],
    );
    const views = await db.query<{ ip_enc: string | null; user_agent_short: string | null }>(
      `select v.ip_enc, v.user_agent_short from public.share_link_views v
         join public.share_links l on l.id = v.share_link_id where l.quote_id = $1`,
      [quoteId],
    );
    const events = await db.query<{ type: string }>(
      `select type from public.quote_events where quote_id = $1 and type = 'viewed'`,
      [quoteId],
    );
    return {
      status: quote.rows[0].status,
      firstViewedAt: quote.rows[0].first_viewed_at,
      viewCount: link.rows[0].view_count,
      views: views.rows,
      viewedEvents: events.rowCount,
    };
  });
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Las acciones del Dueño sobre un enlace, hechas como lo haría la aplicación (con su pase). */
async function revokeLinks(tenantId: string, quoteId: string) {
  await withDb(async (db) => {
    const owner = await db.query<{ user_id: string }>(
      `select user_id from public.members where tenant_id = $1 and role = 'owner'`,
      [tenantId],
    );
    await db.query("begin");
    try {
      await actAs(db, { id: owner.rows[0].user_id, email: "" }, { [TENANT_HEADER]: tenantId });
      await db.query("select public.revoke_quote_links($1)", [quoteId]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

test("el cliente abre su cotización desde el correo, sin cuenta: se ve con la marca, se descarga el PDF y queda Vista", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const { tenantId, orgName } = await setup(page, "enlace");
  const sent = await sendQuote(page, tenantId, "ver");
  const path = new URL(sent.link).pathname;

  // Un antivirus que abre el enlace solo (GET, sin ejecutar la página) no cambia nada.
  const baseURL = test.info().project.use.baseURL!;
  const clientContext = await browser.newContext({
    baseURL,
    viewport: MOBILE,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  try {
    const scanner = await clientContext.request.get(path, {
      headers: { "user-agent": ANTIVIRUS_USER_AGENT },
    });
    expect(scanner.status()).toBe(200);
    await clientContext.request.get(`${API_PREFIX}/${sent.token}/pdf`, {
      headers: { "user-agent": ANTIVIRUS_USER_AGENT },
    });
    const untouched = await quoteRow(sent.quoteId);
    expect(untouched).toMatchObject({ status: "sent", firstViewedAt: null, viewCount: 0 });
    expect(untouched.views).toHaveLength(0);

    // El cliente, en un teléfono y sin sesión.
    const client = await clientContext.newPage();
    const consoleErrors: string[] = [];
    client.on("pageerror", (error) => consoleErrors.push(error.message));
    const beacon = client.waitForResponse(
      (response) => response.url().endsWith("/view") && response.request().method() === "POST",
    );
    const response = await client.goto(path);
    expect(response?.status()).toBe(200);
    expect((await beacon).status()).toBe(200);

    // La marca de la organización, la cotización armada y el cliente.
    await expect(client.getByTestId("share-quote")).toContainText(orgName);
    await expect(client.getByTestId("share-quote-number")).toHaveText(sent.quoteNumber);
    await expect(client.getByTestId("share-quote")).toContainText("Cliente ver");
    await expectNoHorizontalScroll(client);
    await expect(client.getByTestId("share-lines-cards")).toBeVisible();
    await expect(client.getByTestId("share-download-pdf")).toBeVisible();
    // Los botones de aceptar y rechazar (H-031) están, y mirar la cotización no responde nada.
    await expect(client.getByTestId("response-accept-open")).toBeVisible();
    await expect(client.getByTestId("response-reject-open")).toBeVisible();

    // Las cifras son las del PDF (la misma copia congelada).
    const frozen = await withDb(async (db) => {
      const { rows } = await db.query<{
        document_snapshot: { totals: { total: string; subtotal: string } };
        pdf_sha256: string;
      }>(`select document_snapshot, pdf_sha256 from public.quote_packages where quote_id = $1`, [
        sent.quoteId,
      ]);
      return rows[0];
    });
    await expect(client.getByTestId("share-totals")).toContainText(
      frozen.document_snapshot.totals.total,
    );
    await expect(client.getByTestId("share-totals")).toContainText(
      frozen.document_snapshot.totals.subtotal,
    );

    // Sin datos bancarios, ni en lo que se ve ni en el HTML que llega.
    const html = await (await clientContext.request.get(path)).text();
    const visibleText = await client.locator("body").innerText();
    for (const text of [html, visibleText]) {
      expect(text).not.toMatch(/banco/i);
      expect(text).not.toMatch(/\bcuenta\b/i);
    }

    // Queda Vista, con una sola apertura, la IP cifrada y el navegador recortado.
    await expect.poll(async () => (await quoteRow(sent.quoteId)).status).toBe("viewed");
    const viewed = await quoteRow(sent.quoteId);
    expect(viewed.viewCount).toBe(1);
    expect(viewed.viewedEvents).toBe(1);
    expect(viewed.views).toHaveLength(1);
    expect(viewed.views[0].ip_enc).toMatch(/^v\d+\./);
    expect(viewed.views[0].ip_enc).not.toContain("2001:db8");
    expect(viewed.views[0].user_agent_short?.length ?? 0).toBeLessThanOrEqual(120);

    // Descargar el PDF: el mismo archivo que se envió, con el nombre estándar.
    const download = await clientContext.request.get(`${API_PREFIX}/${sent.token}/pdf`);
    expect(download.status()).toBe(200);
    expect(download.headers()["content-type"]).toBe("application/pdf");
    expect(download.headers()["content-disposition"]).toContain(`${sent.quoteNumber}.pdf`);
    expect(
      createHash("sha256")
        .update(await download.body())
        .digest("hex"),
    ).toBe(frozen.pdf_sha256);

    // Cabeceras: nada en cachés, fuera de buscadores y sin pasar la dirección a otros sitios.
    // (El servidor de desarrollo pone «no-cache» en las pantallas; la regla de producción, «no-store»,
    // la verifica src/lib/security-headers.test.ts. La API sí la entrega con «no-store» siempre.)
    expect(download.headers()["cache-control"]).toContain("no-store");
    expect(response!.headers()["cache-control"]).toMatch(/no-store|no-cache/);
    for (const headers of [response!.headers(), download.headers()]) {
      expect(headers["referrer-policy"]).toBe("no-referrer");
      expect(headers["x-robots-tag"]).toContain("noindex");
    }
    expect(await client.locator('meta[name="robots"]').getAttribute("content")).toContain(
      "noindex",
    );
    expect(await client.title()).not.toContain(orgName);

    // En escritorio se ve la tabla de siempre.
    await client.setViewportSize(DESKTOP);
    await expect(client.getByTestId("share-lines-table")).toBeVisible();
    await expectNoHorizontalScroll(client);

    // Una persona del equipo que abre el enlace con su sesión no cuenta como apertura.
    const member = page.waitForResponse(
      (r) => r.url().endsWith("/view") && r.request().method() === "POST",
    );
    await page.goto(path);
    expect((await member).status()).toBe(200);
    const direct = await page.request.post(`${API_PREFIX}/${sent.token}/view`, {
      headers: { origin: new URL(baseURL).origin },
    });
    expect(await direct.json()).toEqual({ recorded: false, reason: "member" });
    expect((await quoteRow(sent.quoteId)).viewCount).toBe(1);

    // Revocado: mensaje claro con el contacto, sin la cotización ni el PDF.
    await revokeLinks(tenantId, sent.quoteId);
    await client.goto(path);
    await expect(client.getByTestId("share-unavailable-title")).toHaveText(
      "Este enlace ya no está disponible",
    );
    await expect(client.getByTestId("share-contact")).toContainText(orgName);
    await expect(client.locator("body")).not.toContainText(sent.quoteNumber);
    await expect(client.locator("body")).not.toContainText("Cliente ver");
    await expect(client.getByTestId("share-quote")).toHaveCount(0);
    await expectNoHorizontalScroll(client);
    expect((await clientContext.request.get(`${API_PREFIX}/${sent.token}/pdf`)).status()).toBe(404);
    expect(consoleErrors).toEqual([]);
  } finally {
    await clientContext.close();
  }
});

test("un enlace vencido muestra el contacto de la empresa y no la cotización", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const { tenantId, orgName } = await setup(page, "vence");
  const sent = await sendQuote(page, tenantId, "vencida");
  const path = new URL(sent.link).pathname;
  await withDb((db) =>
    db.query(
      `update public.quotes set valid_until = app.current_business_date() - 1 where id = $1`,
      [sent.quoteId],
    ),
  );

  const client = await browser.newContext({
    baseURL: test.info().project.use.baseURL!,
    viewport: MOBILE,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  try {
    const clientPage = await client.newPage();
    await clientPage.goto(path);
    await expect(clientPage.getByTestId("share-unavailable-title")).toHaveText(
      "Esta cotización ya no está vigente",
    );
    await expect(clientPage.getByTestId("share-contact")).toContainText(orgName);
    await expect(clientPage.locator("body")).not.toContainText(sent.quoteNumber);
    await expect(clientPage.locator("body")).not.toContainText("Cliente vencida");
    await expect(clientPage.getByTestId("share-quote")).toHaveCount(0);
    await expectNoHorizontalScroll(clientPage);
    expect((await client.request.get(`${API_PREFIX}/${sent.token}/pdf`)).status()).toBe(404);
    // vencer no cuenta como apertura
    expect((await quoteRow(sent.quoteId)).viewCount).toBe(0);
  } finally {
    await client.close();
  }
});

test("un enlace inventado o mal escrito da un mensaje genérico, sin revelar nada", async ({
  page,
  request,
}) => {
  const invented = randomBytes(32).toString("base64url");
  await page.goto(`/c/${invented}`);
  await expect(page.getByTestId("share-not-found")).toBeVisible();
  await expect(page.getByRole("heading", { name: NOT_FOUND_TEXT })).toBeVisible();
  const inventedText = await page.locator("body").innerText();

  await page.goto("/c/corto");
  await expect(page.getByRole("heading", { name: NOT_FOUND_TEXT })).toBeVisible();
  expect(await page.locator("body").innerText()).toBe(inventedText);

  // La API pública responde igual de seca, y un POST sin el origen de la aplicación se rechaza.
  expect((await request.get(`${API_PREFIX}/${invented}/pdf`)).status()).toBe(404);
  expect((await request.get(`${API_PREFIX}/corto/pdf`)).status()).toBe(404);
  expect((await request.post(`${API_PREFIX}/${invented}/view`)).status()).toBe(403);
});

test("pasado el límite por minuto, la API pública responde 429: por IP y por enlace", async ({
  request,
}) => {
  test.setTimeout(240_000);

  // Por IP: 60 pasan (con tokens distintos) y el 61 queda bloqueado.
  const ipHeaders = { "x-forwarded-for": randomTestIp() };
  const statuses: number[] = [];
  for (let i = 0; i < IP_LIMIT + 1; i += 1) {
    const token = randomBytes(32).toString("base64url");
    statuses.push(
      (await request.get(`${API_PREFIX}/${token}/pdf`, { headers: ipHeaders })).status(),
    );
  }
  expect(statuses.slice(0, IP_LIMIT).every((status) => status === 404)).toBe(true);
  expect(statuses[IP_LIMIT]).toBe(429);

  // Por enlace: 30 lecturas del mismo enlace desde cualquier IP; la 31 queda bloqueada.
  const token = randomBytes(32).toString("base64url");
  const linkStatuses: number[] = [];
  for (let i = 0; i < LINK_LIMIT + 1; i += 1) {
    const headers = { "x-forwarded-for": randomTestIp() };
    linkStatuses.push((await request.get(`${API_PREFIX}/${token}/pdf`, { headers })).status());
  }
  expect(linkStatuses.slice(0, LINK_LIMIT).every((status) => status === 404)).toBe(true);
  expect(linkStatuses[LINK_LIMIT]).toBe(429);
  const blocked = await request.get(`${API_PREFIX}/${token}/pdf`, {
    headers: { "x-forwarded-for": randomTestIp() },
  });
  expect(blocked.headers()["retry-after"]).toBe("60");
});
