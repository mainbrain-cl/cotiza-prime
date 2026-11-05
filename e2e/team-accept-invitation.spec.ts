import { createHash, randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { generateRut } from "../src/lib/chile/rut";
import { connect } from "../tests/db/helpers";
import { expect, randomTestIp, test } from "./fixtures";
import {
  TEST_PASSWORD,
  createTenant,
  openVerificationLink,
  signUpAndVerify,
  uniqueEmail,
  waitForVerificationLink,
} from "./helpers";

// H-009: aceptar una invitación. Invitar (como Dueño) → el correo llega a Mailpit → aceptar con una cuenta que ya
// existe (la organización queda en el selector); registrarse desde la invitación y quedar unido al terminar;
// abrirla con otro correo; invitación vencida y cancelada. Todo es ficticio (correos @ejemplo.test).

// Con dos pruebas a la vez, el registro de cuentas supera los 5 s de espera: este archivo corre en orden.
test.describe.configure({ mode: "serial" });

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";
const MOBILE = { width: 375, height: 812 };
const COOKIE_NAME = "cp_invitation";
const ONE_HOUR_SECONDS = 3600;
const ORG_NAME = "Aceptar Invitaciones Ltda";
const OWNER_NAME = "Dueña Aceptar";

async function withDb<T>(fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

type MailDetail = { ID: string; HTML: string; Text: string; Subject: string };

async function invitationMails(address: string): Promise<MailDetail[]> {
  const search = await fetch(
    `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
  );
  const { messages } = (await search.json()) as { messages?: { ID: string }[] };
  const details: MailDetail[] = [];
  for (const { ID } of [...(messages ?? [])].reverse()) {
    const mail = (await (await fetch(`${MAILBOX_URL}/api/v1/message/${ID}`)).json()) as MailDetail;
    if (mail.Subject.includes("te invitó a")) details.push(mail);
  }
  return details;
}

/**
 * Espera el correo de la invitación y devuelve el enlace tal como lo recibe la persona. Si a ese correo llegan
 * varias invitaciones, `nth` dice cuál (1 = la primera) y se espera a que hayan llegado justo esas.
 */
async function waitForInviteLink(
  address: string,
  nth = 1,
): Promise<{ link: string; token: string }> {
  let found: MailDetail[] = [];
  await expect
    .poll(async () => (found = await invitationMails(address)).length, {
      message: `Esperaba el correo de la invitación a ${address}`,
      timeout: 30_000,
    })
    .toBe(nth);
  const match = /href="(https?:\/\/[^"]*\/invitacion\/([A-Za-z0-9_-]{43}))"/.exec(
    found[nth - 1].HTML,
  );
  if (!match) throw new Error("El correo no trae el enlace de la invitación");
  return { link: match[1], token: match[2] };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Fallos de aceptación que lleva una cuenta (el contador guarda una huella del id de la cuenta). */
async function failuresOfAccount(db: import("pg").Client, email: string): Promise<number> {
  const { rows } = await db.query<{ failures: number }>(
    `select l.failures from public.auth_rate_limits l
      where l.scope = 'invite_accept_user'
        and l.key_hash = (select encode(sha256(convert_to('invite_accept_user|' || id::text, 'UTF8')), 'hex')
                            from auth.users where email = $1)`,
    [email],
  );
  return rows[0]?.failures ?? 0;
}

/**
 * Filas de auditoría que dejó ESTA cuenta, en cualquier organización. Solo las suyas: con `fullyParallel` y dos
 * trabajadores, otros archivos escriben en la auditoría al mismo tiempo y contar todas las filas fallaba al azar.
 */
const auditRowsOf = async (db: import("pg").Client, email: string) =>
  Number(
    (
      await db.query<{ n: string }>(
        `select count(*) as n from public.audit_log a join auth.users u on u.id = a.actor_user_id
          where u.email = $1`,
        [email],
      )
    ).rows[0].n,
  );

async function newContext(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": randomTestIp() } });
}

async function login(page: Page, email: string) {
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
}

/** Una cuenta nueva, verificada, en su propio contexto (sin sesión compartida con nadie). */
async function createAccount(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
  name: string,
) {
  const context = await newContext(browser, baseURL);
  try {
    await signUpAndVerify(await context.newPage(), email, name);
  } finally {
    await context.close();
  }
}

/** El Dueño invita desde «Tu equipo». */
async function invite(ownerPage: Page, tenantId: string, email: string, role: string) {
  await ownerPage.goto(`/o/${tenantId}/equipo`);
  await ownerPage.getByTestId("invite-email").fill(email);
  await ownerPage.getByTestId(`invite-role-${role}`).click();
  await ownerPage.getByTestId("invite-submit").click();
  await expect(ownerPage.getByText(`Enviamos la invitación a ${email}.`)).toBeVisible();
}

let ownerContext: BrowserContext;
let ownerPage: Page;
let tenantId: string;

test.beforeAll(async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  ownerContext = await newContext(browser, baseURL);
  ownerPage = await ownerContext.newPage();
  await signUpAndVerify(ownerPage, uniqueEmail("acepta-dueno"), OWNER_NAME);
  tenantId = await createTenant(ownerPage, ORG_NAME, generateRut());
});
test.afterAll(async () => {
  await ownerContext?.close();
});

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("con una cuenta que ya existe: abrir el enlace, ingresar, «Unirme», y la organización queda en el selector", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("acepta-existente");
  await createAccount(browser, baseURL, email, "Ana Existente");
  // La cuenta ya tiene su propia organización: así el selector muestra dos.
  const setup = await newContext(browser, baseURL);
  try {
    const setupPage = await setup.newPage();
    await setupPage.goto("/ingresar");
    await login(setupPage, email);
    await expect(setupPage).toHaveURL(/\/organizaciones\/nueva$/);
    await createTenant(setupPage, "Negocio Propio SpA", generateRut());
  } finally {
    await setup.close();
  }

  await invite(ownerPage, tenantId, email, "sales");
  const { link, token } = await waitForInviteLink(email);
  expect(link.startsWith(`${baseURL}/invitacion/`)).toBe(true);

  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();

    // --- el enlace guarda el código en una cookie y lo saca de la dirección ---
    const response = await page.goto(link);
    expect(response?.request().redirectedFrom()?.url()).toBe(link);
    await expect(page).toHaveURL(`${baseURL}/invitacion`);
    expect(page.url()).not.toContain(token);
    const cookie = (await context.cookies()).find((c) => c.name === COOKIE_NAME);
    expect(cookie?.value).toBe(token);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    expect(cookie?.path).toBe("/");
    const lifetime = (cookie?.expires ?? 0) - Date.now() / 1000;
    expect(lifetime).toBeGreaterThan(ONE_HOUR_SECONDS - 120);
    expect(lifetime).toBeLessThanOrEqual(ONE_HOUR_SECONDS);
    // La página no puede leerla.
    expect(await page.evaluate(() => document.cookie)).not.toContain(COOKIE_NAME);

    // --- sin sesión: nada de la organización ni de si hay cuenta ---
    const signedOut = page.getByTestId("invitation-signed-out");
    await expect(signedOut).toBeVisible();
    await expect(
      page.getByText(
        "Te invitaron a una organización de Cotiza Prime. Ingresa o crea tu cuenta con el correo al que llegó la invitación.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Ingresar", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Crear mi cuenta", exact: true })).toBeVisible();
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain(ORG_NAME);
    expect(bodyText).not.toContain(OWNER_NAME);
    expect(bodyText).not.toMatch(/ya tienes (una )?cuenta/i);

    // --- ingresa y vuelve a la invitación ---
    await page.getByRole("link", { name: "Ingresar", exact: true }).click();
    await expect(page).toHaveURL(/\/ingresar$/);
    await login(page, email);
    await expect(page).toHaveURL(`${baseURL}/invitacion`);

    // --- la vista previa: quién invita, a qué organización, con qué rol ---
    await expect(page.getByTestId("invitation-sentence")).toHaveText(
      `${OWNER_NAME} te invitó a ${ORG_NAME} como Comercial.`,
    );
    await expect(
      page.getByText("Arma y envía sus propias cotizaciones", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText(`Ingresaste como ${email}.`)).toBeVisible();
    // Abrir el enlace no aceptó nada: la membresía todavía no existe.
    await withDb(async (db) => {
      const { rows } = await db.query(
        `select 1 from public.members m join auth.users u on u.id = m.user_id
          where m.tenant_id = $1 and u.email = $2`,
        [tenantId, email],
      );
      expect(rows).toHaveLength(0);
    });

    // --- un clic: entra a la organización ---
    await page.getByRole("button", { name: "Unirme", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
    await expect(page.locator('[data-testid="tenant-switcher"]:visible')).toContainText(ORG_NAME);
    expect((await context.cookies()).find((c) => c.name === COOKIE_NAME)).toBeUndefined();

    // --- el selector tiene las dos, con el rol en cada una ---
    await page.locator('[data-testid="tenant-switcher"]:visible').click();
    await expect(page.getByRole("menuitem", { name: /Negocio Propio SpA.*Dueño/ })).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: new RegExp(`${ORG_NAME}.*Comercial`) }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // --- la base: rol de la invitación, invitación aceptada y correo vaciado ---
    await withDb(async (db) => {
      const member = await db.query<{ role: string; status: string }>(
        `select m.role, m.status from public.members m join auth.users u on u.id = m.user_id
          where m.tenant_id = $1 and u.email = $2`,
        [tenantId, email],
      );
      expect(member.rows).toEqual([{ role: "sales", status: "active" }]);
      const invitation = await db.query(
        `select status, accepted_at, accepted_by, member_id, email_enc, email_hash, email_binding
           from public.invitations where token_sha256 = $1`,
        [sha256(token)],
      );
      expect(invitation.rows[0]).toMatchObject({
        status: "accepted",
        email_enc: null,
        email_hash: null,
        email_binding: null,
      });
      expect(invitation.rows[0].accepted_at).not.toBeNull();
      expect(invitation.rows[0].member_id).not.toBeNull();
      const audit = await db.query(
        `select action from public.audit_log where tenant_id = $1
            and action = 'invitation.accepted' and details::text not like '%' || $2 || '%'`,
        [tenantId, token],
      );
      expect(audit.rowCount).toBe(1);
    });

    // --- volver a abrir el mismo enlace no rompe nada: ya eres parte, un clic te lleva dentro ---
    await page.goto(link);
    await expect(page).toHaveURL(`${baseURL}/invitacion`);
    await expect(
      page.getByRole("heading", { name: "Ya eres parte de esta organización" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
  } finally {
    await context.close();
  }
});

test("sin cuenta: se registra desde la invitación y queda unido al verificar su correo", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("acepta-nueva");
  await invite(ownerPage, tenantId, email, "viewer");
  const { link, token } = await waitForInviteLink(email);

  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await page.goto(link);
    await expect(page).toHaveURL(`${baseURL}/invitacion`);
    await expect(page.getByTestId("invitation-signed-out")).toBeVisible();

    // Crear la cuenta con el correo de la invitación.
    await page.getByRole("link", { name: "Crear mi cuenta", exact: true }).click();
    await expect(page).toHaveURL(/\/registro$/);
    await page.getByLabel("Tu nombre").fill("Nueva Invitada");
    await page.getByLabel("Correo").fill(email);
    await page.getByLabel("Contraseña").fill(TEST_PASSWORD);
    await page.getByRole("checkbox", { name: /Acepto los/ }).check();
    await page.getByRole("button", { name: "Crear mi cuenta" }).click();
    await expect(page.getByTestId("signup-sent")).toBeVisible();

    // Verifica el correo en el mismo navegador: vuelve a la invitación (no a «Crea tu primera organización»).
    await openVerificationLink(page, await waitForVerificationLink(email, "Confirm"));
    await expect(page).toHaveURL(`${baseURL}/invitacion`);
    await expect(page.getByTestId("invitation-sentence")).toHaveText(
      `${OWNER_NAME} te invitó a ${ORG_NAME} como Observador.`,
    );
    await page.getByRole("button", { name: "Unirme", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
    await expect(page.locator('[data-testid="tenant-switcher"]:visible')).toContainText(ORG_NAME);

    await withDb(async (db) => {
      const { rows } = await db.query<{ role: string; status: string }>(
        `select m.role, m.status from public.members m join auth.users u on u.id = m.user_id
          where m.tenant_id = $1 and u.email = $2`,
        [tenantId, email],
      );
      expect(rows).toEqual([{ role: "viewer", status: "active" }]);
      const invitation = await db.query<{ status: string }>(
        "select status from public.invitations where token_sha256 = $1",
        [sha256(token)],
      );
      expect(invitation.rows).toEqual([{ status: "accepted" }]);
    });
  } finally {
    await context.close();
  }
});

test("si verifica el correo en otro dispositivo, el inicio le recuerda abrir de nuevo el enlace", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail("acepta-otro-aparato");
  await invite(ownerPage, tenantId, email, "approver");
  const { link } = await waitForInviteLink(email);

  // El teléfono se registra (sin la cookie de la invitación) y verifica el correo.
  const phone = await newContext(browser, baseURL);
  try {
    const page = await phone.newPage();
    await signUpAndVerify(page, email, "Otra Invitada");
    await expect(page.getByTestId("invited-hint")).toHaveText(
      "¿Te invitaron? Abre de nuevo el enlace del correo de la invitación.",
    );
    // Sin la cookie, la pantalla de invitación no inventa nada.
    await page.goto("/invitacion");
    await expect(page.getByRole("heading", { name: "Falta tu invitación" })).toBeVisible();
    await expect(
      page.getByText("Abre de nuevo el enlace del correo que te enviaron."),
    ).toBeVisible();
    // Con sesión, la salida es un botón grande (no un enlace de texto).
    const toAccount = page.getByTestId("invitation-missing-action");
    await expect(toAccount).toHaveText("Ir a mi cuenta");
    expect((await toAccount.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    // Abre el enlace del correo con la sesión que ya tiene y se une.
    await page.goto(link);
    await expect(page.getByTestId("invitation-sentence")).toContainText(
      `te invitó a ${ORG_NAME} como Aprobador.`,
    );
    await page.getByRole("button", { name: "Unirme", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
  } finally {
    await phone.close();
  }
});

test("con otro correo: se le dice sin mostrar nada de la organización, puede cerrar sesión e ingresar con el correcto", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const intended = uniqueEmail("acepta-destino");
  const other = uniqueEmail("acepta-otra");
  await createAccount(browser, baseURL, intended, "Persona Destino");
  await invite(ownerPage, tenantId, intended, "admin");
  const { link } = await waitForInviteLink(intended);

  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await signUpAndVerify(page, other, "Persona Equivocada");
    await page.goto(link);
    await expect(page).toHaveURL(`${baseURL}/invitacion`);

    const unavailable = page.getByTestId("invitation-unavailable");
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toHaveAttribute("data-result", "wrong_email");
    await expect(
      page.getByText(
        "Esta invitación es para otro correo. Ingresa con el correo al que llegó la invitación.",
      ),
    ).toBeVisible();
    await expect(page.getByText(`Ingresaste como ${other}.`)).toBeVisible();
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain(ORG_NAME);
    expect(bodyText).not.toContain(OWNER_NAME);
    expect(bodyText).not.toContain("Administrador");
    await expect(page.getByRole("button", { name: "Unirme", exact: true })).toHaveCount(0);

    // La invitación sigue pendiente y la persona equivocada no es miembro.
    await withDb(async (db) => {
      const invitation = await db.query<{ status: string }>(
        "select status from public.invitations where tenant_id = $1 and email_hash is not null and role = 'admin'",
        [tenantId],
      );
      expect(invitation.rows).toEqual([{ status: "pending" }]);
      const member = await db.query(
        `select 1 from public.members m join auth.users u on u.id = m.user_id
          where m.tenant_id = $1 and u.email = $2`,
        [tenantId, other],
      );
      expect(member.rowCount).toBe(0);
      // Corrección I1: ver esta pantalla no deja registro en la auditoría ni suma un fallo a la cuenta
      // (solo un intento real de aceptar lo haría; aquí no hay botón para aceptar).
      const denied = await db.query(
        `select 1 from public.audit_log a join auth.users u on u.id = a.actor_user_id
          where a.tenant_id = $1 and a.action = 'invitation.accept_denied' and u.email = $2`,
        [tenantId, other],
      );
      expect(denied.rowCount).toBe(0);
      expect(await failuresOfAccount(db, other)).toBe(0);
    });

    // Cierra sesión (el código se conserva) e ingresa con el correo al que llegó.
    await page.getByRole("button", { name: "Cerrar sesión e ingresar con otro correo" }).click();
    await expect(page).toHaveURL(/\/ingresar/);
    await login(page, intended);
    await expect(page).toHaveURL(`${baseURL}/invitacion`);
    await expect(page.getByTestId("invitation-sentence")).toHaveText(
      `${OWNER_NAME} te invitó a ${ORG_NAME} como Administrador.`,
    );
    await page.getByRole("button", { name: "Unirme", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
    await withDb(async (db) => {
      const { rows } = await db.query<{ role: string }>(
        `select m.role from public.members m join auth.users u on u.id = m.user_id
          where m.tenant_id = $1 and u.email = $2`,
        [tenantId, intended],
      );
      expect(rows).toEqual([{ role: "admin" }]);
    });
  } finally {
    await context.close();
  }
});

test("mirar una invitación ajena (o códigos inventados) no deja registro, no bloquea y la propia invitación sigue sirviendo; la ventana queda aislada", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const mine = uniqueEmail("acepta-victima");
  const someoneElse = uniqueEmail("acepta-ajena");
  await createAccount(browser, baseURL, mine, "Persona Visitante");
  await invite(ownerPage, tenantId, someoneElse, "admin");
  const foreign = await waitForInviteLink(someoneElse);
  await invite(ownerPage, tenantId, mine, "viewer");
  const own = await waitForInviteLink(mine);

  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await page.goto("/ingresar");
    await login(page, mine);
    await expect(page).toHaveURL(/\/organizaciones\/nueva$/);

    const auditBefore = await withDb((db) => auditRowsOf(db, mine));

    // --- una visita a una invitación AJENA, varias veces (como si otro sitio nos mandara allí) ---
    for (let n = 0; n < 3; n++) {
      await page.goto(foreign.link);
      await expect(page.getByTestId("invitation-unavailable")).toHaveAttribute(
        "data-result",
        "wrong_email",
      );
      await page.goto("/invitacion");
      await expect(page.getByTestId("invitation-unavailable")).toHaveAttribute(
        "data-result",
        "wrong_email",
      );
    }
    // --- y 12 códigos inventados: antes bastaban 11 para dejar a la cuenta bloqueada 10 minutos ---
    for (let n = 0; n < 12; n++) {
      await page.goto(`/invitacion/${randomBytes(32).toString("base64url")}`);
      await expect(page.getByTestId("invitation-unavailable")).toHaveAttribute(
        "data-result",
        "not_found",
      );
    }
    await withDb(async (db) => {
      // Ni una fila nueva de esta cuenta en la auditoría (de ninguna organización) ni un fallo en la cuenta.
      expect(await auditRowsOf(db, mine)).toBe(auditBefore);
      expect(await failuresOfAccount(db, mine)).toBe(0);
    });

    // --- la invitación propia sigue sirviendo: no está bloqueada ---
    await page.goto(own.link);
    await expect(page.getByTestId("invitation-sentence")).toHaveText(
      `${OWNER_NAME} te invitó a ${ORG_NAME} como Observador.`,
    );
    await page.getByRole("button", { name: "Unirme", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
    await withDb(async (db) => {
      const { rows } = await db.query<{ role: string }>(
        `select m.role from public.members m join auth.users u on u.id = m.user_id
          where m.tenant_id = $1 and u.email = $2`,
        [tenantId, mine],
      );
      expect(rows).toEqual([{ role: "viewer" }]);
    });
  } finally {
    await context.close();
  }
});

test("«Unirme» acepta la invitación que se mostró: si otra página cambió la cookie entre medio, no entra a ninguna y vuelve a mostrar la de ahora", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const victim = uniqueEmail("acepta-cambiada");
  const otherOrg = "Otra Organización Invitante SpA";
  await createAccount(browser, baseURL, victim, "Persona Cambiada");
  // Otra organización (la de quien quiere meter a la persona en la suya) también la invita.
  const otherContext = await newContext(browser, baseURL);
  const context = await newContext(browser, baseURL);
  try {
    const otherOwner = await otherContext.newPage();
    await signUpAndVerify(otherOwner, uniqueEmail("acepta-otra-org"), "Dueño Otra Org");
    const otherTenant = await createTenant(otherOwner, otherOrg, generateRut());
    await invite(ownerPage, tenantId, victim, "viewer");
    const shown = await waitForInviteLink(victim, 1);
    await invite(otherOwner, otherTenant, victim, "admin");
    const swapped = await waitForInviteLink(victim, 2);

    const page = await context.newPage();
    await page.goto("/ingresar");
    await login(page, victim);
    await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
    await page.goto(shown.link);
    await expect(page.getByTestId("invitation-sentence")).toHaveText(
      `${OWNER_NAME} te invitó a ${ORG_NAME} como Observador.`,
    );
    // El formulario lleva la huella de lo que se mostró, nunca el código ni la huella que usa la base.
    const html = await page.content();
    expect(html).not.toContain(shown.token);
    expect(html).not.toContain(sha256(shown.token));
    const auditBefore = await withDb((db) => auditRowsOf(db, victim));

    // Otra pestaña (o una página ajena con una navegación de primer nivel) abre el otro enlace: la cookie cambia.
    const other = await context.newPage();
    await other.goto(swapped.link);
    await other.close();
    expect((await context.cookies()).find((c) => c.name === COOKIE_NAME)?.value).toBe(
      swapped.token,
    );

    // En la pestaña original, la persona pulsa «Unirme» creyendo que entra a la primera.
    await page.getByRole("button", { name: "Unirme", exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/invitacion?aviso=invitacion-cambio`);
    await expect(page.getByTestId("invitation-changed")).toHaveText(
      "Ahora se muestra otra invitación. Revisa a qué organización te unes.",
    );
    // Ahora se muestra la invitación que hay de verdad en la cookie.
    await expect(page.getByTestId("invitation-sentence")).toContainText(otherOrg);
    await withDb(async (db) => {
      const member = await db.query(
        `select 1 from public.members m join auth.users u on u.id = m.user_id
          where m.tenant_id in ($1, $2) and u.email = $3`,
        [tenantId, otherTenant, victim],
      );
      expect(member.rowCount).toBe(0);
      const pending = await db.query<{ status: string }>(
        "select status from public.invitations where token_sha256 in ($1, $2)",
        [sha256(shown.token), sha256(swapped.token)],
      );
      expect(pending.rows).toEqual([{ status: "pending" }, { status: "pending" }]);
      // No llamó a la base: ni un fallo sumado ni una fila en la auditoría.
      expect(await failuresOfAccount(db, victim)).toBe(0);
      expect(await auditRowsOf(db, victim)).toBe(auditBefore);
    });

    // Si, ya viéndola, decide unirse a la que ahora se muestra, el clic sí vale (y es esa, no la primera).
    await page.getByRole("button", { name: "Unirme", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${otherTenant}$`));
    await withDb(async (db) => {
      const { rows } = await db.query<{ tenant_id: string }>(
        `select m.tenant_id from public.members m join auth.users u on u.id = m.user_id
          where u.email = $1 and m.tenant_id in ($2, $3)`,
        [victim, tenantId, otherTenant],
      );
      expect(rows).toEqual([{ tenant_id: otherTenant }]);
    });
  } finally {
    await context.close();
    await otherContext.close();
  }
});

test("la invitación manda Cross-Origin-Opener-Policy: same-origin, en el enlace del correo y en la pantalla", async ({
  browser,
  baseURL,
}) => {
  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();
    const code = randomBytes(32).toString("base64url");
    // La respuesta del enlace (la redirección) y la de la pantalla a la que lleva.
    const redirect = await page.request.get(`/invitacion/${code}`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(303);
    expect(redirect.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    const screen = await page.goto("/invitacion");
    expect(screen?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    const viaLink = await page.goto(`/invitacion/${code}`);
    expect(viaLink?.url()).toBe(`${baseURL}/invitacion`);
    expect(viaLink?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    // El resto de la aplicación no cambia.
    const signIn = await page.goto("/ingresar");
    expect(signIn?.headers()["cross-origin-opener-policy"]).toBeUndefined();
  } finally {
    await context.close();
  }
});

test("«Seguir sin unirme» borra el código y vuelve al inicio", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("acepta-no-gracias");
  await invite(ownerPage, tenantId, email, "viewer");
  const { link } = await waitForInviteLink(email);

  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await signUpAndVerify(page, email, "Sin Unirme");
    await page.goto(link);
    await expect(page.getByTestId("invitation-ready")).toBeVisible();
    await page.getByRole("button", { name: "Seguir sin unirme" }).click();
    // Sin organizaciones y sin invitación esperando, el inicio lleva a crear la primera.
    await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
    expect((await context.cookies()).find((c) => c.name === COOKIE_NAME)).toBeUndefined();
    await withDb(async (db) => {
      const { rows } = await db.query<{ status: string }>(
        `select i.status from public.invitations i where i.tenant_id = $1 and i.role = 'viewer'
            and i.email_hash is not null and i.status = 'pending'`,
        [tenantId],
      );
      expect(rows.length).toBeGreaterThan(0);
      const member = await db.query(
        `select 1 from public.members m join auth.users u on u.id = m.user_id
          where m.tenant_id = $1 and u.email = $2`,
        [tenantId, email],
      );
      expect(member.rowCount).toBe(0);
    });
  } finally {
    await context.close();
  }
});

test("sin conexión: «Unirme» y «Seguir sin unirme» avisan en la misma pantalla y, al volver la red, funcionan", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("acepta-sin-red");
  await invite(ownerPage, tenantId, email, "viewer");
  const { link } = await waitForInviteLink(email);

  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await signUpAndVerify(page, email, "Sin Red");
    await page.goto(link);
    await expect(page.getByTestId("invitation-ready")).toBeVisible();

    await context.setOffline(true);
    const offlineMessage = page
      .getByRole("alert")
      .filter({ hasText: "No pudimos comunicarnos con el servidor" });
    await page.getByRole("button", { name: "Unirme", exact: true }).click();
    await expect(offlineMessage).toHaveCount(1);
    // La persona sigue viendo su invitación: no cae a la pantalla de error de «problema de nuestro lado».
    await expect(page.getByTestId("invitation-ready")).toBeVisible();
    await expect(page.getByText("Tuvimos un problema de nuestro lado")).toHaveCount(0);

    await page.getByRole("button", { name: "Seguir sin unirme" }).click();
    await expect(offlineMessage).toHaveCount(2);
    await expect(page.getByTestId("invitation-ready")).toBeVisible();

    await context.setOffline(false);
    await page.getByRole("button", { name: "Unirme", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
  } finally {
    await context.close();
  }
});

test("el registro recuerda usar el correo de la invitación, y solo cuando hay una invitación en curso", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail("acepta-ayuda-registro");
  await invite(ownerPage, tenantId, email, "viewer");
  const { link } = await waitForInviteLink(email);

  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await page.goto("/registro");
    await expect(page.getByRole("heading", { name: "Crea tu cuenta" })).toBeVisible();
    await expect(page.getByTestId("signup-invitation-hint")).toHaveCount(0);

    await page.goto(link);
    await page.getByRole("link", { name: "Crear mi cuenta", exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/registro`);
    const hint = page.getByTestId("signup-invitation-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("Crea tu cuenta con el correo al que llegó la invitación");
    // Aquí todavía no se sabe de quién es la invitación: no se nombra la organización.
    expect(await hint.innerText()).not.toContain(ORG_NAME);
  } finally {
    await context.close();
  }
});

test("invitación vencida y cancelada: se explica con claridad y a quién pedir otra", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const late = uniqueEmail("acepta-vencida");
  const cancelled = uniqueEmail("acepta-cancelada");
  await createAccount(browser, baseURL, late, "Llegó Tarde");
  await createAccount(browser, baseURL, cancelled, "Se Canceló");
  await invite(ownerPage, tenantId, late, "sales");
  const lateInvite = await waitForInviteLink(late);
  await invite(ownerPage, tenantId, cancelled, "sales");
  const cancelledInvite = await waitForInviteLink(cancelled);

  // --- vencida ---
  await withDb((db) =>
    db.query(
      "update public.invitations set expires_at = now() - interval '1 day' where token_sha256 = $1",
      [sha256(lateInvite.token)],
    ),
  );
  const lateContext = await newContext(browser, baseURL);
  try {
    const page = await lateContext.newPage();
    await page.goto("/ingresar");
    await login(page, late);
    await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
    await page.goto(lateInvite.link);
    await expect(page).toHaveURL(`${baseURL}/invitacion`);
    const unavailable = page.getByTestId("invitation-unavailable");
    await expect(unavailable).toHaveAttribute("data-result", "expired");
    await expect(
      page.getByText("Esta invitación venció. Pide a quien te invitó que te envíe una nueva."),
    ).toBeVisible();
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain(ORG_NAME);
    await expect(page.getByRole("button", { name: "Unirme", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Entendido" }).click();
    await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
  } finally {
    await lateContext.close();
  }

  // --- cancelada por el Dueño desde «Tu equipo» ---
  await ownerPage.goto(`/o/${tenantId}/equipo`);
  const row = ownerPage.getByTestId("invitation-row").filter({ hasText: cancelled });
  await row.getByTestId("invitation-revoke").click();
  await ownerPage.getByRole("alertdialog").getByRole("button", { name: "Sí, cancelar" }).click();
  await expect(row).toHaveCount(0);
  const cancelledContext = await newContext(browser, baseURL);
  try {
    const page = await cancelledContext.newPage();
    await page.goto("/ingresar");
    await login(page, cancelled);
    await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
    await page.goto(cancelledInvite.link);
    await expect(page.getByTestId("invitation-unavailable")).toHaveAttribute(
      "data-result",
      "revoked",
    );
    await expect(
      page.getByText(
        "Esta invitación fue cancelada. Pide a quien te invitó que te envíe una nueva.",
      ),
    ).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(ORG_NAME);
    await withDb(async (db) => {
      const member = await db.query(
        `select 1 from public.members m join auth.users u on u.id = m.user_id
          where m.tenant_id = $1 and u.email in ($2, $3)`,
        [tenantId, late, cancelled],
      );
      expect(member.rowCount).toBe(0);
    });
  } finally {
    await cancelledContext.close();
  }
});

test("un enlace mal formado o inventado no abre nada: aviso claro y ninguna cookie", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail("acepta-inventado");
  await createAccount(browser, baseURL, email, "Probando Enlaces");
  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();

    // Mal formado: ni se guarda ni se consulta.
    await page.goto("/invitacion/esto-no-es-un-codigo");
    await expect(page).toHaveURL(`${baseURL}/invitacion?aviso=enlace-no-valido`);
    await expect(
      page.getByText(
        "Este enlace de invitación no es válido. Revisa que lo hayas abierto completo desde el correo, o pide que te envíen otra invitación.",
      ),
    ).toBeVisible();
    expect((await context.cookies()).find((c) => c.name === COOKIE_NAME)).toBeUndefined();
    // Sin sesión también hay un botón grande para seguir.
    const toLogin = page.getByTestId("invitation-missing-action");
    await expect(toLogin).toHaveText("Ingresar");
    expect((await toLogin.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    // Bien formado pero inventado: sin sesión no se sabe nada; con sesión, «no es válido».
    const invented = "A".repeat(43);
    await page.goto(`/invitacion/${invented}`);
    await expect(page).toHaveURL(`${baseURL}/invitacion`);
    await expect(page.getByTestId("invitation-signed-out")).toBeVisible();
    await page.getByRole("link", { name: "Ingresar", exact: true }).click();
    await login(page, email);
    await expect(page).toHaveURL(`${baseURL}/invitacion`);
    await expect(page.getByTestId("invitation-unavailable")).toHaveAttribute(
      "data-result",
      "not_found",
    );
    await expect(
      page.getByText(
        "Este enlace de invitación no es válido. Revisa que lo hayas abierto completo desde el correo, o pide a quien te invitó que te envíe otra.",
      ),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("si ya es miembro, la vista previa dice su rol actual y que la invitación no lo cambia", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("acepta-ya-miembro");
  await createAccount(browser, baseURL, email, "Ya Era Miembro");
  await invite(ownerPage, tenantId, email, "admin");
  const { link } = await waitForInviteLink(email);
  // Entra a la organización por otro camino DESPUÉS de que le llegó la invitación, como Observador.
  await withDb((db) =>
    db.query(
      `insert into public.members (tenant_id, user_id, role)
       select $1, id, 'viewer' from auth.users where email = $2`,
      [tenantId, email],
    ),
  );

  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await page.goto("/ingresar");
    await login(page, email);
    await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
    await page.goto(link);
    await expect(page.getByTestId("invitation-already-member")).toHaveText(
      `Ya eres parte de ${ORG_NAME} como Observador. Esta invitación no cambia tu rol.`,
    );
    // No promete el rol de la invitación.
    await expect(page.getByText("Configura la organización, maneja el equipo")).toHaveCount(0);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
    await withDb(async (db) => {
      const { rows } = await db.query<{ role: string }>(
        `select m.role from public.members m join auth.users u on u.id = m.user_id
          where m.tenant_id = $1 and u.email = $2`,
        [tenantId, email],
      );
      expect(rows).toEqual([{ role: "viewer" }]);
    });
  } finally {
    await context.close();
  }
});

test("si «Unirme» falla porque el código ya no sirve, queda una sola salida («Entendido»)", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("acepta-se-cancela");
  await createAccount(browser, baseURL, email, "Se Cancela Al Final");
  await invite(ownerPage, tenantId, email, "viewer");
  const { link, token } = await waitForInviteLink(email);

  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await page.goto("/ingresar");
    await login(page, email);
    await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
    await page.goto(link);
    await expect(page.getByTestId("invitation-ready")).toBeVisible();
    // La cancelan justo antes del clic.
    await withDb((db) =>
      db.query(
        `update public.invitations set status = 'revoked', revoked_at = now(), revoke_reason = 'cancelled'
          where token_sha256 = $1`,
        [sha256(token)],
      ),
    );
    await page.getByRole("button", { name: "Unirme", exact: true }).click();
    await expect(
      page.getByText(
        "Esta invitación fue cancelada. Pide a quien te invitó que te envíe una nueva.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Entendido", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Seguir sin unirme" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Unirme", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Entendido", exact: true }).click();
    await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
  } finally {
    await context.close();
  }
});

test("bloqueada por intentos: se ofrece «Intentar de nuevo» y el código se queda guardado", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("acepta-bloqueada");
  await createAccount(browser, baseURL, email, "Bloqueada Por Intentos");
  await invite(ownerPage, tenantId, email, "viewer");
  const { link, token } = await waitForInviteLink(email);
  // La cuenta ya gastó sus intentos fallidos (el contador es una huella del id de la cuenta).
  await withDb((db) =>
    db.query(
      `insert into public.auth_rate_limits (scope, key_hash, failures, locked_until)
       select 'invite_accept_user', encode(sha256(convert_to('invite_accept_user|' || id::text, 'UTF8')), 'hex'),
              10, now() + interval '10 minutes'
         from auth.users where email = $1`,
      [email],
    ),
  );

  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await page.goto("/ingresar");
    await login(page, email);
    await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
    await page.goto(link);
    await expect(page.getByTestId("invitation-unavailable")).toHaveAttribute(
      "data-result",
      "rate_limited",
    );
    await expect(
      page.getByText("Demasiados intentos. Espera unos minutos e inténtalo de nuevo."),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Intentar de nuevo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Entendido", exact: true })).toHaveCount(0);
    // El código sigue en la cookie: al terminar el bloqueo, «Intentar de nuevo» lo usa.
    expect((await context.cookies()).find((c) => c.name === COOKIE_NAME)?.value).toBe(token);
    await withDb((db) =>
      db.query(
        `update public.auth_rate_limits set locked_until = now() - interval '1 second'
          where scope = 'invite_accept_user'
            and key_hash = (select encode(sha256(convert_to('invite_accept_user|' || id::text, 'UTF8')), 'hex')
                              from auth.users where email = $1)`,
        [email],
      ),
    );
    await page.getByRole("link", { name: "Intentar de nuevo" }).click();
    await expect(page.getByTestId("invitation-ready")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("el cierre de sesión normal borra la invitación guardada (computador compartido)", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail("acepta-compartido");
  await invite(ownerPage, tenantId, email, "viewer");
  const { link } = await waitForInviteLink(email);
  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await signUpAndVerify(page, email, "Computador Compartido");
    await page.goto(link);
    await expect(page.getByTestId("invitation-ready")).toBeVisible();
    expect((await context.cookies()).find((c) => c.name === COOKIE_NAME)).toBeDefined();
    // Sale desde otra pantalla de la cuenta: la invitación de esta persona no debe quedar para la siguiente.
    await page.goto("/organizaciones/nueva");
    await page.getByRole("button", { name: "Cerrar sesión" }).click();
    await expect(page).toHaveURL(/\/ingresar\?aviso=sesion-cerrada$/);
    expect((await context.cookies()).find((c) => c.name === COOKIE_NAME)).toBeUndefined();
  } finally {
    await context.close();
  }
});

test("teléfono (375 px): la invitación se lee sin desplazamiento horizontal y los botones miden 44 px", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("acepta-telefono");
  await createAccount(browser, baseURL, email, "Desde El Teléfono");
  await invite(ownerPage, tenantId, email, "sales");
  const { link } = await waitForInviteLink(email);

  const context = await browser.newContext({
    baseURL,
    viewport: MOBILE,
    extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
  });
  try {
    const page = await context.newPage();
    await page.goto(link);
    await expect(page.getByTestId("invitation-signed-out")).toBeVisible();
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
    for (const name of ["Ingresar", "Crear mi cuenta"]) {
      const box = await page
        .getByTestId("invitation-signed-out")
        .getByRole("link", { name, exact: true })
        .boundingBox();
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("link", { name: "Ingresar", exact: true }).click();
    await login(page, email);
    await expect(page.getByTestId("invitation-ready")).toBeVisible();
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
    for (const name of ["Unirme", "Seguir sin unirme"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
    }
  } finally {
    await context.close();
  }
});

test("sin conexión: el formulario de «Unirme» avisa y la aceptación no se pierde al reintentar", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("acepta-sin-red");
  await createAccount(browser, baseURL, email, "Sin Red");
  await invite(ownerPage, tenantId, email, "viewer");
  const { link } = await waitForInviteLink(email);

  const context = await newContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await page.goto("/ingresar");
    await login(page, email);
    await expect(page).toHaveURL(/\/organizaciones\/nueva$/);
    await page.goto(link);
    await expect(page.getByTestId("invitation-ready")).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByTestId("offline-notice")).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByTestId("offline-notice")).toHaveCount(0);
    await page.getByRole("button", { name: "Unirme", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${tenantId}$`));
  } finally {
    await context.close();
  }
});

test("el límite de aperturas por IP: pasado el tope, el enlace ya no guarda el código", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  // Una IP propia para este contexto: no gasta el cupo de las demás pruebas.
  const context = await newContext(browser, baseURL);
  try {
    const request = context.request;
    const statuses: number[] = [];
    let blockedAt = 0;
    for (let n = 1; n <= 40; n++) {
      const token = Buffer.from(`${n}`.padStart(32, "x")).toString("base64url").slice(0, 43);
      const res = await request.get(`/invitacion/${token.padEnd(43, "A")}`, { maxRedirects: 0 });
      statuses.push(res.status());
      const location = res.headers()["location"] ?? "";
      if (!blockedAt && location.includes("aviso=muchos-intentos")) blockedAt = n;
    }
    expect(statuses.every((s) => s === 303)).toBe(true);
    // 30 aperturas por minuto: la 31 es la primera bloqueada.
    expect(blockedAt).toBe(31);
    // Las primeras 30 aperturas sí dejaron su cookie; la bloqueada no. Se vacía para ver solo el aviso.
    await context.clearCookies();
    const page = await context.newPage();
    await page.goto("/invitacion?aviso=muchos-intentos");
    await expect(
      page.getByText("Se abrieron muchos enlaces de invitación", { exact: false }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
