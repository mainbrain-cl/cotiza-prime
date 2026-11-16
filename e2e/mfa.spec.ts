import { randomInt, randomUUID } from "node:crypto";
import jsQR from "jsqr";
import sharp from "sharp";
import { connect } from "../tests/db/helpers";
import { APP_ROUTES } from "../tests/isolation/registry";
import { freshTotp, totpAt } from "../src/test/totp";
import type { Browser } from "@playwright/test";
import { expect, randomTestIp, test, type Page } from "./fixtures";
import {
  TEST_PASSWORD,
  countMails,
  createTenant,
  openVerificationLink,
  signUpAndVerify,
  submitEnrollmentConfirmation,
  uniqueEmail,
  waitForVerificationLink,
} from "./helpers";

// H-004a · Verificación en dos pasos, de punta a punta. En SERIE y solo con cuentas nuevas @ejemplo.test: activar un factor
// cierra las demás sesiones de la cuenta y Supabase Auth tiene un cupo de verificaciones por IP. Los códigos se calculan
// desde la clave que muestra la pantalla (src/test/totp.ts), igual que los calcularía el teléfono.
test.describe.configure({ mode: "serial" });

const CODE_LABEL = "Código de 6 números";
const SECOND_STEP_URL = /\/ingresar\/codigo$/;
const NEW_PASSWORD = "otra-clave-nueva-456";
const STEP_SECONDS = 30;
const RATE_LIMITED = /Demasiados intentos/;

type Account = {
  email: string;
  tenantId: string;
  secret: string;
  /** Período (de 30 s) del último código usado: el siguiente tiene que ser de otro período. */
  usedStep: number;
  /** Solo si la prueba de recuperar la contraseña la cambió. */
  password?: string;
};

/** Un código que NO sirve: ninguno de los de este período ni el anterior o el siguiente (Supabase tolera uno de margen). */
function wrongCode(secret: string): string {
  const now = Date.now() / 1000;
  const valid = new Set([-1, 0, 1].map((shift) => totpAt(secret, now + shift * STEP_SECONDS)));
  for (;;) {
    const code = String(randomInt(100000, 1000000));
    if (!valid.has(code)) return code;
  }
}

