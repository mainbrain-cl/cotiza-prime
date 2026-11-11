// 🟢 PRUEBAS · Supabase local, datos ficticios.
// H-004a · Verificación en dos pasos.
//
// Sección 1, «Comportamiento de Supabase Auth»: deja por escrito lo que se comprobó de GoTrue (el servicio de
// identidad) en el paso 0 del plan, porque el diseño de H-004a se apoya en eso. Si una actualización de Supabase
// cambia alguno de estos comportamientos, estas pruebas avisan antes que las pantallas.
// Sección 2, «La base exige el segundo paso» (decisión D1-B de Aarón): se agrega con la migración 20261112100000.
//
// Solo cuentas nuevas `@ejemplo.test` creadas aquí: JAMÁS se activa un factor en las personas de la semilla ni de la
// fixture de aislamiento (activar uno cierra las demás sesiones de esa cuenta).
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshTotp } from "../../src/test/totp";
import {
  adminCreateUser,
  localEnv,
  signIn,
  TEST_PASSWORD,
  type Session,
} from "../support/local-supabase";
import { actAsPostgres, connect, withTx } from "./helpers";

/** Lo que de verdad usan estas pruebas de las respuestas de GoTrue. */
type AuthJson = {
  id: string;
  error_code: string;
  access_token: string;
  totp: { qr_code: string; uri: string; secret: string };
  factors: { id: string; status: string }[];
};
type AuthResult = { status: number; json: AuthJson | null };

