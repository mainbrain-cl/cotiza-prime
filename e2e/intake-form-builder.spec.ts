import "../tests/support/stub-server-only"; // debe ir primero
import { randomUUID } from "node:crypto";
import { TENANT_HEADER } from "../src/lib/tenant/constants";
import { localEnv, rpc } from "../tests/support/local-supabase";
import { expect, randomTestIp, test, type Page } from "./fixtures";

// H-086: crear mi formulario público (el constructor). Usa las cuentas de la semilla local
// (`ana` es Dueña y `carla` es Comercial de Negocio Demo 1) y deja sus formularios archivados al final.
// La página pública, el envío y el QR son otras historias y no se prueban aquí.

const SEED_PASSWORD = "Prueba-Cotiza-2026";
const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1440, height: 900 };
/** Precios de la semilla: ninguno puede aparecer en el constructor. */
const SEED_PRICES = ["45.000", "280.000", "1.200", "18.000", "6.500", "45000", "280000"];

async function login(page: Page, email: string): Promise<string> {
  await page.goto("/ingresar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(SEED_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}/);
  return page.url().split("/o/")[1].split(/[/?#]/)[0];
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Cierra los avisos para que no tapen lo siguiente (un aviso que ya se va puede perder el clic: no importa). */
async function dismissToasts(page: Page) {
  for (const button of await page.locator("[data-sonner-toast] [data-close-button]").all())
    await button.click({ force: true, timeout: 1_000 }).catch(() => undefined);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
}

/** Un aviso sale arriba de la pantalla y trae el texto esperado. */
async function expectToast(page: Page, text: string | RegExp) {
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: text });
  await expect(toast).toBeVisible();
  const box = await toast.boundingBox();
  expect(box, "el aviso debe tener posición").not.toBeNull();
  expect(box!.y, "los avisos salen arriba").toBeLessThan(DESKTOP.height / 3);
  await dismissToasts(page);
}

async function expectNoPrices(page: Page) {
  const text = await page.locator("main").first().innerText();
  expect(text, "el editor no lleva el signo $").not.toContain("$");
  const html = await page.content();
  for (const price of SEED_PRICES) {
    expect(text, `precio ${price} en pantalla`).not.toContain(price);
  }
  expect(html).not.toContain("unit_price");
}

async function createForm(page: Page, tenantId: string, name: string): Promise<string> {
  await page.goto(`/o/${tenantId}/formularios`);
  await page.getByTestId("new-form").first().click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/formularios/nuevo$`));
  await page.getByLabel(/^Nombre interno/).fill(name);
  await page.getByRole("button", { name: "Crear formulario" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/formularios/[0-9a-f-]{36}$`));
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return page.url().split("/formularios/")[1];
}

