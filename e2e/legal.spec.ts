import { expect, test } from "@playwright/test";

const PRELIMINARY_VERSION = "2026-10-01-preliminar";

const pages = [
  { path: "/terminos", heading: "Términos y condiciones de uso", other: "Política de privacidad" },
  { path: "/privacidad", heading: "Política de privacidad", other: "Términos y condiciones" },
];

for (const { path, heading, other } of pages) {
  test(`${path} carga sin sesión y muestra aviso y versión`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByText("Versión preliminar, pendiente de revisión legal.")).toBeVisible();
    await expect(page.getByTestId("legal-version")).toContainText(PRELIMINARY_VERSION);
    await expect(
      page
        .getByRole("navigation", { name: "Información legal" })
        .getByRole("link", { name: other }),
    ).toBeVisible();
  });

  test(`${path} no desborda a 375 px`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
}
