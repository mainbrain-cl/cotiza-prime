import { expect, test } from "@playwright/test";

test("en pruebas aparece la franja PRUEBAS arriba de la pantalla", async ({ page }) => {
  await page.goto("/");
  const banner = page.getByRole("note", { name: /entorno de pruebas/i });
  await expect(banner).toBeVisible();
  await expect(banner).toHaveText("PRUEBAS");
  const box = await banner.boundingBox();
  expect(box?.y).toBe(0);
});

test("la franja no tapa el contenido", async ({ page }) => {
  await page.goto("/");
  const banner = await page.getByRole("note", { name: /entorno de pruebas/i }).boundingBox();
  const heading = await page.getByRole("heading", { name: "Cotiza Prime" }).boundingBox();
  expect(heading!.y).toBeGreaterThanOrEqual(banner!.y + banner!.height);
});
