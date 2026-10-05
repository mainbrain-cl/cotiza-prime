import { expect, test } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-007 · Cargar el logo y los colores de mi empresa, de punta a punta.

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const MALICIOUS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert('xss')">
  <script>alert('xss')</script>
  <rect width="10" height="10" fill="#2b54e0" onclick="alert(1)"/>
</svg>`;

test("subir logo y colores, ver la muestra, la advertencia de contraste y el logo en el selector", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 375, height: 812 });

  await signUpAndVerify(page, uniqueEmail("marca"), "Marta Ficticia");
  const tenantId = await createTenant(page, "Marca Ficticia SpA", "76.123.456-0");

  // Desde Configuración se llega a Marca y a Empresa
  await page.goto(`/o/${tenantId}/configuracion`);
  await expect(page.getByRole("link", { name: /^Empresa/ })).toBeVisible();
  await page.getByRole("link", { name: /^Marca/ }).click();
  await expect(page).toHaveURL(/\/configuracion\/marca$/);
  await expect(page.getByTestId("tenant-logo")).toHaveCount(0); // todavía hay iniciales

  // Sin desplazamiento horizontal en el teléfono
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  const fileInput = page.getByLabel("Archivo del logo");
  await expect(page.getByText("PNG, JPG o SVG, de hasta 1 MB.")).toBeVisible();

  // Un archivo que dice ser PNG pero es otra cosa: se rechaza por su contenido, no por su nombre
  await fileInput.setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: Buffer.from("<html><body>no soy una imagen</body></html>"),
  });
  await page.getByRole("button", { name: "Guardar marca" }).click();
  await expect(page.getByText("El archivo no es una imagen PNG, JPG o SVG válida.")).toBeVisible();

  // Un archivo que pesa demasiado: se avisa al elegirlo, diciendo cuál es el máximo
  await fileInput.setInputFiles({
    name: "enorme.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(1_048_576 + 10, 1),
  });
  await expect(page.getByText("El archivo pesa demasiado. El máximo es 1 MB.")).toBeVisible();

  // Colores: la muestra cambia al instante
  const primary = page.locator('input[name="primaryColor"]');
  const secondary = page.locator('input[name="secondaryColor"]');
  await primary.fill("#ffeb3b");
  await expect(page.getByTestId("brand-sample-bar")).toHaveCSS(
    "background-color",
    "rgb(255, 235, 59)",
  );
  await expect(page.getByTestId("brand-sample-button")).toHaveCSS(
    "background-color",
    "rgb(255, 235, 59)",
  );
  // y un amarillo no se lee sobre blanco: advertencia
  await expect(page.getByTestId("contrast-warning-primary")).toContainText(
    "se lee con dificultad sobre blanco",
  );
  await expect(page.getByTestId("contrast-warning-secondary")).toHaveCount(0);
  await secondary.fill("#cccccc");
  await expect(page.getByTestId("contrast-warning-secondary")).toBeVisible();

  // Formato inválido: aviso en el campo
  await primary.fill("azul");
  await expect(page.getByText("Usa el formato #2B54E0.")).toBeVisible();

  // Colores oscuros: sin advertencia
  await primary.fill("#0b2a6f");
  await secondary.fill("#1b6b3a");
  await expect(page.getByTestId("contrast-warning-primary")).toHaveCount(0);
  await expect(page.getByTestId("contrast-warning-secondary")).toHaveCount(0);
  await expect(page.getByTestId("brand-sample-total")).toHaveCSS("color", "rgb(27, 107, 58)");

  // Un SVG con código dentro: se acepta (limpio) y se guarda
  await fileInput.setInputFiles({
    name: "logo.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(MALICIOUS_SVG),
  });
  await expect(page.getByTestId("brand-logo-preview").locator("img")).toBeVisible();
  await page.getByRole("button", { name: "Guardar marca" }).click();
  await expect(page.getByText("Guardamos la marca de tu empresa.")).toBeVisible();

  // El logo guardado se entrega por el servidor, ya limpio y con cabeceras que lo encierran
  const logoUrl = await page.getByTestId("brand-logo-preview").locator("img").getAttribute("src");
  expect(logoUrl).toMatch(new RegExp(`^/api/v1/tenants/${tenantId}/logo\\?v=[0-9a-f]{12}$`));
  const logoResponse = await page.request.get(logoUrl!);
  expect(logoResponse.status()).toBe(200);
  expect(logoResponse.headers()["content-type"]).toBe("image/svg+xml");
  expect(logoResponse.headers()["x-content-type-options"]).toBe("nosniff");
  expect(logoResponse.headers()["content-security-policy"]).toContain("sandbox");
  const body = await logoResponse.text();
  expect(body).toContain("<rect");
  expect(body).not.toMatch(/script|onload|onclick|alert/i);

  // El logo aparece en el selector de organización, y lo guardado sobrevive a recargar
  await page.reload();
  await expect(page.getByTestId("tenant-logo").first()).toBeVisible();
  await expect(page.locator('input[name="primaryColor"]')).toHaveValue("#0b2a6f");
  await expect(page.locator('input[name="secondaryColor"]')).toHaveValue("#1b6b3a");

  // Reemplazar por un PNG: el logo cambia y se puede quitar
  await page.getByLabel("Archivo del logo").setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: PNG_1X1,
  });
  await page.getByRole("button", { name: "Guardar marca" }).click();
  await expect(page.getByText("Guardamos la marca de tu empresa.")).toBeVisible();
  const pngUrl = await page.getByTestId("brand-logo-preview").locator("img").getAttribute("src");
  expect(pngUrl).not.toBe(logoUrl);
  const pngResponse = await page.request.get(pngUrl!);
  expect(pngResponse.headers()["content-type"]).toBe("image/png");
  expect((await page.request.get(logoUrl!)).status()).toBe(200); // la dirección vieja sirve el logo vigente

  await page.getByLabel("Quitar el logo actual").check();
  await page.getByRole("button", { name: "Guardar marca" }).click();
  await expect(page.getByText("Guardamos la marca de tu empresa.")).toBeVisible();
  await expect(page.getByTestId("brand-logo-preview")).toContainText("Sin logo");
  await expect(page.getByTestId("tenant-logo")).toHaveCount(0);
  expect((await page.request.get(`/api/v1/tenants/${tenantId}/logo`)).status()).toBe(404);
});

test("editar los datos de la empresa", async ({ page }) => {
  test.setTimeout(180_000);
  await signUpAndVerify(page, uniqueEmail("empresa"), "Emilia Ficticia");
  const tenantId = await createTenant(page, "Empresa Vieja SpA", "76.123.456-0");

  await page.goto(`/o/${tenantId}/configuracion/empresa`);
  await expect(page.getByLabel("Nombre de la empresa")).toHaveValue("Empresa Vieja SpA");
  await expect(page.getByLabel("RUT de la empresa")).toHaveValue("76.123.456-0");

  // RUT con dígito verificador malo
  await page.getByLabel("RUT de la empresa").fill("76.123.456-9");
  await page.getByLabel("Nombre de la empresa").click();
  await expect(page.getByText("El RUT no es válido.")).toBeVisible();

  await page.getByLabel("Nombre de la empresa").fill("Empresa Nueva SpA");
  await page.getByLabel("RUT de la empresa").fill("76086428-5");
  await page.getByLabel("Correo de contacto (opcional)").fill("contacto@ejemplo.test");
  await page.getByLabel("Teléfono de contacto (opcional)").fill("+56 9 1234 5678");
  await page.getByRole("button", { name: "Guardar datos" }).click();
  await expect(page.getByText("Guardamos los datos de tu empresa.")).toBeVisible();

  // Sobrevive a recargar, y el nombre nuevo llega al selector
  await page.reload();
  await expect(page.getByLabel("Nombre de la empresa")).toHaveValue("Empresa Nueva SpA");
  await expect(page.getByLabel("RUT de la empresa")).toHaveValue("76.086.428-5");
  await expect(page.getByLabel("Correo de contacto (opcional)")).toHaveValue(
    "contacto@ejemplo.test",
  );
  await expect(page.getByTestId("tenant-switcher").first()).toContainText("Empresa Nueva SpA");
});
