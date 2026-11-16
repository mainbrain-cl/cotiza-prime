// H-004b etapa B · Códigos de respaldo del segundo paso: cuenta contra cuenta. El código de la cuenta A usado como si fuera de la cuenta
// B no sirve ni toca el juego de A; las siete funciones no aceptan ningún pase (solo el servidor, con la llave maestra) y la tabla no
// se lee ni se escribe con ningún pase, ni siquiera con el de una persona de una organización. Se llaman las funciones directo en la
// base (como las llama el servidor con la llave maestra). Cuentas nuevas `@ejemplo.test`, nunca las de la fixture ni las de la semilla.
//
// Al final: el CÓDIGO REAL de `disableSecondStepAction` y `verifyRecoveryCodeAction` (con la base, GoTrue, las pasarelas y la
// auditoría reales; solo se reemplazan la sesión de Next, la contraseña, el correo y la verificación del código de 6 números) deja
// `session.mfa_disabled` y `session.mfa_recovery_used` en la plataforma y SOLO en las organizaciones donde la persona está ACTIVA:
// no en una que dejó ni en una ajena, y la dueña de una organización ajena no ve esos eventos.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeRecoveryCode, recoveryCodeHash } from "@/lib/auth/recovery-code";
import { verifyRecoveryCodeAction } from "@/lib/auth/recovery-code-actions";
import { disableSecondStepAction } from "@/lib/auth/second-step-manage-actions";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { adminCreateUser, localEnv, rest, rpc, signIn } from "../support/local-supabase";
import { enrollAndVerifyWithPermit, gotrue } from "../support/mfa-gate";
import { fixture, openDb, tenantHeader, tokenOf } from "./context";

vi.setConfig({ testTimeout: 90_000 });

// Fuera de Next no hay petición, cookies ni proveedor de correo: la sesión, la contraseña de nuevo, el correo y el registro del
// servidor se reemplazan. Todo lo demás (acciones, comprobación de intentos, pasarelas, auditoría, base y GoTrue) es el código real.
const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; emailVerified: boolean } | null,
  client: null as unknown,
}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: async () => undefined }));
vi.mock("@/lib/http/request-context", () => ({
  getRequestContext: async () => ({
    requestId: "5a1c0000-0000-4000-8000-000000000001",
    clientIp: "203.0.113.50",
    userAgent: "vitest",
  }),
  getAppOrigin: () => "https://app.ejemplo.test",
}));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async () => state.user,
  requirePendingSecondStep: async () => state.user,
  hasRecoverySession: async () => false,
  getSessionState: async () => ({
    status: "complete",
    user: state.user,
    secondStep: { active: true, since: null },
  }),
}));
vi.mock("@/lib/auth/reauth", () => ({ confirmPassword: async () => ({ ok: true }) }));
vi.mock("@/lib/security/mfa-account-notice-send", () => ({
  sendDisabledNotice: async () => true,
  sendRecoveryUsedNotice: async () => true,
  sendRecoveryCodesCreatedNotice: async () => true,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));

const hex = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const hashes = () => Array.from({ length: 10 }, hex);

let db: Client;
const created: string[] = [];
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  // Quienes llegaron a tener una membresía (aunque ya quitada) se quedan: el registro del equipo las conserva (como en `second-step.test.ts`).
  const removable = created.filter((id) => !memberships.some((entry) => entry.userId === id));
  if (removable.length > 0) {
    await db.query("delete from auth.users where id = any($1)", [removable]);
  }
  await db.end();
});

