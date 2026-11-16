import { readFile } from "node:fs/promises";
import { connect } from "../tests/db/helpers";
import { localEnv } from "../tests/support/local-supabase";
import { enrollAndVerifyWithPermit } from "../tests/support/mfa-gate";
import { freshTotp } from "../src/test/totp";
import { expect, test, type Page } from "./fixtures";
import {
  TEST_PASSWORD,
  countMails,
  createTenant,
  finishRecoveryCodes,
  signUpAndVerify,
  submitEnrollmentConfirmation,
  uniqueEmail,
} from "./helpers";

// H-004b · Códigos de respaldo: crearlos al activar, generar nuevos y crearlos en una cuenta activada antes. En SERIE y solo con
// cuentas nuevas @ejemplo.test (activar un factor cierra las demás sesiones de la cuenta). Entrar con un código de respaldo y
// desactivar son de los pasos 5 y 6 de la historia.
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
