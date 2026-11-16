// 🟢 PRUEBAS · Supabase local, datos ficticios.
// H-118b · migración 20261113110000_mfa_annul: `mfa_annul_claim`, `mfa_annul_complete`, `mfa_annul_release` y
// `mfa_revoke_sessions` (solo del servidor), sobre las tablas de H-118a. Más lo que se comprobó de Supabase Auth para la
// anulación: cambiar la contraseña con la API de administración YA cierra todas las sesiones de la cuenta.
// Solo cuentas nuevas `@ejemplo.test`. Lo que necesita filas confirmadas (dos conexiones, la API) limpia al terminar; el
// resto corre dentro de una transacción que se deshace.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { localEnv, rpc, signIn } from "../support/local-supabase";
import { enrollAndVerifyWithPermit, gotrue, newMfaAccount } from "../support/mfa-gate";
import {
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  withTx,
  type TestUser,
} from "./helpers";

vi.setConfig({ testTimeout: 90_000 });

const PLATFORM = "00000000-0000-4000-8000-000000000001";
const sha = () => createHash("sha256").update(randomBytes(32)).digest("hex");

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

type Seeded = { user: TestUser; alertId: string; linkId: string; hash: string };

/** Una cuenta con un aviso en el estado dado y un enlace abierto (vigente por defecto). */
async function seed(
  client: Client,
  options: { state?: string; expiresIn?: string; user?: TestUser } = {},
): Promise<Seeded> {
  const user = options.user ?? (await createUser(client));
  const alert = await client.query<{ id: string }>(
    `insert into public.mfa_enrollment_alerts (user_id, factor_id, state, expected_until, verified_at, sent_at)
     values ($1, gen_random_uuid(), $2, now(), now(), now()) returning id`,
    [user.id, options.state ?? "sent"],
  );
  const hash = sha();
  const link = await client.query<{ id: string }>(
    `insert into public.mfa_annul_links (alert_id, user_id, token_sha256, expires_at)
     values ($1, $2, $3, now() + $4::interval) returning id`,
    [alert.rows[0].id, user.id, hash, options.expiresIn ?? "72 hours"],
  );
  return { user, alertId: alert.rows[0].id, linkId: link.rows[0].id, hash };
}

const claim = async (client: Client, hash: string | null) =>
  (
    await client.query<{ r: Record<string, unknown> }>("select public.mfa_annul_claim($1) as r", [
      hash,
    ])
  ).rows[0].r;
const complete = async (client: Client, linkId: string | null) =>
  (
    await client.query<{ r: Record<string, unknown> }>(
      "select public.mfa_annul_complete($1) as r",
      [linkId],
    )
  ).rows[0].r;

