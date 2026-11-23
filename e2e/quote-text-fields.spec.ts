import { randomUUID } from "node:crypto";
import { generateRut } from "../src/lib/chile/rut";
import { readPdf } from "../src/test/read-pdf";
import { connect } from "../tests/db/helpers";
import { expect, randomTestIp, test, type Page } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-048b: exclusiones y notas al pie como campos propios de la cotización, «Insertar texto guardado», el texto inicial del correo con
// variables, y que los dos textos lleguen al PDF y a la página del cliente. Los correos salen a Mailpit local; todo es ficticio.

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";
const MOBILE = { width: 375, height: 812 };
const EXCLUSION_A = "No incluye embalaje.";
const EXCLUSION_B = "No incluye peajes.";
const FOOTER = "Valores en pesos chilenos.";
const CONDITIONS = "Valores sin IVA.";
const BODY_SNIPPET =
  "Estimado/a {{cliente}}: le enviamos la {{numero}} de {{organizacion}}.\n\nSaludos, {{remitente}}";
const SHORT_SNIPPET = "Hola {{cliente}}, adjuntamos la {{numero}}.";

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

type MailDetail = { ID: string; HTML: string; Text: string; Subject: string };
async function waitForMail(address: string): Promise<MailDetail> {
  let found: MailDetail | null = null;
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
        );
        const { messages } = (await search.json()) as { messages?: { ID: string }[] };
        if (!messages?.length) return 0;
        found = (await (
          await fetch(`${MAILBOX_URL}/api/v1/message/${messages[0].ID}`)
        ).json()) as MailDetail;
        return messages.length;
      },
      { message: `Esperaba un correo a ${address}`, timeout: 30_000 },
    )
    .toBe(1);
  return found!;
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function insertSnippet(page: Page, field: string, name: string) {
  await page.getByRole("button", { name: `Insertar texto guardado en ${field}` }).click();
  await page.getByRole("menuitem", { name: new RegExp(name) }).click();
}