async function logIn(page: Page, email: string, password = TEST_PASSWORD) {
  await page.goto("/ingresar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
}

/** La pantalla del código tras la contraseña (ingresar): solo el código. */
async function submitCode(page: Page, code: string) {
  const field = page.getByLabel(CODE_LABEL);
  await field.fill(code);
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
}

/** El último paso de ACTIVAR: el código y, desde H-004b, también la contraseña. */
async function submitEnrollment(page: Page, code: string, password = TEST_PASSWORD) {
  await submitEnrollmentConfirmation(page, code, password);
}

/** Cuenta nueva con su organización y la verificación en dos pasos ya activa. La sesión queda completa (aal2). */
async function createAccountWithSecondStep(page: Page, label: string): Promise<Account> {
  const email = uniqueEmail(label);
  await signUpAndVerify(page, email, "Persona Ficticia");
  const tenantId = await createTenant(page, `Empresa ${label}`, "76086428-5");

  // Desde el menú, igual que lo haría la persona.
  await page
    .locator('aside[aria-label="Menú lateral"]')
    .getByRole("link", { name: "Seguridad de tu cuenta" })
    .click();
  await expect(page).toHaveURL(/\/cuenta\/seguridad$/);
  await page.getByRole("button", { name: "Activar la verificación en dos pasos" }).click();
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  await page.getByRole("button", { name: "Ya la escaneé" }).click();
  const { code, step } = await freshTotp(secret);
  await submitEnrollment(page, code);
  await expect(page).toHaveURL(/\/cuenta\/seguridad\?aviso=activada$/);
  return { email, tenantId, secret, usedStep: step };
}

/** Ingresa solo con la contraseña (sesión parcial) en un navegador sin sesión. */
async function logInPartially(page: Page, account: Account) {
  await page.context().clearCookies();
  await logIn(page, account.email, account.password);
  await expect(page).toHaveURL(SECOND_STEP_URL);
}

async function nextCode(account: Account): Promise<string> {
  const { code, step } = await freshTotp(account.secret, { avoidStep: account.usedStep });
  account.usedStep = step;
  return code;
}

/** Lee un código QR de una captura de pantalla (se agranda sin suavizar para que la lectura no dependa del tamaño). */
async function readQr(png: Buffer): Promise<string> {
  const { data, info } = await sharp(png)
    .resize({ width: 800, kernel: "nearest" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const result = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  if (!result) throw new Error("No se pudo leer el código QR de la pantalla");
  return result.data;
}

let main: Account;

test("activar: desde el menú, con el QR y la clave; un código incorrecto no activa; el correcto sí y cierra las otras sesiones", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("activa");
  await signUpAndVerify(page, email, "Persona Ficticia");
  const tenantId = await createTenant(page, "Empresa Activa", "76086428-5");

  // Sin verificación activa se entra directo, y otra ventana abierta con la misma cuenta.
  const baseURL = test.info().project.use.baseURL;
  const otherContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  const otherPage = await otherContext.newPage();
  await logIn(otherPage, email);
  await expect(otherPage).toHaveURL(new RegExp(`/o/${tenantId}$`));

  // El enlace está fuera del menú «Principal» y lo ve la Dueña.
  await expect(
    page
      .locator('nav[aria-label="Principal"]')
      .getByRole("link", { name: "Seguridad de tu cuenta" }),
  ).toHaveCount(0);
  await page
    .locator('aside[aria-label="Menú lateral"]')
    .getByRole("link", { name: "Seguridad de tu cuenta" })
    .click();
  await expect(page).toHaveURL(/\/cuenta\/seguridad$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Seguridad de tu cuenta");

  await page.getByRole("button", { name: "Activar la verificación en dos pasos" }).click();
  // El QR es una imagen que carga de verdad y la clave se puede leer a mano.
  const qr = page.getByRole("img", { name: "Código QR para tu aplicación de códigos" });
  await expect(qr).toBeVisible();
  expect(await qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(
    true,
  );
  const secretText = await page.getByTestId("totp-secret").innerText();
  expect(secretText).toMatch(/^([A-Z2-7]{4} ){3,}[A-Z2-7]{1,4}$/);
  const secret = secretText.replace(/\s/g, "");
  // El QR se lee de verdad (como lo haría la cámara) y trae la MISMA clave que se muestra para escribir a mano.
  const scanned = await readQr(await qr.screenshot());
  expect(scanned).toMatch(/^otpauth:\/\/totp\//);
  expect(new URL(scanned).searchParams.get("secret")).toBe(secret);
  expect(scanned).toContain("Cotiza%20Prime");
  // Ni la clave ni el código viajan en la dirección.
  expect(page.url()).not.toContain(secret);

  await page.getByRole("button", { name: "Ya la escaneé" }).click();
  await expect(page.getByLabel(CODE_LABEL)).toBeFocused();
  // Un código incorrecto no activa nada.
  await submitEnrollment(page, wrongCode(secret));
  await expect(page.getByText(/El código no coincide/)).toBeVisible();
  await expect(page).toHaveURL(/\/cuenta\/seguridad$/);
  await expect(page.getByLabel(CODE_LABEL)).toBeFocused();
  await expect(page.getByLabel(CODE_LABEL)).toHaveValue("");

  // Una contraseña incorrecta (H-004b) no activa nada ni gasta el código: el MISMO código sirve después con la contraseña buena.
  const { code, step } = await freshTotp(secret);
  await submitEnrollment(page, code, "contrasena-equivocada-999");
  await expect(page.getByText("La contraseña no es correcta.")).toBeVisible();
  await expect(page).toHaveURL(/\/cuenta\/seguridad$/);
  const passwordField = page.getByLabel("Tu contraseña");
  await expect(passwordField).toBeFocused();
  await expect(passwordField).toHaveValue("");
  await expect(passwordField).toHaveAttribute("autocomplete", "current-password");
  // El correo va en un campo oculto para el gestor de contraseñas, sin nombre (no viaja en el envío).
  await expect(page.locator('input[autocomplete="username"]')).toHaveValue(email);
  await expect(page.locator('input[autocomplete="username"]')).not.toHaveAttribute("name", /.+/);

  // Con el código de verdad y la contraseña buena, se activa.
  await submitEnrollment(page, code);
  await expect(page).toHaveURL(/\/cuenta\/seguridad\?aviso=activada$/);
  await expect(page.getByTestId("two-step-active")).toBeVisible();
  await expect(page.getByText(/Está activa desde el \d{2}-\d{2}-\d{4}/)).toBeVisible();

  // La sesión que activó sigue; la otra ventana quedó fuera.
  await page.goto(`/o/${tenantId}`);
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
  await otherPage.goto(`/o/${tenantId}`);
  await expect(otherPage).toHaveURL(/\/ingresar/);
  await otherContext.close();

  // El aviso lo envía NUESTRO servidor (H-118a), no Supabase: llega a Mailpit con el botón para anular la activación.
  await expect.poll(() => countMails(email, "activó"), { timeout: 30_000 }).toBeGreaterThan(0);
  main = { email, tenantId, secret, usedStep: step };
});

test("una sesión parcial no pasa: solo con la contraseña, todo lleva al código; el incorrecto se queda; el correcto entra", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await logInPartially(page, main);
  await expect(page.getByLabel(CODE_LABEL)).toBeFocused();
  await expect(page.getByText(main.email)).toBeVisible();

  // Pantallas de la organización (con su identificador real y con uno al azar) y las que no son de una organización.
  const ownTenant = main.tenantId;
  const pages = APP_ROUTES.filter((r) => r.scope === "tenant" && r.kind === "page").map((r) =>
    r.path.replace("[tenantId]", ownTenant).replace(/\[[a-zA-Z]+\]/g, () => randomUUID()),
  );
  expect(pages.length).toBeGreaterThan(20);
  for (const path of [
    ...pages,
    `/o/${randomUUID()}`,
    "/",
    "/ingresar",
    "/aceptar-terminos",
    "/cuenta/seguridad",
    "/organizaciones/nueva",
    "/invitacion",
    "/restablecer-contrasena",
  ]) {
    await page.goto(path);
    await expect(page, `${path} debe llevar al código`).toHaveURL(SECOND_STEP_URL);
  }
  // Las rutas de la API responden 401, no datos.
  for (const route of APP_ROUTES.filter((r) => r.scope === "tenant" && r.kind === "api")) {
    const path = route.path
      .replace("[tenantId]", ownTenant)
      .replace(/\[[a-zA-Z]+\]/g, () => randomUUID());
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(401);
  }

  // El código incorrecto se queda en la pantalla.
  await page.goto("/ingresar/codigo");
  await submitCode(page, wrongCode(main.secret));
  await expect(page.getByText(/El código no coincide/)).toBeVisible();
  await expect(page).toHaveURL(SECOND_STEP_URL);
  await expect(page.getByLabel(CODE_LABEL)).toBeFocused();

  // El correcto, de otro período, entra; Enter envía.
  await page.getByLabel(CODE_LABEL).fill(await nextCode(main));
  await page.getByLabel(CODE_LABEL).press("Enter");
  await expect(page).toHaveURL(new RegExp(`/o/${ownTenant}$`));
  // Ya con sesión completa, la pantalla del código lleva al inicio (no hay nada que verificar).
  await page.goto("/ingresar/codigo");
  await expect(page).toHaveURL(new RegExp(`/o/${ownTenant}$`));
});

test("un código usado no sirve otra vez; el del período siguiente sí", async ({ page }) => {
  test.setTimeout(240_000);
  await logInPartially(page, main);
  // El mismo código con que se acaba de entrar (de este período o del anterior que Supabase aún acepta).
  await submitCode(page, totpAt(main.secret, main.usedStep * STEP_SECONDS));
  await expect(page.getByText("Ese código ya se usó. Espera el siguiente.")).toBeVisible();
  await expect(page).toHaveURL(SECOND_STEP_URL);
  await submitCode(page, await nextCode(main));
  await expect(page).toHaveURL(new RegExp(`/o/${main.tenantId}$`));
});

test("el límite: cinco intentos y el sexto se rechaza, también el código correcto; el camino de recuperación por correo NO queda bloqueado", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const account = await createAccountWithSecondStep(page, "limite");
  await logInPartially(page, account);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await submitCode(page, wrongCode(account.secret));
    // El botón vuelve a «Verificar» cuando termina la respuesta de este intento.
    await expect(page.getByRole("button", { name: "Verificar" })).toBeVisible();
    await expect(page.getByText(/El código no coincide|Ese código ya se usó/)).toBeVisible();
    await expect(page.getByText(RATE_LIMITED)).toHaveCount(0);
  }
  await submitCode(page, wrongCode(account.secret));
  await expect(page.getByText(RATE_LIMITED)).toBeVisible();
  // Bloqueada: el código de verdad tampoco entra.
  await submitCode(page, await nextCode(account));
  await expect(page.getByText(RATE_LIMITED)).toBeVisible();
  await expect(page).toHaveURL(SECOND_STEP_URL);

  // Quien solo tiene la contraseña (y gastó los intentos del ingreso) no puede cerrarle el camino al dueño que llega con el
  // enlace de recuperación del correo: ese camino tiene sus propios contadores, y el código correcto entra.
  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  const ownerPage = await context.newPage();
  await ownerPage.goto("/recuperar-contrasena");
  await ownerPage.getByLabel("Correo").fill(account.email);
  await ownerPage.getByRole("button", { name: "Enviar enlace" }).click();
  await expect(ownerPage.getByTestId("reset-request-sent")).toBeVisible();
  await openVerificationLink(
    ownerPage,
    await waitForVerificationLink(account.email, "Elige"),
    "/auth/recuperar",
  );
  await expect(ownerPage).toHaveURL(SECOND_STEP_URL);
  await ownerPage.getByLabel(CODE_LABEL).fill(await nextCode(account));
  await ownerPage.getByRole("button", { name: "Verificar" }).click();
  await expect(ownerPage).toHaveURL(/\/restablecer-contrasena$/);
  await context.close();
});

test("recuperar la contraseña con la verificación activa: primero el código, después la contraseña nueva", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  const resetPage = await context.newPage();
  await resetPage.goto("/recuperar-contrasena");
  await resetPage.getByLabel("Correo").fill(main.email);
  await resetPage.getByRole("button", { name: "Enviar enlace" }).click();
  await expect(resetPage.getByTestId("reset-request-sent")).toBeVisible();
  const link = await waitForVerificationLink(main.email, "Elige");
  await openVerificationLink(resetPage, link, "/auth/recuperar");

  // El enlace del correo no basta: lleva al código.
  await expect(resetPage).toHaveURL(SECOND_STEP_URL);
  await resetPage.goto("/restablecer-contrasena");
  await expect(resetPage).toHaveURL(SECOND_STEP_URL);
  await resetPage.getByLabel(CODE_LABEL).fill(await nextCode(main));
  await resetPage.getByRole("button", { name: "Verificar" }).click();
  await expect(resetPage).toHaveURL(/\/restablecer-contrasena$/);
  await resetPage.locator("input[name=password]").fill(NEW_PASSWORD);
  await resetPage.locator("input[name=confirmPassword]").fill(NEW_PASSWORD);
  await resetPage.getByRole("button", { name: "Cambiar contraseña" }).click();
  await expect(resetPage).not.toHaveURL(/\/restablecer-contrasena/);
  await expect(resetPage).not.toHaveURL(/\/ingresar/);

  // La contraseña nueva sirve y sigue pidiendo el código.
  await page.context().clearCookies();
  await logIn(page, main.email, NEW_PASSWORD);
  await expect(page).toHaveURL(SECOND_STEP_URL);
  main.password = NEW_PASSWORD;
  await context.close();
});

test("en el teléfono (375 px, con movimiento reducido): el código y la activación no se desbordan, con áreas táctiles de 44 px y el teclado correcto", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 375, height: 812 });
  // «Reducir movimiento» activado: las pantallas funcionan igual (los fondos y las entradas animadas se apagan).
  await page.emulateMedia({ reducedMotion: "reduce" });
  const email = uniqueEmail("movil");
  await signUpAndVerify(page, email, "Persona Ficticia");
  // Con «reducir movimiento», la animación de entrada de la tarjeta queda sin duración (no se mueve).
  const entryAnimation = async () =>
    page.evaluate(() => {
      const el = document.querySelector("main .animate-enter");
      return el ? getComputedStyle(el).animationDuration : "sin-tarjeta";
    });
  expect(await entryAnimation()).toBe("0s");
  await createTenant(page, "Empresa Móvil", "76086428-5");

  const noOverflow = async (where: string) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${where}: desplazamiento horizontal`).toBeLessThanOrEqual(0);
  };
  const tooSmall = async (where: string) => {
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("main button, main a[href], main input")]
        .filter(
          (el) =>
            el.offsetParent !== null &&
            el.getAttribute("type") !== "hidden" &&
            el.getAttribute("aria-hidden") !== "true",
        )
        .filter((el) => el.getBoundingClientRect().height < 44)
        .map((el) => el.textContent?.trim() || el.getAttribute("name") || el.tagName),
    );
    expect(small, `${where}: áreas táctiles menores a 44 px`).toEqual([]);
  };

  // En el teléfono el acceso está en «Más».
  await page.getByRole("button", { name: "Más" }).click();
  await page.getByRole("menuitem", { name: "Seguridad de tu cuenta" }).click();
  await expect(page).toHaveURL(/\/cuenta\/seguridad$/);
  await noOverflow("seguridad, sin activar");
  await tooSmall("seguridad, sin activar");

  await page.getByRole("button", { name: "Activar la verificación en dos pasos" }).click();
  await expect(page.getByTestId("totp-secret")).toBeVisible();
  await expect(page.getByRole("link", { name: "Abrir en mi aplicación de códigos" })).toBeVisible();
  await noOverflow("seguridad, escanear");
  await tooSmall("seguridad, escanear");
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  await page.getByRole("button", { name: "Ya la escaneé" }).click();
  const field = page.getByLabel(CODE_LABEL);
  await expect(field).toHaveAttribute("inputmode", "numeric");
  await expect(field).toHaveAttribute("autocomplete", "one-time-code");
  expect(
    await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  const passwordField = page.getByLabel("Tu contraseña");
  expect(
    await passwordField.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  await noOverflow("seguridad, confirmar");
  await tooSmall("seguridad, confirmar");
  const { code } = await freshTotp(secret);
  await submitEnrollment(page, code);
  await expect(page).toHaveURL(/\/cuenta\/seguridad\?aviso=activada$/);
  await noOverflow("seguridad, activada");

  // La pantalla del código, con la contraseña sola.
  await page.context().clearCookies();
  await logIn(page, email);
  await expect(page).toHaveURL(SECOND_STEP_URL);
  expect(await entryAnimation()).toBe("0s");
  await noOverflow("código");
  await tooSmall("código");
  await expect(page.getByLabel(CODE_LABEL)).toHaveAttribute("inputmode", "numeric");
});

test("cerrar sesión desde la pantalla del código: la sesión parcial se cierra y vuelve a ingresar", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await logInPartially(page, main);
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await expect(page).toHaveURL(/\/ingresar\?aviso=sesion-cerrada$/);
  // Ya sin sesión, la pantalla del código no deja pasar a nadie.
  await page.goto("/ingresar/codigo");
  await expect(page).toHaveURL(/\/ingresar$/);
  await page.goto(`/o/${main.tenantId}`);
  await expect(page).toHaveURL(/\/ingresar$/);
});

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";

/** Espera el correo de la invitación y devuelve el enlace tal como lo recibe la persona. */
async function waitForInviteLink(address: string): Promise<string> {
  let link: string | null = null;
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
        );
        const { messages } = (await search.json()) as { messages?: { ID: string }[] };
        for (const { ID } of messages ?? []) {
          const mail = (await (await fetch(`${MAILBOX_URL}/api/v1/message/${ID}`)).json()) as {
            Subject: string;
            HTML: string;
          };
          if (!mail.Subject.includes("te invitó a")) continue;
          link =
            /href="(https?:\/\/[^"]*\/invitacion\/[A-Za-z0-9_-]{43})"/.exec(mail.HTML)?.[1] ?? null;
        }
        return link;
      },
      { message: `Esperaba el correo de la invitación a ${address}`, timeout: 30_000 },
    )
    .not.toBeNull();
  return link!;
}

async function newOwner(browser: Browser) {
  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  const page = await context.newPage();
  await signUpAndVerify(page, uniqueEmail("dueno-mfa"), "Dueña Ficticia");
  const tenantId = await createTenant(page, "Empresa Invita", "76086428-5");
  return { context, page, tenantId };
}

async function invite(ownerPage: Page, tenantId: string, email: string, role: string) {
  await ownerPage.goto(`/o/${tenantId}/equipo`);
  await ownerPage.getByTestId("invite-email").fill(email);
  await ownerPage.getByTestId(`invite-role-${role}`).click();
  await ownerPage.getByTestId("invite-submit").click();
  await expect(ownerPage.getByText(`Enviamos la invitación a ${email}.`)).toBeVisible();
}

test("una invitación con la verificación activa: primero el código y después se retoma la invitación", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const owner = await newOwner(browser);
  // La persona invitada ya tiene la verificación activa (su propia cuenta y organización).
  const invitee = await createAccountWithSecondStep(page, "invitada");
  await invite(owner.page, owner.tenantId, invitee.email, "sales");
  const link = await waitForInviteLink(invitee.email);

  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  const inviteePage = await context.newPage();
  await inviteePage.goto(link);
  await expect(inviteePage).toHaveURL(/\/invitacion$/);
  await inviteePage.getByRole("link", { name: "Ingresar", exact: true }).click();
  await logIn(inviteePage, invitee.email);
  // La contraseña sola no basta: primero el código; la invitación sigue esperando en el navegador.
  await expect(inviteePage).toHaveURL(SECOND_STEP_URL);
  await inviteePage.goto("/invitacion");
  await expect(inviteePage).toHaveURL(SECOND_STEP_URL);
  await inviteePage.getByLabel(CODE_LABEL).fill(await nextCode(invitee));
  await inviteePage.getByRole("button", { name: "Verificar" }).click();
  await expect(inviteePage).toHaveURL(/\/invitacion$/);
  await expect(inviteePage.getByTestId("invitation-sentence")).toContainText("Empresa Invita");
  await inviteePage.getByRole("button", { name: "Unirme", exact: true }).click();
  await expect(inviteePage).toHaveURL(new RegExp(`/o/${owner.tenantId}$`));
  await context.close();
  await owner.context.close();
});

test("un Comercial activa la verificación en su propia cuenta (cualquier rol puede, de punta a punta)", async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const owner = await newOwner(browser);
  const email = uniqueEmail("comercial");
  await signUpAndVerify(page, email, "Comercial Ficticia");
  await createTenant(page, "Empresa Propia Comercial", "76086428-5");
  await invite(owner.page, owner.tenantId, email, "sales");
  const link = await waitForInviteLink(email);
  await page.goto(link);
  await expect(page).toHaveURL(/\/invitacion$/);
  await page.getByRole("button", { name: "Unirme", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${owner.tenantId}$`));

  // Ya como Comercial de esa organización, activa la verificación desde el menú.
  await page
    .locator('aside[aria-label="Menú lateral"]')
    .getByRole("link", { name: "Seguridad de tu cuenta" })
    .click();
  await expect(page).toHaveURL(/\/cuenta\/seguridad$/);
  await page.getByRole("button", { name: "Activar la verificación en dos pasos" }).click();
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  await page.getByRole("button", { name: "Ya la escaneé" }).click();
  await submitEnrollment(page, (await freshTotp(secret)).code);
  await expect(page).toHaveURL(/\/cuenta\/seguridad\?aviso=activada$/);
  await expect(page.getByTestId("two-step-active")).toBeVisible();
  // Y la organización del Dueño sigue abierta con sus permisos de Comercial.
  await page.goto(`/o/${owner.tenantId}`);
  await expect(page).toHaveURL(new RegExp(`/o/${owner.tenantId}$`));
  await owner.context.close();
});

