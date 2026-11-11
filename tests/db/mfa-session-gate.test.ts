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
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshTotp } from "../../src/test/totp";
import {
  adminCreateUser,
  localEnv,
  signIn,
  TEST_PASSWORD,
  type Session,
} from "../support/local-supabase";
import { rest } from "../support/local-supabase";
import {
  TENANT_HEADER,
  actAsAnon,
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  expectSqlError,
  withTx,
  type TestUser,
} from "./helpers";

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

// Hablan con GoTrue de verdad (arranque en frío, esperas de período del código): más holgura que los 30 s de siempre.
vi.setConfig({ testTimeout: 90_000 });

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

  it("(a) con un factor verificado y un pase aal1, GoTrue no deja activar otro, ni quitar el verificado, ni cambiar la contraseña ni el correo", async () => {
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

    // Cambiar el correo (la puerta para tomar la cuenta por el otro lado) pide el mismo nivel: con pase aal1 y factor
    // verificado, también se rechaza.
    const email = await auth(partial.accessToken, "PUT", "user", {
      email: `otro-${randomUUID().slice(0, 8)}@ejemplo.test`,
    });
    expect(email.status).toBe(401);
    expect(email.json!.error_code).toBe("insufficient_aal");
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

// ---------------------------------------------------------------------------------------------------------------------
// Sección 2 · La base exige el segundo paso (D1-B).
// ---------------------------------------------------------------------------------------------------------------------

/** Pasa a actuar como `authenticated` con un pase del nivel indicado (`aal1` = solo contraseña, `aal2` = contraseña y código). */
async function actAsLevel(
  client: Client,
  user: TestUser,
  tenantId: string | null,
  aal: "aal1" | "aal2" | null,
): Promise<void> {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: user.id, role: "authenticated", ...(aal ? { aal } : {}) }),
  ]);
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [user.id]);
  await client.query("select set_config('request.headers', $1, true)", [
    JSON.stringify(tenantId ? { [TENANT_HEADER]: tenantId } : {}),
  ]);
  await client.query("set local role authenticated");
}

