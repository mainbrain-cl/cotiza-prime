import type { Client } from "pg";
import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import { localEnv } from "../tests/support/local-supabase";
import { expect, test, type Page } from "./fixtures";
import {
  TEST_PASSWORD,
  confirmEmailFromLink,
  countMails,
  createReadyAccount,
  createTenant,
  expectControlsInsideCard,
  openVerificationLink,
  registerThroughGateway,
  requestSignupLink,
  submitAccountSetup,
  submitSignupEmail,
  uniqueEmail,
  waitForAccountLink,
  waitForVerificationLink,
  SIGNUP_MAIL_SUBJECT,
} from "./helpers";

// H-116: el registro en dos pasos de punta a punta (correo → enlace del correo → nombre, contraseña y términos). Todo ficticio
// (@ejemplo.test): cada prueba usa correos únicos y su propia IP (fixtures.ts), así los topes no se mezclan. El ataque completo
// (registro previo con el correo de otra persona) está en `account-prehijack.spec.ts`.

const MOBILE = { width: 375, height: 812 };
const OFFLINE_TOAST = "[data-sonner-toast]";
const EXPIRED_TITLE = "Este enlace ya se usó o venció";
const LOCKED_MESSAGE = "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.";
const MIN_TOUCH_PX = 44;
const MIN_FIELD_FONT_PX = 16;
/** El tope de enlaces por correo es de 1 por minuto (`SIGNUP_LINK_MAX_PER_EMAIL_PER_MINUTE`): para pedir otro, se espera un poco más. */
const SIGNUP_MINUTE_WAIT_MS = 62_000;

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

type AccountRow = {
  id: string;
  email_confirmed_at: string | null;
  account_ready_at: string | null;
  signup_email: string | null;
  full_name: string;
  sessions: number;
  acceptances: number;
};

/** Lo que la base sabe de una cuenta: verificada o no, terminada o no, cuántas sesiones y aceptaciones de términos tiene. */
async function accountRow(email: string): Promise<AccountRow | undefined> {
  return withDb(async (db) => {
    const { rows } = await db.query<AccountRow>(
      `select u.id, u.email_confirmed_at::text, p.account_ready_at::text, p.signup_email, p.full_name,
              (select count(*)::int from auth.sessions s where s.user_id = u.id) as sessions,
              (select count(*)::int from public.legal_acceptances a where a.user_id = u.id) as acceptances
         from auth.users u join public.profiles p on p.user_id = u.id
        where u.email = $1`,
      [email],
    );
    return rows[0];
  });
}

/** Ingreso directo contra GoTrue con correo y contraseña: el estado HTTP y el código de error. */
async function passwordGrant(
  email: string,
  password: string,
): Promise<{ status: number; code: string | null; accessToken: string | null }> {
  const { apiUrl, publishableKey } = localEnv();
  const res = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { error_code?: string; access_token?: string };
  return {
    status: res.status,
    code: body.error_code ?? null,
    accessToken: body.access_token ?? null,
  };
}