describe("mfa_annul_claim", () => {
  it("K1 · un enlace válido se toma por 2 minutos; la respuesta trae la cuenta (la necesita el servidor) pero no el correo", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const { linkId, hash, user } = await seed(db);
      const got = await claim(db, hash);
      expect(got).toEqual({ result: "ok", link_id: linkId, user_id: user.id });
      expect(JSON.stringify(got)).not.toContain(user.email);
      const row = await db.query<{ secs: number }>(
        "select extract(epoch from (claimed_until - now()))::int as secs from public.mfa_annul_links where id = $1",
        [linkId],
      );
      expect(row.rows[0].secs).toBeGreaterThan(110);
      expect(row.rows[0].secs).toBeLessThanOrEqual(120);
    }));

  it("K2 · inexistente, basura, usado, vencido, tomado o con el aviso revertido, anulado, cerrado o esperando el código: TODOS dan exactamente lo mismo", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const results: unknown[] = [];
      results.push(await claim(db, sha()));
      for (const garbage of [
        null,
        "",
        "abc",
        "g".repeat(64),
        "A".repeat(64),
        "a".repeat(63),
        "a".repeat(65),
      ]) {
        results.push(await claim(db, garbage));
      }
      const used = await seed(db);
      await db.query("update public.mfa_annul_links set used_at = now() where id = $1", [
        used.linkId,
      ]);
      results.push(await claim(db, used.hash));
      const expired = await seed(db, { expiresIn: "-1 second" });
      results.push(await claim(db, expired.hash));
      const taken = await seed(db);
      expect((await claim(db, taken.hash)).result).toBe("ok");
      results.push(await claim(db, taken.hash));
      for (const state of ["reverted", "annulled", "closed", "expected"]) {
        const other = await seed(db, { state });
        results.push(await claim(db, other.hash));
      }
      expect(results.length).toBeGreaterThan(14);
      for (const result of results) expect(result).toEqual({ result: "invalid" });
    }));

  it("K2b · el aviso `pending` (el correo salió pero no se alcanzó a anotar) SÍ sirve: el enlace existe porque se reservó y se intentó mandar", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const pending = await seed(db, { state: "pending" });
      expect(await claim(db, pending.hash)).toEqual({
        result: "ok",
        link_id: pending.linkId,
        user_id: pending.user.id,
      });
      const done = await complete(db, pending.linkId);
      expect(done).toMatchObject({ result: "ok", user_id: pending.user.id });
      expect(
        (
          await db.query("select state from public.mfa_enrollment_alerts where id = $1", [
            pending.alertId,
          ])
        ).rows[0].state,
      ).toBe("annulled");
    }));

  it("K3 · un enlace cuyo plazo de 2 minutos ya pasó se puede tomar de nuevo", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const { linkId, hash } = await seed(db);
      await claim(db, hash);
      await db.query(
        "update public.mfa_annul_links set claimed_until = now() - interval '1 second' where id = $1",
        [linkId],
      );
      expect(await claim(db, hash)).toMatchObject({ result: "ok", link_id: linkId });
    }));

  it("K4 · dos tomas a la vez: gana UNA", async () => {
    const seeded = await seed(db);
    const other = await connect();
    try {
      const [first, second] = await Promise.all([
        claim(db, seeded.hash),
        claim(other, seeded.hash),
      ]);
      const results = [first.result, second.result].sort();
      expect(results).toEqual(["invalid", "ok"]);
    } finally {
      await other.end();
      await db.query("delete from auth.users where id = $1", [seeded.user.id]);
    }
  });

  it("K5 · retención: los enlaces se borran 30 días después de VENCER y un aviso cuando ya no le queda ningún enlace y tiene más de 30 días; un enlace reservado tarde no se borra antes", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const old = await seed(db);
      await db.query(
        "update public.mfa_enrollment_alerts set created_at = now() - interval '40 days' where id = $1",
        [old.alertId],
      );
      await db.query(
        "update public.mfa_annul_links set expires_at = now() - interval '31 days' where id = $1",
        [old.linkId],
      );
      // Aviso de 40 días pero con un enlace reservado tarde, que venció hace solo 10 días: se conserva con su enlace.
      const late = await seed(db);
      await db.query(
        "update public.mfa_enrollment_alerts set created_at = now() - interval '40 days' where id = $1",
        [late.alertId],
      );
      await db.query(
        "update public.mfa_annul_links set expires_at = now() - interval '10 days' where id = $1",
        [late.linkId],
      );
      // Aviso reciente sin enlace: se conserva (aún no tiene 30 días).
      const young = await seed(db);
      await db.query("delete from public.mfa_annul_links where id = $1", [young.linkId]);
      await claim(db, sha());
      const exists = async (table: string, id: string) =>
        (await db.query(`select 1 from public.${table} where id = $1`, [id])).rowCount === 1;
      expect(await exists("mfa_annul_links", old.linkId)).toBe(false);
      expect(await exists("mfa_enrollment_alerts", old.alertId)).toBe(false);
      expect(await exists("mfa_annul_links", late.linkId)).toBe(true);
      expect(await exists("mfa_enrollment_alerts", late.alertId)).toBe(true);
      expect(await exists("mfa_enrollment_alerts", young.alertId)).toBe(true);
    }));
});

