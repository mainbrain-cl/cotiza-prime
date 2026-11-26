import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import { localEnv, rpc } from "../tests/support/local-supabase";
import { expect, test } from "./fixtures";
import {
  TEST_PASSWORD,
  countMails,
  registerThroughGateway,
  requestSignupLink,
  uniqueEmail,
  waitForAccountLink,
} from "./helpers";

// H-116 (segunda barrera): el cambio de correo con el DISPARADOR QUITADO. Corre en el proyecto `trigger-off` de Playwright
// (`--project=trigger-off`), con un solo trabajador y NUNCA a la vez que otra suite: mientras dura, la base local no tiene el
// disparador `forbid_email_change` de `auth.users`. Se quita con el superusuario de la base local (el rol `postgres` no es dueño
// de `auth.users`) y se vuelve a poner siempre, también si la prueba falla. Si al empezar el disparador ya está quitado, una
// corrida anterior murió a medias: se detiene con las instrucciones para ponerlo de nuevo.
//
// Lo que se prueba: aunque el disparador faltara (o una versión futura de Supabase lo esquivara), una cuenta cuyo correo ya no es
// el de alta no se puede terminar ni cuenta como terminada (`profiles.signup_email`), venga la sesión del enlace del correo que
// venga (incluida la del «último clic»). El cambio de correo lo hace GoTrue con su propia conexión a la base: por eso no sirve
// el interruptor de soporte (`app.allow_email_change`), que solo vale en la conexión que lo fija.

test.describe.configure({ mode: "serial" });

const TRIGGER = "forbid_email_change";
const SUPERUSER_URL_PARTS = { user: "supabase_admin", password: "postgres" };

function superuserUrl(): string {
  const url = new URL(localEnv().dbUrl);
  url.username = SUPERUSER_URL_PARTS.user;
  url.password = SUPERUSER_URL_PARTS.password;
  return url.href;
}

async function withSuperuser<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: superuserUrl() });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

async function triggerState(): Promise<string | undefined> {
  return withSuperuser(async (db) => {
    const { rows } = await db.query<{ enabled: string }>(
      `select tgenabled as enabled from pg_trigger
        where tgrelid = 'auth.users'::regclass and tgname = $1`,
      [TRIGGER],
    );
    return rows[0]?.enabled;
  });
}

async function setTrigger(enabled: boolean): Promise<void> {
  await withSuperuser((db) =>
    db.query(`alter table auth.users ${enabled ? "enable" : "disable"} trigger ${TRIGGER}`),
  );
}

test.beforeAll(async () => {
  const state = await triggerState();
  if (state !== "O") {
    throw new Error(
      `El disparador ${TRIGGER} de auth.users no está habilitado (estado: ${state ?? "no existe"}). Una corrida anterior pudo morir a medias: vuelve a ponerlo con «alter table auth.users enable trigger ${TRIGGER}» (como supabase_admin) y repite.`,
    );
  }
  await setTrigger(false);
});

test.afterAll(async () => {
  await setTrigger(true);
  expect(await triggerState(), "el disparador tiene que quedar habilitado").toBe("O");
});

