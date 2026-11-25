import { createHash } from "node:crypto";
import type { Client } from "pg";
import { generateRut } from "../src/lib/chile/rut";
import { TENANT_HEADER } from "../src/lib/tenant/constants";
import { connect } from "../tests/db/helpers";
import { localEnv, rest, rpc } from "../tests/support/local-supabase";
import { expect, test } from "./fixtures";
import {
  MAILBOX_URL,
  TEST_PASSWORD,
  confirmEmailFromLink,
  countMails,
  createTenant,
  requestSignupLink,
  signUpAndVerify,
  submitAccountSetup,
  uniqueEmail,
  waitForAccountLink,
} from "./helpers";

// H-116: el ataque que motivó la historia, de punta a punta. Alguien se registra ANTES con el correo de otra persona y con
// su propia contraseña; cuando la dueña del correo verifica, esa contraseña seguía sirviendo y, con la invitación de H-009,
// el atacante quedaba como Administrador de una organización ajena. Con el registro apagado, la pasarela del servidor y las
// barreras de la base, la contraseña del atacante no sirve y su pase viejo tampoco. Todo ficticio (@ejemplo.test).
//
// OJO con el simulacro: el registro público de Supabase está APAGADO, así que quien planta la cuenta lo hace aquí con la
// llave maestra (lo mismo que haría un registro abierto por error en el panel de producción). La variante «la contraseña
// plantada sobrevivió» se simula con un `update` SQL a `auth.users.encrypted_password`: fijarla con la API de administración
// cierra las sesiones de la cuenta (etapa 2, hallazgo 2) y no representaría el peor caso.

const ATTACKER_PASSWORD = "Clave-Del-Atacante-1";
const SURVIVING_PASSWORD = "Clave-Sobreviviente-2";
const VICTIM_PASSWORD = "Clave-De-La-Victima-3";
/** Cuántas veces intenta entrar el atacante mientras la víctima hace su recorrido, y cada cuánto. El tope de Supabase local es de 60 ingresos por 5 minutos y por IP, y lo comparten todas las pruebas: por eso es más lento que el «cada 200 ms» del diseño. */
const ATTACKER_LOOP_ATTEMPTS = 20;
const ATTACKER_LOOP_INTERVAL_MS = 1_500;

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

function adminHeaders() {
  const { secretKey } = localEnv();
  return {
    apikey: secretKey,
    authorization: `Bearer ${secretKey}`,
    "content-type": "application/json",
  };
}

type Grant = { status: number; code: string | null; accessToken: string | null };