/** Los factores de aplicación que Supabase guarda para esa cuenta (solo lectura, en la base local de pruebas). */
async function factorStatuses(email: string): Promise<string[]> {
  const db = await connect();
  try {
    const { rows } = await db.query<{ status: string }>(
      `select f.status::text as status from auth.mfa_factors f
         join auth.users u on u.id = f.user_id
        where u.email = $1 order by f.created_at`,
      [email],
    );
    return rows.map((row) => row.status);
  } finally {
    await db.end();
  }
}

const ENABLE_BUTTON = "Activar la verificación en dos pasos";

test("cancelar la activación quita de Supabase el intento a medias, desde el paso de la clave y desde el del código (menor 6)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail("cancela");
  await signUpAndVerify(page, email, "Persona Ficticia");
  await createTenant(page, "Empresa Cancela", "76086428-5");
  await page.goto("/cuenta/seguridad");

  // Paso de la clave: queda un factor sin verificar mientras se muestra, y se quita al cancelar.
  await page.getByRole("button", { name: ENABLE_BUTTON }).click();
  await expect(page.getByTestId("totp-secret")).toBeVisible();
  expect(await factorStatuses(email)).toEqual(["unverified"]);
  await page.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByRole("button", { name: ENABLE_BUTTON })).toBeFocused();
  await expect.poll(() => factorStatuses(email)).toEqual([]);

  // Paso del código: lo mismo.
  await page.getByRole("button", { name: ENABLE_BUTTON }).click();
  await page.getByRole("button", { name: "Ya la escaneé" }).click();
  await expect(page.getByLabel(CODE_LABEL)).toBeVisible();
  expect(await factorStatuses(email)).toEqual(["unverified"]);
  await page.getByRole("button", { name: "Cancelar" }).click();
  await expect.poll(() => factorStatuses(email)).toEqual([]);

  // Y se puede empezar de nuevo y activar, con un solo factor.
  await page.getByRole("button", { name: ENABLE_BUTTON }).click();
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  await page.getByRole("button", { name: "Ya la escaneé" }).click();
  await submitEnrollment(page, (await freshTotp(secret)).code);
  await expect(page).toHaveURL(/\/cuenta\/seguridad\?aviso=activada$/);
  expect(await factorStatuses(email)).toEqual(["verified"]);
});

