// 🟢 PRUEBAS · Supabase local, datos ficticios.
// H-004b · PASO 0: cómo se comporta Supabase Auth (GoTrue) con lo que H-004b necesita. El diseño
// (`docs/arquitectura/h-004b-codigos-de-respaldo.md`, §7 «Paso 0») se apoya en esto; si una actualización de Supabase
// cambia alguno de estos comportamientos, estas pruebas avisan antes que las pantallas.
//
// Lo que quedó fijado (Supabase local, CLI 2.119, GoTrue vigente, 2026-11-16):
//   P0-1  Las rutas `/auth/v1/factors/recovery-codes` EXISTEN pero están APAGADAS: GET responde 404 `mfa_factor_not_found`
//         («The user has not enrolled recovery codes») y POST 422 `mfa_recovery_codes_enroll_not_enabled` («MFA enroll is
//         disabled for recovery codes»). Con D1 = A no se usan; queda escrito por si cambia la decisión.
//   P0-2  Un cliente desechable (sin cookies, `signInWithPassword`) crea UNA fila en `auth.sessions` (con o sin factor
//         verificado; el pase es aal1) y `signOut({ scope: "local" })` borra exactamente esa fila y su refresh token, sin tocar
//         las demás sesiones. No sale ningún correo (Mailpit queda en cero). El 429 NO se pudo provocar en local (el tope
//         `sign_in_sign_ups` no se activó ni con 80 ingresos seguidos): se comprueba que un 429 que entregue GoTrue llega a
//         la aplicación como `rate_limited` (que es lo que `reauth.ts` no debe contar como contraseña incorrecta).
//   P0-3  `signOut({ scope: "others" })` funciona desde un pase aal1, con o sin factor verificado: cierra todas las otras
//         sesiones y deja viva la propia.
//   P0-4  Quitar el factor con la llave maestra deja `app.second_step_pending()` en falso para una sesión a medias que
//         estaba abierta (queda COMPLETA sin pasar el código), y no cierra ninguna sesión (ni la a medias ni la completa).
//   P0-5  `DELETE /auth/v1/factors/{id}` con un pase aal2 responde 200 y borra el factor: quien tenga una sesión completa
//         robada puede desactivar el segundo paso hablando directo con Supabase (es la base de la decisión D7 = B).
//   P0-6  Tras ese `unenroll`, el pase aal2 ya entregado sigue sirviendo hasta que vence, y la renovación siguiente entrega
//         un pase aal1, con la cuenta sin factor.
//   P0-7  Borrar la cuenta (API de administración y `auth.users`) borra en cascada una tabla que cuelgue de `auth.users` con
//         `on delete cascade` (así se comportará `mfa_recovery_codes`).
//
// Solo cuentas nuevas `@ejemplo.test` creadas aquí: JAMÁS se activa un factor en las personas de la semilla ni de la
// fixture de aislamiento.
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyAuthError } from "../../src/lib/auth/errors";
import { freshTotp } from "../../src/test/totp";
import { adminCreateUser, localEnv, TEST_PASSWORD } from "../support/local-supabase";
import {
  claimsOf,
  enrollAndVerifyWithPermit,
  gotrue,
  newMfaAccount,
  signIn,
} from "../support/mfa-gate";
import { connect } from "./helpers";

// Hablan con GoTrue de verdad (arranque en frío, esperas de período del código): más holgura que los 30 s de siempre.
vi.setConfig({ testTimeout: 120_000 });

const MAILBOX_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:56324";
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY_REQUESTS = 429;

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

