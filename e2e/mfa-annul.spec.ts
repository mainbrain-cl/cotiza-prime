import { createHash, randomBytes } from "node:crypto";
import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import { adminCreateUser, signIn } from "../tests/support/local-supabase";
import { gotrue } from "../tests/support/mfa-gate";
import { expect, randomTestIp, test, type Page } from "./fixtures";
import {
  TEST_PASSWORD,
  activateTwoStep,
  createTenant,
  openVerificationLink,
  signUpAndVerify,
  uniqueEmail,
  waitForVerificationLink,
} from "./helpers";

// H-118b · Anular la activación del segundo paso desde el enlace del correo de aviso (Mailpit en http://127.0.0.1:56324).
// En SERIE y solo con cuentas nuevas @ejemplo.test. (1) El ataque completo; (2) enlace usado, vencido o inventado: el mismo
// mensaje; (3) abrir el enlace sin apretar no cambia nada; (4) teléfono (375 px), teclado y «reducir movimiento».
test.describe.configure({ mode: "serial" });

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";
const NEW_PASSWORD = "otra-clave-nueva-456";
const INVALID_MESSAGE =
  "Este enlace ya no sirve. Si alguien activó la verificación en tu cuenta sin tu permiso, escríbenos.";
const DONE_MESSAGE =
  "Anulamos la activación y cerramos todas las sesiones. Te enviamos un correo para elegir tu contraseña nueva.";
const ANNUL_BUTTON = "Anular la activación";

type MailpitMessage = { Subject: string; Text: string; HTML: string };

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Espera un correo para esa dirección cuyo asunto contenga el texto y lo devuelve. */
async function waitForMail(address: string, subjectWord: string): Promise<MailpitMessage> {
  let found: MailpitMessage | null = null;
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${address} subject:${subjectWord}`)}`,
        );
        const { messages } = (await search.json()) as { messages?: { ID: string }[] };
        if (!messages?.length) return null;
        found = (await (
          await fetch(`${MAILBOX_URL}/api/v1/message/${messages[0].ID}`)
        ).json()) as MailpitMessage;
        return found;
      },
      { message: `Esperaba un correo «${subjectWord}» para ${address}`, timeout: 30_000 },
    )
    .not.toBeNull();
  return found!;
}

/** El enlace del botón «No fui yo» tal como lo recibe la persona (con el código tras el «#»). */
function annulLinkOf(mail: MailpitMessage): string {
  const link = /https?:\/\/[^\s"<>]+\/cuenta\/anular-dos-pasos#[A-Za-z0-9_-]{43}/.exec(
    mail.Text,
  )?.[0];
  expect(link, "el correo trae el enlace de anulación").toBeTruthy();
  return link!;
}

async function logIn(page: Page, email: string, password: string) {
  await page.goto("/ingresar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
}

/** Desde una sesión con solo la contraseña: activa el segundo paso con un teléfono propio (y la contraseña, que ahora se vuelve a pedir). */
async function activateSecondStep(page: Page): Promise<void> {
  await activateTwoStep(page, TEST_PASSWORD);
}

/** El pase de acceso que el navegador guardó en sus cookies (para pedirle cosas a Supabase directo, como un atacante). */
async function accessTokenOf(page: Page): Promise<string> {
  const cookies = (await page.context().cookies()).filter((cookie) =>
    /auth-token(\.\d+)?$/.test(cookie.name),
  );
  expect(cookies.length).toBeGreaterThan(0);
  const joined = cookies
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cookie) => cookie.value)
    .join("");
  const json = Buffer.from(joined.replace(/^base64-/, ""), "base64url").toString("utf8");
  return (JSON.parse(json) as { access_token: string }).access_token;
}

/** Una cuenta con un aviso `sent` y su enlace abierto (montados por la base). Devuelve el enlace tal como llegaría. */
async function seededLink(
  origin: string,
): Promise<{ email: string; userId: string; url: string; hash: string }> {
  const email = uniqueEmail("anula");
  const userId = await adminCreateUser(email);
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  await withDb(async (db) => {
    const alert = await db.query<{ id: string }>(
      `insert into public.mfa_enrollment_alerts (user_id, factor_id, state, expected_until, verified_at, sent_at)
       values ($1, gen_random_uuid(), 'sent', now(), now(), now()) returning id`,
      [userId],
    );
    await db.query(
      `insert into public.mfa_annul_links (alert_id, user_id, token_sha256, expires_at)
       values ($1, $2, $3, now() + interval '72 hours')`,
      [alert.rows[0].id, userId, hash],
    );
  });
  return { email, userId, url: `${origin}/cuenta/anular-dos-pasos#${token}`, hash };
}