type Account = { id: string; email: string; factorId: string; aal2: string; aal1: string };
/** Una cuenta con el segundo paso hecho (pase aal2), otra sesión solo de contraseña (aal1) y un juego de 10 códigos. */
async function accountWithSet(label: string): Promise<Account & { codes: string[] }> {
  const email = `respaldo-${label}-${randomBytes(4).toString("hex")}@ejemplo.test`;
  const id = await adminCreateUser(email);
  created.push(id);
  const aal1 = (await signIn(email)).accessToken;
  const { factorId, aal2 } = await enrollAndVerifyWithPermit(db, await signIn(email));
  const codes = hashes();
  const replaced = (
    await db.query<{ r: { result: string } }>(
      "select public.mfa_recovery_codes_replace($1, $2, $3::text[]) as r",
      [id, factorId, codes],
    )
  ).rows[0].r;
  expect(replaced.result).toBe("ok");
  return { id, email, factorId, aal2, aal1, codes };
}

const claim = async (user: string, hash: string) =>
  (
    await db.query<{ r: Record<string, unknown> }>(
      "select public.mfa_recovery_code_claim($1, $2) as r",
      [user, hash],
    )
  ).rows[0].r;
const rows = async (user: string) =>
  (
    await db.query<{ code_hash: string; claimed_until: string | null; used_at: string | null }>(
      "select code_hash, claimed_until, used_at from public.mfa_recovery_codes where user_id = $1",
      [user],
    )
  ).rows;

describe("H-004b · el código de la cuenta A no sirve para la cuenta B", () => {
  it("el código de A pedido para B responde `invalid` y deja el juego de A (y el de B) intactos", async () => {
    const a = await accountWithSet("a");
    const b = await accountWithSet("b");
    // B, con su sesión abierta, prueba el código de A: no existe para B.
    expect(await claim(b.id, a.codes[0])).toEqual({ result: "invalid" });
    for (const row of await rows(a.id))
      expect(row).toMatchObject({ claimed_until: null, used_at: null });
    for (const row of await rows(b.id))
      expect(row).toMatchObject({ claimed_until: null, used_at: null });
    expect(await rows(a.id)).toHaveLength(10);
    expect(await rows(b.id)).toHaveLength(10);
    // El de B sigue sirviendo a B, y tomarlo no toca a A.
    expect((await claim(b.id, b.codes[0])).result).toBe("ok");
    for (const row of await rows(a.id)) expect(row.claimed_until).toBeNull();
    // Las dos sesiones y los dos factores siguen como estaban.
    for (const account of [a, b]) {
      expect((await gotrue(account.aal2, "GET", "user")).status).toBe(200);
      expect(
        (
          await db.query("select 1 from auth.mfa_factors where id = $1 and status = 'verified'", [
            account.factorId,
          ])
        ).rowCount,
      ).toBe(1);
    }
  });

  it("la MISMA huella en dos cuentas son dos códigos distintos: tomar el de B no toca el de A", async () => {
    const a = await accountWithSet("c");
    const b = await accountWithSet("d");
    const same = hex();
    for (const account of [a, b]) {
      await db.query(
        "update public.mfa_recovery_codes set code_hash = $2 where id = (select id from public.mfa_recovery_codes where user_id = $1 limit 1)",
        [account.id, same],
      );
    }
    expect((await claim(b.id, same)).result).toBe("ok");
    const aRow = (await rows(a.id)).find((row) => row.code_hash === same);
    expect(aRow).toMatchObject({ claimed_until: null, used_at: null });
  });

  it("completar, soltar o borrar en una cuenta no toca a la otra", async () => {
    const a = await accountWithSet("e");
    const b = await accountWithSet("f");
    const taken = (await claim(b.id, b.codes[0])).code_id as string;
    expect(
      (
        await db.query<{ r: boolean }>(
          "select public.mfa_recovery_codes_acknowledge($1, $2) as r",
          [a.id, randomUUID()],
        )
      ).rows[0].r,
    ).toBe(false);
    expect(
      (
        await db.query<{ r: Record<string, unknown> }>(
          "select public.mfa_recovery_code_complete($1) as r",
          [taken],
        )
      ).rows[0].r.result,
    ).toBe("ok");
    expect(await rows(a.id)).toHaveLength(10);
    expect(
      Number(
        (await db.query<{ r: number }>("select public.mfa_recovery_codes_revoke($1) as r", [b.id]))
          .rows[0].r,
      ),
    ).toBe(1);
    expect(await rows(a.id)).toHaveLength(10);
    expect(
      (
        await db.query<{ r: Record<string, unknown> }>(
          "select public.mfa_recovery_codes_status($1) as r",
          [a.id],
        )
      ).rows[0].r,
    ).toMatchObject({ total: 10, acknowledged: false });
  });
});

