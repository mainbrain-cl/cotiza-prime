import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "../tests/db/helpers";
import { localEnv } from "../tests/support/local-supabase";
import { enrollAndVerifyWithPermit } from "../tests/support/mfa-gate";
import { freshTotp, totpAt } from "../src/test/totp";
import type { Browser } from "@playwright/test";
import { expect, randomTestIp, test, type Page } from "./fixtures";
import {
  TEST_PASSWORD,
  activateTwoStep,
  countMails,
  createTenant,
  finishRecoveryCodes,
  openVerificationLink,
  signUpAndVerify,
  submitEnrollmentConfirmation,
  uniqueEmail,
  waitForVerificationLink,
} from "./helpers";

// H-004b · Códigos de respaldo: crearlos al activar, generar nuevos y crearlos en una cuenta activada antes. En SERIE y solo con
// cuentas nuevas @ejemplo.test (activar un factor cierra las demás sesiones de la cuenta). Desactivar es del paso 6 de la
// historia; entrar con un código de respaldo (paso 5) está al final de este archivo.
test.describe.configure({ mode: "serial" });

const ENABLE_BUTTON = "Activar la verificación en dos pasos";
const CODE_LABEL = "Código de 6 números";
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/;
const NO_CODES_MESSAGE = "No tienes códigos de respaldo. Si pierdes tu teléfono, no podrás entrar.";
const NOT_ACKNOWLEDGED_MESSAGE = "No confirmaste que guardaste tus códigos de respaldo";
const CREATED_NOTICE_SUBJECT = "Creaste códigos de respaldo nuevos en tu cuenta";

/** Las huellas de los códigos vigentes de esa cuenta (solo lectura, en la base local de pruebas). */
async function codeHashesOf(email: string): Promise<string[]> {
  const db = await connect();
  try {
    const { rows } = await db.query<{ code_hash: string }>(
      `select c.code_hash from public.mfa_recovery_codes c
         join auth.users u on u.id = c.user_id where u.email = $1 order by c.code_hash`,
      [email],
    );
    return rows.map((row) => row.code_hash);
  } finally {
    await db.end();
  }
}

/** Cuenta nueva con su organización, en la pantalla de seguridad con el código de la aplicación listo para escribir. */
async function startEnrollment(page: Page, label: string) {
  const email = uniqueEmail(label);
  await signUpAndVerify(page, email, "Persona Ficticia");
  await createTenant(page, `Empresa ${label}`, "76086428-5");
  await page.goto("/cuenta/seguridad");
  await page.getByRole("button", { name: ENABLE_BUTTON }).click();
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  await page.getByRole("button", { name: "Ya la escaneé" }).click();
  await expect(page.getByLabel(CODE_LABEL)).toBeVisible();
  return { email, secret };
}