async function noHorizontalScroll(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test("el registro completo: correo, enlace del correo, «Continuar», nombre y contraseña, y la primera organización", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail("registro");

  // Paso 1: solo el correo. No hay campo de contraseña ni de nombre en esta pantalla.
  await page.goto("/registro");
  await expect(page.getByRole("heading", { name: "Crea tu cuenta" })).toBeVisible();
  await expect(
    page.getByText("Primero confirmamos tu correo. Después eliges tu nombre y tu contraseña."),
  ).toBeVisible();
  await expect(page.locator("input[name=password]")).toHaveCount(0);
  await expect(page.locator("input[name=fullName]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enviarme el enlace" })).toBeVisible();

  await requestSignupLink(page, email);
  await expect(page.getByTestId("signup-sent-email")).toHaveText(email);

  // Mientras la persona no abre el enlace, la cuenta existe SIN verificar y sin nada escrito en su nombre.
  const link = await waitForAccountLink(email);
  const before = await accountRow(email);
  expect(before?.email_confirmed_at).toBeNull();
  expect(before?.account_ready_at).toBeNull();
  expect(before?.signup_email).toBe(email);
  expect(before?.acceptances).toBe(0);
  expect(before?.sessions).toBe(0);

  // El enlace apunta a NUESTRA aplicación (APP_ORIGIN) con el código y el tipo; nunca a Supabase.
  const url = new URL(link);
  expect(url.origin).toBe(baseURL);
  expect(url.pathname).toBe("/confirmar-correo");
  expect(url.searchParams.get("type")).toBe("invite");
  expect(url.searchParams.get("token_hash")?.length).toBeGreaterThan(20);
  expect(link).not.toContain("/auth/v1/");

  // Paso 2: «Continuar» abre la sesión y lleva a terminar la cuenta, con el correo a la vista.
  await confirmEmailFromLink(page, link);
  await expect(page.getByRole("heading", { name: "Termina de crear tu cuenta" })).toBeVisible();
  await expect(page.getByTestId("create-account-email")).toHaveText(email);
  const confirmed = await accountRow(email);
  expect(confirmed?.email_confirmed_at).not.toBeNull();
  expect(confirmed?.account_ready_at).toBeNull();

  // Paso 3: nombre y contraseña (sin términos no se crea).
  await page.getByLabel("Tu nombre").fill("Registro Ficticio");
  await page.locator("input[name=password]").fill(TEST_PASSWORD);
  await page.locator("input[name=confirmPassword]").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page.getByText("Para crear tu cuenta debes aceptar los términos")).toBeVisible();
  await submitAccountSetup(page, "Registro Ficticio");
  await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
  await expect(page.getByRole("heading", { name: "Crea tu primera organización" })).toBeVisible();

  // En la base: terminada, con el nombre que ella eligió, una sola sesión y la aceptación de los términos hecha DESPUÉS de verificar.
  const after = await accountRow(email);
  expect(after?.account_ready_at).not.toBeNull();
  expect(after?.full_name).toBe("Registro Ficticio");
  expect(after?.sessions).toBe(1);
  expect(after?.acceptances).toBeGreaterThanOrEqual(2); // términos y privacidad
  await withDb(async (db) => {
    const { rows } = await db.query<{ later: boolean; context: string; ip: string; agent: string }>(
      `select a.accepted_at > u.email_confirmed_at as later, a.context, a.origin_ip::text as ip, a.user_agent as agent
         from public.legal_acceptances a join auth.users u on u.id = a.user_id where u.email = $1`,
      [email],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.later).toBe(true);
      expect(row.context).toBe("signup");
      expect(row.ip).toMatch(/^2001:db8:/); // la IP real de quien terminó la cuenta
      expect(row.agent).toContain("Chrome");
    }
    const audit = await db.query(
      `select 1 from public.audit_log a join auth.users u on u.id = a.actor_user_id
        where u.email = $1 and a.action = 'account.setup_completed'`,
      [email],
    );
    expect(audit.rowCount).toBe(1);
  });

  // La cuenta funciona: crea su primera organización, y la contraseña elegida sirve para ingresar.
  await createTenant(page, "Registro Ltda", generateRut());
  const grant = await passwordGrant(email, TEST_PASSWORD);
  expect(grant.status).toBe(200);
});

test("un GET al enlace (antivirus, vista previa) no lo gasta; el clic sí, y una segunda vez dice «ya se usó o venció»", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail("antivirus");
  await requestSignupLink(page, email);
  const link = await waitForAccountLink(email);

  // Un robot de correo abre el enlace dos veces (sin navegador, sin cookies): sigue sirviendo.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await page.request.get(link);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("Continuar");
  }
  const intact = await withDb((db) =>
    db.query(
      `select 1 from auth.one_time_tokens t join auth.users u on u.id = t.user_id where u.email = $1`,
      [email],
    ),
  );
  expect(intact.rowCount).toBeGreaterThan(0);
  expect((await accountRow(email))?.email_confirmed_at).toBeNull();

  // La persona sí puede usarlo, en OTRO dispositivo (otro contexto, sin la cookie del registro).
  const phone = await browser.newContext({ baseURL });
  try {
    const phonePage = await phone.newPage();
    await confirmEmailFromLink(phonePage, link);
    await expect(phonePage.getByTestId("create-account-email")).toHaveText(email);
  } finally {
    await phone.close();
  }

  // El mismo enlace, otra vez: ya se usó.
  await page.goto(link);
  await page.getByRole("button", { name: "Continuar" }).click();
  const expired = page.getByTestId("confirm-email-expired");
  await expect(expired).toBeVisible();
  await expect(expired.getByRole("heading", { name: EXPIRED_TITLE })).toBeVisible();
  await expect(expired.getByRole("link", { name: "Pedir un enlace nuevo" })).toHaveAttribute(
    "href",
    "/registro",
  );
});