test("EL ATAQUE COMPLETO: quien sabe la contraseña activa su teléfono y deja fuera a la dueña; ella anula desde el correo, elige contraseña nueva, y el atacante queda fuera", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(420_000);
  const email = uniqueEmail("duena");
  // La dueña: cuenta SIN el segundo paso, con su organización.
  await signUpAndVerify(page, email, "Dueña Ficticia");
  const tenantId = await createTenant(page, "Empresa Atacada", generateRut());

  // El atacante, en otro navegador, entra con la contraseña y activa SU teléfono.
  const attackerContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  const attacker = await attackerContext.newPage();
  await logIn(attacker, email, TEST_PASSWORD);
  await expect(attacker).toHaveURL(new RegExp(`/o/${tenantId}$`));
  await activateSecondStep(attacker);
  const attackerToken = await accessTokenOf(attacker);
  expect((await gotrue(attackerToken, "GET", "user")).status).toBe(200);

  // La sesión de la dueña se cerró al activarse el factor.
  await page.goto(`/o/${tenantId}`);
  await expect(page).toHaveURL(/\/ingresar/);

  // Ella abre el correo de aviso. Abrir el enlace NO cambia nada: el factor sigue, el aviso sigue `sent`, el enlace sin usar.
  const notice = await waitForMail(email, "activó");
  expect(notice.Subject).toBe("Se activó la verificación en dos pasos en tu cuenta");
  const link = annulLinkOf(notice);
  const state = () =>
    withDb(async (db) => {
      const factors = await db.query(
        `select 1 from auth.mfa_factors f join auth.users u on u.id = f.user_id where u.email = $1 and f.status = 'verified'`,
        [email],
      );
      const links = await db.query<{ state: string; used: boolean; claimed: boolean }>(
        `select a.state, l.used_at is not null as used, l.claimed_until is not null as claimed
           from public.mfa_annul_links l join public.mfa_enrollment_alerts a on a.id = l.alert_id
           join auth.users u on u.id = l.user_id where u.email = $1`,
        [email],
      );
      return { factors: factors.rowCount, links: links.rows };
    });
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "¿No fuiste tú?" })).toBeVisible();
  // El código ya no está en la barra de direcciones.
  await expect(page).toHaveURL(/\/cuenta\/anular-dos-pasos$/);
  expect(await state()).toEqual({
    factors: 1,
    links: [{ state: "sent", used: false, claimed: false }],
  });
  // El atacante sigue dentro mientras tanto.
  expect((await gotrue(attackerToken, "GET", "user")).status).toBe(200);

  // Aprieta «Anular» (la página ya guardó el código al abrirse).
  await page.getByRole("button", { name: ANNUL_BUTTON }).click();
  await expect(page.getByTestId("annul-done")).toContainText(DONE_MESSAGE);
  expect(await state()).toEqual({
    factors: 0,
    links: [{ state: "annulled", used: true, claimed: false }],
  });

  // Del lado del atacante: su pase ya no sirve, su siguiente pantalla lo manda a ingresar y la contraseña vieja no entra.
  const direct = await gotrue(attackerToken, "GET", "user");
  expect(direct.status).toBe(403);
  expect(direct.json?.error_code).toBe("session_not_found");
  await attacker.goto(`/o/${tenantId}`);
  await expect(attacker).toHaveURL(/\/ingresar/);
  await logIn(attacker, email, TEST_PASSWORD);
  await expect(attacker.getByText("Correo o contraseña incorrectos.")).toBeVisible();
  await attackerContext.close();

  // A ella le llegan el correo para elegir la contraseña nueva y el aviso de que se anuló.
  const annulled = await waitForMail(email, "Anulamos");
  expect(annulled.Subject).toBe("Anulamos la verificación en dos pasos de tu cuenta");
  const recovery = await waitForVerificationLink(email, "Elige");
  await openVerificationLink(page, recovery, "/auth/recuperar");
  await expect(page).toHaveURL(/\/restablecer-contrasena$/);
  await page.locator("input[name=password]").fill(NEW_PASSWORD);
  await page.locator("input[name=confirmPassword]").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Cambiar contraseña" }).click();
  await expect(page).not.toHaveURL(/\/restablecer-contrasena/);

  // Con la contraseña nueva entra a su organización, sin pedir código.
  await page.context().clearCookies();
  await logIn(page, email, NEW_PASSWORD);
  await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));

  // El registro de actividad de la organización muestra la anulación.
  await page.goto(`/o/${tenantId}/configuracion/actividad`);
  const rows = page.getByTestId("audit-row");
  await expect(
    rows.filter({ hasText: "Se anuló la activación de la verificación en dos pasos" }),
  ).toHaveCount(1);
  const raw = await withDb((db) =>
    db.query<{ n: string }>(
      `select count(*) as n from public.audit_log where action = 'session.mfa_annulled' and tenant_id = $1`,
      [tenantId],
    ),
  );
  expect(Number(raw.rows[0].n)).toBe(1);
  // Y el enlace, ya usado, no sirve.
  await page.goto(link);
  await page.getByRole("button", { name: ANNUL_BUTTON }).click();
  await expect(page.getByText(INVALID_MESSAGE)).toBeVisible();
});

