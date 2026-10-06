import { createHash, randomUUID } from "node:crypto";
import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import { expect, test, type Page } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-029: enviar la cotización por correo, de punta a punta. Los correos salen a Mailpit local
// (EMAIL_PROVIDER=mailpit en playwright.config.ts) y todo es ficticio, con direcciones @ejemplo.test.

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";
const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1440, height: 900 };
const BUTTON_LABEL = "Revisar y aceptar la cotización";

type MailSummary = { ID: string };
type MailDetail = {
  ID: string;
  From: { Name: string; Address: string };
  ReplyTo: { Address: string }[];
  Subject: string;
  HTML: string;
  Text: string;
  Attachments: { PartID: string; FileName: string; ContentType: string; Size: number }[];
};

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Todos los correos que llegaron a una dirección, del más antiguo al más nuevo. */
async function mailsTo(address: string): Promise<MailDetail[]> {
  const search = await fetch(
    `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
  );
  const { messages } = (await search.json()) as { messages?: MailSummary[] };
  const details: MailDetail[] = [];
  for (const { ID } of [...(messages ?? [])].reverse()) {
    details.push((await (await fetch(`${MAILBOX_URL}/api/v1/message/${ID}`)).json()) as MailDetail);
  }
  return details;
}

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

async function attachmentSha256(mail: MailDetail): Promise<string> {
  const [attachment] = mail.Attachments;
  const response = await fetch(
    `${MAILBOX_URL}/api/v1/message/${mail.ID}/part/${attachment.PartID}`,
  );
  return createHash("sha256")
    .update(Buffer.from(await response.arrayBuffer()))
    .digest("hex");
}

async function dismissToasts(page: Page) {
  for (const button of await page.locator("[data-sonner-toast] [data-close-button]").all()) {
    await button.click({ force: true, timeout: 1_000 }).catch(() => undefined);
  }
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
}

async function createCustomer(page: Page, tenantId: string, name: string, email?: string) {
  await page.goto(`/o/${tenantId}/clientes/nuevo`);
  await page.getByLabel(/^(Nombre|Razón social)/).fill(name);
  if (email) await page.getByLabel("Correo (opcional)").fill(email);
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/clientes/[0-9a-f-]{36}(\\?creado=1)?$`));
}

async function setup(page: Page, label: string): Promise<string> {
  await signUpAndVerify(page, uniqueEmail(label), "Vendedora Ficticia");
  const tenantId = await createTenant(page, `Envíos ${label} Ltda`, generateRut());
  await withDb((db) =>
    db.query(
      `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp, tax_treatment)
       values ($1, 'Servicio Alfa', 'service', 10000, 'taxable')`,
      [tenantId],
    ),
  );
  return tenantId;
}