test("un enlace vencido, mal escrito o de otro tipo dice «Este enlace ya se usó o venció» y no revela cuál fue el motivo", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail("vencido");
  await requestSignupLink(page, email);
  const link = await waitForAccountLink(email);

  // Vencido de verdad: el enlace se emitió hace más de una hora.
  await withDb(async (db) => {
    await db.query(
      `update auth.users set confirmation_sent_at = now() - interval '2 hours' where email = $1`,
      [email],
    );
    await db.query(
      `update auth.one_time_tokens set created_at = now() - interval '2 hours'
        where user_id = (select id from auth.users where email = $1)`,
      [email],
    );
  });
  await page.goto(link);
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByTestId("confirm-email-expired")).toBeVisible();
  await expect(page.getByRole("heading", { name: EXPIRED_TITLE })).toBeVisible();
  expect((await accountRow(email))?.email_confirmed_at).toBeNull();

  // Sin código, con un código inventado o con un tipo que no es el del registro: la misma pantalla, sin botón «Continuar».
  const code = new URL(link).searchParams.get("token_hash")!;
  for (const path of [
    "/confirmar-correo",
    "/confirmar-correo?type=invite",
    "/confirmar-correo?token_hash=%21%21%21&type=invite",
    `/confirmar-correo?token_hash=${code}&type=recovery`,
    `/confirmar-correo?token_hash=${code}`,
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: EXPIRED_TITLE }), path).toBeVisible();
    await expect(page.getByRole("button", { name: "Continuar" }), path).toHaveCount(0);
  }
  // Un código con la forma correcta pero que no existe: se rechaza al hacer clic, con la misma frase.
  await page.goto(`/confirmar-correo?token_hash=${"a".repeat(56)}&type=invite`);
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("heading", { name: EXPIRED_TITLE })).toBeVisible();
});

test("una cuenta sin terminar queda atrapada en «Termina de crear tu cuenta»: ninguna otra pantalla se abre", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail("atrapada");
  await requestSignupLink(page, email);
  await confirmEmailFromLink(page, await waitForAccountLink(email));

  for (const path of ["/", "/organizaciones/nueva", "/cuenta/seguridad", "/aceptar-terminos"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/crear-cuenta$/);
  }

  // «¿No es tu correo? Salir» cierra la sesión: sin sesión, la pantalla pide un enlace nuevo.
  await page.getByTestId("create-account-leave").click();
  // Esperar a que el cierre de sesión termine (redirige fuera de /crear-cuenta) antes de volver.
  await expect(page).not.toHaveURL(/\/crear-cuenta$/);
  await page.goto("/crear-cuenta");
  await expect(page.getByTestId("create-account-expired")).toBeVisible();
  await expect(page.getByRole("link", { name: "Pedir un enlace nuevo" })).toBeVisible();
  expect((await accountRow(email))?.account_ready_at).toBeNull();
});

test("si el correo ya tiene una cuenta, la respuesta en pantalla es idéntica y no se envía ningún correo", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const existing = uniqueEmail("ya-existe");
  const fresh = uniqueEmail("nuevo");
  await createReadyAccount(existing, "Ya Existe");

  await requestSignupLink(page, existing);
  const textExisting = (await page.getByTestId("signup-sent").innerText()).replace(existing, "·");
  await requestSignupLink(page, fresh);
  const textFresh = (await page.getByTestId("signup-sent").innerText()).replace(fresh, "·");
  expect(textExisting).toBe(textFresh);
  expect(textExisting).toContain("Si ya tenías una cuenta con este correo");

  // El correo de la persona nueva llega; con eso ya pasó el tiempo en que habría llegado el otro.
  await waitForAccountLink(fresh);
  expect(await countMails(existing, SIGNUP_MAIL_SUBJECT)).toBe(0);
  // Y su cuenta no se tocó: sigue terminada, con su contraseña.
  expect((await accountRow(existing))?.account_ready_at).not.toBeNull();
  expect((await passwordGrant(existing, TEST_PASSWORD)).status).toBe(200);
});

