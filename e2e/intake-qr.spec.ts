import "../tests/support/stub-server-only"; // debe ir primero
import { randomUUID } from "node:crypto";
import jsQR from "jsqr";
import sharp from "sharp";
import { generateRut } from "../src/lib/chile/rut";
import { TENANT_HEADER } from "../src/lib/tenant/constants";
import { rpc } from "../tests/support/local-supabase";
import { expect, randomTestIp, test, type Page } from "./fixtures";
import { TEST_PASSWORD, createTenant, signUpAndVerify, uniqueEmail } from "./helpers";
import { addMember, newPerson, passwordToken, prepareOrgForForms } from "./intake-support";

// H-091: descargar el código QR del formulario público. Arma sus propias organizaciones por corrida
// («Ana» Dueña de A, «Carla» Comercial de A, «Beto» Dueño de B, con el catálogo de la semilla): no
// depende de `npm run db:seed`, que CI no corre. Deja sus formularios archivados al final. Todo ficticio.

const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1440, height: 900 };
const PUBLIC_ID = /[A-Za-z0-9_-]{22}/;

const created: { token: string; tenantId: string; formId: string }[] = [];

async function login(page: Page, email: string): Promise<string> {
  await page.goto("/ingresar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}/);
  return page.url().split("/o/")[1].split(/[/?#]/)[0];
}

async function dismissToasts(page: Page) {
  for (const button of await page.locator("[data-sonner-toast] [data-close-button]").all())
    await button.click({ force: true, timeout: 1_000 }).catch(() => undefined);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
}

/** Crea un formulario por pantalla, le agrega un servicio del catálogo y lo publica. */
async function createAndPublish(
  page: Page,
  tenantId: string,
  name: string,
  email: string,
): Promise<string> {
  await page.goto(`/o/${tenantId}/formularios/nuevo`);
  await page.getByLabel(/^Nombre interno/).fill(name);
  await page.getByRole("button", { name: "Crear formulario" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/formularios/[0-9a-f-]{36}$`));
  const formId = page.url().split("/formularios/")[1];
  created.push({ token: await passwordToken(email), tenantId, formId });
  await page.getByLabel("Agregar del catálogo").selectOption({ index: 1 });
  await page.getByTestId("add-from-catalog").click();
  await expect(page.getByTestId("form-item")).toHaveCount(1);
  await page.getByTestId("save-form").click();
  await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
  await dismissToasts(page);
  await page.getByTestId("publish-form").click();
  await expect(page.getByTestId("public-link")).toBeVisible();
  await dismissToasts(page);
  return formId;
}

async function publicIdOf(page: Page): Promise<string> {
  const link = (await page.getByTestId("public-link").innerText()).trim();
  const publicId = link.split("/f/")[1];
  expect(publicId).toMatch(PUBLIC_ID);
  return publicId;
}

async function decodePng(bytes: Buffer): Promise<string | null> {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
}

async function decodeSvg(svg: string): Promise<string | null> {
  const png = await sharp(Buffer.from(svg), { density: 600 })
    .flatten({ background: "#fff" })
    .png()
    .toBuffer();
  return decodePng(png);
}

const qrUrl = (tenantId: string, formId: string, query = "format=png") =>
  `/api/v1/tenants/${tenantId}/intake-forms/${formId}/qr?${query}`;

test.afterAll(async () => {
  for (const { token, tenantId, formId } of created) {
    await rpc(
      token,
      "set_intake_form_status",
      { p_form_id: formId, p_status: "archived" },
      { [TENANT_HEADER]: tenantId },
    );
  }
});

test("Ana descarga el QR en PNG y SVG; apunta a su formulario, sigue igual en pausa y cambia al regenerar; los demás no pueden", async ({
  page,
  browser,
}) => {
  test.setTimeout(480_000);
  const suffix = randomUUID().slice(0, 6);
  const name = `QR Camión ${suffix}`;
  const baseURL = test.info().project.use.baseURL as string;
  await page.setViewportSize(DESKTOP);

  // Ana crea su cuenta y la organización A; Carla es Comercial de A y Beto es Dueño de otra (B)
  const anaEmail = uniqueEmail("ana");
  await signUpAndVerify(page, anaEmail, "Ana Prueba");
  const tenantId = await createTenant(page, `Negocio QR ${suffix}`, generateRut());
  await prepareOrgForForms(anaEmail, tenantId);
  const carlaPerson = await newPerson(browser, "carla", "Carla Prueba");
  await carlaPerson.context.close();
  await addMember({ tenantId }, carlaPerson, "sales");
  const betoPerson = await newPerson(browser, "beto", "Beto Prueba");
  await prepareOrgForForms(
    betoPerson.email,
    await createTenant(betoPerson.page, `Negocio Otro ${suffix}`, generateRut()),
  );
  await betoPerson.context.close();

  const formId = await createAndPublish(page, tenantId, name, anaEmail);
  const publicId = await publicIdOf(page);
  const link = (await page.getByTestId("public-link").innerText()).trim();

  // --- Pantalla: vista previa, botones y notas ------------------------------------------------
  const section = page.getByTestId("qr-section");
  await expect(section.getByRole("link", { name: "Descargar QR (PNG)" })).toBeVisible();
  await expect(section.getByRole("link", { name: "Descargar QR (SVG)" })).toBeVisible();
  await expect(page.getByTestId("qr-regenerate-note")).toHaveText(
    "Si regeneras el enlace, los QR ya impresos dejan de servir.",
  );
  await expect(page.getByTestId("qr-pause-note")).toContainText(
    "quien escanee el QR verá que no está disponible",
  );
  const preview = page.getByTestId("qr-preview");
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  // el identificador solo aparece dentro del enlace
  expect((await page.locator("main").first().innerText()).split(publicId).length - 1).toBe(1);

  // --- La descarga por el botón ----------------------------------------------------------------
  const downloadPromise = page.waitForEvent("download");
  await section.getByRole("link", { name: "Descargar QR (PNG)" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`qr-qr-camion-${suffix}.png`);

  // --- PNG: cabeceras, tamaño y contenido ------------------------------------------------------
  const png = await page.request.get(qrUrl(tenantId, formId, "format=png"));
  expect(png.status()).toBe(200);
  expect(png.headers()["content-type"]).toBe("image/png");
  expect(png.headers()["content-disposition"]).toBe(
    `attachment; filename="qr-qr-camion-${suffix}.png"`,
  );
  expect(png.headers()["x-content-type-options"]).toBe("nosniff");
  expect(png.headers()["cache-control"]).toBe("private, no-store");
  const pngBytes = await png.body();
  expect((await sharp(pngBytes).metadata()).width).toBe(2048);
  expect(await decodePng(pngBytes)).toBe(`${new URL(baseURL).origin}/f/${publicId}`);
  expect(link).toBe(`${new URL(baseURL).origin}/f/${publicId}`);

  // --- SVG: solo svg, path y rect; decodifica a la misma dirección ----------------------------
  const svgRes = await page.request.get(qrUrl(tenantId, formId, "format=svg"));
  expect(svgRes.status()).toBe(200);
  expect(svgRes.headers()["content-type"]).toContain("image/svg+xml");
  expect(svgRes.headers()["content-disposition"]).toBe(
    `attachment; filename="qr-qr-camion-${suffix}.svg"`,
  );
  expect(svgRes.headers()["x-content-type-options"]).toBe("nosniff");
  expect(svgRes.headers()["cache-control"]).toBe("private, no-store");
  const csp = svgRes.headers()["content-security-policy"];
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("sandbox");
  const svg = await svgRes.text();
  const tags = [...svg.matchAll(/<\/?([a-zA-Z][\w:-]*)/g)].map((m) => m[1]);
  expect(new Set(tags)).toEqual(new Set(["svg", "rect", "path"]));
  expect(svg).not.toMatch(/<script|onload|href=|<style/i);
  expect(await decodeSvg(svg)).toBe(`${new URL(baseURL).origin}/f/${publicId}`);

  // --- Formato inválido -------------------------------------------------------------------------
  expect((await page.request.get(qrUrl(tenantId, formId, "format=exe"))).status()).toBe(400);
  expect((await page.request.get(qrUrl(tenantId, formId, ""))).status()).toBe(400);

  // --- Abrir esa dirección muestra el formulario -----------------------------------------------
  await page.goto(`/f/${publicId}`);
  await expect(page.getByTestId("form-view")).toBeVisible();

  // --- En pausa: el QR no cambia y la página dice «no disponible» ------------------------------
  await page.goto(`/o/${tenantId}/formularios/${formId}`);
  await page.getByTestId("pause-form").click();
  await expect(page.getByTestId("status-panel").getByText("En pausa").first()).toBeVisible();
  await expect(page.getByTestId("qr-section")).toBeVisible();
  const pausedPng = await page.request.get(qrUrl(tenantId, formId, "format=png"));
  expect(pausedPng.status()).toBe(200);
  expect(await decodePng(await pausedPng.body())).toBe(link);
  await page.goto(`/f/${publicId}`);
  await expect(page.getByTestId("intake-unavailable")).toBeVisible();
  await page.goto(`/o/${tenantId}/formularios/${formId}`);
  await dismissToasts(page);
  await page.getByTestId("resume-form").click();
  await expect(page.getByTestId("status-panel").getByText("Publicado")).toBeVisible();

  // --- 375 px: sin desplazamiento horizontal ---------------------------------------------------
  await page.setViewportSize(MOBILE);
  await page.goto(`/o/${tenantId}/formularios/${formId}`);
  await expect(page.getByTestId("qr-section")).toBeVisible();
  for (const url of [`/o/${tenantId}/formularios/${formId}`, `/o/${tenantId}/formularios`]) {
    await page.goto(url);
    await expect(page.getByTestId("qr-download-png").first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, url).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize(DESKTOP);
  await page.goto(`/o/${tenantId}/formularios`);
  await expect(page.getByTestId("qr-download-svg").first()).toBeVisible();

  // --- Carla (Comercial): sin botones y la ruta la rechaza -------------------------------------
  const carlaCtx = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
    viewport: DESKTOP,
  });
  const carla = await carlaCtx.newPage();
  const carlaTenant = await login(carla, carlaPerson.email);
  expect(carlaTenant).toBe(tenantId);
  await carla.goto(`/o/${tenantId}/formularios/${formId}`);
  await expect(carla.getByTestId("public-link")).toBeVisible();
  await expect(carla.getByTestId("qr-section")).toHaveCount(0);
  await carla.goto(`/o/${tenantId}/formularios`);
  await expect(carla.getByTestId("intake-form-row").first()).toBeVisible();
  await expect(carla.getByTestId("qr-section")).toHaveCount(0);
  for (const format of ["png", "svg"]) {
    const res = await carla.request.get(qrUrl(tenantId, formId, `format=${format}`));
    expect(res.status()).toBe(403);
    expect((await res.body()).length).toBe(0);
  }
  await carlaCtx.close();

  // --- Un formulario de B no se descarga desde A -----------------------------------------------
  const betoCtx = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
    viewport: DESKTOP,
  });
  const beto = await betoCtx.newPage();
  const tenantB = await login(beto, betoPerson.email);
  expect(tenantB).not.toBe(tenantId);
  const formB = await createAndPublish(beto, tenantB, `QR de B ${suffix}`, betoPerson.email);
  const publicIdB = await publicIdOf(beto);
  // Beto sí puede bajar el suyo
  const own = await beto.request.get(qrUrl(tenantB, formB, "format=png"));
  expect(own.status()).toBe(200);
  expect(await decodePng(await own.body())).toContain(`/f/${publicIdB}`);
  await betoCtx.close();

  // Ana, con su organización y el formulario de B: no existe; con la organización de B: no es miembro
  for (const url of [qrUrl(tenantId, formB), qrUrl(tenantB, formB), qrUrl(tenantB, formId)]) {
    const res = await page.request.get(url);
    expect(res.status(), url).toBe(404);
    const body = await res.text();
    expect(body, url).not.toContain(publicIdB);
  }
  // un identificador que no es un UUID tampoco revela nada
  expect((await page.request.get(qrUrl(tenantId, "no-es-un-uuid"))).status()).toBe(404);

  // --- Regenerar el enlace: el QR nuevo apunta al nuevo; el viejo ya no abre nada --------------
  await page.goto(`/o/${tenantId}/formularios/${formId}`);
  await page.getByTestId("regenerate-open").click();
  await page.getByTestId("regenerate-confirm").click();
  await expect
    .poll(async () => (await page.getByTestId("public-link").innerText()).trim())
    .not.toBe(link);
  const newPublicId = await publicIdOf(page);
  expect(newPublicId).not.toBe(publicId);
  const regenerated = await page.request.get(qrUrl(tenantId, formId, "format=png"));
  expect(await decodePng(await regenerated.body())).toBe(
    `${new URL(baseURL).origin}/f/${newPublicId}`,
  );
  await page.goto(`/f/${newPublicId}`);
  await expect(page.getByTestId("form-view")).toBeVisible();
  await page.goto(`/f/${publicId}`);
  await expect(page.getByTestId("intake-not-found")).toBeVisible();
});