test("activar: con la contraseña mala no pasa y el mismo código sirve; con la buena salen 10 códigos, «Listo» espera la casilla y al recargar no vuelven", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { email, secret } = await startEnrollment(page, "respaldo");
  const { code, step } = await freshTotp(secret);

  // Contraseña mala: error en su campo, ni códigos ni verificación.
  await submitEnrollmentConfirmation(page, code, "no-es-mi-clave-123");
  await expect(page.getByText("La contraseña no es correcta.")).toBeVisible();
  await expect(page.getByTestId("recovery-codes-screen")).toHaveCount(0);
  expect(await codeHashesOf(email)).toEqual([]);

  // El mismo código sigue sirviendo con la contraseña buena.
  await submitEnrollmentConfirmation(page, code, TEST_PASSWORD);
  await expect(page.getByTestId("recovery-codes-screen")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tus códigos de respaldo" })).toBeFocused();
  await expect(
    page.getByText(
      "Solo los verás esta vez. Cada código sirve una sola vez. Si pierdes tu teléfono, entra con uno.",
    ),
  ).toBeVisible();
  const shown = await page.getByTestId("recovery-code").allInnerTexts();
  expect(shown).toHaveLength(10);
  expect(new Set(shown).size).toBe(10);
  for (const item of shown) expect(item).toMatch(CODE_SHAPE);
  // Nunca en la dirección ni en el almacenamiento del navegador.
  expect(page.url()).not.toContain(shown[0]);
  const storage = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]),
  );
  for (const item of shown) expect(storage).not.toContain(item);

  // En la base solo hay huellas: 10, y ninguna es el código.
  const hashes = await codeHashesOf(email);
  expect(hashes).toHaveLength(10);
  for (const hash of hashes) {
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    for (const item of shown) expect(hash).not.toContain(item.replaceAll("-", ""));
  }

  // «Listo» está deshabilitado hasta marcar la casilla.
  const done = page.getByRole("button", { name: "Listo", exact: true });
  await expect(done).toBeDisabled();
  await page.getByRole("checkbox", { name: "Guardé estos códigos en un lugar seguro" }).check();
  await expect(done).toBeEnabled();
  await page.getByRole("checkbox", { name: "Guardé estos códigos en un lugar seguro" }).uncheck();
  await expect(done).toBeDisabled();

  // «Copiar todos» copia los 10 códigos, uno por línea.
  await page.getByRole("button", { name: "Copiar todos" }).click();
  await expect(page.getByRole("button", { name: "Copiados" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown.join("\n"));

  // «Descargar (.txt)» arma el archivo en el navegador, con los códigos y sin el correo.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Descargar (.txt)" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("codigos-de-respaldo-cotiza-prime.txt");
  const file = await readFile((await download.path())!, "utf8");
  for (const [index, item] of shown.entries()) expect(file).toContain(`${index + 1}. ${item}`);
  expect(file).not.toContain(email);
  expect(file).not.toContain("@");

  // Al recargar sin apretar «Listo», los códigos NO vuelven; la pantalla avisa que no se confirmó.
  await page.reload();
  await expect(page.getByTestId("recovery-code")).toHaveCount(0);
  await expect(page.getByTestId("recovery-codes-screen")).toHaveCount(0);
  await expect(page.getByTestId("two-step-active")).toBeVisible();
  await expect(page.getByText(NOT_ACKNOWLEDGED_MESSAGE)).toBeVisible();
  const reloaded = await page.content();
  for (const item of shown) expect(reloaded).not.toContain(item);

  // Caso 6: generar códigos nuevos pide la contraseña y el código de la APLICACIÓN; los viejos dejan de servir.
  // Un código de respaldo en ese campo se rechaza sin gastar el intento.
  await page.getByRole("button", { name: "Generar códigos nuevos", exact: true }).click();
  await expect(page.getByText("Los códigos anteriores dejarán de servir")).toBeVisible();
  await page.getByLabel(CODE_LABEL).fill(shown[0]);
  await page.getByLabel("Tu contraseña").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Generar códigos nuevos", exact: true }).last().click();
  await expect(page.getByText("no un código de respaldo")).toBeVisible();
  expect(await codeHashesOf(email)).toEqual(hashes);
  // Contraseña mala: no cambia nada.
  const next = await freshTotp(secret, { avoidStep: step });
  await page.getByLabel(CODE_LABEL).fill(next.code);
  await page.getByLabel("Tu contraseña").fill("no-es-mi-clave-123");
  await page.getByRole("button", { name: "Generar códigos nuevos", exact: true }).last().click();
  await expect(page.getByText("La contraseña no es correcta.")).toBeVisible();
  expect(await codeHashesOf(email)).toEqual(hashes);
  // Con la contraseña buena y el código de la aplicación salen 10 códigos distintos.
  await page.getByLabel(CODE_LABEL).fill(next.code);
  await page.getByLabel("Tu contraseña").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Generar códigos nuevos", exact: true }).last().click();
  await expect(page.getByTestId("recovery-codes-screen")).toBeVisible();
  const fresh = await page.getByTestId("recovery-code").allInnerTexts();
  expect(fresh).toHaveLength(10);
  expect(fresh.filter((item) => shown.includes(item))).toEqual([]);
  const freshHashes = await codeHashesOf(email);
  expect(freshHashes).toHaveLength(10);
  // Ninguna huella de los códigos viejos sobrevive: ya no sirven.
  expect(freshHashes.filter((hash) => hashes.includes(hash))).toEqual([]);

  // «Listo» confirma y vuelve con el aviso; sin alarma y con la fecha de creación.
  await finishRecoveryCodes(page, "codigos");
  await expect(
    page.getByText(
      "Listo: tus códigos de respaldo nuevos quedaron creados. Los anteriores ya no sirven.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("recovery-has-codes")).toContainText(
    /creados el \d{2}-\d{2}-\d{4}/,
  );
  await expect(page.getByText(NOT_ACKNOWLEDGED_MESSAGE)).toHaveCount(0);

  // Llegó el aviso por correo, sin ningún código de respaldo.
  await expect.poll(() => countMails(email, CREATED_NOTICE_SUBJECT)).toBe(1);
});

test("una cuenta activada antes de los códigos de respaldo ve «No tienes códigos» y los crea con su contraseña y el código de su aplicación", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("sincodigos");
  await signUpAndVerify(page, email, "Persona Ficticia");
  await createTenant(page, "Empresa Sin Códigos", "76086428-5");

  // La activa por la API de Supabase, con el permiso del servidor (como hacen las pruebas de H-118): sin códigos.
  const { apiUrl, publishableKey } = localEnv();
  const login = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  expect(login.status).toBe(200);
  const body = (await login.json()) as {
    access_token: string;
    expires_at: number;
    user: { id: string };
  };
  const db = await connect();
  let secret: string;
  let usedStep: number;
  try {
    const enrolled = await enrollAndVerifyWithPermit(db, {
      accessToken: body.access_token,
      expiresAt: body.expires_at,
      userId: body.user.id,
    });
    secret = enrolled.secret;
    usedStep = enrolled.step;
  } finally {
    await db.end();
  }
  expect(await codeHashesOf(email)).toEqual([]);

  // La sesión del navegador se cerró al activar: entra con la contraseña y el código.
  await page.context().clearCookies();
  await page.goto("/ingresar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page).toHaveURL(/\/ingresar\/codigo$/);
  const entry = await freshTotp(secret, { avoidStep: usedStep });
  await page.getByLabel(CODE_LABEL).fill(entry.code);
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).not.toHaveURL(/\/ingresar/);

  await page.goto("/cuenta/seguridad");
  await expect(page.getByTestId("two-step-active")).toBeVisible();
  await expect(page.getByTestId("recovery-no-codes")).toHaveText(NO_CODES_MESSAGE);
  await expect(page.getByRole("button", { name: "Generar códigos nuevos" })).toHaveCount(0);

  // Crear pide las dos cosas: sin contraseña, sin código.
  await page.getByRole("button", { name: "Crear códigos de respaldo", exact: true }).click();
  await expect(page.getByText("Los códigos anteriores dejarán de servir")).toHaveCount(0);
  const created = await freshTotp(secret, { avoidStep: entry.step });
  await page.getByLabel(CODE_LABEL).fill(created.code);
  await page.getByRole("button", { name: "Crear códigos de respaldo", exact: true }).last().click();
  await expect(page.getByText("Ingresa tu contraseña.")).toBeVisible();
  expect(await codeHashesOf(email)).toEqual([]);
  await page.getByLabel(CODE_LABEL).fill(created.code);
  await page.getByLabel("Tu contraseña").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Crear códigos de respaldo", exact: true }).last().click();
  await expect(page.getByTestId("recovery-codes-screen")).toBeVisible();
  expect(await page.getByTestId("recovery-code").count()).toBe(10);
  expect(await codeHashesOf(email)).toHaveLength(10);

  await finishRecoveryCodes(page, "codigos");
  await expect(page.getByTestId("recovery-has-codes")).toBeVisible();
  await expect(page.getByTestId("recovery-no-codes")).toHaveCount(0);
});

