import "../tests/support/stub-server-only"; // debe ir primero
import { randomUUID } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { generateRut } from "../src/lib/chile/rut";
import { TENANT_HEADER } from "../src/lib/tenant/constants";
import { connect } from "../tests/db/helpers";
import { localEnv, rest, rpc } from "../tests/support/local-supabase";
import { TEST_PASSWORD, createTenant, signUpAndVerify, uniqueEmail } from "./helpers";
import { expect, randomTestIp, test, type Page } from "./fixtures";

// H-088: ver en vivo lo que estoy pidiendo. Todo ficticio, una organización nueva por corrida. El resumen
// se arma solo en el navegador (sin peticiones por tecla), no muestra ningún monto, tiene hoja en teléfono
// y es el mismo que ve el equipo en la solicitud ya recibida.

const MOBILE = { width: 375, height: 812 };
const CATALOG_PRICE = 45_000;
const XSS_MESSAGE = "Hola <script>alert(1)</script> & comillas";

const ctx = {} as {
  tenantId: string;
  token: string;
  ownerContext: BrowserContext;
  ownerPage: Page;
  publicId: string;
  formId: string;
  catalogItemId: string;
  freeItemId: string;
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

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function openForm(page: Page) {
  await page.goto(`/f/${ctx.publicId}`);
  await expect(page.getByTestId("form-view")).toBeVisible();
  await expect(page.locator("#pf-name")).toBeEnabled();
}

const summaryText = (page: Page) =>
  page.getByTestId("summary-aside").getByTestId("request-summary-body");

test.describe.configure({ mode: "serial" });

test.describe("H-088 · resumen en vivo del formulario público", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    ctx.ownerContext = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
    });
    ctx.ownerPage = await ctx.ownerContext.newPage();
    const email = uniqueEmail("resumen");
    await signUpAndVerify(ctx.ownerPage, email, "Dueña Resumen");
    ctx.tenantId = await createTenant(
      ctx.ownerPage,
      `Negocio Resumen ${randomUUID().slice(0, 6)}`,
      generateRut(),
    );
    ctx.token = await passwordToken(email);
    const patched = await rest(ctx.token, `tenants?tenant_id=eq.${ctx.tenantId}`, {
      method: "PATCH",
      headers: { ...header(), prefer: "return=representation" },
      body: { contact_email: `contacto-${randomUUID().slice(0, 6)}@ejemplo.test` },
    });
    expect(patched.status, patched.text).toBe(200);

    const catalogId = randomUUID();
    const catalog = await rest(ctx.token, "catalog_items", {
      method: "POST",
      headers: { ...header(), prefer: "return=minimal" },
      body: {
        id: catalogId,
        name: "Flete urbano",
        unit: "service",
        unit_price_clp: CATALOG_PRICE,
        tax_treatment: "taxable",
      },
    });
    expect(catalog.status, catalog.text).toBeLessThan(300);

    ctx.formId = randomUUID();
    ctx.catalogItemId = randomUUID();
    ctx.freeItemId = randomUUID();
    const created = await ok<{ public_id: string; revision: number }>(
      rpc(
        ctx.token,
        "create_intake_form",
        { p_form_id: ctx.formId, p_name: "Fletes resumen" },
        header(),
      ),
      "create_intake_form",
    );
    ctx.publicId = created.public_id;
    await ok(
      rpc(
        ctx.token,
        "save_intake_form",
        {
          p_form_id: ctx.formId,
          p_expected_revision: created.revision,
          p_form: {
            title: "Pide tu cotización de flete",
            intro: "Cuéntanos qué necesitas.",
            success_message: "¡Gracias! Te escribiremos hoy.",
            fields: {
              phone: "optional",
              company: "off",
              comuna: "off",
              serviceAddress: "off",
              desiredDate: "off",
              message: "optional",
            },
          },
          p_items: [
            {
              id: ctx.catalogItemId,
              kind: "catalog",
              catalog_item_id: catalogId,
              public_name: "Flete urbano",
              public_description: "Dentro de la Región Metropolitana",
              unit: "service",
              quantity_mode: "none",
            },
            {
              id: ctx.freeItemId,
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
    await ok(
      rpc(
        ctx.token,
        "set_intake_form_status",
        { p_form_id: ctx.formId, p_status: "published" },
        header(),
      ),
      "publicar",
    );
  });

  test.afterAll(async () => {
    await ctx.ownerContext?.close();
  });

  test("escritorio: el resumen cambia en vivo, sin peticiones por tecla, sin dinero y con el HTML como texto", async ({
    page,
  }) => {
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await openForm(page);
    const summary = summaryText(page);
    await expect(page.getByTestId("summary-aside")).toBeVisible();
    await expect(summary).toContainText("Aquí irá el resumen");
    await expect(page.getByTestId("summary-open")).toBeHidden();

    const requests: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith("data:")) requests.push(`${request.method()} ${request.url()}`);
    });

    await page.locator(`#pf-item-${ctx.freeItemId}`).check();
    await expect(summary).toContainText("Traslado por kilómetro");
    await page.locator(`#pf-qty-${ctx.freeItemId}`).fill("12,5");
    await expect(summary).toContainText("12,5 km");
    await page.locator(`#pf-qty-${ctx.freeItemId}`).fill("20");
    await expect(summary).toContainText("20 km");
    await expect(summary).not.toContainText("12,5 km");
    await page.locator(`#pf-item-${ctx.catalogItemId}`).check();
    await expect(summary).toContainText("Flete urbano");
    await page.locator("#pf-name").fill("Ana Prueba");
    await page.locator("#pf-email").fill("ana@cliente.test");
    await page.locator("#pf-message").fill(XSS_MESSAGE);
    await expect(summary).toContainText("Ana Prueba");
    await expect(summary).toContainText("ana@cliente.test");
    await expect(summary).toContainText("<script>alert(1)</script>");
    expect(await summary.locator("script, img").count()).toBe(0);
    await page.locator(`#pf-item-${ctx.catalogItemId}`).uncheck();
    await expect(summary).not.toContainText("Flete urbano");
    // Un campo que no se llena no aparece
    await expect(summary).not.toContainText("Teléfono");

    expect(requests, "ninguna petición mientras se escribe").toEqual([]);
    // Ningún monto: ni en el resumen ni en toda la página
    expect(await summary.innerText()).not.toMatch(/[$]|CLP|precio|total/i);
    const html = await page.content();
    expect(html).not.toContain("45.000");
    expect(html).not.toContain("45000");
    expect(html).not.toContain("unit_price");
    expect(dialogs).toEqual([]);
    // El borrador no se guarda en el navegador
    const stored = await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    }));
    expect(stored).toEqual({ local: 0, session: 0 });
    await expectNoHorizontalScroll(page);
  });

  test("teléfono: botón «Ver resumen (N)» abre una hoja y los campos conservan lo escrito", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    await openForm(page);
    await expect(page.getByTestId("summary-aside")).toBeHidden();
    const open = page.getByTestId("summary-open");
    await expect(open).toHaveText(/Ver resumen \(0\)/);

    await page.locator("#pf-name").fill("Ana Prueba");
    await page.locator(`#pf-item-${ctx.freeItemId}`).check();
    await page.locator(`#pf-qty-${ctx.freeItemId}`).fill("7");
    await page.locator("#pf-message").fill("Mensaje en el teléfono");
    await expect(open).toHaveText(/Ver resumen \(1\)/);
    await expectNoHorizontalScroll(page);

    await open.click();
    const sheet = page.getByTestId("summary-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("aria-labelledby", "summary-sheet-title");
    await expect(sheet).toContainText("Traslado por kilómetro");
    await expect(sheet).toContainText("7 km");
    await expect(sheet).toContainText("Ana Prueba");
    await expect(sheet).toContainText("Mensaje en el teléfono");
    expect(await sheet.innerText()).not.toMatch(/[$]/);
    await expectNoHorizontalScroll(page);

    // Escape cierra y el foco vuelve al botón
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(open).toBeFocused();
    await expect(page.locator("#pf-name")).toHaveValue("Ana Prueba");
    await expect(page.locator(`#pf-qty-${ctx.freeItemId}`)).toHaveValue("7");
    await expect(page.locator("#pf-message")).toHaveValue("Mensaje en el teléfono");
    await expect(page.locator(`#pf-item-${ctx.freeItemId}`)).toBeChecked();

    // También se cierra con la equis, y el resumen se actualiza al volver a abrirla
    await page.locator("#pf-email").fill("ana@cliente.test");
    await open.click();
    await expect(sheet).toContainText("ana@cliente.test");
    await page.getByTestId("summary-close").click();
    await expect(sheet).toBeHidden();
    await expectNoHorizontalScroll(page);
  });

  test("lo que ve el visitante es lo mismo que ve el equipo en la solicitud recibida", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openForm(page);
    await page.locator("#pf-name").fill("Beatriz Visitante");
    await page.locator("#pf-email").fill(`bea-${randomUUID().slice(0, 6)}@cliente.test`);
    await page.locator("#pf-phone").fill("+56 9 8765 4321");
    await page.locator("#pf-message").fill("Necesito un flete\nel viernes");
    await page.locator(`#pf-item-${ctx.freeItemId}`).check();
    await page.locator(`#pf-qty-${ctx.freeItemId}`).fill("12,5");
    await page.locator(`#pf-item-${ctx.catalogItemId}`).check();
    const seen = await summaryText(page).innerText();
    expect(seen).toContain("12,5 km");

    await page.locator("#pf-consent").check();
    await page.getByTestId("antibot-memory-pass").click();
    await page.getByTestId("submit-request").click();
    await expect(page.getByTestId("intake-success")).toBeVisible({ timeout: 30_000 });

    const db = await connect();
    let requestId: string;
    try {
      const { rows } = await db.query<{ id: string }>(
        "select id from public.intake_requests where form_id = $1 order by created_at desc limit 1",
        [ctx.formId],
      );
      requestId = rows[0].id;
    } finally {
      await db.end();
    }

    await ctx.ownerPage.goto(`/o/${ctx.tenantId}/solicitudes/${requestId}`);
    const team = ctx.ownerPage.getByTestId("request-items").getByTestId("request-summary-body");
    await expect(team).toBeVisible();
    expect(await team.innerText()).toBe(seen);
    expect(await ctx.ownerPage.getByTestId("request-items").innerText()).not.toMatch(/[$]/);
  });
});