async function passwordGrant(email: string, password: string): Promise<Grant> {
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

/** Lo que haría un registro público abierto por error: una cuenta SIN verificar, con la contraseña y el nombre del atacante. */
async function plantAccount(email: string): Promise<string> {
  const { apiUrl } = localEnv();
  const res = await fetch(`${apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      email,
      password: ATTACKER_PASSWORD,
      email_confirm: false,
      user_metadata: { full_name: "Atacante", accepted_legal: { terms: "x", privacy: "x" } },
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

type MailDetail = { HTML: string; Subject: string };

/** El enlace de la invitación (`/invitacion/<código>`) del correo que llegó a esa dirección. */
async function waitForInvitationLink(address: string): Promise<{ link: string; token: string }> {
  let found: { link: string; token: string } | null = null;
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
        );
        const { messages } = (await search.json()) as { messages?: { ID: string }[] };
        for (const { ID } of messages ?? []) {
          const mail = (await (
            await fetch(`${MAILBOX_URL}/api/v1/message/${ID}`)
          ).json()) as MailDetail;
          const match = /href="(https?:\/\/[^"]*\/invitacion\/([A-Za-z0-9_-]{43}))"/.exec(
            mail.HTML,
          );
          if (mail.Subject.includes("te invitó a") && match) {
            found = { link: match[1], token: match[2] };
            return true;
          }
        }
        return false;
      },
      { message: `No llegó la invitación a ${address}`, timeout: 30_000 },
    )
    .toBe(true);
  return found!;
}

async function currentLegalVersions(): Promise<{
  p_terms_version: string;
  p_privacy_version: string;
}> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ kind: string; version: string }>(
      "select kind, version from public.legal_documents where is_current",
    );
    const by = Object.fromEntries(rows.map((row) => [row.kind, row.version]));
    return { p_terms_version: by.terms, p_privacy_version: by.privacy };
  });
}

test("el ataque completo: con el correo de la víctima y una contraseña plantada, la víctima termina su cuenta y el pase del atacante no sirve", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(420_000);
  const victimEmail = uniqueEmail("victima");
  const ownerEmail = uniqueEmail("dueno-atacado");
  const { apiUrl, publishableKey } = localEnv();

  // La organización que invita a la víctima como Administradora (el premio del ataque, con H-009).
  const ownerContext = await browser.newContext({ baseURL });
  const ownerPage = await ownerContext.newPage();
  await signUpAndVerify(ownerPage, ownerEmail, "Dueña Atacada");
  const tenantId = await createTenant(ownerPage, "Organización Atacada", generateRut());
  await ownerPage.goto(`/o/${tenantId}/equipo`);
  await ownerPage.getByTestId("invite-email").fill(victimEmail);
  await ownerPage.getByTestId("invite-role-admin").click();
  await ownerPage.getByTestId("invite-submit").click();
  await expect(ownerPage.getByText(`Enviamos la invitación a ${victimEmail}.`)).toBeVisible();
  const invitation = await waitForInvitationLink(victimEmail);

  // 1. El atacante intenta registrarse con la API pública: está apagada. Y planta la cuenta con la llave maestra.
  const signup = await fetch(`${apiUrl}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({
      email: victimEmail,
      password: ATTACKER_PASSWORD,
      data: { full_name: "Atacante", accepted_legal: { terms: "x", privacy: "x" } },
    }),
  });
  expect(signup.status).toBe(422);
  expect(((await signup.json()) as { error_code: string }).error_code).toBe("signup_disabled");
  const victimId = await plantAccount(victimEmail);

  // Un programa del atacante intenta entrar con su contraseña durante todo el recorrido de la víctima. Ningún intento da sesión.
  let attackerSessions = 0;
  let attackerAttempts = 0;
  let stopLoop = false;
  const loop = (async () => {
    while (!stopLoop && attackerAttempts < ATTACKER_LOOP_ATTEMPTS) {
      attackerAttempts += 1;
      const grant = await passwordGrant(victimEmail, ATTACKER_PASSWORD);
      if (grant.status === 200) attackerSessions += 1;
      await new Promise((resolve) => setTimeout(resolve, ATTACKER_LOOP_INTERVAL_MS));
    }
  })();

  try {
    // 2. La víctima abre su invitación y crea su cuenta POR LA PANTALLA (correo → enlace → «Continuar»).
    const victimContext = await browser.newContext({ baseURL });
    const victimPage = await victimContext.newPage();
    await victimPage.goto(invitation.link);
    await expect(victimPage).toHaveURL(`${baseURL}/invitacion`);
    await victimPage.getByRole("link", { name: "Crear mi cuenta", exact: true }).click();
    await requestSignupLink(victimPage, victimEmail);
    const link = await waitForAccountLink(victimEmail);

    // La contraseña del atacante ya no sirve (la pasarela puso otra al azar), aunque la cuenta no estaba verificada.
    expect((await passwordGrant(victimEmail, ATTACKER_PASSWORD)).code).toBe("invalid_credentials");

    await confirmEmailFromLink(victimPage, link);

    // 3. Peor caso: «la contraseña plantada sobrevivió» (un cambio de configuración, una cuenta antigua…). Con ella el atacante
    //    entra ahora (el correo ya está verificado) y guarda su pase, que todavía no vence.
    await withDb((db) =>
      db.query(
        "update auth.users set encrypted_password = crypt($1, gen_salt('bf')) where id = $2",
        [SURVIVING_PASSWORD, victimId],
      ),
    );
    const planted = await passwordGrant(victimEmail, SURVIVING_PASSWORD);
    expect(planted.status).toBe(200);
    const attackerPass = planted.accessToken!;

    // 4. La víctima termina su cuenta con SU contraseña y se une a la organización.
    await submitAccountSetup(victimPage, "Víctima Ficticia", VICTIM_PASSWORD);
    await expect(victimPage).toHaveURL(`${baseURL}/invitacion`);
    await victimPage.getByRole("button", { name: "Unirme", exact: true }).click();
    await expect(victimPage).toHaveURL(new RegExp(`/o/${tenantId}$`));

    stopLoop = true;
    await loop;
    expect(attackerSessions, "ningún intento del atacante dio sesión").toBe(0);
    expect(attackerAttempts).toBeGreaterThan(3);

    // 5. Lo que dice la base: una sola sesión (la de la víctima) y todo lo escrito después de verificar lo escribió ELLA.
    await withDb(async (db) => {
      const sessions = await db.query("select 1 from auth.sessions where user_id = $1", [victimId]);
      expect(sessions.rowCount).toBe(1);
      const profile = await db.query<{ full_name: string; ready: boolean }>(
        "select full_name, account_ready_at is not null as ready from public.profiles where user_id = $1",
        [victimId],
      );
      expect(profile.rows[0]).toEqual({ full_name: "Víctima Ficticia", ready: true });
      const acceptances = await db.query<{ later: boolean; agent: string }>(
        `select a.accepted_at > u.email_confirmed_at as later, a.user_agent as agent
           from public.legal_acceptances a join auth.users u on u.id = a.user_id where a.user_id = $1`,
        [victimId],
      );
      expect(acceptances.rows.length).toBeGreaterThanOrEqual(2);
      for (const row of acceptances.rows) {
        expect(row.later).toBe(true);
        expect(row.agent).toContain("Chrome"); // el navegador de la víctima, no el del atacante
      }
      const member = await db.query<{ role: string; status: string }>(
        "select role, status from public.members where tenant_id = $1 and user_id = $2",
        [tenantId, victimId],
      );
      expect(member.rows).toEqual([{ role: "admin", status: "active" }]);
    });

    // 6. Las contraseñas del atacante (la original y la sobreviviente) ya no entran; la de la víctima sí.
    expect((await passwordGrant(victimEmail, ATTACKER_PASSWORD)).code).toBe("invalid_credentials");
    expect((await passwordGrant(victimEmail, SURVIVING_PASSWORD)).code).toBe("invalid_credentials");
    expect((await passwordGrant(victimEmail, VICTIM_PASSWORD)).status).toBe(200);

    // 7. El pase del atacante sigue sin vencer, pero su sesión ya no existe: la base lo rechaza en todas partes.
    const versions = await currentLegalVersions();
    const noMember = await rest(attackerPass, `members?tenant_id=eq.${tenantId}&select=id`, {
      headers: { [TENANT_HEADER]: tenantId },
    });
    expect(noMember.json).toEqual([]);
    const noTenant = await rest(attackerPass, `tenants?tenant_id=eq.${tenantId}&select=tenant_id`);
    expect(noTenant.json).toEqual([]);
    const rename = await rest(attackerPass, `profiles?user_id=eq.${victimId}&select=full_name`, {
      method: "PATCH",
      body: { full_name: "Hackeado por el atacante" },
      headers: { prefer: "return=representation" },
    });
    expect(rename.json).toEqual([]);
    expect(
      (
        await withDb((db) =>
          db.query("select full_name from public.profiles where user_id = $1", [victimId]),
        )
      ).rows[0].full_name,
    ).toBe("Víctima Ficticia");
    const complete = await rpc(attackerPass, "complete_account_setup", {
      p_full_name: "Hackeado por el atacante",
      ...versions,
    });
    expect(complete.status).toBeGreaterThanOrEqual(400);
    const create = await rpc(attackerPass, "create_tenant", {
      p_name: "Organización del atacante",
      p_rut: generateRut(),
      p_industry: "services",
    });
    expect(create.status).toBeGreaterThanOrEqual(400);
    const accept = await rpc(attackerPass, "accept_invitation", {
      p_token_sha256: createHash("sha256").update(invitation.token).digest("hex"),
    });
    expect(accept.status).toBeGreaterThanOrEqual(400);
    // Y la API de cuentas de Supabase también rechaza ese pase: la sesión se borró.
    const user = await fetch(`${apiUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey, authorization: `Bearer ${attackerPass}` },
    });
    expect(user.status).toBe(403);
    await victimContext.close();
  } finally {
    stopLoop = true;
    await loop;
    await ownerContext.close();
  }
});

test("un pase de una sesión que se cerró ya no sirve en la base, aunque no haya vencido", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail("sesion-cerrada");
  await signUpAndVerify(page, email, "Sesión Cerrada");
  const tenantId = await createTenant(page, "Negocio Sesión Cerrada", generateRut());
  const grant = await passwordGrant(email, TEST_PASSWORD);
  expect(grant.status).toBe(200);
  const pass = grant.accessToken!;

  const readOwn = () =>
    rest(pass, `members?tenant_id=eq.${tenantId}&select=id`, {
      headers: { [TENANT_HEADER]: tenantId },
    });
  expect(((await readOwn()).json as unknown[]).length).toBe(1);

  // Cerrar la sesión de ese pase en el servidor de cuentas (como lo hace «Cerrar sesión» o terminar la cuenta).
  const { apiUrl, publishableKey } = localEnv();
  const logout = await fetch(`${apiUrl}/auth/v1/logout?scope=global`, {
    method: "POST",
    headers: { apikey: publishableKey, authorization: `Bearer ${pass}` },
  });
  expect(logout.status).toBeLessThan(300);

  // El pase no ha vencido (PostgREST solo mira la firma y el vencimiento), pero la base ya no lo deja leer nada.
  expect((await readOwn()).json).toEqual([]);
  expect((await rest(pass, `tenants?tenant_id=eq.${tenantId}&select=tenant_id`)).json).toEqual([]);
  const create = await rpc(pass, "create_tenant", {
    p_name: "Otra",
    p_rut: generateRut(),
    p_industry: "services",
  });
  expect(create.status).toBeGreaterThanOrEqual(400);

  // Y en el navegador, la sesión de la prueba también murió (cierre global): pide ingresar.
  await page.goto(`/o/${tenantId}`);
  await expect(page).toHaveURL(/\/ingresar/);
});

test("«el último clic»: con el disparador puesto, pedir el cambio de correo a la dirección de otra persona falla, el correo no cambia y salen los avisos de «no disponible»", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  // El atacante crea una cuenta con SU correo por nuestro formulario, abre el enlace y, SIN terminarla, pide el cambio al correo
  // de la víctima con la llave pública y su pase (así lo hace quien llama la API directo).
  const attackerEmail = uniqueEmail("atacante-ultimo-clic");
  const victimEmail = uniqueEmail("victima-ultimo-clic");
  await requestSignupLink(page, attackerEmail);
  await confirmEmailFromLink(page, await waitForAccountLink(attackerEmail));
  const cookies = await page.context().cookies();
  expect(cookies.some((cookie) => cookie.name.startsWith("sb-"))).toBe(true);

  // El pase de la sesión del enlace, por la API: un segundo enlace no se puede (ya se usó), así que se pide con la llave
  // maestra un enlace nuevo del mismo tipo y se canjea como lo haría el atacante con su correo.
  const { apiUrl, publishableKey } = localEnv();
  const generated = await fetch(`${apiUrl}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ type: "magiclink", email: attackerEmail }),
  });
  const hashed = ((await generated.json()) as { hashed_token: string }).hashed_token;
  const verified = await fetch(`${apiUrl}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: hashed }),
  });
  const linkSession = (await verified.json()) as { access_token: string };
  expect(linkSession.access_token).toBeTruthy();

  const change = await fetch(`${apiUrl}/auth/v1/user`, {
    method: "PUT",
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${linkSession.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: victimEmail }),
  });
  // El disparador de la base rechaza la escritura: Supabase responde un error del servidor, y el correo de la cuenta no cambia.
  expect(change.status).toBeGreaterThanOrEqual(400);
  await withDb(async (db) => {
    const { rows } = await db.query<{ email: string; email_change: string | null }>(
      "select email, email_change from auth.users where email = $1 or email_change = $2",
      [attackerEmail, victimEmail],
    );
    expect(rows).toEqual([{ email: attackerEmail, email_change: "" }]);
    const profile = await db.query(
      "select 1 from public.profiles where signup_email = $1 and account_ready_at is null",
      [attackerEmail],
    );
    expect(profile.rowCount).toBe(1);
  });

  // Medido (etapa 1): GoTrue alcanza a enviar los dos avisos ANTES de que la base rechace. Son avisos de «no disponible», sin
  // ningún enlace para confirmar nada: sirven de molestia (una puerta de correos no pedidos, anotada en seguridad-pendiente.md),
  // no de ataque.
  const subject = "El cambio de correo no está disponible";
  await expect.poll(() => countMails(victimEmail, subject), { timeout: 30_000 }).toBe(1);
  const noticeSearch = await fetch(
    `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${victimEmail} subject:"${subject}"`)}`,
  );
  const { messages } = (await noticeSearch.json()) as { messages: { ID: string }[] };
  const notice = (await (
    await fetch(`${MAILBOX_URL}/api/v1/message/${messages[0].ID}`)
  ).json()) as {
    Text: string;
    HTML: string;
  };
  expect(notice.Text).toContain("este cambio no se hizo y no hay nada que confirmar");
  expect(notice.HTML).not.toMatch(/\/auth\/v1\/verify/);
  expect(notice.HTML).not.toMatch(/href=/);

  // La cuenta del atacante sigue sin terminar y atrapada: su pase de enlace no le da nada.
  await page.goto("/");
  await expect(page).toHaveURL(`${baseURL}/crear-cuenta`);
  expect(await countMails(attackerEmail, SIGNUP_SUBJECT_SNIPPET)).toBe(1);
});

const SIGNUP_SUBJECT_SNIPPET = "Confirma tu correo para crear tu cuenta";