test("teclado, teléfono (375 px) y modo oscuro: la pantalla de códigos se maneja sin ratón, sin desplazamiento horizontal y con buen contraste", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const { secret } = await startEnrollment(page, "teclado");
  await submitEnrollmentConfirmation(page, (await freshTotp(secret)).code);
  await expect(page.getByTestId("recovery-codes-screen")).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  // Los 10 códigos caben enteros en el ancho de la pantalla.
  const rights = await page
    .getByTestId("recovery-code")
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right));
  for (const right of rights) expect(right).toBeLessThanOrEqual(375);
  // Los códigos se leen: el texto y el fondo de su lista tienen contraste suficiente (4,5:1) en modo oscuro.
  const contrast = await page
    .getByTestId("recovery-code")
    .first()
    .evaluate((node) => {
      const channels = (color: string) =>
        (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((value) => Number(value));
      const luminance = ([r, g, b]: number[]) => {
        const lin = (value: number) => {
          const unit = value / 255;
          return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const backgroundOf = (element: Element | null): string => {
        for (let current = element; current; current = current.parentElement) {
          const color = getComputedStyle(current).backgroundColor;
          if (!/rgba?\(\s*0,\s*0,\s*0,\s*0\)|transparent/.test(color)) return color;
        }
        return "rgb(255, 255, 255)";
      };
      const foreground = luminance(channels(getComputedStyle(node).color));
      const background = luminance(channels(backgroundOf(node)));
      const [light, dark] =
        foreground > background ? [foreground, background] : [background, foreground];
      return (light + 0.05) / (dark + 0.05);
    });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({
    path: testInfo.outputPath("codigos-375-oscuro.png"),
    fullPage: true,
  });

  // Solo con el teclado: de «Copiar todos» a la casilla, marcarla con la barra espaciadora y apretar «Listo» con Enter.
  const checkbox = page.getByRole("checkbox", { name: "Guardé estos códigos en un lugar seguro" });
  for (
    let presses = 0;
    presses < 8 && !(await checkbox.evaluate((el) => el === document.activeElement));
    presses += 1
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(checkbox).toBeFocused();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Listo", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/cuenta\/seguridad\?aviso=activada$/);
  await expect(page.getByTestId("recovery-section")).toBeVisible();
  const afterOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(afterOverflow).toBeLessThanOrEqual(0);
});

// ───────────────────────────── Paso 5: entrar con un código de respaldo ─────────────────────────────

const BACKUP_LABEL = "Código de respaldo";
const BACKUP_LINK = "¿No tienes tu teléfono? Usa un código de respaldo";
const BACKUP_SUBMIT = "Entrar con el código de respaldo";
const BACKUP_INVALID =
  "Ese código de respaldo no sirve. Revisa cómo lo escribiste; cada código sirve una sola vez.";
const BACKUP_USED_NOTICE_SUBJECT = "Se usó un código de respaldo en tu cuenta";
const BACKUP_WARNING =
  "Al usarlo, la verificación en dos pasos se desactiva y tendrás que activarla de nuevo con tu teléfono.";
const AFTER_BACKUP_NOTICE =
  "Entraste con un código de respaldo. Desactivamos la verificación en dos pasos y cerramos tus otras sesiones. Actívala de nuevo con tu teléfono; si recuperas el anterior, borra de su aplicación la entrada vieja de Cotiza Prime.";
const SECOND_STEP_URL = /\/ingresar\/codigo$/;
const RATE_LIMITED = /Demasiados intentos/;
const NEW_PASSWORD = "otra-clave-nueva-456";
const STEP_SECONDS = 30;
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Un código de respaldo con la forma correcta que NO es de nadie (de 60 bits al azar: no choca con uno real). */
function randomBackupCode(): string {
  let code = "";
  for (let index = 0; index < 12; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (index % 4 === 3 && index < 11) code += "-";
  }
  return code;
}

/** Un código de 6 números que NO sirve: ninguno de los de este período ni el anterior o el siguiente. */
function wrongTotp(secret: string): string {
  const now = Date.now() / 1000;
  const valid = new Set([-1, 0, 1].map((shift) => totpAt(secret, now + shift * STEP_SECONDS)));
  for (;;) {
    const code = String(randomInt(100000, 1000000));
    if (!valid.has(code)) return code;
  }
}

/** Cuenta nueva con organización, la verificación en dos pasos activa y sus 10 códigos de respaldo. */
async function createProtectedAccount(page: Page, label: string) {
  const { email, secret } = await startEnrollment(page, label);
  const first = await freshTotp(secret);
  await submitEnrollmentConfirmation(page, first.code);
  const recoveryCodes = await finishRecoveryCodes(page);
  return { email, secret, step: first.step, recoveryCodes };
}

/** Un navegador nuevo, sin sesión y con su propia IP (la aplicación limita intentos por IP). */
async function newVisitor(browser: Browser) {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  return { context, page: await context.newPage() };
}

/** Ingresa solo con la contraseña: queda en la pantalla del código (sesión a medias). */
async function logInPartially(page: Page, email: string, password = TEST_PASSWORD) {
  await page.goto("/ingresar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page).toHaveURL(SECOND_STEP_URL);
}

/** Cambia al formulario del código de respaldo y lo envía. */
async function submitBackupCode(page: Page, code: string) {
  if (!(await page.getByLabel(BACKUP_LABEL).isVisible())) {
    await page.getByRole("button", { name: BACKUP_LINK }).click();
  }
  await page.getByLabel(BACKUP_LABEL).fill(code);
  await page.getByRole("button", { name: BACKUP_SUBMIT }).click();
}

/**
 * Envía un código de respaldo que NO va a servir y espera a que termine ESE intento: React vacía el campo al terminar la acción,
 * y el mensaje de un intento anterior puede seguir a la vista (el estado del formulario se conserva al cambiar de pantalla), así
 * que ver el mensaje no basta para saber que ya respondió.
 */
async function submitRejectedBackupCode(page: Page, code: string) {
  await submitBackupCode(page, code);
  await expect(page.getByLabel(BACKUP_LABEL)).toHaveValue("");
  await expect(page.getByText(BACKUP_INVALID)).toBeVisible();
}

/** Pide el enlace de «¿Olvidaste tu contraseña?» y lo abre en `page`: queda en la pantalla del código (sesión a medias del enlace). */
async function openRecoveryLink(page: Page, email: string) {
  await page.goto("/recuperar-contrasena");
  await page.getByLabel("Correo").fill(email);
  await page.getByRole("button", { name: "Enviar enlace" }).click();
  await expect(page.getByTestId("reset-request-sent")).toBeVisible();
  await openVerificationLink(
    page,
    await waitForVerificationLink(email, "Elige"),
    "/auth/recuperar",
  );
  await expect(page).toHaveURL(SECOND_STEP_URL);
}

test("entrar con un código de respaldo: uno malo no sirve; uno bueno desactiva la verificación, cierra la otra sesión, avisa por correo y no se puede repetir; al activar de nuevo hay códigos nuevos", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const account = await createProtectedAccount(page, "usarcodigo");
  const [first, second] = account.recoveryCodes;

  // Otra sesión completa de la misma cuenta (contraseña y código de la aplicación).
  const other = await newVisitor(browser);
  await logInPartially(other.page, account.email);
  const entry = await freshTotp(account.secret, { avoidStep: account.step });
  await other.page.getByLabel(CODE_LABEL).fill(entry.code);
  await other.page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(other.page).not.toHaveURL(/\/ingresar/);

  // Quien tiene solo la contraseña llega a la pantalla del código y ve el aviso de que el código de respaldo desactiva el segundo paso.
  const visitor = await newVisitor(browser);
  await logInPartially(visitor.page, account.email);
  await expect(
    visitor.page.getByText("Si no tienes la aplicación ni tus códigos de respaldo"),
  ).toBeVisible();
  await visitor.page.getByRole("button", { name: BACKUP_LINK }).click();
  await expect(visitor.page.getByLabel(BACKUP_LABEL)).toBeFocused();
  await expect(visitor.page.getByText(BACKUP_WARNING)).toBeVisible();

  // 6 números es el código de la aplicación: se le dice, sin gastar un intento.
  await submitBackupCode(visitor.page, "123456");
  await expect(visitor.page.getByText("Eso parece el código de tu aplicación.")).toBeVisible();

  // Uno malo (con la forma correcta): el mensaje único, el campo vacío y el foco en él.
  await submitBackupCode(visitor.page, randomBackupCode());
  await expect(visitor.page.getByText(BACKUP_INVALID)).toBeVisible();
  await expect(visitor.page.getByLabel(BACKUP_LABEL)).toHaveValue("");
  await expect(visitor.page.getByLabel(BACKUP_LABEL)).toBeFocused();
  expect(await codeHashesOf(account.email)).toHaveLength(10);

  // Uno bueno (escrito en minúsculas y sin guiones, como lo teclearía alguien): entra y lleva a activar de nuevo.
  await submitBackupCode(visitor.page, first.toLowerCase().replaceAll("-", ""));
  await expect(visitor.page).toHaveURL(/\/cuenta\/seguridad\?aviso=respaldo$/);
  await expect(visitor.page.getByText(AFTER_BACKUP_NOTICE)).toBeVisible();
  await expect(visitor.page.getByRole("button", { name: ENABLE_BUTTON })).toBeVisible();
  await expect(visitor.page.getByTestId("two-step-active")).toHaveCount(0);
  // Se quitó el factor, el código quedó usado y el resto del juego se borró.
  expect(await codeHashesOf(account.email)).toHaveLength(1);

  // La otra sesión quedó fuera y llegó el aviso por correo, sin ningún código.
  await other.page.goto("/cuenta/seguridad");
  await expect(other.page).toHaveURL(/\/ingresar/);
  await expect.poll(() => countMails(account.email, BACKUP_USED_NOTICE_SUBJECT)).toBe(1);

  // La contraseña sola ya entra directo (no hay verificación que pedir) y el mismo código no sirve otra vez.
  const again = await newVisitor(browser);
  await again.page.goto("/ingresar");
  await again.page.getByLabel("Correo").fill(account.email);
  await again.page.getByLabel("Contraseña").fill(TEST_PASSWORD);
  await again.page.getByRole("button", { name: "Ingresar" }).click();
  await expect(again.page).not.toHaveURL(/\/ingresar/);

  // Al activar de nuevo con el teléfono nuevo salen 10 códigos DISTINTOS y los viejos dejan de servir.
  const reenabled = await activateTwoStep(visitor.page);
  expect(reenabled.recoveryCodes).toHaveLength(10);
  expect(reenabled.recoveryCodes.filter((item) => account.recoveryCodes.includes(item))).toEqual(
    [],
  );
  const stranger = await newVisitor(browser);
  await logInPartially(stranger.page, account.email);
  for (const oldCode of [first, second]) {
    await submitRejectedBackupCode(stranger.page, oldCode);
    await expect(stranger.page).toHaveURL(SECOND_STEP_URL);
  }
  // Y uno de los nuevos sí sirve.
  await submitBackupCode(stranger.page, reenabled.recoveryCodes[0]);
  await expect(stranger.page).toHaveURL(/\/cuenta\/seguridad\?aviso=respaldo$/);
  await expect.poll(() => countMails(account.email, BACKUP_USED_NOTICE_SUBJECT)).toBe(2);
  for (const visit of [other, visitor, again, stranger]) await visit.context.close();
});

test("olvidé la contraseña y perdí el teléfono: enlace del correo, código de respaldo y elegir la contraseña nueva", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const account = await createProtectedAccount(page, "olvido");
  const owner = await newVisitor(browser);
  await openRecoveryLink(owner.page, account.email);

  // Por el enlace del correo no hay contraseña que cambiar con el bloqueo de 24 h: la pantalla es la misma, con la salida del código de respaldo.
  await submitBackupCode(owner.page, account.recoveryCodes[3]);
  await expect(owner.page).toHaveURL(/\/restablecer-contrasena$/);
  await owner.page.locator("input[name=password]").fill(NEW_PASSWORD);
  await owner.page.locator("input[name=confirmPassword]").fill(NEW_PASSWORD);
  await owner.page.getByRole("button", { name: "Cambiar contraseña" }).click();
  await expect(owner.page).not.toHaveURL(/\/restablecer-contrasena|\/ingresar/);
  await expect.poll(() => countMails(account.email, BACKUP_USED_NOTICE_SUBJECT)).toBe(1);

  // Con la contraseña nueva entra directo: ya no hay verificación en dos pasos; la otra sesión (la de la activación) quedó fuera.
  const back = await newVisitor(browser);
  await back.page.goto("/ingresar");
  await back.page.getByLabel("Correo").fill(account.email);
  await back.page.getByLabel("Contraseña").fill(NEW_PASSWORD);
  await back.page.getByRole("button", { name: "Ingresar" }).click();
  await expect(back.page).not.toHaveURL(/\/ingresar/);
  await page.goto("/cuenta/seguridad");
  await expect(page).toHaveURL(/\/ingresar/);
  for (const visit of [owner, back]) await visit.context.close();
});

test("el límite: 5 intentos mezclados (aplicación y respaldo) y el sexto se rechaza, también con un código bueno; por el enlace del correo la misma cuenta todavía entra", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const account = await createProtectedAccount(page, "limite");
  const visitor = await newVisitor(browser);
  await logInPartially(visitor.page, account.email);

  // Cinco intentos que alternan el código de la aplicación y el de respaldo.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (attempt % 2 === 1) {
      await submitRejectedBackupCode(visitor.page, randomBackupCode());
      // Vuelve al formulario de la aplicación para el siguiente.
      await visitor.page.getByRole("button", { name: "Volver al código de mi aplicación" }).click();
    } else {
      await visitor.page.getByLabel(CODE_LABEL).fill(wrongTotp(account.secret));
      await visitor.page.getByRole("button", { name: "Verificar", exact: true }).click();
      // Termina ESE intento: React vacía el campo al responder (el mensaje de uno anterior puede seguir a la vista).
      await expect(visitor.page.getByLabel(CODE_LABEL)).toHaveValue("");
      await expect(
        visitor.page.getByText(/El código no coincide|Ese código ya se usó/),
      ).toBeVisible();
    }
    await expect(visitor.page.getByText(RATE_LIMITED)).toHaveCount(0);
  }
  // El sexto: bloqueado. Ni con uno de respaldo bueno entra, y ese código no se gasta.
  await visitor.page.getByRole("button", { name: BACKUP_LINK }).click();
  await visitor.page.getByLabel(BACKUP_LABEL).fill(account.recoveryCodes[0]);
  await visitor.page.getByRole("button", { name: BACKUP_SUBMIT }).click();
  await expect(visitor.page.getByText(RATE_LIMITED)).toBeVisible();
  await expect(visitor.page).toHaveURL(SECOND_STEP_URL);
  expect(await codeHashesOf(account.email)).toHaveLength(10);

  // Quien llega con el enlace del correo tiene sus propios contadores: la dueña todavía entra.
  const owner = await newVisitor(browser);
  await openRecoveryLink(owner.page, account.email);
  const code = await freshTotp(account.secret, { avoidStep: account.step });
  await owner.page.getByLabel(CODE_LABEL).fill(code.code);
  await owner.page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(owner.page).toHaveURL(/\/restablecer-contrasena$/);
  for (const visit of [visitor, owner]) await visit.context.close();
});

