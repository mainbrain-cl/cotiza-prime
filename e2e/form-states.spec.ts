import { expect, test } from "./fixtures";

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
