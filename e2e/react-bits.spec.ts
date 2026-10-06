import { randomUUID } from "node:crypto";
import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import { expect, test } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// Decisión 018: menú flotante vertical, tarjetas y contadores del inicio, fondos con movimiento.

test("menú flotante vertical: teclado, etiquetas, navegación y cierre de sesión", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUpAndVerify(page, uniqueEmail("dock"), "Dock Ficticia");
  const tenantId = await createTenant(page, "Dock Ltda", generateRut());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/o/${tenantId}`);

  const aside = page.getByRole("complementary", { name: "Menú lateral" });
  await expect(aside).toBeVisible();
  const box = await aside.boundingBox();
  // Pegado a la izquierda y en vertical
  expect(box!.x).toBeLessThan(32);
  expect(box!.height).toBeGreaterThan(box!.width * 4);

  const nav = aside.getByRole("navigation", { name: "Principal" });
  for (const name of ["Inicio", "Cotizaciones", "Clientes", "Catálogo", "Configuración"]) {
    await expect(nav.getByRole("link", { name })).toBeVisible();
  }
  await expect(nav.getByRole("link", { name: "Inicio" })).toHaveAttribute("aria-current", "page");

  // Cada destino mide al menos 44 px de lado
  const link = nav.getByRole("link", { name: "Catálogo" });
  const linkBox = await link.boundingBox();
  expect(linkBox!.width).toBeGreaterThanOrEqual(44);
  expect(linkBox!.height).toBeGreaterThanOrEqual(44);

  // Por teclado el destino se ve: aparece su nombre al lado
  await link.focus();
  await expect(aside.getByText("Catálogo", { exact: true }).last()).toBeVisible();

  await link.click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}/catalogo$`));
  await expect(nav.getByRole("link", { name: "Catálogo" })).toHaveAttribute("aria-current", "page");

  // Cierre de sesión desde el menú
  await aside.getByRole("button", { name: "Cerrar sesión" }).click();
  await expect(page).toHaveURL(/\/ingresar/);
});

test("inicio: resumen por estado con contadores y sin desplazamiento horizontal en teléfono", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUpAndVerify(page, uniqueEmail("resumen"), "Resumen Ficticia");
  const tenantId = await createTenant(page, "Resumen Ltda", generateRut());
  const db = await connect();
  try {
    await db.query(
      `insert into public.customers (id, tenant_id, kind, display_name)
       values ($1, $2, 'company', 'Cliente Resumen Ltda')`,
      [randomUUID(), tenantId],
    );
  } finally {
    await db.end();
  }

  await page.goto(`/o/${tenantId}`);
  await expect(page.getByText("Tu organización está lista")).toBeVisible();

  await page.goto(`/o/${tenantId}/cotizaciones/nueva`);
  await page.getByRole("button", { name: /Cliente Resumen Ltda/ }).click();
  await expect(page).toHaveURL(/\/cotizaciones\/[0-9a-f-]{36}$/);

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/o/${tenantId}`);
  const summary = page.getByTestId("status-summary");
  await expect(summary).toBeVisible();
  const drafts = summary.getByRole("link", { name: /Borradores/ });
  // El valor final siempre está escrito para lectores de pantalla y para quien no ve la animación
  await expect(drafts.locator(".sr-only")).toHaveText("1");
  await expect(drafts).toHaveText(/\$0/);
  // Teléfono: sin menú vertical, con barra inferior, sin desplazamiento horizontal
  await expect(page.getByRole("complementary", { name: "Menú lateral" })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("fondos con movimiento: solo en escritorio y sin 'reducir movimiento'", async ({
  browser,
}) => {
  const open = async (options: Parameters<typeof browser.newContext>[0]) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.goto("/ingresar");
    await page.waitForTimeout(1500);
    const canvases = await page.locator("main canvas").count();
    await context.close();
    return canvases;
  };

  // Teléfono y movimiento reducido: solo el fondo suave de CSS, nunca el lienzo
  expect(await open({ viewport: { width: 375, height: 800 } })).toBe(0);
  expect(await open({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" })).toBe(0);
});