/** Contraste (WCAG) entre el texto de un elemento y el fondo que realmente se ve detrás. */
async function contrastOf(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const channels = (color: string) =>
        (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((value) => Number(value));
      const luminance = ([r, g, b]: number[]) => {
        const lin = (value: number) => {
          const unit = value / 255;
          return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const backgroundOf = (element: Element | null): string => {
        for (let current = element; current; current = current.parentElement) {
          const color = getComputedStyle(current).backgroundColor;
          if (!/rgba?\(\s*0,\s*0,\s*0,\s*0\)|transparent/.test(color)) return color;
        }
        return "rgb(255, 255, 255)";
      };
      const foreground = luminance(channels(getComputedStyle(node).color));
      const background = luminance(channels(backgroundOf(node)));
      const [light, dark] =
        foreground > background ? [foreground, background] : [background, foreground];
      return (light + 0.05) / (dark + 0.05);
    });
}

test("la pantalla del código de respaldo en el teléfono (375 px): sin desplazamiento, con teclado, letra de 16 px, áreas de 44 px y contraste en claro y oscuro", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const account = await createProtectedAccount(page, "movilrespaldo");
  const visitor = await newVisitor(browser);
  const mobile = visitor.page;
  await mobile.setViewportSize({ width: 375, height: 812 });
  await mobile.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await logInPartially(mobile, account.email);

  const noOverflow = async (where: string) => {
    const overflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${where}: desplazamiento horizontal`).toBeLessThanOrEqual(0);
  };
  const smallTargets = () =>
    mobile.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("main button, main a[href], main input")]
        .filter((el) => el.offsetParent !== null && el.getAttribute("type") !== "hidden")
        .map((el) => ({
          label: el.textContent?.trim() || el.getAttribute("name"),
          box: el.getBoundingClientRect(),
        }))
        .filter(({ box }) => box.height < 44)
        .map(({ label }) => label),
    );
  await noOverflow("código de la aplicación");

  // Solo con el teclado: Tab hasta el enlace, Enter lo abre y el foco queda en el campo.
  const link = mobile.getByRole("button", { name: BACKUP_LINK });
  for (
    let presses = 0;
    presses < 6 && !(await link.evaluate((el) => el === document.activeElement));
    presses += 1
  ) {
    await mobile.keyboard.press("Tab");
  }
  await expect(link).toBeFocused();
  await mobile.keyboard.press("Enter");
  const field = mobile.getByLabel(BACKUP_LABEL);
  await expect(field).toBeFocused();

  await noOverflow("código de respaldo, oscuro");
  expect(await smallTargets()).toEqual([]);
  expect(
    await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  await expect(field).toHaveAttribute("autocomplete", "off");
  await expect(field).toHaveAttribute("autocapitalize", "characters");
  await expect(field).toHaveAttribute("spellcheck", "false");
  expect(await contrastOf(mobile, "main form p.bg-warning-soft")).toBeGreaterThanOrEqual(4.5);
  await mobile.screenshot({ path: testInfo.outputPath("respaldo-375-oscuro.png"), fullPage: true });

  // Enter envía el formulario; un error deja el campo vacío, el foco en él y el mensaje legible.
  await mobile.keyboard.type(randomBackupCode());
  await mobile.keyboard.press("Enter");
  await expect(mobile.getByText(BACKUP_INVALID)).toBeVisible();
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  await noOverflow("con el error");
  expect(await smallTargets()).toEqual([]);

  // Modo claro.
  await mobile.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  expect(await contrastOf(mobile, "main form p.bg-warning-soft")).toBeGreaterThanOrEqual(4.5);
  await noOverflow("código de respaldo, claro");
  await mobile.screenshot({ path: testInfo.outputPath("respaldo-375-claro.png"), fullPage: true });
  await visitor.context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------
// Etapa C · Desactivar la verificación en dos pasos (caso 5 del diseño).
// ---------------------------------------------------------------------------------------------------------------------------

const DISABLE_OPEN = "Desactivar la verificación en dos pasos";
const DISABLE_SUBMIT = "Desactivar la verificación";
const ANY_CODE_LABEL = "Código de tu aplicación o código de respaldo";
const DISABLED_NOTICE_SUBJECT = "Se pidió desactivar la verificación en dos pasos de tu cuenta";
const NOTICE_FAILED =
  "No pudimos enviarte el correo de aviso, así que no desactivamos la verificación. Inténtalo de nuevo en unos minutos.";
const WRONG_PASSWORD = "no-es-mi-clave-123";

/** Cuántos factores de la verificación en dos pasos tiene esa cuenta (solo lectura, base local de pruebas). */
async function factorCountOf(email: string): Promise<number> {
  const db = await connect();
  try {
    const { rows } = await db.query<{ total: string }>(
      `select count(*) as total from auth.mfa_factors f join auth.users u on u.id = f.user_id where u.email = $1`,
      [email],
    );
    return Number(rows[0].total);
  } finally {
    await db.end();
  }
}

/** Cuántos códigos de respaldo de esa cuenta están libres (ni usados ni tomados). */
async function freeCodesOf(email: string): Promise<number> {
  const db = await connect();
  try {
    const { rows } = await db.query<{ total: string }>(
      `select count(*) as total from public.mfa_recovery_codes c join auth.users u on u.id = c.user_id
        where u.email = $1 and c.used_at is null and (c.claimed_until is null or c.claimed_until < now())`,
      [email],
    );
    return Number(rows[0].total);
  } finally {
    await db.end();
  }
}

/** Abre la sección de desactivar y devuelve sus campos. */
async function openDisable(page: Page) {
  await page.goto("/cuenta/seguridad");
  await expect(page.getByTestId("two-step-active")).toBeVisible();
  await page.getByRole("button", { name: DISABLE_OPEN }).click();
  const section = page.getByTestId("disable-section");
  return {
    section,
    code: section.getByLabel(ANY_CODE_LABEL),
    password: section.getByLabel("Tu contraseña"),
    submit: section.getByRole("button", { name: DISABLE_SUBMIT, exact: true }),
  };
}

/** Otra sesión completa de la misma cuenta (contraseña y código de la aplicación), en un navegador aparte. */
async function otherFullSession(
  browser: Browser,
  account: { email: string; secret: string; step: number },
) {
  const other = await newVisitor(browser);
  await logInPartially(other.page, account.email);
  const entry = await freshTotp(account.secret, { avoidStep: account.step });
  await other.page.getByLabel(CODE_LABEL).fill(entry.code);
  await other.page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(other.page).not.toHaveURL(/\/ingresar/);
  return { ...other, step: entry.step };
}

test("desactivar con el código de la aplicación: la contraseña mala y el código malo no cambian nada; con los buenos se desactiva, llega el aviso, la otra sesión queda fuera y los códigos de respaldo se borran", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const account = await createProtectedAccount(page, "desactiva");
  const other = await otherFullSession(browser, account);
  const form = await openDisable(page);
  await expect(
    form.section.getByText("cerramos tu sesión en tus otros dispositivos"),
  ).toBeVisible();

  // Contraseña mala (con un código de la aplicación que SÍ sirve): error en su campo, no se gasta el código ni se avisa.
  const first = await freshTotp(account.secret, { avoidStep: other.step });
  await form.code.fill(first.code);
  await form.password.fill(WRONG_PASSWORD);
  await form.submit.click();
  await expect(page.getByText("La contraseña no es correcta.")).toBeVisible();
  expect(await factorCountOf(account.email)).toBe(1);
  expect(await countMails(account.email, DISABLED_NOTICE_SUBJECT)).toBe(0);

  // Contraseña buena y un código de la aplicación incorrecto: el error del código; sigue activa.
  await form.code.fill(wrongTotp(account.secret));
  await form.password.fill(TEST_PASSWORD);
  await form.submit.click();
  await expect(page.getByText("El código no coincide")).toBeVisible();
  expect(await factorCountOf(account.email)).toBe(1);

  // Contraseña buena y un código de respaldo que no existe: el mensaje único; sigue activa y los 10 códigos intactos.
  await form.code.fill(randomBackupCode());
  await form.password.fill(TEST_PASSWORD);
  await form.submit.click();
  await expect(page.getByText(BACKUP_INVALID)).toBeVisible();
  expect(await factorCountOf(account.email)).toBe(1);
  expect(await codeHashesOf(account.email)).toHaveLength(10);
  expect(await countMails(account.email, DISABLED_NOTICE_SUBJECT)).toBe(0);

  // Algo que no es un código: el error en su campo, sin gastar nada.
  await form.code.fill("hola");
  await form.password.fill(TEST_PASSWORD);
  await form.submit.click();
  await expect(page.getByText("Revisa cómo lo escribiste.")).toBeVisible();

  // Con todo bueno: se desactiva y se vuelve a la pantalla de seguridad con el aviso.
  const good = await freshTotp(account.secret, { avoidStep: other.step });
  await form.code.fill(good.code);
  await form.password.fill(TEST_PASSWORD);
  await form.submit.click();
  await expect(page).toHaveURL(/\/cuenta\/seguridad\?aviso=desactivada$/);
  await expect(
    page.getByText(
      `Desactivamos la verificación en dos pasos y cerramos tu sesión en tus otros dispositivos. Te enviamos un aviso a ${account.email}.`,
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: ENABLE_BUTTON })).toBeVisible();
  await expect(page.getByTestId("two-step-active")).toHaveCount(0);
  expect(await factorCountOf(account.email)).toBe(0);
  expect(await codeHashesOf(account.email)).toEqual([]);

  // Llegó el aviso (en presente, sin códigos) y la otra sesión quedó fuera.
  await expect.poll(() => countMails(account.email, DISABLED_NOTICE_SUBJECT)).toBe(1);
  await other.page.goto("/cuenta/seguridad");
  await expect(other.page).toHaveURL(/\/ingresar/);

  // Sin segundo paso, la contraseña sola ya entra directo; y se puede volver a activar con códigos NUEVOS.
  const again = await newVisitor(browser);
  await again.page.goto("/ingresar");
  await again.page.getByLabel("Correo").fill(account.email);
  await again.page.getByLabel("Contraseña").fill(TEST_PASSWORD);
  await again.page.getByRole("button", { name: "Ingresar" }).click();
  await expect(again.page).not.toHaveURL(/\/ingresar/);
  const reenabled = await activateTwoStep(page);
  expect(reenabled.recoveryCodes.filter((item) => account.recoveryCodes.includes(item))).toEqual(
    [],
  );
  for (const visit of [other, again]) await visit.context.close();
});

test("desactivar con un código de respaldo (sin el teléfono pero con la sesión abierta): se desactiva, avisa, cierra la otra sesión y el código ya no sirve", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const account = await createProtectedAccount(page, "desrespaldo");
  const other = await otherFullSession(browser, account);
  const form = await openDisable(page);

  // Escrito en minúsculas y sin guiones, como lo teclearía alguien. Con la contraseña mala no se toma el código.
  const typed = account.recoveryCodes[0].toLowerCase().replaceAll("-", "");
  await form.code.fill(typed);
  await form.password.fill(WRONG_PASSWORD);
  await form.submit.click();
  await expect(page.getByText("La contraseña no es correcta.")).toBeVisible();
  expect(await freeCodesOf(account.email)).toBe(10);
  expect(await factorCountOf(account.email)).toBe(1);

  await form.code.fill(typed);
  await form.password.fill(TEST_PASSWORD);
  await form.submit.click();
  await expect(page).toHaveURL(/\/cuenta\/seguridad\?aviso=desactivada$/);
  await expect(page.getByRole("button", { name: ENABLE_BUTTON })).toBeVisible();
  expect(await factorCountOf(account.email)).toBe(0);
  // El código usado y el resto del juego ya no sirven.
  expect(await codeHashesOf(account.email)).toEqual([]);
  await expect.poll(() => countMails(account.email, DISABLED_NOTICE_SUBJECT)).toBe(1);
  await other.page.goto("/cuenta/seguridad");
  await expect(other.page).toHaveURL(/\/ingresar/);
  await other.context.close();
});

test("si el correo de aviso no sale (destinatario fuera de la lista permitida), NO se desactiva: la verificación sigue activa y el código de respaldo no se pierde", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const email = `fuera-${randomInt(100000, 999999)}@otro-dominio.test`;
  await signUpAndVerify(page, email, "Persona Ficticia");
  await createTenant(page, "Empresa Sin Aviso", "76086428-5");

  // La activa por la API de Supabase con el permiso del servidor (con el correo fuera de la lista, la pantalla la revertiría).
  const { apiUrl, publishableKey } = localEnv();
  const login = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  expect(login.status).toBe(200);
  const body = (await login.json()) as {
    access_token: string;
    expires_at: number;
    user: { id: string };
  };
  const db = await connect();
  let secret: string;
  let usedStep: number;
  try {
    const enrolled = await enrollAndVerifyWithPermit(db, {
      accessToken: body.access_token,
      expiresAt: body.expires_at,
      userId: body.user.id,
    });
    secret = enrolled.secret;
    usedStep = enrolled.step;
  } finally {
    await db.end();
  }

  await page.context().clearCookies();
  await logInPartially(page, email);
  const entry = await freshTotp(secret, { avoidStep: usedStep });
  await page.getByLabel(CODE_LABEL).fill(entry.code);
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).not.toHaveURL(/\/ingresar/);

  // Crea sus códigos de respaldo (el aviso de esa creación es de mejor esfuerzo: no sale y no importa).
  await page.goto("/cuenta/seguridad");
  await page.getByRole("button", { name: "Crear códigos de respaldo", exact: true }).click();
  const created = await freshTotp(secret, { avoidStep: entry.step });
  await page.getByLabel(CODE_LABEL).fill(created.code);
  await page.getByLabel("Tu contraseña").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Crear códigos de respaldo", exact: true }).last().click();
  const codes = await finishRecoveryCodes(page, "codigos");

  // Con el código de la aplicación: el aviso no sale, no se desactiva nada.
  const form = await openDisable(page);
  const attempt = await freshTotp(secret, { avoidStep: created.step });
  await form.code.fill(attempt.code);
  await form.password.fill(TEST_PASSWORD);
  await form.submit.click();
  await expect(page.getByText(NOTICE_FAILED)).toBeVisible();
  await expect(page).toHaveURL(/\/cuenta\/seguridad$/);
  expect(await factorCountOf(email)).toBe(1);
  expect(await codeHashesOf(email)).toHaveLength(10);

  // Con un código de respaldo: tampoco, y el código se SUELTA (sigue libre, sin usar ni tomar).
  await form.code.fill(codes[0]);
  await form.password.fill(TEST_PASSWORD);
  await form.submit.click();
  await expect(page.getByText(NOTICE_FAILED)).toBeVisible();
  expect(await factorCountOf(email)).toBe(1);
  expect(await freeCodesOf(email)).toBe(10);
  await page.goto("/cuenta/seguridad");
  await expect(page.getByTestId("two-step-active")).toBeVisible();
});
