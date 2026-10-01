import { expect, test, type Page } from "@playwright/test";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-020: cargar servicios en el catálogo, de punta a punta.

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function addService(
  page: Page,
  service: { name: string; unit: string; price: string; tax: string; description?: string },
) {
  await page.getByLabel(/^Nombre/).fill(service.name);
  if (service.description)
    await page.getByLabel("Descripción (opcional)").fill(service.description);
  await page.getByLabel(/^Unidad/).selectOption(service.unit);
  await page.getByLabel("Precio neto (en pesos)").fill(service.price);
  await page.getByLabel(/^IVA/).selectOption(service.tax);
  await page.getByRole("button", { name: "Agregar al catálogo" }).click();
  await expect(page.getByText(`Agregaste "${service.name}" al catálogo.`)).toBeVisible();
}

test("cargar servicios en el catálogo y verlos con el precio bien formateado", async ({ page }) => {
  test.setTimeout(240_000);
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await signUpAndVerify(page, uniqueEmail("catalogo"), "Cata Ficticia");
  const tenantId = await createTenant(page, "Catálogo Ltda", "76.123.456-0");

  await page.getByRole("link", { name: "Catálogo" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/catalogo$`));
  await expect(page.getByText("Disponible pronto")).toHaveCount(0);

  // Estado vacío: explica qué es el catálogo y cómo agregar el primero
  await expect(page.getByRole("heading", { name: "Tu catálogo está vacío" })).toBeVisible();
  await expect(page.getByText("el equipo elige de aquí")).toBeVisible();

  // Precios inválidos se rechazan con un mensaje claro
  await page.getByLabel(/^Nombre/).fill("Prueba");
  await page.getByLabel("Precio neto (en pesos)").fill("1500,50");
  await page.getByRole("button", { name: "Agregar al catálogo" }).click();
  await expect(page.getByText("Usa pesos enteros, sin decimales.")).toBeVisible();
  await page.getByLabel("Precio neto (en pesos)").fill("-100");
  await page.getByRole("button", { name: "Agregar al catálogo" }).click();
  await expect(page.getByText("El precio no puede ser negativo.")).toBeVisible();

  await page.getByLabel(/^Nombre/).fill("");
  await addService(page, {
    name: "Flete Santiago",
    description: "Traslado dentro de la Región Metropolitana",
    unit: "service",
    price: "1250000",
    tax: "taxable",
  });
  await addService(page, {
    name: "Hora de técnico",
    unit: "hour",
    price: "18.000",
    tax: "taxable",
  });
  await addService(page, { name: "Asesoría exenta", unit: "day", price: "$95.500", tax: "exempt" });

  const items = page.getByTestId("catalog-item");
  await expect(items).toHaveCount(3);
  await expect(items.filter({ hasText: "Flete Santiago" })).toContainText("$1.250.000");
  await expect(items.filter({ hasText: "Hora de técnico" })).toContainText("$18.000");
  await expect(items.filter({ hasText: "Hora de técnico" })).toContainText("Hora");
  await expect(items.filter({ hasText: "Asesoría exenta" })).toContainText("$95.500");
  await expect(items.filter({ hasText: "Asesoría exenta" })).toContainText("Exento de IVA");

  // Buscador por nombre
  await page.getByLabel("Buscar por nombre").fill("flet");
  await page.getByLabel("Buscar por nombre").press("Enter");
  await expect(page).toHaveURL(/q=flet/);
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Flete Santiago");
  await page.getByLabel("Buscar por nombre").fill("zzz");
  await page.getByLabel("Buscar por nombre").press("Enter");
  await expect(page.getByText("No hay servicios que coincidan")).toBeVisible();

  // Teléfono, claro y oscuro: sin desplazamiento horizontal
  await page.goto(`/o/${tenantId}/catalogo`);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(items).toHaveCount(3);
  await expectNoHorizontalScroll(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(items).toHaveCount(3);
  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoHorizontalScroll(page);

  expect(consoleErrors).toEqual([]);
});