describe("mfa_annul_complete y mfa_annul_release", () => {
  it("K6 · consume ESE enlace y todos los abiertos de la cuenta (y de ninguna otra); cierra los avisos; devuelve el correo de auth.users", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const mine = await seed(db);
      const second = await seed(db, { user: mine.user });
      const expiredLink = await seed(db, { user: mine.user, expiresIn: "-1 hour" });
      const permit = await db.query<{ id: string }>(
        `insert into public.mfa_enrollment_alerts (user_id, factor_id, state, expected_until)
         values ($1, gen_random_uuid(), 'expected', now() + interval '1 minute') returning id`,
        [mine.user.id],
      );
      const theirs = await seed(db);
      await claim(db, mine.hash);

      const done = await complete(db, mine.linkId);
      expect(done).toEqual({ result: "ok", user_id: mine.user.id, email: mine.user.email });

      const links = await db.query<{ id: string; used: boolean }>(
        "select id, used_at is not null as used from public.mfa_annul_links where user_id = $1",
        [mine.user.id],
      );
      expect(links.rows.length).toBe(3);
      expect(links.rows.every((row) => row.used)).toBe(true);
      expect(links.rows.map((row) => row.id)).toEqual(
        expect.arrayContaining([mine.linkId, second.linkId, expiredLink.linkId]),
      );
      const states = await db.query<{ id: string; state: string }>(
        "select id, state from public.mfa_enrollment_alerts where user_id = $1",
        [mine.user.id],
      );
      const byId = Object.fromEntries(states.rows.map((row) => [row.id, row.state]));
      expect(byId[mine.alertId]).toBe("annulled");
      expect(byId[second.alertId]).toBe("annulled");
      expect(byId[permit.rows[0].id]).toBe("closed");
      // La otra cuenta no se tocó.
      const other = await db.query<{ used: boolean; state: string }>(
        `select l.used_at is not null as used, a.state from public.mfa_annul_links l
           join public.mfa_enrollment_alerts a on a.id = l.alert_id where l.id = $1`,
        [theirs.linkId],
      );
      expect(other.rows[0]).toEqual({ used: false, state: "sent" });
      // Ningún enlace de la cuenta sirve ya.
      for (const hash of [mine.hash, second.hash])
        expect(await claim(db, hash)).toEqual({ result: "invalid" });
      // Completar otra vez ya no hace nada.
      expect(await complete(db, mine.linkId)).toEqual({ result: "invalid" });
      expect(await complete(db, randomUUID())).toEqual({ result: "invalid" });
    }));

  it("K7 · audita en la plataforma y en las organizaciones donde la persona está ACTIVA, no en las que dejó; sin correo ni código", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const person = await createUser(db);
      const active = await createTenantAs(db, person, "76086428-5", "Activa");
      const owner = await createUser(db);
      const left = await createTenantAs(db, owner, "77777777-7", "Dejada");
      await db.query(
        "insert into public.members (tenant_id, user_id, role, status) values ($1, $2, 'sales', 'active')",
        [left, person.id],
      );
      await db.query(
        "update public.members set status = 'removed', removed_at = now() where tenant_id = $1 and user_id = $2",
        [left, person.id],
      );
      const never = await createTenantAs(db, await createUser(db), "76123456-0", "Ajena");
      const seeded = await seed(db, { user: person });
      await claim(db, seeded.hash);
      await complete(db, seeded.linkId);

      const rows = await db.query<{
        tenant_id: string;
        actor_type: string;
        actor_user_id: string | null;
        result: string;
        details: Record<string, unknown>;
        resource_type: string | null;
      }>(
        `select tenant_id, actor_type, actor_user_id, result, details, resource_type from public.audit_log
          where action = 'session.mfa_annulled' and actor_user_id = $1`,
        [person.id],
      );
      expect(rows.rows.map((row) => row.tenant_id).sort()).toEqual([PLATFORM, active].sort());
      expect(rows.rows.map((row) => row.tenant_id)).not.toContain(left);
      expect(rows.rows.map((row) => row.tenant_id)).not.toContain(never);
      for (const row of rows.rows) {
        expect(row).toMatchObject({
          actor_type: "public",
          result: "success",
          resource_type: "session",
        });
        expect(row.details).toEqual({ via: "email_link" });
      }
      expect(JSON.stringify(rows.rows)).not.toContain(person.email);
      expect(JSON.stringify(rows.rows)).not.toContain(seeded.hash);
    }));

  it("K8 · soltar el enlace lo deja abrirse de nuevo; uno ya usado no se suelta; argumento nulo se rechaza", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const { linkId, hash } = await seed(db);
      await claim(db, hash);
      expect((await claim(db, hash)).result).toBe("invalid");
      expect(
        (await db.query("select public.mfa_annul_release($1) as ok", [linkId])).rows[0].ok,
      ).toBe(true);
      expect(await claim(db, hash)).toMatchObject({ result: "ok", link_id: linkId });
      await complete(db, linkId);
      expect(
        (await db.query("select public.mfa_annul_release($1) as ok", [linkId])).rows[0].ok,
      ).toBe(false);
      await db.query("savepoint s");
      await expect(db.query("select public.mfa_annul_release(null)")).rejects.toMatchObject({
        code: "CP422",
      });
      await db.query("rollback to savepoint s");
      await expect(db.query("select public.mfa_annul_complete(null)")).rejects.toMatchObject({
        code: "CP422",
      });
    }));
});

