import { expect, randomTestIp, test, type Page } from "./fixtures";
import {
  TEST_PASSWORD,
  countMails,
  openVerificationLink,
  signUpAndVerify,
  uniqueEmail,
  waitForVerificationLink,
} from "./helpers";

// H-003: recuperar la contraseña de punta a punta. Correos únicos @ejemplo.test.

const NEW_PASSWORD = "otra-clave-nueva-456";
const SENT_MESSAGE = /Si ese correo tiene una cuenta en Cotiza Prime/;
const RESET_SUBJECT = "Reset";
const CHANGED_SUBJECT = "cambió";
const RECOVERY_PATH = "/auth/recuperar";

async function requestReset(page: Page, email: string) {
  await page.goto("/ingresar");
  await page.getByRole("link", { name: "¿Olvidaste tu contraseña?" }).click();
  await expect(page).toHaveURL(/\/recuperar-contrasena$/);
  await page.getByLabel("Correo").fill(email);
  await page.getByRole("button", { name: "Enviar enlace" }).click();
  await expect(page.getByTestId("reset-request-sent")).toBeVisible();
}

async function login(page: Page, email: string, password: string) {
  await page.goto("/ingresar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
}

test("recuperar la contraseña cierra las otras sesiones y la vieja deja de servir", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("clara");
  const ghost = uniqueEmail("fantasma");
  const baseURL = test.info().project.use.baseURL;
  const newContext = () =>
    browser.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": randomTestIp() } });

  // Sesión 1 (la del registro) y sesión 2 (otro navegador con la contraseña actual)
  await signUpAndVerify(page, email, "Clara Ficticia");
  const otherContext = await newContext();
  const otherPage = await otherContext.newPage();
  await login(otherPage, email, TEST_PASSWORD);
  await expect(otherPage).not.toHaveURL(/\/ingresar/);

  // El mensaje es el mismo exista o no la cuenta
  const ghostContext = await newContext();
  const ghostPage = await ghostContext.newPage();
  await requestReset(ghostPage, ghost);
  await expect(ghostPage.getByText(SENT_MESSAGE)).toBeVisible();
  const ghostMessage = await ghostPage.getByTestId("reset-request-sent").innerText();

  // Se pide el enlace desde un tercer navegador (quien olvidó la contraseña)
  const resetContext = await newContext();
  const resetPage = await resetContext.newPage();
  await requestReset(resetPage, email);
  expect(await resetPage.getByTestId("reset-request-sent").innerText()).toBe(ghostMessage);

  // El enlace llega al correo, abre la pantalla de contraseña nueva y exige las reglas
  const link = await waitForVerificationLink(email, RESET_SUBJECT);
  await openVerificationLink(resetPage, link, RECOVERY_PATH);
  await expect(resetPage).toHaveURL(/\/restablecer-contrasena$/);
  await resetPage.locator("input[name=password]").fill("corta");
  await resetPage.locator("input[name=confirmPassword]").fill("corta");
  await resetPage.getByRole("button", { name: "Cambiar contraseña" }).click();
  await expect(
    resetPage.getByText("La contraseña debe tener al menos 10 caracteres."),
  ).toBeVisible();
  await resetPage.locator("input[name=password]").fill(NEW_PASSWORD);
  await resetPage.locator("input[name=confirmPassword]").fill("no-coincide-123");
  await resetPage.getByRole("button", { name: "Cambiar contraseña" }).click();
  await expect(resetPage.getByText("Las contraseñas no coinciden.")).toBeVisible();

  await resetPage.locator("input[name=password]").fill(NEW_PASSWORD);
  await resetPage.locator("input[name=confirmPassword]").fill(NEW_PASSWORD);
  await resetPage.getByRole("button", { name: "Cambiar contraseña" }).click();
  await expect(resetPage).not.toHaveURL(/\/restablecer-contrasena/);

  // Las otras sesiones quedaron cerradas; la que cambió la contraseña sigue abierta
  await page.goto("/organizaciones/nueva");
  await expect(page).toHaveURL(/\/ingresar$/);
  await otherPage.goto("/organizaciones/nueva");
  await expect(otherPage).toHaveURL(/\/ingresar$/);
  await resetPage.goto("/organizaciones/nueva");
  await expect(resetPage).toHaveURL(/\/organizaciones\/nueva$/);

  // Un enlace que no sirve (código inválido, caducado o usado) lleva a ingresar con un aviso
  const reuseContext = await newContext();
  const reusePage = await reuseContext.newPage();
  await reusePage.goto(`${RECOVERY_PATH}?code=codigo-que-no-existe`);
  await expect(reusePage).toHaveURL(/\/ingresar\?aviso=enlace-recuperacion-vencido$/);
  await expect(reusePage.getByText(/El enlace para cambiar tu contraseña caducó/)).toBeVisible();

  // La contraseña vieja ya no sirve y la nueva sí
  await page.context().clearCookies();
  await login(page, email, TEST_PASSWORD);
  await expect(page.getByText("Correo o contraseña incorrectos.")).toBeVisible();
  await login(page, email, NEW_PASSWORD);
  await expect(page).not.toHaveURL(/\/ingresar/);

  // Aviso por correo de que la contraseña cambió. Lo envía Supabase Auth según supabase/config.toml:
  // solo se exige si la Supabase local ya se reinició con esa configuración.
  if (process.env.E2E_EXPECT_PASSWORD_CHANGED_MAIL === "1") {
    await expect
      .poll(() => countMails(email, CHANGED_SUBJECT), { timeout: 30_000 })
      .toBeGreaterThan(0);
  }

  await Promise.all([
    otherContext.close(),
    ghostContext.close(),
    resetContext.close(),
    reuseContext.close(),
  ]);
});

test("las pantallas de recuperación se ven bien en el teléfono", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ["/recuperar-contrasena", "/restablecer-contrasena"]) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
  // Sin sesión, la pantalla de contraseña nueva lleva a ingresar con el aviso
  await expect(page).toHaveURL(/\/ingresar\?aviso=enlace-recuperacion-vencido$/);
});
