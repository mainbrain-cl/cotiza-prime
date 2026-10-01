import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import { expect, randomTestIp, test } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-021: editar, desactivar y reactivar un servicio, de punta a punta.

test("editar el precio, desactivar y reactivar un servicio; un Observador no ve la edición", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await signUpAndVerify(page, uniqueEmail("editar"), "Edita Ficticia");
  const tenantId = await createTenant(page, "Edición Ltda", generateRut());
  await page.goto(`/o/${tenantId}/catalogo`);

  // Dos servicios para ver cómo el filtro separa activos de inactivos
  for (const [name, price] of [
    ["Flete Maipú", "10000"],
    ["Hora de grúa", "30000"],
  ]) {
    await page.getByLabel(/^Nombre/).fill(name);
    await page.getByLabel("Precio neto (en pesos)").fill(price);
    await page.getByRole("button", { name: "Agregar al catálogo" }).click();
    await expect(page.getByText(`Agregaste "${name}" al catálogo.`)).toBeVisible();
  }
  const items = page.getByTestId("catalog-item");
  await expect(items).toHaveCount(2);

  // Editar el precio y la unidad
  await page.getByRole("link", { name: "Flete Maipú" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/catalogo/[0-9a-f-]{36}$`));
  const itemUrl = page.url();
  await page.getByLabel("Precio neto (en pesos)").fill("12.500");
  await page.getByLabel(/^Unidad/).selectOption("km");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Guardamos los cambios del servicio.")).toBeVisible();

  // Un precio inválido se rechaza con un mensaje claro
  await page.getByLabel("Precio neto (en pesos)").fill("12,5");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Usa pesos enteros, sin decimales.")).toBeVisible();

  await page.getByRole("link", { name: "Catálogo", exact: true }).first().click();
  await expect(items.filter({ hasText: "Flete Maipú" })).toContainText("$12.500");
  await expect(items.filter({ hasText: "Flete Maipú" })).toContainText("Kilómetro");

  // Desactivar: desaparece de "Activos", aparece en "Inactivos" y no se borra
  await page.goto(itemUrl);
  await page.getByRole("button", { name: "Desactivar servicio" }).click();
  await expect(page.getByText("Desactivaste el servicio")).toBeVisible();
  await expect(page.getByTestId("inactive-notice")).toBeVisible();

  await page.goto(`/o/${tenantId}/catalogo`);
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Hora de grúa");
  await page.getByRole("link", { name: "Inactivos" }).click();
  await expect(page).toHaveURL(/estado=inactivos/);
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Flete Maipú");
  await expect(items.first()).toContainText("Desactivado");
  await page.getByRole("link", { name: "Todos" }).click();
  await expect(items).toHaveCount(2);

  // Un Observador de la misma organización ve el servicio, pero no puede editarlo
  const viewerEmail = uniqueEmail("observador");
  const viewerContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  const viewerPage = await viewerContext.newPage();
  try {
    await signUpAndVerify(viewerPage, viewerEmail, "Observa Ficticio");
    const db = await connect();
    try {
      await db.query(
        `insert into public.members (tenant_id, user_id, role)
         select $1, id, 'viewer' from auth.users where email = $2`,
        [tenantId, viewerEmail],
      );
    } finally {
      await db.end();
    }
    await viewerPage.goto(`/o/${tenantId}/catalogo?estado=todos`);
    await expect(viewerPage.getByTestId("catalog-item")).toHaveCount(2);
    await expect(viewerPage.getByRole("button", { name: "Agregar al catálogo" })).toHaveCount(0);
    await viewerPage.goto(itemUrl);
    await expect(viewerPage.getByRole("heading", { name: "Flete Maipú" })).toBeVisible();
    await expect(viewerPage.getByRole("button", { name: "Guardar cambios" })).toHaveCount(0);
    await expect(viewerPage.getByRole("button", { name: /servicio$/ })).toHaveCount(0);
    await expect(viewerPage.getByText("$12.500")).toBeVisible();
  } finally {
    await viewerContext.close();
  }

  // Reactivar
  await page.goto(itemUrl);
  await page.getByRole("button", { name: "Reactivar servicio" }).click();
  await expect(page.getByText("Reactivaste el servicio")).toBeVisible();
  await page.goto(`/o/${tenantId}/catalogo`);
  await expect(items).toHaveCount(2);

  // Teléfono: sin desplazamiento horizontal
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(itemUrl);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  expect(consoleErrors).toEqual([]);
});
