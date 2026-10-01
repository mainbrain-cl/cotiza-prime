import { connect } from "../tests/db/helpers";
import { expect, test, type Page } from "./fixtures";
import { TEST_PASSWORD, signUpAndVerify, uniqueEmail } from "./helpers";

// H-002: límite de intentos de ingreso y de registro, de punta a punta.
// Cada prueba navega desde una IP propia (ver fixtures.ts), así los contadores no se mezclan.

const MAX_FAILURES_PER_ACCOUNT = 5; // debe coincidir con LOGIN_MAX_FAILURES_PER_ACCOUNT
const MAX_SIGNUPS_PER_IP = 10; // debe coincidir con SIGNUP_MAX_ATTEMPTS_PER_IP
const WRONG_PASSWORD = "la-clave-equivocada";
const INVALID_MESSAGE = "Correo o contraseña incorrectos.";
const LOCKED_MESSAGE = "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.";

async function tryLogin(page: Page, email: string, password: string) {
  await page.goto("/ingresar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
}

test("5 contraseñas incorrectas bloquean la cuenta, sin revelar si existe", async ({ page }) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("bloqueo");
  const ghost = uniqueEmail("fantasma");
  await signUpAndVerify(page, email, "Bea Ficticia");
  await page.context().clearCookies();

  // Los primeros 4 fallos dicen lo de siempre; el 5.º ya muestra el bloqueo
  for (let attempt = 1; attempt < MAX_FAILURES_PER_ACCOUNT; attempt++) {
    await tryLogin(page, email, WRONG_PASSWORD);
    await expect(page.getByText(INVALID_MESSAGE)).toBeVisible();
  }
  await tryLogin(page, email, WRONG_PASSWORD);
  await expect(page.getByText(LOCKED_MESSAGE)).toBeVisible();

  // Con la cuenta bloqueada, ni la contraseña correcta entra
  await tryLogin(page, email, TEST_PASSWORD);
  await expect(page.getByText(LOCKED_MESSAGE)).toBeVisible();
  await expect(page).toHaveURL(/\/ingresar$/);

  // Una cuenta que no existe se comporta exactamente igual
  for (let attempt = 1; attempt < MAX_FAILURES_PER_ACCOUNT; attempt++) {
    await tryLogin(page, ghost, WRONG_PASSWORD);
    await expect(page.getByText(INVALID_MESSAGE)).toBeVisible();
  }
  await tryLogin(page, ghost, WRONG_PASSWORD);
  await expect(page.getByText(LOCKED_MESSAGE)).toBeVisible();

  // Auditoría: queda el bloqueo con la huella del correo (nunca el correo) y la IP real
  const db = await connect();
  try {
    const { rows } = await db.query(
      `select action, origin_ip::text as ip, details::text as details
         from public.audit_log
        where tenant_id = '00000000-0000-4000-8000-000000000001'
          and action in ('session.login_locked', 'session.login_failed')
          and details->>'emailHash' is not null
        order by id desc limit 40`,
    );
    const locked = rows.filter((row) => row.action === "session.login_locked");
    expect(locked.length).toBeGreaterThanOrEqual(2);
    const everything = JSON.stringify(rows).toLowerCase();
    expect(everything).not.toContain("ejemplo.test");
    expect(everything).not.toContain(email.toLowerCase());
    expect(locked[0].details).toMatch(/"emailHash": "[0-9a-f]{64}"/);
    expect(locked[0].ip).toMatch(/^2001:db8:/); // la IP real del cliente, no la del servidor
  } finally {
    await db.end();
  }
});

test("solo cuentan los fallos: ingresar bien limpia el contador de la cuenta", async ({ page }) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("limpia");
  await signUpAndVerify(page, email, "Lía Ficticia");
  await page.context().clearCookies();

  // 4 fallos (uno menos que el bloqueo)…
  for (let attempt = 1; attempt < MAX_FAILURES_PER_ACCOUNT; attempt++) {
    await tryLogin(page, email, WRONG_PASSWORD);
    await expect(page.getByText(INVALID_MESSAGE)).toBeVisible();
  }
  // …un ingreso correcto…
  await tryLogin(page, email, TEST_PASSWORD);
  await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
  await page.context().clearCookies();

  // …y otros 4 fallos no bloquean, porque el contador volvió a cero
  for (let attempt = 1; attempt < MAX_FAILURES_PER_ACCOUNT; attempt++) {
    await tryLogin(page, email, WRONG_PASSWORD);
    await expect(page.getByText(INVALID_MESSAGE)).toBeVisible();
  }
  await tryLogin(page, email, TEST_PASSWORD);
  await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
});

test("el registro se limita por IP", async ({ page }) => {
  test.setTimeout(240_000);
  for (let attempt = 1; attempt <= MAX_SIGNUPS_PER_IP; attempt++) {
    await page.goto("/registro");
    await page.getByLabel("Tu nombre").fill("Persona Ficticia");
    await page.getByLabel("Correo").fill(uniqueEmail("masivo"));
    await page.getByLabel("Contraseña").fill(TEST_PASSWORD);
    await page.getByRole("checkbox", { name: /Acepto los/ }).check();
    await page.getByRole("button", { name: "Crear mi cuenta" }).click();
    await expect(page.getByTestId("signup-sent")).toBeVisible();
  }
  await page.goto("/registro");
  await page.getByLabel("Tu nombre").fill("Persona Ficticia");
  await page.getByLabel("Correo").fill(uniqueEmail("masivo"));
  await page.getByLabel("Contraseña").fill(TEST_PASSWORD);
  await page.getByRole("checkbox", { name: /Acepto los/ }).check();
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page.getByText(LOCKED_MESSAGE)).toBeVisible();
  await expect(page.getByTestId("signup-sent")).toHaveCount(0);
});