/** Lo que hará `reauth.ts`: un cliente de Supabase sin cookies ni renovación automática (nada se guarda). */
function disposableClient(options: { fetch?: typeof fetch } = {}) {
  const { apiUrl, publishableKey } = localEnv();
  return createClient(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
}

const sessionIds = async (userId: string): Promise<string[]> =>
  (
    await db.query<{ id: string }>("select id from auth.sessions where user_id = $1 order by id", [
      userId,
    ])
  ).rows.map((row) => row.id);

const refreshTokenCountOfSession = async (sessionId: string): Promise<number> =>
  Number(
    (
      await db.query<{ n: string }>(
        "select count(*) as n from auth.refresh_tokens where session_id = $1",
        [sessionId],
      )
    ).rows[0].n,
  );

const factorCount = async (userId: string): Promise<number> =>
  Number(
    (
      await db.query<{ n: string }>(
        "select count(*) as n from auth.mfa_factors where user_id = $1",
        [userId],
      )
    ).rows[0].n,
  );

/** Cuántos correos hay en Mailpit para esa dirección. */
async function mailCountFor(email: string): Promise<number> {
  const res = await fetch(
    `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
  );
  return ((await res.json()) as { messages_count: number }).messages_count;
}

/** `select app.second_step_pending()` como `authenticated`, con un pase del nivel indicado. */
async function secondStepPendingAs(userId: string, aal: "aal1" | "aal2"): Promise<boolean> {
  await db.query("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated", aal }),
    ]);
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await db.query("set local role authenticated");
    const { rows } = await db.query<{ p: boolean }>("select app.second_step_pending() as p");
    return rows[0].p;
  } finally {
    await db.query("rollback");
  }
}

/** Cuenta nueva, con o sin factor verificado, y una sesión completa suya abierta. */
async function accountWith(withFactor: boolean) {
  const account = await newMfaAccount();
  const enrolled = withFactor
    ? await enrollAndVerifyWithPermit(db, await signIn(account.email))
    : null;
  return { account, enrolled };
}

describe("Supabase Auth para H-004b (paso 0)", () => {
  it("P0-1 · las rutas de códigos de respaldo propios de Supabase existen pero están apagadas (con D1 = A no se usan)", async () => {
    const account = await newMfaAccount();
    const session = await signIn(account.email);
    const status = await gotrue(session.accessToken, "GET", "factors/recovery-codes");
    expect(status.status).toBe(HTTP_NOT_FOUND);
    expect(status.json?.error_code).toBe("mfa_factor_not_found");
    const generate = await gotrue(session.accessToken, "POST", "factors/recovery-codes", {});
    expect(generate.status).toBe(HTTP_UNPROCESSABLE);
    expect(generate.json?.error_code).toBe("mfa_recovery_codes_enroll_not_enabled");
  });

  for (const withFactor of [false, true]) {
    it(`P0-2 · la sesión desechable de signInWithPassword (${withFactor ? "con" : "sin"} factor verificado) crea una sola sesión, signOut local borra solo esa, y no sale ningún correo`, async () => {
      const { account } = await accountWith(withFactor);
      const mine = await signIn(account.email);
      const before = await sessionIds(account.id);
      const mailsBefore = await mailCountFor(account.email);

      const client = disposableClient();
      const { data, error } = await client.auth.signInWithPassword({
        email: account.email,
        password: TEST_PASSWORD,
      });
      expect(error).toBeNull();
      expect(data.user?.id).toBe(account.id);
      expect(claimsOf(data.session!.access_token).aal).toBe("aal1");
      const disposableSession = claimsOf(data.session!.access_token).session_id;

      const during = await sessionIds(account.id);
      expect(during).toHaveLength(before.length + 1);
      expect(during).toContain(disposableSession);
      expect(await refreshTokenCountOfSession(disposableSession)).toBeGreaterThan(0);

      const out = await client.auth.signOut({ scope: "local" });
      expect(out.error).toBeNull();
      // Se fue exactamente esa sesión (y su refresh token); las demás siguen y sirven.
      expect(await sessionIds(account.id)).toEqual(before);
      expect(await refreshTokenCountOfSession(disposableSession)).toBe(0);
      expect((await gotrue(mine.accessToken, "GET", "user")).status).toBe(HTTP_OK);
      // Ni el ingreso ni el cierre de la sesión desechable mandan correo.
      expect(await mailCountFor(account.email)).toBe(mailsBefore);
    });
  }

  it("P0-2 · un 429 de GoTrue llega a la aplicación como «rate_limited» (no cuenta como contraseña incorrecta); el tope real no se puede provocar en local", async () => {
    // GoTrue local no activó `sign_in_sign_ups` ni con 80 ingresos seguidos: se simula la respuesta que daría el servidor.
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          code: 429,
          error_code: "over_request_rate_limit",
          msg: "Request rate limit reached",
        }),
        { status: HTTP_TOO_MANY_REQUESTS, headers: { "content-type": "application/json" } },
      );
    const { error } = await disposableClient({ fetch: fakeFetch }).auth.signInWithPassword({
      email: "alguien@ejemplo.test",
      password: "una-contrasena-cualquiera",
    });
    expect(error?.status).toBe(HTTP_TOO_MANY_REQUESTS);
    expect(classifyAuthError(error!)).toBe("rate_limited");

    // Y una contraseña incorrecta de verdad es `invalid_credentials` (400): lo único que suma al contador.
    const wrong = await disposableClient().auth.signInWithPassword({
      email: (await newMfaAccount()).email,
      password: "contrasena-incorrecta-123",
    });
    expect(classifyAuthError(wrong.error!)).toBe("invalid_credentials");
  });

  for (const withFactor of [false, true]) {
    it(`P0-3 · signOut({ scope: "others" }) funciona desde un pase aal1 (${withFactor ? "con" : "sin"} factor verificado): cierra las otras y deja la propia`, async () => {
      const { account } = await accountWith(withFactor);
      const otherA = await signIn(account.email);
      const otherB = await signIn(account.email);
      const client = disposableClient();
      const { data } = await client.auth.signInWithPassword({
        email: account.email,
        password: TEST_PASSWORD,
      });
      const claims = claimsOf(data.session!.access_token);
      expect(claims.aal).toBe("aal1");

      const out = await client.auth.signOut({ scope: "others" });
      expect(out.error).toBeNull();
      expect(await sessionIds(account.id)).toEqual([claims.session_id]);
      for (const other of [otherA, otherB]) {
        const res = await gotrue(other.accessToken, "GET", "user");
        expect(res.status).toBe(HTTP_FORBIDDEN);
        expect(res.json?.error_code).toBe("session_not_found");
      }
      expect((await gotrue(data.session!.access_token, "GET", "user")).status).toBe(HTTP_OK);
    });
  }

  it("P0-4 · quitar el factor con la llave maestra deja COMPLETA la sesión a medias abierta (second_step_pending pasa a falso) y no cierra ninguna sesión", async () => {
    const { account, enrolled } = await accountWith(true);
    const partial = await signIn(account.email);
    expect(claimsOf(partial.accessToken).aal).toBe("aal1");
    const before = await sessionIds(account.id);
    expect(await secondStepPendingAs(account.id, "aal1")).toBe(true);

    const { secretKey, apiUrl } = localEnv();
    const removed = await fetch(
      `${apiUrl}/auth/v1/admin/users/${account.id}/factors/${enrolled!.factorId}`,
      { method: "DELETE", headers: { apikey: secretKey, authorization: `Bearer ${secretKey}` } },
    );
    expect(removed.status).toBe(HTTP_OK);
    expect(await factorCount(account.id)).toBe(0);

    expect(await secondStepPendingAs(account.id, "aal1")).toBe(false);
    // Las dos sesiones (la completa de la activación y la a medias) siguen vivas: por eso se cierran a mano con signOut others.
    expect(await sessionIds(account.id)).toEqual(before);
    expect((await gotrue(partial.accessToken, "GET", "user")).status).toBe(HTTP_OK);
    expect((await gotrue(enrolled!.aal2, "GET", "user")).status).toBe(HTTP_OK);
  });

  it("P0-5 y P0-6 · DELETE /factors/{id} con un pase aal2 responde 200 (base de D7); el pase aal2 ya entregado sigue sirviendo y la renovación siguiente deja un pase aal1 y la cuenta sin factor", async () => {
    const { account, enrolled } = await accountWith(true);
    // Sesión completa nueva con el cliente de supabase-js, para tener su refresh token (aal2 por contraseña y código).
    const client = disposableClient();
    await client.auth.signInWithPassword({ email: account.email, password: TEST_PASSWORD });
    const challenge = await client.auth.mfa.challenge({ factorId: enrolled!.factorId });
    expect(challenge.error).toBeNull();
    const { code } = await freshTotp(enrolled!.secret, { avoidStep: enrolled!.step });
    const verified = await client.auth.mfa.verify({
      factorId: enrolled!.factorId,
      challengeId: challenge.data!.id,
      code,
    });
    expect(verified.error).toBeNull();
    const aal2 = verified.data!.access_token;
    const refreshToken = verified.data!.refresh_token;
    expect(claimsOf(aal2).aal).toBe("aal2");

    // P0-5
    const removed = await gotrue(aal2, "DELETE", `factors/${enrolled!.factorId}`);
    expect(removed.status).toBe(HTTP_OK);
    expect(await factorCount(account.id)).toBe(0);

    // P0-6: el pase aal2 de antes sigue sirviendo hasta que vence (el riesgo de los 15 minutos del diseño)...
    expect((await gotrue(aal2, "GET", "user")).status).toBe(HTTP_OK);
    // ...y la renovación siguiente entrega un pase aal1.
    const { apiUrl, publishableKey } = localEnv();
    const refreshed = await fetch(`${apiUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    expect(refreshed.status).toBe(HTTP_OK);
    const renewed = (await refreshed.json()) as { access_token: string };
    expect(claimsOf(renewed.access_token).aal).toBe("aal1");
    expect(await secondStepPendingAs(account.id, "aal1")).toBe(false);
  });

  it("P0-7 · borrar la cuenta borra en cascada una tabla que cuelga de auth.users con on delete cascade (como mfa_recovery_codes)", async () => {
    const email = `mfa-${randomUUID().slice(0, 8)}@ejemplo.test`;
    const userId = await adminCreateUser(email);
    await db.query(
      `create table public.tmp_p0_7_cascade (
         id uuid primary key default gen_random_uuid(),
         user_id uuid not null references auth.users (id) on delete cascade
       )`,
    );
    try {
      await db.query("insert into public.tmp_p0_7_cascade (user_id) values ($1), ($1)", [userId]);
      const { secretKey, apiUrl } = localEnv();
      const removed = await fetch(`${apiUrl}/auth/v1/admin/users/${userId}`, {
        method: "DELETE",
        headers: { apikey: secretKey, authorization: `Bearer ${secretKey}` },
      });
      expect(removed.status).toBe(HTTP_OK);
      const left = await db.query("select 1 from public.tmp_p0_7_cascade where user_id = $1", [
        userId,
      ]);
      expect(left.rowCount).toBe(0);
    } finally {
      await db.query("drop table if exists public.tmp_p0_7_cascade");
    }
  });
});
