import "../tests/support/stub-server-only"; // debe ir primero
import { randomUUID } from "node:crypto";
import { decryptPii } from "../src/lib/crypto/pii";
import { generateRut } from "../src/lib/chile/rut";
import { TENANT_HEADER, actAs, connect } from "../tests/db/helpers";
import { expect, randomTestIp, test, type Page } from "./fixtures";
import { countMails, createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-031: aceptar o rechazar la cotización desde el enlace del correo, sin cuenta. Los correos salen a
// Mailpit local (EMAIL_PROVIDER=mailpit en playwright.config.ts) y todo es ficticio (@ejemplo.test).

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";
const MOBILE = { width: 375, height: 812 };
const API_PREFIX = "/api/v1/public/quote-links";
const RESPOND_LIMIT = 10;

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

async function setup(
  page: Page,
  label: string,
): Promise<{ tenantId: string; orgName: string; authorEmail: string }> {
  const authorEmail = uniqueEmail(label);
  await signUpAndVerify(page, authorEmail, "Vendedora Ficticia");
  const orgName = `Respuesta ${label} Ltda`;
  const tenantId = await createTenant(page, orgName, generateRut());
  await withDb((db) =>
    db.query(
      `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp, tax_treatment)
       values ($1, 'Servicio Alfa', 'service', 10000, 'taxable')`,
      [tenantId],
    ),
  );
  return { tenantId, orgName, authorEmail };
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

type ResponseRow = {
  id: string;
  tenant_id: string;
  decision: string;
  acceptor_name_enc: string | null;
  reason_code: string | null;
  reason_text_enc: string | null;
  ip_enc: string | null;
  acceptance_text_version: string | null;
  user_agent_short: string | null;
};

async function state(quoteId: string) {
  return withDb(async (db) => {
    const quote = await db.query<{ status: string; responded_at: string | null }>(
      `select status, responded_at from public.quotes where id = $1`,
      [quoteId],
    );
    const responses = await db.query<ResponseRow>(
      `select id, tenant_id, decision, acceptor_name_enc, reason_code, reason_text_enc, ip_enc,
              acceptance_text_version, user_agent_short
         from public.quote_responses where quote_id = $1`,
      [quoteId],
    );
    const events = await db.query<{ type: string; data: { reason_code?: string } }>(
      `select type, data from public.quote_events
        where quote_id = $1 and type in ('accepted', 'rejected_by_customer')`,
      [quoteId],
    );
    const audit = await db.query<{ action: string; origin_ip: string | null; details: object }>(
      `select action, host(origin_ip) as origin_ip, details from public.audit_log
        where resource_id = $1 and action in ('quote.accepted', 'quote.rejected')`,
      [quoteId],
    );
    return {
      status: quote.rows[0].status,
      respondedAt: quote.rows[0].responded_at,
      responses: responses.rows,
      events: events.rows,
      audit: audit.rows,
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

test("el cliente acepta desde su teléfono: queda registrado, no se puede repetir y el autor recibe el aviso", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const { tenantId, authorEmail } = await setup(page, "acepta");
  const sent = await sendQuote(page, tenantId, "acepta");
  const path = new URL(sent.link).pathname;
  const baseURL = test.info().project.use.baseURL!;
  const clientIp = randomTestIp();

  const clientContext = await browser.newContext({
    baseURL,
    viewport: MOBILE,
    extraHTTPHeaders: { "x-forwarded-for": clientIp },
  });
  try {
    const client = await clientContext.newPage();
    const consoleErrors: string[] = [];
    client.on("pageerror", (error) => consoleErrors.push(error.message));
    await client.goto(path);
    // Otra pestaña, abierta antes de responder: se usa más abajo para comprobar que no cambia nada.
    const other = await clientContext.newPage();
    await other.goto(path);
    await expect(other.getByTestId("response-accept-open")).toBeVisible();

    await expect(client.getByTestId("response-accept-open")).toBeVisible();
    await expect(client.getByTestId("response-reject-open")).toBeVisible();
    await expectNoHorizontalScroll(client);

    // Aceptar sin nombre y sin conformidad: se pide, y no se registra nada.
    await client.getByTestId("response-accept-open").click();
    await client.getByTestId("accept-submit").click();
    await expect(client.getByText("Escribe tu nombre para aceptar.")).toBeVisible();
    await client.getByTestId("accept-name").fill("Carolina Cliente Ficticia");
    await client.getByTestId("accept-submit").click();
    await expect(client.getByText("Marca la casilla para confirmar que aceptas.")).toBeVisible();
    await expectNoHorizontalScroll(client);
    expect((await state(sent.quoteId)).responses).toHaveLength(0);

    // Con todo completo, un doble clic registra una sola vez.
    await client.getByTestId("accept-confirm").check();
    await client.getByTestId("accept-submit").dblclick();
    await expect(client.getByTestId("response-confirmation")).toContainText(
      "Aceptaste esta cotización",
    );
    await expect(client.getByTestId("response-accept-open")).toHaveCount(0);

    const accepted = await state(sent.quoteId);
    expect(accepted.status).toBe("accepted");
    expect(accepted.respondedAt).not.toBeNull();
    expect(accepted.responses).toHaveLength(1);
    const row = accepted.responses[0];
    expect(row).toMatchObject({ decision: "accepted", acceptance_text_version: "v1" });
    expect(row.reason_code).toBeNull();
    // El nombre y la IP van cifrados con el sello de la fila; la IP es la que vio el servidor.
    expect(row.acceptor_name_enc).toMatch(/^v\d+\./);
    expect(row.acceptor_name_enc).not.toContain("Carolina");
    expect(
      decryptPii(row.acceptor_name_enc!, {
        table: "quote_responses",
        field: "acceptor_name",
        tenantId,
        rowId: row.id,
      }),
    ).toBe("Carolina Cliente Ficticia");
    expect(
      decryptPii(row.ip_enc!, { table: "quote_responses", field: "ip", tenantId, rowId: row.id }),
    ).toBe(clientIp);
    expect(accepted.audit).toHaveLength(1);
    expect(accepted.audit[0].origin_ip).toBe(clientIp);
    expect(JSON.stringify(accepted.audit[0].details)).not.toContain("Carolina");
    expect(accepted.events.map((event) => event.type)).toEqual(["accepted"]);

    // Recargar: ya no hay botones, y dice lo que quedó. El PDF sigue descargable.
    await client.reload();
    await expect(client.getByTestId("response-confirmation")).toContainText(
      "Ya respondiste esta cotización",
    );
    await expect(client.getByTestId("response-confirmation")).toContainText("La aceptaste");
    // Y el aviso de la parte de arriba dice que ya fue aceptada, con la fecha.
    await expect(client.getByTestId("share-response-notice")).toContainText(
      /Esta cotización ya fue aceptada el \d{2}[-/]\d{2}[-/]\d{4}/,
    );
    await expect(client.getByRole("button", { name: /^(aceptar|rechazar)$/i })).toHaveCount(0);
    await expect(client.getByTestId("share-download-pdf")).toBeVisible();
    const pdf = await clientContext.request.get(`${API_PREFIX}/${sent.token}/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");

    // La otra pestaña intenta rechazar: recibe «ya respondiste» y la decisión no cambia.
    await other.getByTestId("response-reject-open").click();
    await other.getByTestId("reject-reason-timing").check();
    await other.getByTestId("reject-submit").click();
    await expect(other.getByTestId("response-confirmation")).toContainText(
      "Ya respondiste esta cotización",
    );
    await expect(other.getByTestId("response-confirmation")).toContainText("La aceptaste");
    const afterOther = await state(sent.quoteId);
    expect(afterOther.status).toBe("accepted");
    expect(afterOther.responses).toHaveLength(1);
    expect(afterOther.responses[0].decision).toBe("accepted");

    // Sin datos bancarios, ni en el HTML ni en lo que se ve.
    const html = await (await clientContext.request.get(path)).text();
    const visibleText = await client.locator("body").innerText();
    for (const text of [html, visibleText]) {
      expect(text).not.toMatch(/banco/i);
      expect(text).not.toMatch(/\bcuenta\b/i);
    }
    expect(consoleErrors).toEqual([]);
  } finally {
    await clientContext.close();
  }

  // El autor recibe un solo aviso (el doble clic no lo duplica) y el equipo ve la respuesta.
  await expect.poll(() => countMails(authorEmail, sent.quoteNumber), { timeout: 30_000 }).toBe(1);
  const notice = (await mailsTo(authorEmail)).find((mail) => mail.Text.includes("aceptó"));
  expect(notice).toBeDefined();
  // El correo no lleva el nombre de quien aceptó: eso se ve solo dentro de la aplicación.
  expect(notice!.Text).not.toContain("Carolina Cliente Ficticia");
  expect(notice!.Text).not.toMatch(/banco/i);
  await page.goto(`/o/${tenantId}/cotizaciones/${sent.quoteId}`);
  await expect(page.getByTestId("customer-response-headline")).toContainText(
    "Aceptada por Carolina Cliente Ficticia el",
  );
  await expect(page.getByText("Aceptada", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("El cliente aceptó la cotización")).toBeVisible();
  await page.goto(`/o/${tenantId}/cotizaciones`);
  // La lista dibuja tabla y tarjetas: se mira la que está a la vista.
  await expect(
    page.getByText("Aceptada", { exact: true }).locator("visible=true").first(),
  ).toBeVisible();
});

test("el cliente rechaza: sin motivo no se registra, y el motivo queda visible para el equipo", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const { tenantId, authorEmail } = await setup(page, "rechaza");
  const sent = await sendQuote(page, tenantId, "rechaza");
  const path = new URL(sent.link).pathname;
  const baseURL = test.info().project.use.baseURL!;

  // Una IP que no es una IP (cabecera inventada): no se registra como IP de nadie.
  const clientContext = await browser.newContext({
    baseURL,
    viewport: MOBILE,
    extraHTTPHeaders: { "x-forwarded-for": "esto-no-es-una-ip" },
  });
  try {
    const client = await clientContext.newPage();
    await client.goto(path);
    await client.getByTestId("response-reject-open").click();
    await expectNoHorizontalScroll(client);

    // Sin motivo.
    await client.getByTestId("reject-submit").click();
    await expect(client.getByText("Elige el motivo del rechazo.")).toBeVisible();
    // «Otro» sin texto, y con 2 caracteres.
    await client.getByTestId("reject-reason-other").check();
    await client.getByTestId("reject-submit").click();
    await expect(client.getByText(/Cuéntanos brevemente el motivo \(entre 3 y 200/)).toBeVisible();
    await client.getByTestId("reject-reason-text").fill("ab");
    await client.getByTestId("reject-submit").click();
    await expect(client.getByText(/Cuéntanos brevemente el motivo \(entre 3 y 200/)).toBeVisible();
    expect((await state(sent.quoteId)).responses).toHaveLength(0);
    expect((await state(sent.quoteId)).status).not.toBe("rejected_by_customer");

    // «Otro» con texto: se registra, con el texto cifrado.
    await client.getByTestId("reject-reason-text").fill("Lo resolvimos con otro equipo");
    await client.getByTestId("reject-submit").dblclick();
    await expect(client.getByTestId("response-confirmation")).toContainText(
      "Rechazaste esta cotización",
    );

    const rejected = await state(sent.quoteId);
    expect(rejected.status).toBe("rejected_by_customer");
    expect(rejected.responses).toHaveLength(1);
    const row = rejected.responses[0];
    expect(row).toMatchObject({ decision: "rejected", reason_code: "other" });
    expect(row.acceptor_name_enc).toBeNull();
    expect(row.acceptance_text_version).toBeNull();
    expect(row.reason_text_enc).not.toContain("equipo");
    expect(
      decryptPii(row.reason_text_enc!, {
        table: "quote_responses",
        field: "reason_text",
        tenantId,
        rowId: row.id,
      }),
    ).toBe("Lo resolvimos con otro equipo");
    // La cabecera inventada no se tomó por una IP.
    expect(row.ip_enc).toBeNull();
    expect(rejected.audit).toHaveLength(1);
    expect(rejected.audit[0].origin_ip).toBeNull();
    expect(rejected.events).toEqual([
      { type: "rejected_by_customer", data: { reason_code: "other" } },
    ]);

    // Recargar: ya no hay botones.
    await client.reload();
    await expect(client.getByTestId("response-confirmation")).toContainText("La rechazaste");
    await expect(client.getByRole("button", { name: /^(aceptar|rechazar)$/i })).toHaveCount(0);

    // El mismo clic llevado directo a la ruta con otra decisión: ya respondida, no cambia.
    const origin = new URL(baseURL).origin;
    const again = await clientContext.request.post(`${API_PREFIX}/${sent.token}/accept`, {
      headers: { origin },
      data: { responseKey: randomUUID(), name: "Otra Persona", confirmed: true },
    });
    expect(await again.json()).toEqual({ status: "already_responded", decision: "rejected" });
    expect((await state(sent.quoteId)).status).toBe("rejected_by_customer");
  } finally {
    await clientContext.close();
  }

  // El autor recibe el aviso con el motivo, y el equipo lo ve en la cotización y en la lista.
  await expect.poll(() => countMails(authorEmail, sent.quoteNumber), { timeout: 30_000 }).toBe(1);
  const notice = (await mailsTo(authorEmail)).find((mail) => mail.Text.includes("rechazó"));
  expect(notice).toBeDefined();
  expect(notice!.Text).toContain("Otro motivo");
  // El correo solo avisa que hay comentario; el texto libre se ve dentro de la aplicación.
  expect(notice!.Text).not.toContain("Lo resolvimos con otro equipo");
  expect(notice!.Text).toContain("El cliente dejó un comentario");
  await page.goto(`/o/${tenantId}/cotizaciones/${sent.quoteId}`);
  await expect(page.getByTestId("customer-response-reason")).toContainText("Otro motivo");
  await expect(page.getByTestId("customer-response-detail")).toContainText(
    "Lo resolvimos con otro equipo",
  );
  await expect(page.getByText("Rechazada por el cliente", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("El cliente rechazó la cotización: otro motivo")).toBeVisible();
  await page.goto(`/o/${tenantId}/cotizaciones`);
  await expect(
    page.getByText("Rechazada por el cliente", { exact: true }).locator("visible=true").first(),
  ).toBeVisible();
});

test("un enlace revocado o vencido no permite responder, y las respuestas por IP tienen tope", async ({
  page,
  browser,
}) => {
  test.setTimeout(540_000);
  const { tenantId } = await setup(page, "no-responde");
  const revoked = await sendQuote(page, tenantId, "revocada");
  const expired = await sendQuote(page, tenantId, "vencida");
  const baseURL = test.info().project.use.baseURL!;
  const origin = new URL(baseURL).origin;

  const clientContext = await browser.newContext({
    baseURL,
    viewport: MOBILE,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  try {
    const client = await clientContext.newPage();
    const accept = (token: string) => ({
      headers: { origin },
      data: { responseKey: randomUUID(), name: "Persona Ficticia", confirmed: true },
      url: `${API_PREFIX}/${token}/accept`,
    });

    // Revocado: la página estaba abierta, se revoca y al aceptar aparece el aviso (sin respuesta).
    await client.goto(new URL(revoked.link).pathname);
    await client.getByTestId("response-accept-open").click();
    await revokeLinks(tenantId, revoked.quoteId);
    await client.getByTestId("accept-name").fill("Persona Ficticia");
    await client.getByTestId("accept-confirm").check();
    await client.getByTestId("accept-submit").click();
    await expect(client.getByTestId("share-unavailable-title")).toHaveText(
      "Este enlace ya no está disponible",
    );
    let after = await state(revoked.quoteId);
    expect(after.responses).toHaveLength(0);
    expect(after.status).not.toBe("accepted");
    // Directo a la ruta: 409 y nada cambia.
    const direct = accept(revoked.token);
    const viaApi = await clientContext.request.post(direct.url, {
      headers: direct.headers,
      data: direct.data,
    });
    expect(viaApi.status()).toBe(409);
    expect(await viaApi.json()).toEqual({ status: "unavailable", reason: "revoked" });

    // Vencido: la vigencia pasó con la página abierta.
    await client.goto(new URL(expired.link).pathname);
    await client.getByTestId("response-reject-open").click();
    await withDb((db) =>
      db.query(
        `update public.quotes set valid_until = app.current_business_date() - 1 where id = $1`,
        [expired.quoteId],
      ),
    );
    await client.getByTestId("reject-reason-timing").check();
    await client.getByTestId("reject-submit").click();
    await expect(client.getByTestId("share-unavailable-title")).toHaveText(
      "Esta cotización ya no está vigente",
    );
    after = await state(expired.quoteId);
    expect(after.responses).toHaveLength(0);
    expect(after.status).toBe("expired");

    // Tope por IP: hasta 10 respuestas por hora; la siguiente recibe 429 con un mensaje claro.
    // (Ya se usaron 2 en esta IP: la del enlace revocado y la de la ruta directa; la tercera es la del vencido.)
    const used = 3;
    for (let i = used; i < RESPOND_LIMIT; i += 1) {
      const res = await clientContext.request.post(direct.url, {
        headers: direct.headers,
        data: { ...direct.data, responseKey: randomUUID() },
      });
      expect(res.status(), `respuesta ${i + 1}`).toBe(409);
    }
    const blocked = await clientContext.request.post(direct.url, {
      headers: direct.headers,
      data: { ...direct.data, responseKey: randomUUID() },
    });
    expect(blocked.status()).toBe(429);
    expect(blocked.headers()["retry-after"]).toBeTruthy();
    expect((await blocked.json()).message).toContain("muchas solicitudes");
    // Una petición mal armada no gasta el cupo ni llega a la base: se rechaza antes.
    const invalid = await clientContext.request.post(direct.url, {
      headers: { origin },
      data: { responseKey: "x", name: "", confirmed: false },
    });
    expect(invalid.status()).toBe(422);
    // Sin el origen de la aplicación y con un token mal formado, también se rechaza.
    expect(
      (
        await clientContext.request.post(direct.url, {
          data: direct.data,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await clientContext.request.post(`${API_PREFIX}/token-corto/accept`, {
          headers: { origin },
          data: direct.data,
        })
      ).status(),
    ).toBe(404);
  } finally {
    await clientContext.close();
  }
});
