import { expect, test } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// Estados de los formularios (DISENO.md, "Los cuatro estados"): sin conexión. Y pie legal (H-110).

test("los formularios avisan cuando no hay conexión", async ({ page, context }) => {
  await page.goto("/ingresar");
  await expect(page.getByTestId("offline-notice")).toHaveCount(0);

  await context.setOffline(true);
  await expect(page.getByTestId("offline-notice")).toBeVisible();
  await expect(page.getByTestId("offline-notice")).toContainText("Sin conexión");

  await context.setOffline(false);
  await expect(page.getByTestId("offline-notice")).toHaveCount(0);
});

// Antes, enviar sin red lanzaba un error sin atrapar: la pantalla se reemplazaba por un error y se perdía lo
// escrito. Ahora el botón no envía, avisa con un aviso breve y todo queda donde estaba.
const OFFLINE_TOAST = "[data-sonner-toast]";

test("sin conexión, el ingreso no envía, avisa y conserva lo escrito; al volver la red funciona", async ({
  page,
  context,
}) => {
  await page.goto("/ingresar");
  // Un correo distinto en cada corrida: las credenciales son falsas y el límite de intentos del ingreso las cuenta.
  const email = uniqueEmail("sin-red-ingreso");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill("clave-cualquiera-123");
  // Cada llamada a una acción del servidor lleva la cabecera `next-action`: sin red no debe salir ninguna.
  const serverActionCalls: string[] = [];
  page.on("request", (request) => {
    if (request.headers()["next-action"]) serverActionCalls.push(request.url());
  });

  await context.setOffline(true);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.locator(OFFLINE_TOAST).filter({ hasText: "Sin conexión" })).toBeVisible();
  await expect(page).toHaveURL(/\/ingresar$/);
  await expect(page.getByLabel("Correo")).toHaveValue(email);
  await expect(page.getByLabel("Contraseña")).toHaveValue("clave-cualquiera-123");
  await expect(page.getByTestId("error-screen")).toHaveCount(0);

  // Enter dentro del campo también pasa por el botón: tampoco envía.
  await page.getByLabel("Contraseña").press("Enter");
  await page.waitForTimeout(500); // margen para que una petición indebida llegara a registrarse
  expect(serverActionCalls).toEqual([]);
  await expect(page).toHaveURL(/\/ingresar$/);
  await expect(page.getByLabel("Correo")).toHaveValue(email);
  await expect(page.getByTestId("error-screen")).toHaveCount(0);

  // Con la red de vuelta el mismo formulario envía (las credenciales son falsas: responde el servidor).
  await context.setOffline(false);
  await expect(page.getByTestId("offline-notice")).toHaveCount(0);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Correo o contraseña incorrectos." }),
  ).toBeVisible();
  expect(serverActionCalls).toHaveLength(1);
  await expect(page.getByTestId("error-screen")).toHaveCount(0);
});

test("sin conexión, un formulario de la organización no pierde lo escrito", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  await signUpAndVerify(page, uniqueEmail("sin-red"), "Clara Ficticia");
  const tenantId = await createTenant(page, "Negocio Sin Red", "76.123.456-0");
  await page.goto(`/o/${tenantId}/clientes/nuevo`);
  await page.getByLabel(/^(Nombre|Razón social)/).fill("Cliente que no se pierde");

  await context.setOffline(true);
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page.locator(OFFLINE_TOAST).filter({ hasText: "Sin conexión" })).toBeVisible();
  await expect(page.getByLabel(/^(Nombre|Razón social)/)).toHaveValue("Cliente que no se pierde");
  await expect(page.getByTestId("error-screen")).toHaveCount(0);

  await context.setOffline(false);
  await page.getByRole("button", { name: "Guardar cliente" }).click();
  await expect(page).not.toHaveURL(/\/clientes\/nuevo$/);
  await expect(page.getByTestId("error-screen")).toHaveCount(0);
});

test("los enlaces legales están en el pie del ingreso, el registro y el inicio", async ({
  page,
}) => {
  for (const path of ["/", "/ingresar", "/registro"]) {
    await page.goto(path);
    const legal = page.getByRole("navigation", { name: "Información legal" });
    await expect(legal.getByRole("link", { name: "Términos y condiciones" })).toBeVisible();
    await expect(legal.getByRole("link", { name: "Política de privacidad" })).toBeVisible();
  }
});
