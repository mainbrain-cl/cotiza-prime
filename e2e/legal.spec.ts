import { expect, test } from "@playwright/test";

const pages = [
  {
    path: "/terminos",
    heading: "Términos y condiciones de uso",
    other: "Política de privacidad",
    version: "2026-10-01-preliminar",
  },
  {
    path: "/privacidad",
    heading: "Política de privacidad",
    other: "Términos y condiciones",
    version: "2026-11-27-preliminar",
  },
];

for (const { path, heading, other, version } of pages) {
  test(`${path} carga sin sesión y muestra aviso y versión`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByText("Versión preliminar, pendiente de revisión legal.")).toBeVisible();
    await expect(page.getByTestId("legal-version")).toContainText(version);
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
