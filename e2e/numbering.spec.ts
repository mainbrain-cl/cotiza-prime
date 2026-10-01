import { expect, test } from "@playwright/test";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-024 · Configurar la numeración de las cotizaciones, de punta a punta.

test("configurar prefijo, formato y partida; ver la vista previa; no poder bajar el número", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 375, height: 812 });

  await signUpAndVerify(page, uniqueEmail("numeracion"), "Nora Ficticia");
  const tenantId = await createTenant(page, "Numeración Ficticia SpA", "76.123.456-0");

  // Desde Configuración se llega a Numeración
  await page.goto(`/o/${tenantId}/configuracion`);
  await page.getByRole("link", { name: /Numeración/ }).click();
  await expect(page).toHaveURL(/\/configuracion\/numeracion$/);

  const preview = page.getByTestId("numbering-preview");
  // Valores por defecto de una organización nueva
  await expect(preview).toHaveText(/^COT-\d{4}-0001$/);

  // Sin desplazamiento horizontal en el teléfono
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Prefijo y partida: la vista previa se actualiza sola
  await page.getByLabel("Prefijo").fill("ppto");
  await page.getByLabel("Número de la próxima cotización").fill("2001");
  await expect(preview).toHaveText(/^PPTO-\d{4}-2001$/);

  // Formato corrido: sin año
  await page.getByRole("radio", { name: /Corrido/ }).check();
  await expect(preview).toHaveText("PPTO-2001");

  // Prefijo inválido: mensaje claro
  await page.getByLabel("Prefijo").fill("PP TO");
  await expect(page.getByText(/El prefijo debe tener de 1 a 8 letras o números/)).toBeVisible();
  await page.getByLabel("Prefijo").fill("PPTO");
  await expect(preview).toHaveText("PPTO-2001");

  // Guardar
  await page.getByRole("button", { name: "Guardar numeración" }).click();
  await expect(page.getByTestId("numbering-saved")).toContainText(
    "La próxima cotización será PPTO-2001",
  );

  // Al recargar queda guardado
  await page.reload();
  await expect(page.getByLabel("Prefijo")).toHaveValue("PPTO");
  await expect(page.getByLabel("Número de la próxima cotización")).toHaveValue("2001");
  await expect(preview).toHaveText("PPTO-2001");

  // Bajar el número: el error aparece al escribir y también al intentar guardar
  await page.getByLabel("Número de la próxima cotización").fill("5");
  await expect(page.getByText("El próximo número no puede ser menor que 2001.")).toBeVisible();
  await expect(preview).toContainText("Corrige los datos");
  await page.getByRole("button", { name: "Guardar numeración" }).click();
  await expect(page.getByText("El próximo número no puede ser menor que 2001.")).toBeVisible();
  await expect(page.getByTestId("numbering-saved")).toHaveCount(0);

  // Subirlo sí se puede
  await page.getByLabel("Número de la próxima cotización").fill("2050");
  await expect(preview).toHaveText("PPTO-2050");
  await page.getByRole("button", { name: "Guardar numeración" }).click();
  await expect(page.getByTestId("numbering-saved")).toContainText("PPTO-2050");

  // Escritorio
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("heading", { name: "Numeración de cotizaciones" })).toBeVisible();
});