async function addFactor(client: Client, userId: string, status: "verified" | "unverified") {
  await client.query("reset role");
  await client.query(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
     values (gen_random_uuid(), $1, $2, 'totp', $3, now(), now(), 'x')`,
    [userId, `factor-${randomUUID().slice(0, 6)}`, status],
  );
}

/** Una organización con su Dueño, un servicio de catálogo y un cliente. */
async function ownerWithData(client: Client) {
  const owner = await createUser(client);
  const tenantId = await createTenantAs(client, owner);
  await client.query(
    `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp) values ($1, 'Flete', 'service', 1000)`,
    [tenantId],
  );
  await client.query(
    `insert into public.customers (id, tenant_id, kind, display_name) values (gen_random_uuid(), $1, 'company', 'Cliente de prueba')`,
    [tenantId],
  );
  return { owner, tenantId };
}

type Counts = { tenants: number; members: number; catalog: number; customers: number; ids: number };

async function counts(client: Client): Promise<Counts> {
  const n = async (sql: string) => Number((await client.query<{ n: string }>(sql)).rows[0].n);
  return {
    tenants: await n("select count(*) as n from public.tenants"),
    members: await n("select count(*) as n from public.members"),
    catalog: await n("select count(*) as n from public.catalog_items"),
    customers: await n("select count(*) as n from public.customers"),
    ids: await n("select count(*) as n from app.my_tenant_ids()"),
  };
}

const SEES_EVERYTHING: Counts = { tenants: 1, members: 1, catalog: 1, customers: 1, ids: 1 };
const SEES_NOTHING: Counts = { tenants: 0, members: 0, catalog: 0, customers: 0, ids: 0 };

describe("La base exige el segundo paso (D1-B)", () => {
  it("D1 · sin factor, con pase aal1 (o sin nivel): todo igual que antes", () =>
    withTx(db, async () => {
      const { owner, tenantId } = await ownerWithData(db);
      for (const level of ["aal1", null] as const) {
        await actAsLevel(db, owner, tenantId, level);
        expect(await counts(db)).toEqual(SEES_EVERYTHING);
        expect((await db.query("select app.current_tenant_id() as t")).rows[0].t).toBe(tenantId);
      }
    }));

  it("D2 · con un factor SIN verificar y pase aal1: todo igual que antes (activar a medias no bloquea a nadie)", () =>
    withTx(db, async () => {
      const { owner, tenantId } = await ownerWithData(db);
      await addFactor(db, owner.id, "unverified");
      await actAsLevel(db, owner, tenantId, "aal1");
      expect(await counts(db)).toEqual(SEES_EVERYTHING);
    }));

  it("D3 · con un factor verificado y pase aal1 (sesión parcial): no ve nada de ninguna organización", () =>
    withTx(db, async () => {
      const { owner, tenantId } = await ownerWithData(db);
      await addFactor(db, owner.id, "verified");
      await actAsLevel(db, owner, tenantId, "aal1");
      expect(await counts(db)).toEqual(SEES_NOTHING);
      const resolved = await db.query(
        "select app.current_tenant_id() as t, app.current_member_role() as r",
      );
      expect(resolved.rows[0]).toEqual({ t: null, r: null });
      // Un pase sin nivel también cuenta como aal1.
      await actAsLevel(db, owner, tenantId, null);
      expect(await counts(db)).toEqual(SEES_NOTHING);
    }));

  it("D4 · con un factor verificado y pase aal1 no puede escribir: ni agregar, ni cambiar, ni borrar", () =>
    withTx(db, async () => {
      const { owner, tenantId } = await ownerWithData(db);
      await addFactor(db, owner.id, "verified");
      await actAsLevel(db, owner, tenantId, "aal1");
      const insert = await expectSqlError(
        db,
        `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp) values ($1, 'Colado', 'service', 1)`,
        [tenantId],
      );
      expect(insert.code).toBe("42501");
      expect((await db.query("update public.catalog_items set unit_price_clp = 1")).rowCount).toBe(
        0,
      );
      expect((await db.query("update public.catalog_items set is_active = false")).rowCount).toBe(
        0,
      );
      expect((await db.query("update public.customers set display_name = 'x'")).rowCount).toBe(0);
      // Y los datos siguen intactos para quien sí pasó el segundo paso.
      await actAsLevel(db, owner, tenantId, "aal2");
      const rows = await db.query("select name, unit_price_clp from public.catalog_items");
      expect(rows.rows).toEqual([{ name: "Flete", unit_price_clp: "1000" }]);
    }));

  it("D5 · con un factor verificado y pase aal2: ve y cambia sus datos como siempre", () =>
    withTx(db, async () => {
      const { owner, tenantId } = await ownerWithData(db);
      await addFactor(db, owner.id, "verified");
      await actAsLevel(db, owner, tenantId, "aal2");
      expect(await counts(db)).toEqual(SEES_EVERYTHING);
      expect(
        (await db.query("update public.catalog_items set unit_price_clp = 2000")).rowCount,
      ).toBe(1);
    }));

  it("D6 · el factor de OTRA cuenta no afecta a esta persona", () =>
    withTx(db, async () => {
      const { owner, tenantId } = await ownerWithData(db);
      const other = await createUser(db);
      await addFactor(db, other.id, "verified");
      await actAsLevel(db, owner, tenantId, "aal1");
      expect(await counts(db)).toEqual(SEES_EVERYTHING);
    }));

  it("D7 · la función no la ejecuta nadie anónimo, y la nombran las funciones centrales", () =>
    withTx(db, async () => {
      const { owner } = await ownerWithData(db);
      await actAsLevel(db, owner, null, "aal2");
      // Con sesión sí puede (la nombra una política); solo dice si la propia sesión está a medias.
      expect((await db.query("select app.second_step_pending() as p")).rows[0].p).toBe(false);
      await actAsAnon(db);
      const denied = await expectSqlError(db, "select app.second_step_pending()");
      expect(denied.code).toBe("42501");
      await actAsPostgres(db);
      const users = await db.query<{ n: string }>(
        `select count(*) as n from pg_proc p
          where p.proname in ('current_tenant_id', 'my_tenant_ids') and p.pronamespace = 'app'::regnamespace
            and p.prosrc like '%app.second_step_pending()%'`,
      );
      expect(Number(users.rows[0].n)).toBe(2);
    }));

  it("D8 · los tres alcances nuevos del límite de intentos se aceptan; uno desconocido sigue rechazado", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      for (const scope of ["mfa_verify_user", "mfa_verify_user_day", "mfa_code_used"]) {
        const key = randomBytes(32).toString("hex");
        await db.query("select public.auth_limit_record_failure($1, $2, 5, 900, 900)", [
          scope,
          key,
        ]);
        const rows = await db.query(
          "select count(*)::int as n from public.auth_rate_limits where scope = $1 and key_hash = $2",
          [scope, key],
        );
        expect(rows.rows[0].n).toBe(1);
      }
      const unknown = await expectSqlError(
        db,
        "select public.auth_limit_record_failure('mfa_otro', 'x', 5, 900, 900)",
      );
      expect(unknown.code).toBe("23514");
    }));
});

// ---------------------------------------------------------------------------------------------------------------------
// Sección 2b · Las puertas que usan `auth.uid()` sin pasar por la organización (ronda 1 de correcciones).
// ---------------------------------------------------------------------------------------------------------------------
describe("La base exige el segundo paso en las puertas con auth.uid() y sin organización", () => {
  const ANY_TOKEN = "a".repeat(64);
  const GATE_MESSAGE = /second_step_required/;

  /** Una cuenta (con perfil) y, si se pide, un factor verificado. */
  async function account(client: Client, factor: "none" | "verified" | "unverified") {
    const user = await createUser(client);
    if (factor !== "none") await addFactor(client, user.id, factor);
    return user;
  }

  const PUBLIC_CALLS: {
    name: string;
    sql: string;
    params: unknown[];
    works: (row: unknown) => void;
  }[] = [
    {
      name: "create_tenant",
      sql: "select public.create_tenant('Empresa Puerta', '76086428-5', 'services') as r",
      params: [],
      works: (r) => expect(r).toMatch(/^[0-9a-f-]{36}$/),
    },
    {
      name: "invitation_preview",
      sql: "select public.invitation_preview($1) as r",
      params: [ANY_TOKEN],
      works: (r) => expect(r).toEqual({ result: "not_found" }),
    },
    {
      name: "accept_invitation",
      sql: "select public.accept_invitation($1) as r",
      params: [ANY_TOKEN],
      works: (r) => expect(r).toEqual({ result: "not_found" }),
    },
    {
      name: "accept_current_legal_documents",
      sql: "select public.accept_current_legal_documents() as r",
      params: [],
      works: (r) => expect(typeof r).toBe("number"),
    },
  ];

  it.each(PUBLIC_CALLS)(
    "$name · con factor verificado y pase aal1 se rechaza con 42501 «second_step_required» y no deja nada",
    ({ sql, params }) =>
      withTx(db, async () => {
        const user = await account(db, "verified");
        await actAsLevel(db, user, null, "aal1");
        const error = await expectSqlError(db, sql, params);
        expect(error.code).toBe("42501");
        expect(error.message).toMatch(GATE_MESSAGE);
        await actAsPostgres(db);
        // No quedó nada a nombre de la cuenta: ni organización creada ni membresía.
        expect(
          (await db.query("select 1 from public.members where user_id = $1", [user.id])).rowCount,
        ).toBe(0);
        expect(
          (await db.query("select 1 from public.tenants where created_by = $1", [user.id]))
            .rowCount,
        ).toBe(0);
      }),
  );

  it.each(PUBLIC_CALLS)(
    "$name · con pase aal2, con un factor sin verificar o sin factor funciona como antes",
    ({ sql, params, works }) =>
      withTx(db, async () => {
        const verified = await account(db, "verified");
        const unverified = await account(db, "unverified");
        const plain = await account(db, "none");
        for (const [user, level] of [
          [verified, "aal2"],
          [unverified, "aal1"],
          [plain, "aal1"],
          [plain, null],
        ] as const) {
          await db.query("savepoint puerta");
          await actAsLevel(db, user, null, level);
          works((await db.query(sql, params)).rows[0].r);
          await actAsPostgres(db);
          await db.query("rollback to savepoint puerta");
        }
      }),
  );

  it("el perfil propio: con el segundo paso pendiente no se lee ni se cambia; con aal2 o sin factor, sí", () =>
    withTx(db, async () => {
      const gated = await account(db, "verified");
      const plain = await account(db, "none");
      const read = async (user: TestUser, level: "aal1" | "aal2" | null) => {
        await actAsLevel(db, user, null, level);
        const rows = (
          await db.query("select user_id from public.profiles where user_id = $1", [user.id])
        ).rowCount;
        const changed = (
          await db.query(
            "update public.profiles set full_name = 'Nombre nuevo' where user_id = $1",
            [user.id],
          )
        ).rowCount;
        await actAsPostgres(db);
        return { rows, changed };
      };
      expect(await read(gated, "aal1")).toEqual({ rows: 0, changed: 0 });
      expect(await read(gated, null)).toEqual({ rows: 0, changed: 0 });
      expect(await read(gated, "aal2")).toEqual({ rows: 1, changed: 1 });
      expect(await read(plain, "aal1")).toEqual({ rows: 1, changed: 1 });
      // Un cambio que intenta pasar por otro usuario tampoco funciona (la condición de siempre).
      await actAsLevel(db, plain, null, "aal2");
      expect(
        (
          await db.query("update public.profiles set full_name = 'Ajeno' where user_id = $1", [
            gated.id,
          ])
        ).rowCount,
      ).toBe(0);
    }));

  it("las aceptaciones propias de los términos: con el segundo paso pendiente no se leen; con aal2, sí", () =>
    withTx(db, async () => {
      const user = await account(db, "verified");
      await actAsLevel(db, user, null, "aal2");
      await db.query("select public.accept_current_legal_documents()");
      const own = async (level: "aal1" | "aal2") => {
        await actAsLevel(db, user, null, level);
        const n = Number(
          (await db.query<{ n: string }>("select count(*) as n from public.legal_acceptances"))
            .rows[0].n,
        );
        await actAsPostgres(db);
        return n;
      };
      expect(await own("aal2")).toBeGreaterThan(0);
      expect(await own("aal1")).toBe(0);
    }));

  it("los documentos vigentes (legal_documents) siguen siendo públicos: se leen con la sesión parcial y sin sesión", () =>
    withTx(db, async () => {
      const user = await account(db, "verified");
      await actAsLevel(db, user, null, "aal1");
      expect(
        Number((await db.query("select count(*) as n from public.legal_documents")).rows[0].n),
      ).toBeGreaterThan(0);
      await actAsAnon(db);
      expect(
        Number((await db.query("select count(*) as n from public.legal_documents")).rows[0].n),
      ).toBeGreaterThan(0);
    }));
});

describe("La base exige el segundo paso, con pases reales por HTTP (PostgREST + GoTrue)", () => {
  it("H1 · un pase aal1 de una cuenta con factor no lee nada con la cabecera de su organización; el aal2 de la misma cuenta sí", async () => {
    // La cuenta y su organización se crean y se confirman (no hay transacción: hablan PostgREST y GoTrue).
    const account = await newAccount();
    await db.query("begin");
    const tenantId = await createTenantAs(db, { id: account.id, email: account.email });
    await db.query(
      `insert into public.customers (id, tenant_id, kind, display_name) values (gen_random_uuid(), $1, 'company', 'Cliente HTTP')`,
      [tenantId],
    );
    await db.query("commit");

    const header = { [TENANT_HEADER]: tenantId };
    const before = await signIn(account.email);
    const open = await rest(before.accessToken, "customers?select=display_name", {
      headers: header,
    });
    expect(open.json).toEqual([{ display_name: "Cliente HTTP" }]);

    const enrolled = await enrollAndVerify(await signIn(account.email), "principal");

    // Pase aal1 nuevo (solo contraseña): la cuenta ya tiene el segundo paso activo.
    const partial = await signIn(account.email);
    expect(claimsOf(partial.accessToken).aal).toBe("aal1");
    // Todas las tablas de `public` que la API expone (el catálogo, no una lista a mano): cero filas o rechazo. La única que se lee
    // es `legal_documents`, que es pública. `select=*` lo rechazan las tablas con columnas privadas: también es un rechazo.
    const tables = (
      await db.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p')
            and has_table_privilege('authenticated', c.oid, 'select') order by 1`,
      )
    ).rows.map((row) => row.relname);
    expect(tables.length).toBeGreaterThan(15);
    for (const table of tables) {
      const res = await rest(partial.accessToken, `${table}?select=*&limit=1`, { headers: header });
      if (table === "legal_documents") {
        expect(res.status, table).toBe(200);
        continue;
      }
      const rejected = res.status >= 400;
      const empty = res.status === 200 && Array.isArray(res.json) && res.json.length === 0;
      expect(rejected || empty, `${table}: ${res.status} ${res.text.slice(0, 100)}`).toBe(true);
    }
    // Las que muestran filas con el pase completo: el control de que el barrido no mira en vacío.
    const stillThere = await rest(enrolled.aal2, "customers?select=display_name&limit=1", {
      headers: header,
    });
    expect(stillThere.json).toEqual([{ display_name: "Cliente HTTP" }]);
    const write = await rest(partial.accessToken, "catalog_items", {
      method: "POST",
      headers: { ...header, prefer: "return=minimal" },
      body: { tenant_id: tenantId, name: "Colado", unit: "service", unit_price_clp: 1 },
    });
    expect([401, 403]).toContain(write.status);

    // El pase aal2 sí ve lo suyo.
    const full = await rest(enrolled.aal2, "customers?select=display_name", { headers: header });
    expect(full.json).toEqual([{ display_name: "Cliente HTTP" }]);
  });
});