test("un enlace usado, vencido o inventado da exactamente el mismo mensaje y no cambia nada", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const origin = new URL(baseURL!).origin;
  const used = await seededLink(origin);
  const expired = await seededLink(origin);
  const fresh = await seededLink(origin);
  await withDb(async (db) => {
    await db.query("update public.mfa_annul_links set used_at = now() where user_id = $1", [
      used.userId,
    ]);
    await db.query(
      "update public.mfa_annul_links set expires_at = now() - interval '1 minute' where user_id = $1",
      [expired.userId],
    );
  });
  // Una cuenta con sesión abierta: ninguno de los intentos de abajo la toca.
  const bystander = await signIn(fresh.email);

  const invented = `${origin}/cuenta/anular-dos-pasos#${randomBytes(32).toString("base64url")}`;
  const garbage = `${origin}/cuenta/anular-dos-pasos#basura`;
  const messages: string[] = [];
  for (const url of [used.url, expired.url, invented, garbage]) {
    await page.goto(url);
    await page.getByRole("button", { name: ANNUL_BUTTON }).click();
    const alert = page.getByRole("alert").filter({ hasText: "Este enlace ya no sirve" });
    await expect(alert).toBeVisible();
    messages.push((await alert.innerText()).trim());
    // Nada de lo que dice delata el estado del enlace ni un correo.
    await expect(page.getByText(used.email)).toHaveCount(0);
  }
  expect(new Set(messages)).toEqual(new Set([INVALID_MESSAGE]));

  // Sin el código (la dirección sin el «#», o la página recargada después de que el «#» se borró) NO se envía nada al
  // servidor y solo se pide abrir otra vez el botón del correo: no se dice nada del enlace.
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  const missing = page
    .getByRole("status")
    .filter({ hasText: "Abre otra vez el botón del correo." });
  await page.goto(`${origin}/cuenta/anular-dos-pasos`);
  await page.getByRole("button", { name: ANNUL_BUTTON }).click();
  await expect(missing).toBeVisible();
  await page.goto("about:blank");
  await page.goto(fresh.url);
  await expect(page).toHaveURL(/\/cuenta\/anular-dos-pasos$/);
  await page.reload();
  await page.getByRole("button", { name: ANNUL_BUTTON }).click();
  await expect(missing).toBeVisible();
  await expect(page.getByText("Este enlace ya no sirve")).toHaveCount(0);
  expect(posts).toEqual([]);
  // Ninguna cuenta cambió: la que tenía sesión la conserva y su enlace sigue abierto.
  expect((await gotrue(bystander.accessToken, "GET", "user")).status).toBe(200);
  const remaining = await withDb((db) =>
    db.query<{ used: boolean; claimed: boolean }>(
      "select used_at is not null as used, claimed_until is not null as claimed from public.mfa_annul_links where user_id = $1",
      [fresh.userId],
    ),
  );
  expect(remaining.rows).toEqual([{ used: false, claimed: false }]);
});