function publicHeaders(token?: string) {
  const { publishableKey } = localEnv();
  return {
    apikey: publishableKey,
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function gotrue(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { apiUrl } = localEnv();
  const res = await fetch(`${apiUrl}/auth/v1/${path}`, {
    method,
    headers: publicHeaders(options.token),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as {
    amr?: { method: string }[];
    session_id?: string;
  };

/** Canjea el enlace del correo del registro por una sesión, como lo haría quien tiene el correo (un `POST /verify`). */
async function sessionFromSignupLink(link: string): Promise<string> {
  const tokenHash = new URL(link).searchParams.get("token_hash")!;
  const res = await gotrue("POST", "verify", { body: { type: "invite", token_hash: tokenHash } });
  expect(res.status).toBe(200);
  return res.json.access_token as string;
}

/**
 * El cambio de correo en dos clics, de punta a punta: la cuenta pide cambiar a `victimEmail` (con el disparador quitado
 * GoTrue lo acepta), la víctima confirma en SU correo y el pedido hace el «último clic» en el correo viejo. Las plantillas de
 * Cotiza Prime no traen enlaces de confirmación (a propósito), así que los dos códigos se leen de la base: es lo que habría
 * en los enlaces de una plantilla de serie. Devuelve la sesión que entrega el último clic.
 */
async function changeEmailWithBothClicks(
  fromPass: string,
  fromEmail: string,
  victimEmail: string,
): Promise<string> {
  const change = await gotrue("PUT", "user", { token: fromPass, body: { email: victimEmail } });
  expect(change.status, "sin el disparador, GoTrue acepta el pedido de cambio").toBe(200);
  const tokens = await withSuperuser(async (db) => {
    const { rows } = await db.query<{ current: string; next: string }>(
      `select email_change_token_current as current, email_change_token_new as next
         from auth.users where email = $1`,
      [fromEmail],
    );
    return rows[0];
  });
  // La víctima confirma en SU correo (el nuevo).
  const victimClick = await gotrue("POST", "verify", {
    body: { type: "email_change", token_hash: tokens.next },
  });
  expect(victimClick.status).toBe(200);
  // El atacante hace el último clic en el correo viejo, que es suyo.
  const lastClick = await gotrue("POST", "verify", {
    body: { type: "email_change", token_hash: tokens.current },
  });
  expect(lastClick.status).toBe(200);
  const pass = lastClick.json.access_token as string;
  expect(pass).toBeTruthy();
  return pass;
}

const sha = () => createHash("sha256").update(randomBytes(16)).digest("hex");

async function legalVersions() {
  return withSuperuser(async (db) => {
    const { rows } = await db.query<{ kind: string; version: string }>(
      "select kind, version from public.legal_documents where is_current",
    );
    const by = Object.fromEntries(rows.map((row) => [row.kind, row.version]));
    return { p_terms_version: by.terms, p_privacy_version: by.privacy };
  });
}

test("«el último clic» con el disparador quitado: el atacante que NO terminó su cuenta no puede terminarla con el correo de la víctima, ni con la sesión del enlace original ni con la del último clic", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const attackerEmail = uniqueEmail("atacante-ultimo-clic");
  const victimEmail = uniqueEmail("victima-ultimo-clic");

  // La cuenta del atacante, por nuestro formulario; abre el enlace y NO la termina.
  await requestSignupLink(page, attackerEmail);
  const originalLinkPass = await sessionFromSignupLink(await waitForAccountLink(attackerEmail));
  expect(claimsOf(originalLinkPass).amr?.[0]?.method).toBe("otp");

  const lastClickPass = await changeEmailWithBothClicks(
    originalLinkPass,
    attackerEmail,
    victimEmail,
  );
  // Se anota qué trae la sesión del último clic (el diseño suponía `otp`, igual que el enlace original).
  const lastClickAmr = claimsOf(lastClickPass).amr?.map((entry) => entry.method);
  test.info().annotations.push({ type: "amr del último clic", description: String(lastClickAmr) });
  expect(lastClickAmr).toContain("otp");

  // Ahora la cuenta tiene el correo de la víctima, pero su correo de alta sigue siendo el del atacante.
  await withSuperuser(async (db) => {
    const { rows } = await db.query<{ email: string; signup_email: string; ready: boolean }>(
      `select u.email, p.signup_email, p.account_ready_at is not null as ready
         from auth.users u join public.profiles p on p.user_id = u.id where u.id = $1`,
      [claimsOfUserId(lastClickPass)],
    );
    expect(rows[0]).toEqual({ email: victimEmail, signup_email: attackerEmail, ready: false });
  });

  const versions = await legalVersions();
  for (const [label, pass] of [
    ["la sesión del enlace original", originalLinkPass],
    ["la sesión del último clic", lastClickPass],
  ] as const) {
    const complete = await rpc(pass, "complete_account_setup", {
      p_full_name: "Atacante",
      ...versions,
    });
    expect(complete.json, `${label}: complete_account_setup`).toEqual({ result: "email_changed" });
    expect((await rpc(pass, "my_account_ready")).json, `${label}: my_account_ready`).toBe(false);
    expect(
      (await rpc(pass, "accept_invitation", { p_token_sha256: sha() })).json,
      `${label}: accept_invitation`,
    ).toEqual({ result: "unverified" });
    const create = await rpc(pass, "create_tenant", {
      p_name: "Organización del atacante",
      p_rut: "76086428-5",
      p_industry: "services",
    });
    expect(create.status, `${label}: create_tenant`).toBeGreaterThanOrEqual(400);
  }

  // El rechazo queda en la auditoría (sin el correo) y la cuenta sigue sin terminar.
  await withSuperuser(async (db) => {
    const denied = await db.query(
      `select details::text as d from public.audit_log
        where action = 'account.setup_denied' and actor_user_id = $1`,
      [claimsOfUserId(lastClickPass)],
    );
    expect(denied.rowCount).toBeGreaterThan(0);
    expect(JSON.stringify(denied.rows)).not.toContain("ejemplo.test");
    const profile = await db.query(
      "select account_ready_at from public.profiles where user_id = $1",
      [claimsOfUserId(lastClickPass)],
    );
    expect(profile.rows[0].account_ready_at).toBeNull();
  });

  // Lo que se observa del lado de la víctima: el correo ya pertenece a una cuenta verificada del atacante, así que nuestro
  // formulario no le manda ningún enlace (decisión A2). Es el costo de que el disparador falte; con el disparador puesto no pasa.
  const responseMails = await countMails(victimEmail, "Confirma tu correo para crear tu cuenta");
  expect(responseMails).toBe(0);
});

test("«cambio de correo tras terminar» con el disparador quitado: quien terminó su cuenta y luego cambia su correo al de la víctima deja de contar como terminado", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const attackerEmail = uniqueEmail("atacante-terminada");
  const victimEmail = uniqueEmail("victima-terminada");

  // El atacante termina su propia cuenta por la pantalla y entra con su contraseña.
  await registerThroughGateway(page, attackerEmail, "Atacante Terminado");
  const login = await gotrue("POST", "token?grant_type=password", {
    body: { email: attackerEmail, password: TEST_PASSWORD },
  });
  expect(login.status).toBe(200);
  const passwordPass = login.json.access_token as string;
  expect((await rpc(passwordPass, "my_account_ready")).json).toBe(true);

  const lastClickPass = await changeEmailWithBothClicks(passwordPass, attackerEmail, victimEmail);

  // La cuenta ya no cuenta como terminada, con la sesión que sea (de contraseña o del último clic).
  for (const pass of [passwordPass, lastClickPass]) {
    expect((await rpc(pass, "my_account_ready")).json).toBe(false);
    expect((await rpc(pass, "accept_invitation", { p_token_sha256: sha() })).json).toEqual({
      result: "unverified",
    });
    const create = await rpc(pass, "create_tenant", {
      p_name: "Organización del atacante",
      p_rut: "76086428-5",
      p_industry: "services",
    });
    expect(create.status).toBeGreaterThanOrEqual(400);
  }
  // `complete_account_setup` responde `email_changed` con la sesión del enlace: la cuenta queda para soporte (decisión J1).
  const versions = await legalVersions();
  expect(
    (await rpc(lastClickPass, "complete_account_setup", { p_full_name: "X", ...versions })).json,
  ).toEqual({ result: "email_changed" });
});

/** El id de la cuenta que dueña de un pase. */
function claimsOfUserId(token: string): string {
  return (JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as { sub: string })
    .sub;
}
