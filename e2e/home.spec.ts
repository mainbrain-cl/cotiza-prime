import { expect, test } from "@playwright/test";

test("la página de inicio abre", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Cotiza Prime" })).toBeVisible();
});