async function passwordToken(email: string): Promise<string> {
  const { apiUrl, publishableKey } = localEnv();
  const res = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password: SEED_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

test("Ana arma, publica, pausa y regenera su formulario; Carla (Comercial) solo mira", async ({
  page,
  browser,
}) => {
  test.setTimeout(480_000);
  const suffix = randomUUID().slice(0, 6);
  const nameOne = `Fletes web ${suffix}`;
  const nameTwo = `Mudanzas web ${suffix}`;
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.setViewportSize(DESKTOP);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  // --- Ana entra y llega a Formularios desde el menú ------------------------------------------
  const tenantId = await login(page, "ana@ejemplo.test");
  await page.getByRole("link", { name: "Formularios" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/formularios$`));
  await expect(page.getByRole("heading", { level: 1, name: "Formularios" })).toBeVisible();

  // --- Crear, y configurar datos ---------------------------------------------------------------
  const formId = await createForm(page, tenantId, nameOne);
  await expect(page.getByTestId("status-panel").getByText("Borrador")).toBeVisible();
  // Guardar no sirve sin cambios
  await expect(page.getByTestId("save-form")).toBeDisabled();

  await page.getByLabel("Título del formulario").fill("Pide tu cotización de flete");
  await page
    .getByLabel("Introducción (opcional)")
    .fill("Cuéntanos qué necesitas y te respondemos hoy.");
  const fields = page.getByTestId("section-fields");
  await fields.getByLabel("Teléfono").selectOption("required");
  await fields.getByLabel("Empresa").selectOption("optional");
  await fields.getByLabel("Mensaje").selectOption("off");

  // El RUT no se puede pedir y se explica por qué (minimización)
  await expect(page.getByTestId("rut-note")).toContainText("No se pueden pedir");
  await expect(page.getByTestId("rut-note")).toContainText("Ley 21.719");
  await expect(fields.getByLabel("RUT")).toHaveCount(0);

  // --- Sin servicios no se puede publicar; la pantalla explica qué falta ----------------------
  await page.getByTestId("save-form").click();
  await expectToast(page, "Guardamos los cambios del formulario.");
  await expect(page.getByTestId("publish-checklist")).toContainText("Agregar al menos un servicio");
  await page.getByTestId("publish-form").click();
  await expect(page.getByRole("alert").filter({ hasText: "al menos un servicio" })).toBeVisible();
  await expect(page.getByTestId("status-panel").getByText("Borrador")).toBeVisible();

  // --- Dos servicios del catálogo, sin precio -------------------------------------------------
  await page.getByLabel("Agregar del catálogo").selectOption({ label: "Flete urbano" });
  await page.getByTestId("add-from-catalog").click();
  await page.getByLabel("Agregar del catálogo").selectOption({ label: "Mudanza completa" });
  await page.getByTestId("add-from-catalog").click();
  const items = page.getByTestId("form-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).getByLabel("Nombre que verá la persona")).toHaveValue("Flete urbano");
  await expect(items.nth(1).getByLabel("Unidad")).toHaveValue("day");
  await expectNoPrices(page);

  // Editables: descripción y orden
  await items.nth(0).getByLabel("Descripción (opcional)").fill("Dentro de la Región Metropolitana");
  await page.getByRole("button", { name: "Subir Mudanza completa" }).click();
  await expect(items.nth(0).getByLabel("Nombre que verá la persona")).toHaveValue(
    "Mudanza completa",
  );
  await page.getByRole("button", { name: "Bajar Mudanza completa" }).click();
  await expect(items.nth(0).getByLabel("Nombre que verá la persona")).toHaveValue("Flete urbano");

  // Un servicio libre se agrega y se quita
  await page.getByTestId("add-free-item").click();
  await expect(items).toHaveCount(3);
  await page.getByRole("button", { name: "Quitar servicio" }).click();
  await expect(items).toHaveCount(2);

  // --- Vista previa con la marca de la organización -------------------------------------------
  const preview = page.getByTestId("form-view");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Negocio Demo 1");
  await expect(preview).toContainText("Pide tu cotización de flete");
  await expect(preview).toContainText("Cuéntanos qué necesitas");
  await expect(preview).toContainText("Flete urbano");
  await expect(preview).toContainText("Dentro de la Región Metropolitana");
  await expect(preview).toContainText("Teléfono");
  await expect(preview).toContainText("Tus datos los recibirá Negocio Demo 1");
  await expect(preview.getByText("Mensaje")).toHaveCount(0);
  await expect(preview).toHaveClass(/customer-light/);
  const brandColor = await preview.evaluate((el) =>
    getComputedStyle(el).getPropertyValue("--brand").trim(),
  );
  expect(brandColor).toMatch(/^#[0-9a-f]{6}$/i);
  // inerte: no se puede escribir ni enviar
  await expect(preview.locator("form")).toHaveAttribute("inert", "");

  // --- Guardar y publicar ----------------------------------------------------------------------
  await expect(page.getByTestId("publish-form")).toBeDisabled(); // hay cambios sin guardar
  await page.getByTestId("save-form").click();
  await expectToast(page, "Guardamos los cambios del formulario.");
  await page.getByTestId("publish-form").click();
  await expectToast(page, "Publicamos el formulario.");
  const panel = page.getByTestId("status-panel");
  await expect(panel.getByText("Publicado", { exact: true })).toBeVisible();
  const link = (await page.getByTestId("public-link").innerText()).trim();
  expect(link).toMatch(new RegExp(`^http://localhost:\\d+/f/[A-Za-z0-9_-]{22}$`));
  // la página pública ya existe (H-087): ya no hay nota de «todavía no disponible»
  await expect(page.getByTestId("link-not-ready")).toHaveCount(0);
  await panel.getByRole("button", { name: "Copiar enlace" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await dismissToasts(page);
  // el identificador solo aparece dentro del enlace
  const publicId = link.split("/f/")[1];
  expect((await page.locator("main").first().innerText()).split(publicId).length - 1).toBe(1);

  // Lo guardado sigue ahí tras recargar
  await page.reload();
  await expect(page.getByLabel("Título del formulario")).toHaveValue("Pide tu cotización de flete");
  await expect(page.getByTestId("form-item")).toHaveCount(2);
  await expect(page.getByTestId("section-fields").getByLabel("Teléfono")).toHaveValue("required");
  await expectNoPrices(page);

  // --- Pausar y reanudar -----------------------------------------------------------------------
  await page.getByTestId("pause-form").click();
  await expectToast(page, "Pausamos el formulario");
  await expect(page.getByTestId("status-panel").getByText("En pausa").first()).toBeVisible();
  await page.getByTestId("resume-form").click();
  await expectToast(page, "Reanudamos el formulario.");
  await expect(page.getByTestId("status-panel").getByText("Publicado")).toBeVisible();

  // --- Cambio de otra persona: avisa sin perder lo escrito ------------------------------------
  const other = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
    viewport: DESKTOP,
  });
  const otherPage = await other.newPage();
  await login(otherPage, "ana@ejemplo.test");
  await otherPage.goto(`/o/${tenantId}/formularios/${formId}`);
  await otherPage.getByLabel("Título del formulario").fill("Otro título guardado antes");
  await otherPage.getByTestId("save-form").click();
  await expectToast(otherPage, "Guardamos los cambios del formulario.");
  await other.close();

  await page.getByLabel("Título del formulario").fill("Mi título sin perder");
  await page.getByTestId("save-form").click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Otra persona guardó cambios" }),
  ).toBeVisible();
  await expect(page.getByLabel("Título del formulario")).toHaveValue("Mi título sin perder");
  await page.reload();
  await expect(page.getByLabel("Título del formulario")).toHaveValue("Otro título guardado antes");

  // --- Regenerar el enlace, con confirmación que advierte --------------------------------------
  await page.getByTestId("regenerate-open").click();
  const dialog = page.getByTestId("regenerate-dialog");
  await expect(dialog).toContainText("códigos QR impresos");
  await expect(dialog).toContainText("dejará de funcionar");
  await page.getByTestId("regenerate-cancel").click();
  await expect(dialog).toHaveCount(0);
  expect((await page.getByTestId("public-link").innerText()).trim()).toBe(link);

  await page.getByTestId("regenerate-open").click();
  await page.getByTestId("regenerate-confirm").click();
  await expectToast(page, "Creamos un enlace nuevo.");
  await expect
    .poll(async () => (await page.getByTestId("public-link").innerText()).trim())
    .not.toBe(link);
  expect((await page.getByTestId("public-link").innerText()).trim()).toMatch(
    /\/f\/[A-Za-z0-9_-]{22}$/,
  );

  // --- La lista: estado, solicitudes y enlace copiable -----------------------------------------
  await page.goto(`/o/${tenantId}/formularios`);
  const row = page.getByTestId("intake-form-row").filter({ hasText: nameOne });
  await expect(row).toBeVisible();
  await expect(row.getByText("Publicado")).toBeVisible();
  await expect(row).toContainText("Sin solicitudes");
  await expect(row.getByTestId("row-public-link")).toContainText("/f/");

  // --- Un segundo formulario -------------------------------------------------------------------
  const secondId = await createForm(page, tenantId, nameTwo);
  expect(secondId).not.toBe(formId);
  await page.goto(`/o/${tenantId}/formularios`);
  await expect(page.getByTestId("intake-form-row").filter({ hasText: nameTwo })).toBeVisible();
  await expect(page.getByTestId("intake-form-row").filter({ hasText: nameOne })).toBeVisible();

  // --- 375 px: sin desplazamiento horizontal, lista en tarjetas y editor usable ---------------
  await page.setViewportSize(MOBILE);
  await page.goto(`/o/${tenantId}/formularios`);
  await expectNoHorizontalScroll(page);
  await page.goto(`/o/${tenantId}/formularios/${formId}`);
  await expect(page.getByTestId("form-view")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.goto(`/o/${tenantId}/formularios/nuevo`);
  await expectNoHorizontalScroll(page);
  await page.setViewportSize(DESKTOP);

  // --- Carla (Comercial) ve la lista en solo lectura --------------------------------------------
  const carlaContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
    viewport: DESKTOP,
  });
  const carla = await carlaContext.newPage();
  const carlaTenant = await login(carla, "carla@ejemplo.test");
  expect(carlaTenant).toBe(tenantId);
  await carla.goto(`/o/${tenantId}/formularios`);
  await expect(carla.getByTestId("intake-form-row").filter({ hasText: nameOne })).toBeVisible();
  await expect(carla.getByTestId("new-form")).toHaveCount(0);
  await expect(carla.getByRole("link", { name: "Crear formulario" })).toHaveCount(0);
  await carla.goto(`/o/${tenantId}/formularios/${formId}`);
  await expect(
    carla.getByText("solo el Dueño y los Administradores pueden cambiarlo"),
  ).toBeVisible();
  for (const name of [
    /Guardar/,
    /Publicar/,
    /Pausar/,
    /Reanudar/,
    /Archivar/,
    /Crear enlace nuevo/,
  ]) {
    await expect(carla.getByRole("button", { name })).toHaveCount(0);
  }
  await expect(carla.getByLabel("Título del formulario")).toBeDisabled();
  await expect(carla.getByTestId("form-view")).toBeVisible();
  await expectNoPrices(carla);
  // crear formularios no está a su alcance: la pantalla no existe para ella
  await carla.goto(`/o/${tenantId}/formularios/nuevo`);
  await expect(carla.getByRole("heading", { name: "No encontrado" })).toBeVisible();
  await expect(carla.getByLabel(/^Nombre interno/)).toHaveCount(0);

  // y el servidor rechaza su intento directo, sin pasar por la pantalla
  const carlaToken = await passwordToken("carla@ejemplo.test");
  const header = { [TENANT_HEADER]: tenantId };
  const attempts: [string, object][] = [
    ["create_intake_form", { p_form_id: randomUUID(), p_name: "Intento de Carla" }],
    ["set_intake_form_status", { p_form_id: formId, p_status: "paused" }],
    ["regenerate_intake_form_public_id", { p_form_id: formId }],
    [
      "save_intake_form",
      { p_form_id: formId, p_expected_revision: 1, p_form: { title: "Intento" }, p_items: null },
    ],
  ];
  for (const [name, args] of attempts) {
    const res = await rpc(carlaToken, name, args, header);
    expect(res.status, name).toBeGreaterThanOrEqual(400);
    expect((res.json as { code?: string } | null)?.code, name).toBe("42501");
  }
  await carlaContext.close();

  // --- Limpieza: los dos formularios de prueba se archivan -------------------------------------
  for (const id of [formId, secondId]) {
    await page.goto(`/o/${tenantId}/formularios/${id}`);
    await page.getByTestId("archive-open").click();
    await page.getByTestId("archive-confirm").click();
    await expectToast(page, "Archivamos el formulario.");
    await expect(page.getByTestId("status-panel").getByText("Archivado")).toBeVisible();
    await expect(page.getByTestId("save-form")).toHaveCount(0);
  }
  await page.goto(`/o/${tenantId}/formularios`);
  await expect(page.getByTestId("intake-form-row").filter({ hasText: nameOne })).toHaveCount(0);
  await page.goto(`/o/${tenantId}/formularios?estado=archivados`);
  await expect(page.getByTestId("intake-form-row").filter({ hasText: nameOne })).toBeVisible();

  expect(consoleErrors).toEqual([]);
});