/** Crea una cotización para el cliente dado; con `withLine` agrega una línea y guarda. */
async function newQuote(
  page: Page,
  tenantId: string,
  customerName: string,
  withLine = true,
): Promise<string> {
  await page.goto(`/o/${tenantId}/cotizaciones/nueva`);
  await page.getByRole("button", { name: new RegExp(customerName) }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));
  const quoteId = page.url().split("/").pop()!;
  if (withLine) {
    await page.getByRole("button", { name: "Agregar Servicio Alfa", exact: true }).click();
    await page.getByTestId("save-quote").click();
    await expect(page.getByTestId("save-status")).toHaveText("Guardado.");
  }
  return quoteId;
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("enviar la cotización: correo con PDF y botón, estado Enviada, un doble clic no duplica y reenviar manda el mismo PDF", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  const tenantId = await setup(page, "envio");
  const customerEmail = uniqueEmail("cliente");
  await createCustomer(page, tenantId, "Cliente Con Correo", customerEmail);
  const quoteId = await newQuote(page, tenantId, "Cliente Con Correo");
  const quoteNumber = await page.getByTestId("quote-number").innerText();

  // La pantalla de enviar, en teléfono: sin desplazamiento horizontal y todo apilado.
  await page.setViewportSize(MOBILE);
  await page.getByTestId("go-send").click();
  await expect(page).toHaveURL(new RegExp(`/cotizaciones/${quoteId}/enviar$`));
  await expect(page.getByTestId("send-subject")).toBeVisible();
  await expectNoHorizontalScroll(page);
  // En teléfono no se incrusta el PDF: queda el botón de abrirlo aparte, de al menos 44 px.
  await expect(page.getByTestId("pdf-frame")).toHaveCount(0);
  const openPdf = page.getByRole("link", { name: "Abrir en otra pestaña" });
  await expect(openPdf).toBeVisible();
  expect((await openPdf.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.setViewportSize(DESKTOP);

  // Texto de partida en español de Chile, asunto con el número y vista previa lado a lado.
  await expect(page.getByTestId("send-body")).toHaveValue(/Estimado\/a Cliente Con Correo:/);
  await expect(page.getByTestId("send-body")).toHaveValue(/Le hacemos llegar la cotización/);
  await expect(page.getByTestId("send-subject")).toHaveValue(
    new RegExp(`^Cotización ${quoteNumber} de `),
  );
  await expect(page.getByTestId("pdf-frame")).toHaveAttribute(
    "src",
    `/api/v1/tenants/${tenantId}/quotes/${quoteId}/pdf?size=letter`,
  );
  const preview = page.getByTestId("email-preview");
  await expect(preview).toContainText(BUTTON_LABEL);
  const previewBox = await preview.boundingBox();
  const frameBox = await page.getByTestId("pdf-frame").boundingBox();
  expect(Math.abs(previewBox!.y - frameBox!.y)).toBeLessThan(80); // uno al lado del otro

  // Formato básico: la negrita se ve en la vista previa y nada de HTML libre pasa.
  await page
    .getByTestId("send-body")
    .fill(
      "Estimado cliente: **gracias** por su interés.\n\n<script>alert(1)</script>\n\n- Primero\n- Segundo",
    );
  await expect(page.getByTestId("email-preview-body").locator("strong")).toHaveText("gracias");
  await expect(page.getByTestId("email-preview-body").locator("li")).toHaveCount(2);
  await expect(page.getByTestId("email-preview-body").locator("script")).toHaveCount(0);

  // Un doble clic rápido en «Enviar» manda un solo correo.
  await page.getByTestId("send-submit").dblclick();
  await expect(page).toHaveURL(new RegExp(`/cotizaciones/${quoteId}$`), { timeout: 120_000 });
  await expect(page.getByText("Enviada", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("quote-timeline")).toContainText("Enviada al cliente");
  await dismissToasts(page);

  const [first] = await waitForMails(customerEmail, 1);
  expect(first.From.Name).toBe("Envíos envio Ltda");
  expect(first.Subject).toBe(`Cotización ${quoteNumber} de Envíos envio Ltda`);
  expect(first.Attachments).toHaveLength(1);
  expect(first.Attachments[0].ContentType).toBe("application/pdf");
  expect(first.Attachments[0].FileName).toBe(`${quoteNumber}.pdf`);
  expect(first.HTML).toContain(BUTTON_LABEL);
  expect(first.HTML).toContain("<strong>gracias</strong>");
  expect(first.HTML).not.toContain("<script");
  expect(first.HTML).toMatch(/href="http:\/\/localhost:\d+\/c\/[A-Za-z0-9_-]{43}"/);
  expect(first.ReplyTo.length).toBe(1); // sin contacto en la organización: el correo del autor
  for (const text of [first.HTML, first.Text]) {
    expect(text).not.toMatch(/banco/i);
    expect(text).not.toMatch(/cuenta/i);
  }

  // Lo enviado es lo guardado: el sello del adjunto es el del paquete, y la ruta interna del PDF
  // entrega ese mismo archivo (no vuelve a armarlo).
  const sentSha = await attachmentSha256(first);
  const stored = await withDb(async (db) => {
    const packages = await db.query(
      `select p.pdf_sha256, p.state, q.status
         from public.quote_packages p join public.quotes q on q.id = p.quote_id
        where p.quote_id = $1`,
      [quoteId],
    );
    const emails = await db.query(
      `select kind, status from public.email_messages where quote_id = $1`,
      [quoteId],
    );
    return { packages: packages.rows, emails: emails.rows };
  });
  expect(stored.packages).toEqual([{ pdf_sha256: sentSha, state: "sent", status: "sent" }]);
  expect(stored.emails).toEqual([{ kind: "quote", status: "sent" }]);
  const served = await page.request.get(`/api/v1/tenants/${tenantId}/quotes/${quoteId}/pdf`);
  expect(served.status()).toBe(200);
  expect(
    createHash("sha256")
      .update(await served.body())
      .digest("hex"),
  ).toBe(sentSha);
  expect(served.headers()["x-frame-options"]).toBe("SAMEORIGIN");

  // La pantalla de enviar ya no sirve: vuelve a la cotización.
  await page.goto(`/o/${tenantId}/cotizaciones/${quoteId}/enviar`);
  await expect(page).toHaveURL(new RegExp(`/cotizaciones/${quoteId}$`));

  // Reenviar: mismo PDF, enlace nuevo, y queda en el historial.
  await page.getByTestId("resend-quote").click();
  const mails = await waitForMails(customerEmail, 2);
  expect(await attachmentSha256(mails[1])).toBe(sentSha);
  const linkOf = (mail: MailDetail) => /\/c\/([A-Za-z0-9_-]{43})/.exec(mail.HTML)![1];
  expect(linkOf(mails[1])).not.toBe(linkOf(mails[0]));
  await expect(page.getByTestId("quote-timeline")).toContainText("Reenviada al cliente");
  await expect(page.getByTestId("pdf-hint")).toContainText("tal como se envió");
  // Ya enviada: el PDF es el archivo congelado, no hay tamaño de hoja que elegir (M9).
  await expect(page.getByLabel("Tamaño de hoja")).toHaveCount(0);

  expect(consoleErrors).toEqual([]);
});

test("si el correo no sale, se avisa en pantalla y la cotización sigue en borrador", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const tenantId = await setup(page, "fallo");
  // Fuera de la lista blanca de pruebas (ejemplo.test): el envío falla sin tocar a nadie.
  await createCustomer(
    page,
    tenantId,
    "Cliente Fuera de Lista",
    `fuera-${randomUUID().slice(0, 8)}@dominio-real.cl`,
  );
  const quoteId = await newQuote(page, tenantId, "Cliente Fuera de Lista");

  await page.getByTestId("go-send").click();
  await page.getByTestId("send-submit").click();
  // La dirección no sirve (no es "problema nuestro"): el mensaje manda a revisar la ficha del cliente.
  await expect(page.getByText("rechazó la dirección del cliente")).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText("sigue como borrador")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/cotizaciones/${quoteId}/enviar$`));

  const state = await withDb(async (db) => {
    const quote = await db.query(`select status, sent_at from public.quotes where id = $1`, [
      quoteId,
    ]);
    const emails = await db.query(
      `select status, error_code from public.email_messages where quote_id = $1`,
      [quoteId],
    );
    const packages = await db.query(`select state from public.quote_packages where quote_id = $1`, [
      quoteId,
    ]);
    const links = await db.query(
      `select activated_at, revoked_at from public.share_links where quote_id = $1`,
      [quoteId],
    );
    return { quote: quote.rows, emails: emails.rows, packages: packages.rows, links: links.rows };
  });
  expect(state.quote).toEqual([{ status: "draft", sent_at: null }]);
  expect(state.emails).toEqual([{ status: "failed", error_code: "recipient_not_allowed" }]);
  expect(state.packages).toEqual([{ state: "failed" }]);
  expect(state.links).toHaveLength(1);
  expect(state.links[0].activated_at).toBeNull();
  expect(state.links[0].revoked_at).not.toBeNull();

  // En la cotización sigue «Borrador», con el intento fallido en el historial, y se puede reintentar.
  await page.goto(`/o/${tenantId}/cotizaciones/${quoteId}`);
  await expect(page.getByText("Borrador", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("quote-timeline")).toContainText("No se pudo enviar el correo");
  await expect(page.getByTestId("go-send")).toBeVisible();
});

test("sin correo del cliente o sin líneas no se puede enviar, y se explica por qué", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const tenantId = await setup(page, "bloqueo");
  await createCustomer(page, tenantId, "Cliente Sin Correo");
  const withoutEmail = await newQuote(page, tenantId, "Cliente Sin Correo");

  await page.goto(`/o/${tenantId}/cotizaciones/${withoutEmail}/enviar`);
  await expect(page.getByTestId("send-blocker")).toContainText("no tiene correo");
  await expect(page.getByTestId("send-submit")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Agregar el correo del cliente" })).toBeVisible();

  // Con correo pero sin líneas, el motivo son las líneas.
  await createCustomer(page, tenantId, "Cliente Con Correo B", uniqueEmail("b"));
  const emptyWithEmail = await newQuote(page, tenantId, "Cliente Con Correo B", false);
  await page.goto(`/o/${tenantId}/cotizaciones/${emptyWithEmail}/enviar`);
  await expect(page.getByTestId("send-blocker")).toContainText("al menos una línea");
  await expect(page.getByTestId("send-submit")).toHaveCount(0);
});