test("abrir el enlace varias veces sin apretar no cambia nada; la página manda las cabeceras de seguridad", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const origin = new URL(baseURL!).origin;
  const seeded = await seededLink(origin);
  const session = await signIn(seeded.email);
  for (let i = 0; i < 3; i += 1) {
    // Sale a una página en blanco para que cada apertura sea una carga nueva (como abrir el correo otra vez).
    await page.goto("about:blank");
    const response = await page.goto(seeded.url);
    expect(response?.headers()["cache-control"]).toBe("private, no-store, max-age=0");
    expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(page.getByRole("button", { name: ANNUL_BUTTON })).toBeVisible();
    await expect(page.getByRole("link", { name: "Fui yo: no hacer nada" })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  }
  // Ni el enlace ni la cuenta cambiaron: sin tomar, sin usar, con su sesión.
  const row = await withDb((db) =>
    db.query<{ used: boolean; claimed: boolean; state: string }>(
      `select l.used_at is not null as used, l.claimed_until is not null as claimed, a.state
         from public.mfa_annul_links l join public.mfa_enrollment_alerts a on a.id = l.alert_id where l.user_id = $1`,
      [seeded.userId],
    ),
  );
  expect(row.rows).toEqual([{ used: false, claimed: false, state: "sent" }]);
  expect((await gotrue(session.accessToken, "GET", "user")).status).toBe(200);
  // «Fui yo: no hacer nada» sale de la página sin anular.
  await page.getByRole("link", { name: "Fui yo: no hacer nada" }).click();
  await expect(page).not.toHaveURL(/anular-dos-pasos/);
  expect((await gotrue(session.accessToken, "GET", "user")).status).toBe(200);
});

test("once pedidos inválidos desde la misma IP no frenan a la dueña: su enlace válido igual anula; todos los inválidos dan el mismo mensaje y el 11.º, el límite habitual", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const origin = new URL(baseURL!).origin;
  const owner = await seededLink(origin);
  const invalidMessages: string[] = [];
  // Un compañero de la misma red (misma IP) prueba enlaces inventados: los primeros 10 dan el mismo mensaje y el 11.º, el límite.
  for (let attempt = 1; attempt <= 11; attempt += 1) {
    await page.goto("about:blank");
    await page.goto(`${origin}/cuenta/anular-dos-pasos#${randomBytes(32).toString("base64url")}`);
    await page.getByRole("button", { name: ANNUL_BUTTON }).click();
    if (attempt <= 10) {
      const alert = page.getByRole("alert").filter({ hasText: "Este enlace ya no sirve" });
      await expect(alert).toBeVisible();
      invalidMessages.push((await alert.innerText()).trim());
    } else {
      await expect(
        page.getByRole("alert").filter({ hasText: "Demasiados intentos" }),
      ).toBeVisible();
    }
  }
  expect(new Set(invalidMessages)).toEqual(new Set([INVALID_MESSAGE]));
  // Con la IP ya bloqueada para enlaces inválidos, el enlace VÁLIDO de la dueña igual anula.
  await page.goto("about:blank");
  await page.goto(owner.url);
  await page.getByRole("button", { name: ANNUL_BUTTON }).click();
  await expect(page.getByTestId("annul-done")).toContainText(
    "Anulamos la activación y cerramos todas las sesiones.",
  );
  const state = await withDb((db) =>
    db.query<{ state: string; used: boolean }>(
      `select a.state, l.used_at is not null as used from public.mfa_annul_links l
         join public.mfa_enrollment_alerts a on a.id = l.alert_id where l.user_id = $1`,
      [owner.userId],
    ),
  );
  expect(state.rows).toEqual([{ state: "annulled", used: true }]);
});

test("en el teléfono (375 px, con movimiento reducido): sin desborde, áreas de 44 px, foco visible y se maneja con el teclado", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const origin = new URL(baseURL!).origin;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${origin}/cuenta/anular-dos-pasos#${randomBytes(32).toString("base64url")}`);
  const button = page.getByRole("button", { name: ANNUL_BUTTON });
  await expect(button).toBeVisible();
  // Con «reducir movimiento», la animación de entrada de la tarjeta queda sin duración (no se mueve).
  const entryAnimation = await page.evaluate(() => {
    const el = document.querySelector("main .animate-enter");
    return el ? getComputedStyle(el).animationDuration : "sin-tarjeta";
  });
  expect(entryAnimation).toBe("0s");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  for (const target of [button, page.getByRole("link", { name: "Fui yo: no hacer nada" })]) {
    const box = await target.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  // Botón rojo y sólido (no transparente).
  const background = await button.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(background).not.toMatch(/rgba?\(\s*0,\s*0,\s*0,\s*0\)|transparent/);
  // Con el teclado: Tab llega al botón (con anillo de foco) y Enter lo aprieta.
  for (
    let i = 0;
    i < 12 && !(await button.evaluate((node) => node === document.activeElement));
    i += 1
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(button).toBeFocused();
  const ring = await button.evaluate((node) => getComputedStyle(node).boxShadow);
  expect(ring).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page.getByText(INVALID_MESSAGE)).toBeVisible();
  const afterOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(afterOverflow).toBeLessThanOrEqual(0);
});