describe("sesiones y permisos", () => {
  it("K9 · cambiar la contraseña con la API de administración YA cierra todas las sesiones y los tokens de renovación de la cuenta", async () => {
    const account = await newMfaAccount();
    const first = await signIn(account.email);
    const second = await signIn(account.email);
    const count = async () =>
      Number(
        (
          await db.query<{ n: string }>(
            `select (select count(*) from auth.sessions where user_id = $1)
                  + (select count(*) from auth.refresh_tokens where user_id = $1::text) as n`,
            [account.id],
          )
        ).rows[0].n,
      );
    expect(await count()).toBeGreaterThan(0);
    const { apiUrl, secretKey } = localEnv();
    const changed = await fetch(`${apiUrl}/auth/v1/admin/users/${account.id}`, {
      method: "PUT",
      headers: {
        apikey: secretKey,
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: `${randomBytes(48).toString("base64url")}Aa1!` }),
    });
    expect(changed.status).toBe(200);
    expect(await count()).toBe(0);
    for (const session of [first, second]) {
      const res = await gotrue(session.accessToken, "GET", "user");
      expect(res.status).toBe(403);
      expect(res.json?.error_code).toBe("session_not_found");
    }
    // Y la contraseña de antes ya no sirve.
    await expect(signIn(account.email)).rejects.toThrow();
  });

  it("K10 · mfa_revoke_sessions borra lo que quede de la cuenta y devuelve cuántos quedan (0), sin tocar a otras cuentas", async () => {
    const mine = await newMfaAccount();
    const other = await newMfaAccount();
    const mineSession = await signIn(mine.email);
    const otherSession = await signIn(other.email);
    const left = await db.query<{ n: number }>("select public.mfa_revoke_sessions($1) as n", [
      mine.id,
    ]);
    expect(left.rows[0].n).toBe(0);
    expect((await gotrue(mineSession.accessToken, "GET", "user")).status).toBe(403);
    expect((await gotrue(otherSession.accessToken, "GET", "user")).status).toBe(200);
    await expect(db.query("select public.mfa_revoke_sessions(null)")).rejects.toMatchObject({
      code: "CP422",
    });
  });

  it("K11 · ni sin sesión, ni con pase de solo contraseña, ni con pase completo se llaman las cuatro funciones por la API; solo service_role las ejecuta", async () => {
    const partialAccount = await newMfaAccount();
    const partial = await signIn(partialAccount.email);
    const full = await newMfaAccount();
    const { aal2 } = await enrollAndVerifyWithPermit(db, await signIn(full.email));
    try {
      const args: Record<string, object> = {
        mfa_annul_claim: { p_token_sha256: sha() },
        mfa_annul_complete: { p_link_id: randomUUID() },
        mfa_annul_release: { p_link_id: randomUUID() },
        mfa_revoke_sessions: { p_user_id: full.id },
      };
      for (const [who, token] of [
        ["sin sesión", null],
        ["solo contraseña", partial.accessToken],
        ["pase completo", aal2],
      ] as const) {
        for (const [name, body] of Object.entries(args)) {
          const res = await rpc(token, name, body);
          expect([401, 403], `${who} llama ${name}: ${res.text}`).toContain(res.status);
        }
      }
      for (const fn of [
        "public.mfa_annul_claim(text)",
        "public.mfa_annul_complete(uuid)",
        "public.mfa_annul_release(uuid)",
        "public.mfa_revoke_sessions(uuid)",
      ]) {
        const { rows } = await db.query<{ anon: boolean; auth: boolean; service: boolean }>(
          `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                  has_function_privilege('service_role', $1, 'execute') as service`,
          [fn],
        );
        expect(rows[0], fn).toEqual({ anon: false, auth: false, service: true });
      }
      // La cuenta con pase completo conserva su sesión: nada de lo anterior la cerró.
      expect((await gotrue(aal2, "GET", "user")).status).toBe(200);
    } finally {
      await db.query("delete from auth.users where id = any($1)", [[partialAccount.id, full.id]]);
    }
  });
});