/** Pedido directo a GoTrue con un pase (no `supabase-js`: se quieren ver los códigos de error tal cual). */
async function auth(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<AuthResult> {
  const { apiUrl, publishableKey } = localEnv();
  const res = await fetch(`${apiUrl}/auth/v1/${path}`, {
    method,
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: AuthJson | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const claimsOf = (accessToken: string) =>
  JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8")) as {
    aal: string;
    amr: { method: string }[];
    session_id: string;
  };

async function newAccount(): Promise<{ email: string; id: string }> {
  const email = `mfa-${randomUUID().slice(0, 8)}@ejemplo.test`;
  return { email, id: await adminCreateUser(email) };
}

/** Activa un factor TOTP y lo verifica con un código de verdad. Devuelve todo lo necesario para seguir. */
async function enrollAndVerify(
  session: Session,
  friendlyName?: string,
): Promise<{ factorId: string; secret: string; aal2: string; step: number }> {
  const enrolled = await auth(session.accessToken, "POST", "factors", {
    factor_type: "totp",
    issuer: "Cotiza Prime",
    ...(friendlyName ? { friendly_name: friendlyName } : {}),
  });
  expect(enrolled.status).toBe(200);
  const factorId = enrolled.json!.id as string;
  const secret = enrolled.json!.totp.secret as string;
  const challenge = await auth(session.accessToken, "POST", `factors/${factorId}/challenge`, {});
  expect(challenge.status).toBe(200);
  const { code, step } = await freshTotp(secret);
  const verified = await auth(session.accessToken, "POST", `factors/${factorId}/verify`, {
    challenge_id: challenge.json!.id,
    code,
  });
  expect(verified.status).toBe(200);
  return { factorId, secret, aal2: verified.json!.access_token as string, step };
}

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

describe("Comportamiento de Supabase Auth (paso 0 de H-004a)", () => {
  it("(e) activar y verificar da un pase aal2 cuyo amr trae la contraseña y el código; el qr_code viene como documento SVG (supabase-js lo convierte en data:image/svg+xml)", async () => {
    const account = await newAccount();
    const session = await signIn(account.email);
    expect(claimsOf(session.accessToken).aal).toBe("aal1");

    const enrolled = await auth(session.accessToken, "POST", "factors", {
      factor_type: "totp",
      issuer: "Cotiza Prime",
    });
    expect(enrolled.status).toBe(200);
    expect(Object.keys(enrolled.json!.totp).sort()).toEqual(["qr_code", "secret", "uri"]);
    expect(enrolled.json!.totp.qr_code).toContain("<svg");
    expect(enrolled.json!.totp.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(enrolled.json!.totp.secret).toMatch(/^[A-Z2-7]{16,}$/);

    const factorId = enrolled.json!.id as string;
    const challenge = await auth(session.accessToken, "POST", `factors/${factorId}/challenge`, {});
    const { code } = await freshTotp(enrolled.json!.totp.secret);
    const verified = await auth(session.accessToken, "POST", `factors/${factorId}/verify`, {
      challenge_id: challenge.json!.id,
      code,
    });
    expect(verified.status).toBe(200);
    const claims = claimsOf(verified.json!.access_token);
    expect(claims.aal).toBe("aal2");
    expect(claims.amr.map((entry) => entry.method).sort()).toEqual(["password", "totp"]);
  });

  it("(c) al verificar el primer factor GoTrue cierra las otras sesiones de la cuenta; la sesión que verificó sigue", async () => {
    const account = await newAccount();
    const mine = await signIn(account.email);
    const other = await signIn(account.email);
    const before = await auth(other.accessToken, "GET", "user");
    expect(before.status).toBe(200);

    await enrollAndVerify(mine);

    const after = await auth(other.accessToken, "GET", "user");
    expect(after.status).toBe(403);
    expect(after.json!.error_code).toBe("session_not_found");
    expect((await auth(mine.accessToken, "GET", "user")).status).toBe(200);
  });

  it("(a) con un factor verificado y un pase aal1, GoTrue no deja activar otro, ni quitar el verificado, ni cambiar la contraseña", async () => {
    const account = await newAccount();
    await enrollAndVerify(await signIn(account.email), "principal");
    const partial = await signIn(account.email);
    expect(claimsOf(partial.accessToken).aal).toBe("aal1");

    const enroll = await auth(partial.accessToken, "POST", "factors", {
      factor_type: "totp",
      issuer: "Cotiza Prime",
      friendly_name: "otro",
    });
    expect(enroll.status).toBe(403);
    expect(enroll.json!.error_code).toBe("insufficient_aal");

    const user = await auth(partial.accessToken, "GET", "user");
    const factorId = (user.json!.factors as { id: string; status: string }[])[0].id;
    const unenroll = await auth(partial.accessToken, "DELETE", `factors/${factorId}`);
    expect(unenroll.status).toBe(422);
    expect(unenroll.json!.error_code).toBe("insufficient_aal");

    const password = await auth(partial.accessToken, "PUT", "user", {
      password: `${TEST_PASSWORD}-nueva`,
    });
    expect(password.status).toBe(401);
    expect(password.json!.error_code).toBe("insufficient_aal");
  });

  it("el ingreso con contraseña y GET /user traen la lista de factores con su estado (la app decide con eso)", async () => {
    const account = await newAccount();
    const { apiUrl, publishableKey } = localEnv();
    const grant = async () =>
      (await (
        await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: { apikey: publishableKey, "content-type": "application/json" },
          body: JSON.stringify({ email: account.email, password: TEST_PASSWORD }),
        })
      ).json()) as { user: { factors?: { status: string; factor_type: string }[] } };

    expect((await grant()).user.factors ?? []).toEqual([]);
    const session = await signIn(account.email);
    await auth(session.accessToken, "POST", "factors", { factor_type: "totp", issuer: "x" });
    expect((await grant()).user.factors).toMatchObject([
      { status: "unverified", factor_type: "totp" },
    ]);
    await enrollAndVerify(await signIn(account.email), "segundo");
    // Al verificar, GoTrue borra los factores sin verificar del mismo tipo: queda solo el verificado.
    const statuses = (await grant()).user.factors!.map((factor) => factor.status);
    expect(statuses).toEqual(["verified"]);
  });

  it("(d) los factores sin verificar cuentan para el tope de 10, no se limpian solos (solo al verificar otro del mismo tipo) y se pueden quitar con un pase aal1; sin nombre, el segundo choca", async () => {
    const account = await newAccount();
    const session = await signIn(account.email);
    const first = await auth(session.accessToken, "POST", "factors", {
      factor_type: "totp",
      issuer: "x",
    });
    expect(first.status).toBe(200);
    const unnamedAgain = await auth(session.accessToken, "POST", "factors", {
      factor_type: "totp",
      issuer: "x",
    });
    expect(unnamedAgain.status).toBe(422);
    expect(unnamedAgain.json!.error_code).toBe("mfa_factor_name_conflict");

    // Quitar el sin verificar con un pase aal1 está permitido: es lo que hará «Activar» antes de empezar de nuevo.
    const removed = await auth(session.accessToken, "DELETE", `factors/${first.json!.id}`);
    expect(removed.status).toBe(200);
    const again = await auth(session.accessToken, "POST", "factors", {
      factor_type: "totp",
      issuer: "x",
    });
    expect(again.status).toBe(200);

    // El tope de 10 también lo llenan los sin verificar (con nombres distintos).
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const enrolled = await auth(session.accessToken, "POST", "factors", {
        factor_type: "totp",
        issuer: "x",
        friendly_name: `intento-${i}`,
      });
      statuses.push(enrolled.status);
      if (enrolled.status !== 200) {
        expect(enrolled.json!.error_code).toBe("too_many_enrolled_mfa_factors");
        break;
      }
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(9);
    expect(statuses.at(-1)).toBe(422);
  });

  it("(b) el mismo código, con un desafío nuevo dentro del mismo período, se acepta: por eso la app lleva su propio bloqueo de códigos usados", async () => {
    const account = await newAccount();
    const first = await enrollAndVerify(await signIn(account.email));
    const partial = await signIn(account.email);
    const challenge = await auth(
      partial.accessToken,
      "POST",
      `factors/${first.factorId}/challenge`,
      {},
    );
    expect(challenge.status).toBe(200);
    // El código de siempre, recalculado para el período en que se verificó: GoTrue lo vuelve a aceptar.
    const { totpAt } = await import("../../src/test/totp");
    const sameCode = totpAt(first.secret, first.step * 30);
    const replay = await auth(partial.accessToken, "POST", `factors/${first.factorId}/verify`, {
      challenge_id: challenge.json!.id,
      code: sameCode,
    });
    expect(replay.status).toBe(200);
  });

  it("(g) GoTrue local no corta los códigos incorrectos repetidos de una cuenta: el límite que importa es el propio", async () => {
    const account = await newAccount();
    const session = await signIn(account.email);
    const enrolled = await auth(session.accessToken, "POST", "factors", {
      factor_type: "totp",
      issuer: "x",
    });
    const factorId = enrolled.json!.id as string;
    const results: number[] = [];
    for (let i = 0; i < 25; i++) {
      const challenge = await auth(
        session.accessToken,
        "POST",
        `factors/${factorId}/challenge`,
        {},
      );
      const attempt = await auth(session.accessToken, "POST", `factors/${factorId}/verify`, {
        challenge_id: challenge.json!.id,
        code: "000000",
      });
      results.push(attempt.status);
    }
    expect(new Set(results)).toEqual(new Set([422]));
  });

  it("(f) una función con `security definer` puede leer auth.mfa_factors (la usará app.second_step_pending)", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await db.query<{ id: string }>(
        `insert into auth.users (id, email, aud, role, email_confirmed_at)
         values (gen_random_uuid(), 'f-' || gen_random_uuid() || '@ejemplo.test', 'authenticated', 'authenticated', now())
         returning id`,
      );
      const userId = user.rows[0].id;
      await db.query(
        `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
         values (gen_random_uuid(), $1, 'prueba', 'totp', 'verified', now(), now(), 'x')`,
        [userId],
      );
      await db.query(
        `create function public.tmp_reads_mfa(p_user uuid) returns boolean
         language sql stable security definer set search_path = '' as $$
           select exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified')
         $$`,
      );
      await db.query("grant execute on function public.tmp_reads_mfa(uuid) to authenticated");
      await db.query("set local role authenticated");
      const read = await db.query<{ r: boolean }>("select public.tmp_reads_mfa($1) as r", [userId]);
      expect(read.rows[0].r).toBe(true);
      // Y la persona común, sin la función, no puede leer esa tabla.
      await db.query("savepoint s");
      await expect(db.query("select count(*) from auth.mfa_factors")).rejects.toThrow();
      await db.query("rollback to savepoint s");
    }));
});
