import { expect, randomTestIp, test, type Page } from "./fixtures";
import {
  TEST_PASSWORD,
  confirmEmailFromLink,
  createTenant,
  requestSignupLink,
  signUpAndVerify,
  submitAccountSetup,
  uniqueEmail,
  waitForAccountLink,
} from "./helpers";

// Cuentas, organizaciones y aislamiento de punta a punta (H-001, H-002, H-005, H-006).
// Todo con correos únicos @ejemplo.test: no depende de datos previos ni los deja en conflicto.

const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1440, height: 900 };

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("registro, organizaciones, cambio, cierre de sesión y aislamiento", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const emailA = uniqueEmail("ana");
  const emailB = uniqueEmail("beto");

  // Errores de la consola (por ejemplo, de hidratación) rompen la prueba
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  // ── H-001 / H-116: registro en dos pasos (correo → enlace → nombre y contraseña) ────────────
  await requestSignupLink(page, emailA);
  await confirmEmailFromLink(page, await waitForAccountLink(emailA));
  // Con una contraseña corta y sin aceptar los términos: se dice cuál es el largo mínimo y se exige aceptar
  await page.getByLabel("Tu nombre").fill("Ana Ficticia");
  await page.locator("input[name=password]").fill("corta");
  await page.locator("input[name=confirmPassword]").fill("corta");
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page.getByText("La contraseña debe tener al menos 10 caracteres.")).toBeVisible();
  await expect(page.getByText("Para crear tu cuenta debes aceptar los términos")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "términos y condiciones", exact: true }),
  ).toHaveAttribute("href", "/terminos");
  await expect(
    page.getByRole("link", { name: "política de privacidad", exact: true }),
  ).toHaveAttribute("href", "/privacidad");
  await submitAccountSetup(page, "Ana Ficticia");
  await expect(page).toHaveURL(/\/organizaciones\/nueva$/);

  // ── H-005: crear la primera organización (con aviso inmediato del RUT) ──────────────────────
  await expect(page.getByRole("heading", { name: "Crea tu primera organización" })).toBeVisible();
  await page.getByLabel("RUT de la empresa").fill("76.123.456-9");
  await page.getByLabel("Nombre de la empresa").click(); // al salir del campo se valida
  await expect(page.getByText("El RUT no es válido.")).toBeVisible();
  await page.getByLabel("RUT de la empresa").fill("761234560");
  await page.getByLabel("Nombre de la empresa").click();
  await expect(page.getByLabel("RUT de la empresa")).toHaveValue("76.123.456-0");

  const tenantA = await createTenant(page, "Negocio 1", "76.123.456-0");
  await expect(page.getByRole("heading", { name: "Inicio" })).toBeVisible();
  await expect(page.getByText("Tu organización está lista")).toBeVisible();

  // ── H-005 y H-006: una segunda organización y el selector ───────────────────────────────────
  await page.locator('[data-testid="tenant-switcher"]:visible').click();
  await page.getByRole("menuitem", { name: "Crear otra organización" }).click();
  await expect(page.getByRole("heading", { name: "Crea otra organización" })).toBeVisible();
  const tenantB = await createTenant(page, "Negocio 2", "12.345.678-5");
  expect(tenantB).not.toBe(tenantA);
  await expect(page.locator('[data-testid="tenant-switcher"]:visible')).toContainText("Negocio 2");

  await page.locator('[data-testid="tenant-switcher"]:visible').click();
  // El selector muestra las dos, con el rol de la persona en cada una
  await expect(page.getByRole("menuitem", { name: /Negocio 1.*Dueño/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Negocio 2.*Dueño/ })).toBeVisible();
  await page.getByRole("menuitem", { name: /Negocio 1/ }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantA}$`));
  await expect(page.locator('[data-testid="tenant-switcher"]:visible')).toContainText("Negocio 1");

  // Cotizaciones (H-025): una organización nueva no tiene ninguna y lo dice con honestidad
  await page.getByRole("link", { name: "Cotizaciones" }).first().click();
  await expect(page.getByRole("heading", { name: "Cotizaciones", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Aún no tienes cotizaciones" })).toBeVisible();

  // ── Teléfono: sin desplazamiento horizontal y con barra inferior ────────────────────────────
  await page.setViewportSize(MOBILE);
  const orgResponse = await page.goto(`/o/${tenantA}`);
  // Lo que depende de quien lo mira nunca se guarda en cachés compartidas
  // (en desarrollo Next fija su propio valor; el valor exacto de producción lo prueba src/lib/security-headers.test.ts)
  expect(orgResponse?.headers()["cache-control"]).toMatch(/no-cache|no-store/);
  expect(orgResponse?.headers()["cache-control"]).not.toMatch(/public|s-maxage/);
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.setViewportSize(DESKTOP);

  // ── H-002: cierre de sesión efectivo ────────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await expect(page).toHaveURL(/\/ingresar\?aviso=sesion-cerrada$/);
  await expect(page.getByText("Cerraste sesión.")).toBeVisible();
  const leftover = (await page.context().cookies()).filter((c) =>
    /auth-token(\.\d+)?$/.test(c.name),
  );
  expect(leftover, "al cerrar sesión no debe quedar el pase en el navegador").toHaveLength(0);

  await page.goto(`/o/${tenantA}`);
  await expect(page).toHaveURL(/\/ingresar$/); // sin sesión no se entra a una organización
  await page.goBack();
  await expect(page.getByText("Negocio 1")).toHaveCount(0); // atrás no muestra datos

  // Mensaje que no revela si el correo existe
  await page.getByLabel("Correo").fill(emailA);
  await page.getByLabel("Contraseña").fill("la-clave-equivocada");
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByText("Correo o contraseña incorrectos.")).toBeVisible();
  await page.goto("/ingresar"); // pantalla limpia: así el mensaje que se lee es el del segundo intento
  await page.getByLabel("Correo").fill(uniqueEmail("fantasma"));
  await page.getByLabel("Contraseña").fill("la-clave-equivocada");
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByText("Correo o contraseña incorrectos.")).toBeVisible();

  // Ingreso correcto: vuelve a la última organización usada (Negocio 1)
  await page.goto("/ingresar");
  await page.getByLabel("Correo").fill(emailA);
  await page.getByLabel("Contraseña").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${tenantA}$`));

  // Las cookies de sesión no las puede leer JavaScript y no viajan entre sitios
  const sessionCookies = (await page.context().cookies()).filter((c) => c.name.startsWith("sb-"));
  expect(sessionCookies.length).toBeGreaterThan(0);
  for (const cookie of sessionCookies) {
    expect(cookie.httpOnly, `${cookie.name} debe ser HttpOnly`).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
  }

  expect(consoleErrors, "no debe haber errores en la consola").toEqual([]);

  // ── H-002: "volver atrás" tras cerrar sesión no deja ver la pantalla anterior ────────────────
  await page.goto(`/o/${tenantA}/clientes`);
  await expect(page.getByRole("heading", { name: "Clientes", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await expect(page).toHaveURL(/\/ingresar\?aviso=sesion-cerrada$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/ingresar$/);
  await expect(page.getByText("Negocio 1")).toHaveCount(0);

  // ── Aislamiento: otra cuenta no puede ver la organización de Ana ────────────────────────────
  const contextB = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  const pageB = await contextB.newPage();
  await signUpAndVerify(pageB, emailB, "Beto Ficticio");
  const tenantOfBeto = await createTenant(pageB, "Negocio de Beto", "13.000.000-2");
  expect(tenantOfBeto).not.toBe(tenantA);

  const response = await pageB.goto(`/o/${tenantA}`);
  expect(response?.status()).toBe(404);
  await expect(pageB.getByRole("heading", { name: "No encontrado" })).toBeVisible();
  await expect(pageB.getByText("Negocio 1")).toHaveCount(0);
  await expect(pageB.getByText("Ana Ficticia")).toHaveCount(0);

  // Una dirección que ni siquiera es un identificador responde lo mismo
  await pageB.goto("/o/no-es-un-id");
  await expect(pageB.getByRole("heading", { name: "No encontrado" })).toBeVisible();
  await contextB.close();
});