test("exclusiones y notas al pie: se insertan desde los textos guardados, se guardan, y llegan al PDF y a la página del cliente; el correo parte con el texto inicial y las variables completas", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  const orgName = "Textos Ficticios Ltda";
  await signUpAndVerify(page, uniqueEmail("textos"), "Vendedora Ficticia");
  const tenantId = await createTenant(page, orgName, generateRut());
  const customerEmail = uniqueEmail("cliente");
  await withDb(async (db) => {
    await db.query(
      `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp, tax_treatment)
       values ($1, 'Servicio Alfa', 'service', 10000, 'taxable')`,
      [tenantId],
    );
    // Los textos guardados se crean como lo haría la pantalla de Configuración (aquí, directo, solo para preparar datos).
    for (const [kind, name, body, isDefault] of [
      ["conditions", "Condiciones estándar", CONDITIONS, false],
      ["exclusions", "Sin embalaje", EXCLUSION_A, false],
      ["exclusions", "Sin peajes", EXCLUSION_B, false],
      ["footer_note", "Pie estándar", FOOTER, false],
      ["email_body", "Saludo formal", BODY_SNIPPET, true],
      ["email_body", "Saludo breve", SHORT_SNIPPET, false],
    ] as const) {
      await db.query(
        `insert into public.text_snippets (id, tenant_id, kind, name, body, is_default)
         values ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), tenantId, kind, name, body, isDefault],
      );
    }
  });
  await page.goto(`/o/${tenantId}/clientes/nuevo`);
  await page.getByLabel(/^(Nombre|Razón social)/).fill("Cliente Textos");
  await page.getByLabel("Correo (opcional)").fill(customerEmail);
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/clientes/[0-9a-f-]{36}(\\?creado=1)?$`));

  // La cotización con una línea.
  await page.goto(`/o/${tenantId}/cotizaciones/nueva`);
  await page.getByRole("button", { name: /Cliente Textos/ }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/cotizaciones/[0-9a-f-]{36}$`));
  const quoteId = page.url().split("/").pop()!;
  const quotePath = `/o/${tenantId}/cotizaciones/${quoteId}`;
  await page.getByRole("button", { name: "Agregar Servicio Alfa", exact: true }).click();

  // Los cuatro textos, en el orden del PDF, y las observaciones sin botón de textos guardados.
  const order = await page
    .locator("label")
    .evaluateAll((labels) =>
      labels
        .map((label) => label.textContent ?? "")
        .filter((text) =>
          /^(Observaciones|Condiciones comerciales|Exclusiones|Notas al pie)/.test(text),
        ),
    );
  expect(order).toEqual([
    "Observaciones (opcional)",
    "Condiciones comerciales (opcional)",
    "Exclusiones (opcional)",
    "Notas al pie (opcional)",
  ]);
  await expect(page.getByRole("button", { name: /Insertar texto guardado/ })).toHaveCount(3);

  // Insertar: cada campo ofrece solo los textos de su tipo; el texto va al final, separado por una línea en blanco.
  await insertSnippet(page, "Condiciones comerciales", "Condiciones estándar");
  await expect(page.locator("#conditions")).toHaveValue(CONDITIONS);
  await insertSnippet(page, "Exclusiones", "Sin embalaje");
  await page.getByRole("button", { name: "Insertar texto guardado en Exclusiones" }).click();
  // solo los textos de exclusiones (no los de otros tipos), más el enlace para administrarlos (la persona es Dueña)
  await expect(page.locator('[role="menuitem"]:not(a)')).toHaveCount(2);
  await expect(page.getByRole("menuitem", { name: "Administrar textos" })).toBeVisible();
  const added = page.getByRole("menuitem", { name: /Sin embalaje/ });
  await expect(added).toContainText("Ya agregado");
  await expect(added).toHaveAttribute("data-disabled", "");
  await page.getByRole("menuitem", { name: /Sin peajes/ }).click();
  await expect(page.locator("#exclusions")).toHaveValue(`${EXCLUSION_A}\n\n${EXCLUSION_B}`);
  await insertSnippet(page, "Notas al pie", "Pie estándar");
  await expect(page.locator("#footer-note")).toHaveValue(FOOTER);
  await expect(page.getByTestId("exclusions-count")).toHaveText("40 / 4.000");

  // El editor en teléfono, con el menú abierto: sin desplazamiento horizontal y los botones de al menos 44 px.
  await page.setViewportSize(MOBILE);
  await page.getByRole("button", { name: "Insertar texto guardado en Notas al pie" }).click();
  await expect(page.getByRole("menuitem", { name: /Pie estándar/ })).toBeVisible();
  await expectNoHorizontalScroll(page);
  const triggerBox = await page
    .getByRole("button", { name: "Insertar texto guardado en Notas al pie" })
    .boundingBox();
  expect(triggerBox!.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Un texto de verdad escrito a mano se suma al insertado.
  await page.locator("#observations").fill("Retiro en bodega de Pudahuel.");

  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("save-status")).toHaveText("Guardado.");
  // Recargar: todo persiste (y los textos guardados vuelven a ofrecerse).
  await page.reload();
  await expect(page.locator("#exclusions")).toHaveValue(`${EXCLUSION_A}\n\n${EXCLUSION_B}`);
  await expect(page.locator("#footer-note")).toHaveValue(FOOTER);
  await expect(page.locator("#conditions")).toHaveValue(CONDITIONS);
  const stored = await withDb(async (db) => {
    const { rows } = await db.query(
      "select exclusions, footer_note, conditions, observations from public.quotes where id = $1",
      [quoteId],
    );
    return rows[0];
  });
  expect(stored).toEqual({
    exclusions: `${EXCLUSION_A}\n\n${EXCLUSION_B}`,
    footer_note: FOOTER,
    conditions: CONDITIONS,
    observations: "Retiro en bodega de Pudahuel.",
  });

  // «Enviar»: el correo parte con el texto inicial y las variables ya completas.
  await page.getByTestId("go-send").click();
  await expect(page).toHaveURL(new RegExp(`/cotizaciones/${quoteId}/enviar$`));
  const quoteNumber = (await page.getByRole("heading", { level: 1 }).innerText()).replace(
    /^Enviar\s+/,
    "",
  );
  const body = page.getByTestId("send-body");
  await expect(body).toHaveValue(/Estimado\/a Cliente Textos: le enviamos la COT-/);
  await expect(body).toHaveValue(new RegExp(`de ${orgName}\\.`));
  await expect(body).toHaveValue(/Saludos, Vendedora Ficticia/);
  await expect(body).not.toHaveValue(/\{\{/);
  expect(await body.inputValue()).toContain(quoteNumber);
  const select = page.getByTestId("send-snippet-select");
  await expect(select.locator("option")).toHaveText([
    "Elige un texto guardado…",
    "Texto de siempre",
    "Saludo breve",
    "Saludo formal (texto inicial)",
  ]);
  const useSnippet = page.getByTestId("send-snippet-use");

  // Elegir en la lista no cambia el correo; «Usar este texto» sí. Sin haber editado el actual: directo. Editado: pide confirmar.
  await select.selectOption({ label: "Saludo breve" });
  await expect(body).toHaveValue(/^Estimado\/a Cliente Textos/);
  await useSnippet.click();
  await expect(body).toHaveValue(/^Hola Cliente Textos, adjuntamos la COT-/);
  await body.fill("Lo que escribí yo, con **cariño**.");
  await select.selectOption({ label: "Saludo formal (texto inicial)" });
  await useSnippet.click();
  await expect(page.getByTestId("send-snippet-confirm")).toBeVisible();
  await page.getByTestId("send-snippet-keep").click();
  await expect(body).toHaveValue("Lo que escribí yo, con **cariño**.");
  await select.selectOption({ label: "Saludo formal (texto inicial)" });
  await useSnippet.click();
  await page.getByTestId("send-snippet-replace").click();
  await expect(body).toHaveValue(/Estimado\/a Cliente Textos/);

  // Una variable escrita a mano y sin completar no deja enviar.
  await body.fill("Estimado/a {{cliente}}: adjuntamos la cotización.");
  await expect(page.getByTestId("send-unresolved-variables")).toBeVisible();
  await expect(page.getByTestId("send-submit")).toBeDisabled();
  await body.fill("Estimado/a Cliente Textos: adjuntamos la cotización.");
  await expect(page.getByTestId("send-submit")).toBeEnabled();

  // En teléfono, la pantalla de enviar con el selector sigue sin desplazamiento horizontal.
  await page.setViewportSize(MOBILE);
  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByTestId("send-submit").click();
  await expect(page).toHaveURL(new RegExp(`/cotizaciones/${quoteId}$`), { timeout: 120_000 });
  const mail = await waitForMail(customerEmail);
  expect(mail.HTML + mail.Text).not.toContain("{{");

  // El PDF congelado trae los dos bloques, con sus títulos y su texto, y en el orden del diseño.
  const pdf = await page.request.get(`/api/v1/tenants/${tenantId}/quotes/${quoteId}/pdf`);
  expect(pdf.status()).toBe(200);
  const read = await readPdf(await pdf.body());
  const squash = (value: string) => value.replace(/\s+/g, "");
  const flat = squash(read.text);
  for (const text of [EXCLUSION_A, EXCLUSION_B, FOOTER, CONDITIONS]) {
    expect(flat).toContain(squash(text));
  }
  const positions = ["OBSERVACIONES", "CONDICIONES", "EXCLUSIONES", "NOTAS"].map((title) =>
    flat.indexOf(title),
  );
  expect(positions.every((index) => index >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(flat.indexOf(squash(FOOTER))).toBeGreaterThan(flat.indexOf("NOTAS"));

  // La página del cliente, sin sesión y en teléfono: «Exclusiones» y «Notas» como texto, sin desplazamiento horizontal.
  const token = /\/c\/([A-Za-z0-9_-]{43})/.exec(mail.HTML)![1];
  const baseURL = test.info().project.use.baseURL!;
  const clientContext = await browser.newContext({
    baseURL,
    viewport: MOBILE,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  try {
    const client = await clientContext.newPage();
    await client.goto(`/c/${token}`);
    const view = client.getByTestId("share-quote");
    await expect(view).toBeVisible();
    await expect(view.getByRole("heading", { name: "Exclusiones" })).toBeVisible();
    await expect(view.getByRole("heading", { name: "Notas" })).toBeVisible();
    await expect(view).toContainText(EXCLUSION_A);
    await expect(view).toContainText(EXCLUSION_B);
    await expect(view).toContainText(FOOTER);
    await expectNoHorizontalScroll(client);
  } finally {
    await clientContext.close();
  }

  // Ya enviada: la cotización no se edita y muestra los dos textos en solo lectura, sin botones de textos guardados.
  await page.goto(quotePath);
  await expect(page.getByText(EXCLUSION_A)).toBeVisible();
  await expect(page.getByText(FOOTER)).toBeVisible();
  await expect(page.getByRole("button", { name: /Insertar texto guardado/ })).toHaveCount(0);

  expect(consoleErrors).toEqual([]);
});