describe("H-004b · ningún pase llega a los códigos", () => {
  it("con el pase de B (aal1 y aal2), el de una persona de la organización A o sin sesión: ni se lee ni se escribe la tabla de A, ni se llaman las siete funciones", async () => {
    const a = await accountWithSet("g");
    const b = await accountWithSet("h");
    const ana = await tokenOf("ana");
    const attackerTokens: [string, string | null][] = [
      ["B con solo contraseña", b.aal1],
      ["B con pase completo", b.aal2],
      ["ana (organización A)", ana],
      ["sin sesión", null],
    ];
    const functionArgs: Record<string, object> = {
      mfa_recovery_codes_replace: {
        p_user_id: a.id,
        p_factor_id: a.factorId,
        p_code_hashes: hashes(),
      },
      mfa_recovery_code_claim: { p_user_id: a.id, p_code_hash: a.codes[0] },
      mfa_recovery_code_complete: { p_code_id: randomUUID() },
      mfa_recovery_code_release: { p_code_id: randomUUID() },
      mfa_recovery_codes_acknowledge: { p_user_id: a.id, p_set_id: randomUUID() },
      mfa_recovery_codes_status: { p_user_id: a.id },
      mfa_recovery_codes_revoke: { p_user_id: a.id },
    };
    for (const [who, token] of attackerTokens) {
      for (const [name, body] of Object.entries(functionArgs)) {
        const res = await rpc(token, name, body);
        expect([401, 403], `${who} llama ${name}: ${res.text}`).toContain(res.status);
      }
      for (const [method, path, body] of [
        ["GET", `mfa_recovery_codes?user_id=eq.${a.id}&select=*`, undefined],
        ["PATCH", `mfa_recovery_codes?user_id=eq.${a.id}`, { used_at: new Date() }],
        ["DELETE", `mfa_recovery_codes?user_id=eq.${a.id}`, undefined],
      ] as const) {
        const res = await rest(token, path, { method, body });
        expect([401, 403], `${who} ${method} ${path}: ${res.text}`).toContain(res.status);
      }
    }
    // El juego de A quedó exactamente como estaba.
    expect(await rows(a.id)).toHaveLength(10);
    for (const row of await rows(a.id))
      expect(row).toMatchObject({ claimed_until: null, used_at: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// La auditoría de desactivar y de entrar con un código: plataforma y organizaciones donde la persona está ACTIVA.
// ---------------------------------------------------------------------------------------------------------------------------

const MEMBER_ROLE = "sales";
const memberships: { tenantId: string; userId: string }[] = [];

/** Una persona NUEVA con la verificación activa y un juego de códigos; activa en `active` y con membresía quitada en `left`. */
async function personIn(label: string, active: string[], left: string[]) {
  const person = await accountWithSet(label);
  for (const tenantId of [...active, ...left]) {
    await db.query("insert into public.members (tenant_id, user_id, role) values ($1, $2, $3)", [
      tenantId,
      person.id,
      MEMBER_ROLE,
    ]);
    memberships.push({ tenantId, userId: person.id });
  }
  for (const tenantId of left) {
    await db.query(
      "update public.members set status = 'removed', removed_at = now() where tenant_id = $1 and user_id = $2",
      [tenantId, person.id],
    );
  }
  // Los códigos reales de ESTA cuenta: se reemplaza el juego de `accountWithSet` por huellas de códigos que conocemos.
  const known = Array.from({ length: 10 }, () =>
    randomBytes(8).toString("hex").slice(0, 12).toUpperCase(),
  );
  const normalized = known.map((code) => normalizeRecoveryCode(code)!);
  const replaced = (
    await db.query<{ r: { result: string } }>(
      "select public.mfa_recovery_codes_replace($1, $2, $3::text[]) as r",
      [person.id, person.factorId, normalized.map((code) => recoveryCodeHash(person.id, code))],
    )
  ).rows[0].r;
  expect(replaced.result).toBe("ok");
  return { ...person, known };
}

/** Un cliente que habla con la base y con GoTrue con el pase dado (como el de la sesión de la persona), sin cookies. */
function sessionClient(person: { id: string; factorId: string }, accessToken: string) {
  const { apiUrl, publishableKey } = localEnv();
  const restClient = createClient(apiUrl, publishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    from: restClient.from.bind(restClient),
    auth: {
      signOut: async () => ({ error: null }),
      mfa: {
        listFactors: async () => ({
          data: { all: [{ id: person.factorId, factor_type: "totp", status: "verified" }] },
          error: null,
        }),
        // La verificación del código de 6 números es de Supabase: aquí se da por buena; lo que se prueba es la auditoría.
        challengeAndVerify: async () => ({ data: {}, error: null }),
        // Quitar el factor SÍ es real: con el pase de la persona, como lo hace la acción.
        unenroll: async ({ factorId }: { factorId: string }) => {
          const res = await gotrue(accessToken, "DELETE", `factors/${factorId}`);
          return res.status === 200
            ? { data: {}, error: null }
            : { data: null, error: { code: res.json?.error_code, status: res.status } };
        },
      },
    },
  };
}

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
/** Las acciones terminan SIEMPRE en una redirección cuando salen bien: se la deja pasar y se devuelve el resultado si no. */
async function run(action: () => Promise<unknown>): Promise<unknown> {
  try {
    return await action();
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (error instanceof Error && /NEXT_REDIRECT/.test(error.message + String(digest))) {
      return "redirect";
    }
    throw error;
  }
}
const eventTenants = async (userId: string, action: string) =>
  (
    await db.query<{ tenant_id: string }>(
      "select tenant_id from public.audit_log where actor_user_id = $1 and action = $2 order by tenant_id",
      [userId, action],
    )
  ).rows.map((row) => row.tenant_id);

describe("H-004b · la auditoría de desactivar y de entrar con un código solo queda donde la persona está activa", () => {
  afterAll(async () => {
    // Las personas de esta prueba salen de las organizaciones de la fixture (como hace `second-step.test.ts`).
    for (const { tenantId, userId } of memberships) {
      await db.query(
        "update public.members set status = 'removed', removed_at = now() where tenant_id = $1 and user_id = $2 and status = 'active'",
        [tenantId, userId],
      );
    }
  });

  it("desactivar con el código de la aplicación: `session.mfa_disabled` en la plataforma y en A (activa), no en B (la dejó) ni en C; la dueña de B no ve nada y la de A sí", async () => {
    const { A, B, C } = fixture().orgs;
    const person = await personIn("desactiva", [A.tenantId], [B.tenantId]);
    state.user = { id: person.id, email: person.email, emailVerified: true };
    state.client = sessionClient(person, person.aal2);

    const result = await run(() =>
      disableSecondStepAction({ status: "idle" }, form({ code: "123456", password: "x" })),
    );
    expect(result).toBe("redirect");

    // La verificación quedó quitada de verdad (con el pase de la persona) y los códigos borrados.
    expect(
      (await db.query("select 1 from auth.mfa_factors where user_id = $1", [person.id])).rowCount,
    ).toBe(0);
    expect(await rows(person.id)).toHaveLength(0);

    const tenants = await eventTenants(person.id, "session.mfa_disabled");
    expect([...tenants].sort()).toEqual([PLATFORM_TENANT_ID, A.tenantId].sort());
    expect(tenants).not.toContain(B.tenantId);
    expect(tenants).not.toContain(C.tenantId);
    const details = (
      await db.query<{ details: { via: string } }>(
        "select details from public.audit_log where actor_user_id = $1 and action = 'session.mfa_disabled' and tenant_id = $2",
        [person.id, A.tenantId],
      )
    ).rows[0].details;
    expect(details.via).toBe("totp");

    // Lo que ven los dueños por la API: la de A ve el evento de su miembro; la de B (donde ya no está) y la de C, ninguno.
    const seenBy = async (persona: "ana" | "beto" | "carla", tenantId: string) =>
      (
        await rest(
          await tokenOf(persona),
          `audit_log?actor_user_id=eq.${person.id}&action=eq.session.mfa_disabled&select=id`,
          { headers: tenantHeader(tenantId) },
        )
      ).json as unknown[];
    expect(await seenBy("ana", A.tenantId)).toHaveLength(1);
    expect(await seenBy("beto", B.tenantId)).toHaveLength(0);
    expect(await seenBy("carla", C.tenantId)).toHaveLength(0);
  });

  it("desactivar con un código de respaldo: `via: recovery_code`, en la plataforma y en las DOS organizaciones donde la persona está activa (y en ninguna otra)", async () => {
    const { A, B, C } = fixture().orgs;
    const person = await personIn("respaldo", [A.tenantId, B.tenantId], []);
    state.user = { id: person.id, email: person.email, emailVerified: true };
    state.client = sessionClient(person, person.aal2);

    const result = await run(() =>
      disableSecondStepAction({ status: "idle" }, form({ code: person.known[0], password: "x" })),
    );
    expect(result).toBe("redirect");
    expect(
      (await db.query("select 1 from auth.mfa_factors where user_id = $1", [person.id])).rowCount,
    ).toBe(0);
    // El código usado y el resto del juego ya no sirven.
    expect(await rows(person.id)).toHaveLength(0);

    const tenants = await eventTenants(person.id, "session.mfa_disabled");
    expect([...tenants].sort()).toEqual([PLATFORM_TENANT_ID, A.tenantId, B.tenantId].sort());
    expect(tenants).not.toContain(C.tenantId);
    const vias = (
      await db.query<{ details: { via: string } }>(
        "select details from public.audit_log where actor_user_id = $1 and action = 'session.mfa_disabled'",
        [person.id],
      )
    ).rows.map((row) => row.details.via);
    expect(vias).toEqual(["recovery_code", "recovery_code", "recovery_code"]);
  });

  it("entrar con un código de respaldo desde la sesión a medias: `session.mfa_recovery_used` en la plataforma y solo en A (activa); el ingreso solo en A", async () => {
    const { A, B, C } = fixture().orgs;
    const person = await personIn("entra", [A.tenantId], [B.tenantId]);
    // La sesión a medias: solo contraseña (aal1), con el factor todavía puesto.
    const partial = (await signIn(person.email)).accessToken;
    state.user = { id: person.id, email: person.email, emailVerified: true };
    state.client = sessionClient(person, partial);

    const result = await run(() =>
      verifyRecoveryCodeAction({ status: "idle" }, form({ recoveryCode: person.known[1] })),
    );
    expect(result).toBe("redirect");
    // Quitar el factor deja la sesión completa y el resto del juego borrado.
    expect(
      (await db.query("select 1 from auth.mfa_factors where user_id = $1", [person.id])).rowCount,
    ).toBe(0);

    const used = await eventTenants(person.id, "session.mfa_recovery_used");
    expect([...used].sort()).toEqual([PLATFORM_TENANT_ID, A.tenantId].sort());
    expect(used).not.toContain(B.tenantId);
    expect(used).not.toContain(C.tenantId);
    // El ingreso de cada organización (`session.login`) solo en la activa.
    expect(await eventTenants(person.id, "session.login")).toEqual([A.tenantId]);
  });
});