test("pedir otro enlace a los pocos segundos: se limita por correo y el primer enlace sigue sirviendo", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail("tope");
  await requestSignupLink(page, email);
  const first = await waitForAccountLink(email);

  await submitSignupEmail(page, email);
  await expect(page.getByText(LOCKED_MESSAGE)).toBeVisible();
  expect(await countMails(email, SIGNUP_MAIL_SUBJECT)).toBe(1);

  await confirmEmailFromLink(page, first);
});

test("un segundo enlace anula el primero (cada correo nuevo reemplaza al anterior)", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("reenvio");
  await requestSignupLink(page, email);
  const first = await waitForAccountLink(email);

  // El tope por correo es de 1 por minuto: se espera a que pase (el contador es de la aplicación y no se toca desde aquí).
  await page.waitForTimeout(SIGNUP_MINUTE_WAIT_MS);
  await requestSignupLink(page, email);
  const second = await waitForAccountLink(email, 2);
  expect(second).not.toBe(first);

  await page.goto(first);
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("heading", { name: EXPIRED_TITLE })).toBeVisible();

  await confirmEmailFromLink(page, second);
  await expect(page).toHaveURL(`${baseURL}/crear-cuenta`);
});

test("recuperar la contraseña de una cuenta que no se terminó lleva a «Termina de crear tu cuenta»", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("recuperar-sin-terminar");
  // Confirmó su correo pero no terminó: cerró la pestaña en «Termina de crear tu cuenta».
  await requestSignupLink(page, email);
  await confirmEmailFromLink(page, await waitForAccountLink(email));
  await page.context().clearCookies();

  const other = await browser.newContext({ baseURL });
  try {
    const resetPage = await other.newPage();
    await resetPage.goto("/recuperar-contrasena");
    await resetPage.getByLabel("Correo").fill(email);
    await resetPage.getByRole("button", { name: "Enviar enlace" }).click();
    await expect(resetPage.getByTestId("reset-request-sent")).toBeVisible();

    const recovery = await waitForVerificationLink(email, "Elige");
    await openVerificationLink(resetPage, recovery, "/auth/recuperar");
    await expect(resetPage).toHaveURL(/\/crear-cuenta$/);
    await expect(resetPage.getByTestId("create-account-email")).toHaveText(email);

    await submitAccountSetup(resetPage, "Recuperada Ficticia", "otra-clave-nueva-456");
    await expect(resetPage).toHaveURL(/\/organizaciones\/nueva$/);
    expect((await accountRow(email))?.account_ready_at).not.toBeNull();
    expect((await passwordGrant(email, "otra-clave-nueva-456")).status).toBe(200);
    // La contraseña aleatoria que la pasarela había puesto no la conoce nadie.
    expect((await passwordGrant(email, TEST_PASSWORD)).code).toBe("invalid_credentials");
  } finally {
    await other.close();
  }
});

