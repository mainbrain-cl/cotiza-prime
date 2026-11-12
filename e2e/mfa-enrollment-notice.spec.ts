import { randomUUID } from "node:crypto";
import { freshTotp } from "../src/test/totp";
import { connect } from "../tests/db/helpers";
import { adminCreateUser, signIn } from "../tests/support/local-supabase";
import { challengeAndVerifyRaw, startEnrollment } from "../tests/support/mfa-gate";
import { expect, test, type Page } from "./fixtures";
import { createTenant, signUpAndVerify, uniqueEmail } from "./helpers";

// H-118a · El aviso de que se activó la verificación en dos pasos, de punta a punta (Mailpit en http://127.0.0.1:56324):
// (1) activar manda el correo con el enlace «#» para anular; (2) un correo que no sale (destinatario fuera de la lista
// permitida) revierte la activación con su mensaje; (3) activar directo por la API de Supabase queda rechazado.
// Solo cuentas nuevas @ejemplo.test (o de un dominio fuera de la lista, a propósito en la prueba 2).
test.describe.configure({ mode: "serial" });

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";
const NOTICE_SUBJECT = "Se activó la verificación en dos pasos en tu cuenta";
const REVERTED_MESSAGE =
  "No pudimos enviarte el correo de aviso, así que no dejamos activa la verificación. Inténtalo de nuevo en unos minutos.";

type MailpitMessage = { Subject: string; Text: string; HTML: string };

/** Espera el aviso de la activación en el buzón y lo devuelve. */
async function waitForNotice(address: string): Promise<MailpitMessage> {
  let found: MailpitMessage | null = null;
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${address} subject:activó`)}`,
        );
        const { messages } = (await search.json()) as { messages?: { ID: string }[] };
        if (!messages?.length) return null;
        found = (await (
          await fetch(`${MAILBOX_URL}/api/v1/message/${messages[0].ID}`)
        ).json()) as MailpitMessage;
        return found;
      },
      { message: `Esperaba el aviso de la activación a ${address}`, timeout: 30_000 },
    )
    .not.toBeNull();
  return found!;
}

async function openEnrollment(page: Page): Promise<string> {
  await page.goto("/cuenta/seguridad");
  await page.getByRole("button", { name: "Activar la verificación en dos pasos" }).click();
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  await page.getByRole("button", { name: "Ya la escaneé" }).click();
  return secret;
}

async function submitCode(page: Page, secret: string) {
  await page.getByLabel("Código de 6 números").fill((await freshTotp(secret)).code);
  await page.getByRole("button", { name: "Confirmar y activar" }).click();
}

test("activar manda el aviso por correo, con el botón «No fui yo» y el código tras el «#»; la pantalla dice a qué correo", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("aviso");
  await signUpAndVerify(page, email, "Persona Ficticia");
  await createTenant(page, "Empresa Aviso", "76086428-5");
  const secret = await openEnrollment(page);
  await submitCode(page, secret);
  await expect(page).toHaveURL(/\/cuenta\/seguridad\?aviso=activada$/);
  await expect(page.getByText(`Te enviamos un aviso a ${email}`)).toBeVisible();

  const mail = await waitForNotice(email);
  expect(mail.Subject).toBe(NOTICE_SUBJECT);
  expect(mail.Text).toContain("Si fuiste tú, no hagas nada.");
  expect(mail.Text).toContain("No lo reenvíes.");
  expect(mail.Text).toContain("No fui yo: anular la activación");
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const link = new RegExp(`${origin}/cuenta/anular-dos-pasos#([A-Za-z0-9_-]{43})`).exec(mail.Text);
  expect(link, "el enlace del botón lleva el código tras el «#»").not.toBeNull();
  expect(mail.HTML).toContain(`href="${origin}/cuenta/anular-dos-pasos#${link![1]}"`);

  // En la base queda el aviso `sent` y un enlace con la huella (nunca el código).
  const db = await connect();
  try {
    const alerts = await db.query<{ state: string }>(
      `select a.state from public.mfa_enrollment_alerts a join auth.users u on u.id = a.user_id where u.email = $1`,
      [email],
    );
    expect(alerts.rows).toEqual([{ state: "sent" }]);
    const links = await db.query<{ token_sha256: string }>(
      `select l.token_sha256 from public.mfa_annul_links l join auth.users u on u.id = l.user_id where u.email = $1`,
      [email],
    );
    expect(links.rows).toHaveLength(1);
    expect(links.rows[0].token_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(links.rows[0].token_sha256).not.toContain(link![1]);
  } finally {
    await db.end();
  }
});

test("un correo que no sale (destinatario fuera de la lista permitida) revierte la activación y lo dice", async ({
  page,
}) => {
  test.setTimeout(240_000);
  // Un dominio que la lista permitida de pruebas (ejemplo.test) rechaza: el proveedor "no acepta" el aviso.
  const email = `fuera-${randomUUID().slice(0, 8)}@otro-dominio.test`;
  await signUpAndVerify(page, email, "Persona Ficticia");
  await createTenant(page, "Empresa Sin Aviso", "76086428-5");
  const secret = await openEnrollment(page);
  await submitCode(page, secret);
  await expect(page.getByText(REVERTED_MESSAGE)).toBeVisible();
  await expect(page).toHaveURL(/\/cuenta\/seguridad$/);

  // La activación se revirtió de verdad: el factor ya no existe y el aviso quedó `reverted` con su código.
  const db = await connect();
  try {
    const factors = await db.query(
      `select 1 from auth.mfa_factors f join auth.users u on u.id = f.user_id where u.email = $1`,
      [email],
    );
    expect(factors.rowCount).toBe(0);
    const alerts = await db.query<{ state: string; error_code: string }>(
      `select a.state, a.error_code from public.mfa_enrollment_alerts a join auth.users u on u.id = a.user_id where u.email = $1`,
      [email],
    );
    expect(alerts.rows).toEqual([{ state: "reverted", error_code: "recipient_not_allowed" }]);
    const links = await db.query(
      `select 1 from public.mfa_annul_links l join auth.users u on u.id = l.user_id where u.email = $1`,
      [email],
    );
    expect(links.rowCount).toBe(0);
    const audit = await db.query(
      `select 1 from public.audit_log a join auth.users u on u.id = a.actor_user_id
        where u.email = $1 and a.action = 'session.mfa_enroll_reverted'`,
      [email],
    );
    expect(audit.rowCount).toBe(1);
  } finally {
    await db.end();
  }
  // Y la persona puede volver a la pantalla: la cuenta sigue sin segundo paso.
  await page.goto("/cuenta/seguridad");
  await expect(
    page.getByRole("button", { name: "Activar la verificación en dos pasos" }),
  ).toBeVisible();
});

test("activar hablando directo con Supabase (sin pasar por el servidor) queda rechazado y no activa nada", async () => {
  test.setTimeout(120_000);
  const email = uniqueEmail("directo");
  const userId = await adminCreateUser(email);
  const session = await signIn(email);
  const { factorId, secret } = await startEnrollment(session);
  const rejected = await challengeAndVerifyRaw(session, factorId, secret);
  expect(rejected.status).toBe(500);

  const db = await connect();
  try {
    const factor = await db.query<{ status: string }>(
      "select status::text as status from auth.mfa_factors where id = $1",
      [factorId],
    );
    expect(factor.rows).toEqual([{ status: "unverified" }]);
    const alerts = await db.query("select 1 from public.mfa_enrollment_alerts where user_id = $1", [
      userId,
    ]);
    expect(alerts.rowCount).toBe(0);
  } finally {
    await db.end();
  }
});