test("activar desde dos pestañas a la vez: la que se quedó con el intento reemplazado ve «está activa», no «caducó» (menor 7)", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail("dospestanas");
  await signUpAndVerify(page, email, "Persona Ficticia");
  await createTenant(page, "Empresa Dos Pestanas", "76086428-5");
  const tabB = await context.newPage();

  async function startAndScan(tab: Page): Promise<string> {
    await tab.goto("/cuenta/seguridad");
    await tab.getByRole("button", { name: ENABLE_BUTTON }).click();
    const secret = (await tab.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
    await tab.getByRole("button", { name: "Ya la escaneé" }).click();
    await expect(tab.getByLabel(CODE_LABEL)).toBeVisible();
    return secret;
  }
  const secretA = await startAndScan(page);
  const secretB = await startAndScan(tabB);

  // La segunda pestaña activa la cuenta.
  await submitEnrollment(tabB, (await freshTotp(secretB)).code);
  await expect(tabB).toHaveURL(/\/cuenta\/seguridad\?aviso=activada$/);

  // La primera todavía muestra su intento (ya reemplazado): al confirmar, ve que la cuenta está activa.
  await submitEnrollment(page, (await freshTotp(secretA)).code);
  await expect(page).toHaveURL(/\/cuenta\/seguridad$/);
  await expect(page.getByTestId("two-step-active")).toBeVisible();
  await expect(page.getByText(/La activación caducó/)).toHaveCount(0);
  expect(await factorStatuses(email)).toEqual(["verified"]);
});