test("en el teléfono (375 px) las tres pantallas no se desbordan, los campos son de 16 px y lo tocable mide 44 px", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize(MOBILE);
  const email = uniqueEmail("movil");

  const checkScreen = async (where: string) => {
    expect(
      await noHorizontalScroll(page),
      `${where}: desplazamiento horizontal`,
    ).toBeLessThanOrEqual(0);
    await expectControlsInsideCard(page, where);
    const metrics = await page.evaluate(() => {
      const card = document.querySelector('section[aria-labelledby="auth-title"]')!;
      const controls = [
        ...card.querySelectorAll<HTMLElement>(
          'button, a[href], input:not([type="hidden"]):not([type="checkbox"]), label:has(input[type="checkbox"])',
        ),
      ].filter((el) => el.getClientRects().length > 0 && !el.classList.contains("sr-only"));
      return controls.map((el) => {
        const rect = el.getBoundingClientRect();
        const isField = el instanceof HTMLInputElement;
        return {
          name: (el.textContent?.trim() || el.getAttribute("name") || el.tagName).slice(0, 40),
          height: rect.height,
          isField,
          font: isField ? parseFloat(getComputedStyle(el).fontSize) : null,
          // Enlaces dentro de una frase (política de privacidad, términos) quedan fuera: no son un control aparte.
          inline: el instanceof HTMLAnchorElement && el.closest("p, span") !== null,
        };
      });
    });
    for (const control of metrics) {
      if (control.isField) {
        expect(control.font, `${where}: letra del campo «${control.name}»`).toBeGreaterThanOrEqual(
          MIN_FIELD_FONT_PX,
        );
      }
      if (!control.inline) {
        expect(control.height, `${where}: alto de «${control.name}»`).toBeGreaterThanOrEqual(
          MIN_TOUCH_PX - 1,
        );
      }
    }
  };

  await page.goto("/registro");
  await checkScreen("/registro");
  await requestSignupLink(page, email);
  await checkScreen("/registro (enviado)");
  const link = await waitForAccountLink(email);

  await page.goto(link);
  await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();
  await checkScreen("/confirmar-correo");

  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page).toHaveURL(/\/crear-cuenta$/);
  await checkScreen("/crear-cuenta");
  // Con un error a la vista (contraseñas que no coinciden) tampoco se desborda.
  await page.getByLabel("Tu nombre").fill("Móvil Ficticio");
  await page.locator("input[name=password]").fill(TEST_PASSWORD);
  await page.locator("input[name=confirmPassword]").fill("otra-clave-distinta-1");
  await page.getByRole("checkbox", { name: /Acepto los/ }).check();
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page.getByText("Las contraseñas no coinciden.")).toBeVisible();
  await checkScreen("/crear-cuenta (con errores)");

  await page.goto("/confirmar-correo");
  await expect(page.getByRole("heading", { name: EXPIRED_TITLE })).toBeVisible();
  await checkScreen("/confirmar-correo (enlace vencido)");
});

test("sin conexión: el correo del registro no se envía, avisa y conserva lo escrito; al volver la red funciona", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail("sin-red");
  await page.goto("/registro");
  await page.getByLabel("Correo").fill(email);
  await page.getByTestId("antibot-memory-pass").click();
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.headers()["next-action"]) calls.push(request.url());
  });

  await context.setOffline(true);
  await page.getByRole("button", { name: "Enviarme el enlace" }).click();
  await expect(page.locator(OFFLINE_TOAST).filter({ hasText: "Sin conexión" })).toBeVisible();
  await expect(page.getByLabel("Correo")).toHaveValue(email);
  expect(calls).toHaveLength(0);
  await expect(page.getByTestId("error-screen")).toHaveCount(0);

  await context.setOffline(false);
  await page.getByRole("button", { name: "Enviarme el enlace" }).click();
  await expect(page.getByTestId("signup-sent")).toBeVisible();
});

test("sin conexión: «Crear mi cuenta» no envía, avisa y conserva el nombre; al volver la red la cuenta se crea", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail("sin-red-cuenta");
  await requestSignupLink(page, email);
  await confirmEmailFromLink(page, await waitForAccountLink(email));
  await page.getByLabel("Tu nombre").fill("Sin Red Ficticia");
  await page.locator("input[name=password]").fill(TEST_PASSWORD);
  await page.locator("input[name=confirmPassword]").fill(TEST_PASSWORD);
  await page.getByRole("checkbox", { name: /Acepto los/ }).check();
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.headers()["next-action"]) calls.push(request.url());
  });

  await context.setOffline(true);
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page.locator(OFFLINE_TOAST).filter({ hasText: "Sin conexión" })).toBeVisible();
  await expect(page.getByLabel("Tu nombre")).toHaveValue("Sin Red Ficticia");
  expect(calls).toHaveLength(0);
  await expect(page.getByTestId("error-screen")).toHaveCount(0);
  expect((await accountRow(email))?.account_ready_at).toBeNull();

  await context.setOffline(false);
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
  expect((await accountRow(email))?.account_ready_at).not.toBeNull();
});

test("el registro con la sesión de una cuenta ya terminada: «Crea tu cuenta» manda al inicio y «Termina de crear tu cuenta» sigue de largo", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail("ya-terminada");
  await registerThroughGateway(page, email, "Ya Terminada");
  await page.goto("/registro");
  await expect(page).not.toHaveURL(/\/registro$/);
  await page.goto("/crear-cuenta");
  await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
});
