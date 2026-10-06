import { expect, test, type Page } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-115: avisos animados (Sonner) y movimiento reducido.

/** Cierra los avisos abiertos para que ninguno quede encima de lo que se va a tocar. */
async function dismissToasts(page: Page) {
  const closeButtons = page.locator("[data-sonner-toast] [data-close-button]");
  // Un aviso que ya se está yendo deja su botón fuera de pantalla: ese clic se puede perder sin problema.
  for (const button of await closeButtons.all())
    await button.click({ force: true, timeout: 1_000 }).catch(() => undefined);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
}

async function addService(page: Page, name: string) {
  await dismissToasts(page);
  await page.getByLabel(/^Nombre/).fill(name);
  await page.getByLabel(/^Unidad/).selectOption({ index: 1 });
  await page.getByLabel("Precio neto (en pesos)").fill("10000");
  await page.getByRole("button", { name: "Agregar al catálogo" }).click();
}

/** Mayor duración (en segundos) de animación o transición entre el elemento y sus hijos. */
async function longestMotionSeconds(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((root) => {
      const toSeconds = (list: string) =>
        Math.max(
          ...list.split(",").map((part) => {
            const value = parseFloat(part);
            return part.trim().endsWith("ms") ? value / 1000 : value;
          }),
        );
      let longest = 0;
      for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
        const style = getComputedStyle(element);
        longest = Math.max(longest, toSeconds(style.animationDuration));
        longest = Math.max(longest, toSeconds(style.transitionDuration));
      }
      return longest;
    });
}

test("al guardar un servicio sale un aviso, y con movimiento reducido nada se anima", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUpAndVerify(page, uniqueEmail("pulido"), "Pulido Ficticio");
  const tenantId = await createTenant(page, "Pulido Ltda", "76.123.456-0");
  await page.goto(`/o/${tenantId}/catalogo`);

  // Movimiento normal: el aviso entra con su animación y se anuncia a lectores de pantalla.
  await addService(page, "Servicio uno");
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Servicio uno" });
  await expect(toast).toBeVisible();
  await expect(page.getByRole("region", { name: /Avisos/ })).toHaveAttribute("aria-live", "polite");

  // Movimiento reducido: ninguna animación ni transición dura algo.
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
    true,
  );
  await addService(page, "Servicio dos");
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Servicio dos" }),
  ).toBeVisible();
  expect(await longestMotionSeconds(page, "body")).toBe(0);
});
