// 🟢 PRUEBAS · Supabase local, datos ficticios.
// H-004b etapa B · migración 20261116100000_mfa_recovery_codes: la tabla `mfa_recovery_codes` (solo huellas, de la plataforma) y sus
// siete funciones (solo del servidor): reemplazar el juego, tomar un código, completar, soltar, marcar «guardé», estado y borrar.
// Lo que depende solo de la base corre dentro de una transacción que se deshace, con factores escritos directo en
// `auth.mfa_factors`. Lo que exige Supabase Auth de verdad (borrar el factor por la API, las dos conexiones de las carreras, los
// pases aal1 y aal2 contra la API) usa cuentas nuevas `@ejemplo.test` y limpia al terminar.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rest, rpc, signIn } from "../support/local-supabase";
import { enrollAndVerifyWithPermit, gotrue, newMfaAccount } from "../support/mfa-gate";
import {
  actAs,
  actAsAnon,
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  expectSqlError,
  withTx,
  type TestUser,
} from "./helpers";

vi.setConfig({ testTimeout: 90_000 });

const PLATFORM = "00000000-0000-4000-8000-000000000001";
const hex = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const hashes = (n = 10) => Array.from({ length: n }, hex);

let db: Client;
const committedUsers: string[] = [];
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  if (committedUsers.length > 0) {
    await db.query("delete from auth.users where id = any($1)", [committedUsers]);
  }
  await db.end();
});

/** Un factor escrito directo en `auth.mfa_factors` (la prueba corre como postgres: el disparador de H-118 no actúa al insertar). */
async function addFactor(
  client: Client,
  userId: string,
  options: { type?: "totp" | "phone"; status?: "verified" | "unverified" } = {},
): Promise<string> {
  const type = options.type ?? "totp";
  const { rows } = await client.query<{ id: string }>(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret, phone)
     values (gen_random_uuid(), $1, $2, $3::auth.factor_type, $4::auth.factor_status, now(), now(), 'x', $5) returning id`,
    [
      userId,
      `f-${randomUUID().slice(0, 6)}`,
      type,
      options.status ?? "verified",
      type === "phone" ? `+569${Math.floor(Math.random() * 1e8)}` : null,
    ],
  );
  return rows[0].id;
}

/** Una cuenta con un factor TOTP verificado y un juego de 10 códigos puesto por `replace`. */
async function withSet(client: Client) {
  const user = await createUser(client);
  const factorId = await addFactor(client, user.id);
  const codeHashes = hashes();
  const result = await replace(client, user.id, factorId, codeHashes);
  expect(result.result).toBe("ok");
  return { user, factorId, codeHashes, setId: result.set_id as string };
}

type Json = Record<string, unknown>;
const call = async (client: Client, sql: string, params: unknown[]): Promise<Json> =>
  (await client.query<{ r: Json }>(sql, params)).rows[0].r;
const replace = (client: Client, user: string | null, factor: string | null, list: unknown) =>
  call(client, "select public.mfa_recovery_codes_replace($1, $2, $3::text[]) as r", [
    user,
    factor,
    list,
  ]);
const claim = (client: Client, user: string | null, hash: string | null) =>
  call(client, "select public.mfa_recovery_code_claim($1, $2) as r", [user, hash]);
const complete = (client: Client, codeId: string | null) =>
  call(client, "select public.mfa_recovery_code_complete($1) as r", [codeId]);
const status = (client: Client, user: string | null) =>
  call(client, "select public.mfa_recovery_codes_status($1) as r", [user]);
const release = async (client: Client, codeId: string | null) =>
  (await client.query<{ r: boolean }>("select public.mfa_recovery_code_release($1) as r", [codeId]))
    .rows[0].r;
const acknowledge = async (client: Client, user: string | null, set: string | null) =>
  (
    await client.query<{ r: boolean }>(
      "select public.mfa_recovery_codes_acknowledge($1, $2) as r",
      [user, set],
    )
  ).rows[0].r;
const revoke = async (client: Client, user: string | null) =>
  Number(
    (await client.query<{ r: number }>("select public.mfa_recovery_codes_revoke($1) as r", [user]))
      .rows[0].r,
  );
const countFor = async (client: Client, user: string) =>
  Number(
    (
      await client.query<{ n: string }>(
        "select count(*) as n from public.mfa_recovery_codes where user_id = $1",
        [user],
      )
    ).rows[0].n,
  );
const rowOf = async (client: Client, userId: string, hash: string) =>
  (
    await client.query<{
      id: string;
      used_at: string | null;
      claimed_until: string | null;
      acknowledged_at: string | null;
    }>(
      "select id, used_at, claimed_until, acknowledged_at from public.mfa_recovery_codes where user_id = $1 and code_hash = $2",
      [userId, hash],
    )
  ).rows[0];

describe("mfa_recovery_codes_replace", () => {
  it("RP1 · sin factor, con un factor sin verificar, de otro tipo o de OTRA cuenta responde `no_factor` y no guarda nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const mine = await createUser(db);
      const other = await createUser(db);
      const otherFactor = await addFactor(db, other.id);
      const results = [
        await replace(db, mine.id, randomUUID(), hashes()),
        await replace(
          db,
          mine.id,
          await addFactor(db, mine.id, { status: "unverified" }),
          hashes(),
        ),
        await replace(db, mine.id, await addFactor(db, mine.id, { type: "phone" }), hashes()),
        await replace(db, mine.id, otherFactor, hashes()),
      ];
      for (const result of results) expect(result).toEqual({ result: "no_factor" });
      expect(await countFor(db, mine.id)).toBe(0);
      expect(await countFor(db, other.id)).toBe(0);
    }));

  it("RP2 · exige exactamente 10 huellas distintas con la forma correcta (si no, CP422) y argumentos no nulos", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const factor = await addFactor(db, user.id);
      const ten = hashes();
      const bad: [string, string | null, string | null, unknown][] = [
        ["9 huellas", user.id, factor, hashes(9)],
        ["11 huellas", user.id, factor, hashes(11)],
        ["vacío", user.id, factor, []],
        ["repetidas", user.id, factor, [...ten.slice(0, 9), ten[0]]],
        ["mayúsculas", user.id, factor, [...ten.slice(0, 9), "A".repeat(64)]],
        ["corta", user.id, factor, [...ten.slice(0, 9), "a".repeat(63)]],
        ["no hexadecimal", user.id, factor, [...ten.slice(0, 9), "g".repeat(64)]],
        ["con un nulo", user.id, factor, [...ten.slice(0, 9), null]],
        ["lista nula", user.id, factor, null],
        ["cuenta nula", null, factor, ten],
        ["factor nulo", user.id, null, ten],
      ];
      for (const [label, u, f, list] of bad) {
        const error = await expectSqlError(
          db,
          "select public.mfa_recovery_codes_replace($1, $2, $3::text[])",
          [u, f, list],
        );
        expect(error.code, label).toBe("CP422");
      }
      expect(await countFor(db, user.id)).toBe(0);
    }));

  it("RP3 · guarda las 10 huellas con el tenant de la plataforma, un solo juego y sin tocar a otras cuentas; reemplaza el anterior", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const first = await withSet(db);
      const bystander = await withSet(db);
      const list = hashes();
      const second = await replace(db, first.user.id, first.factorId, list);
      expect(second).toMatchObject({ result: "ok", total: 10 });
      expect(second.set_id).not.toBe(first.setId);
      const rows = await db.query<{
        tenant_id: string;
        set_id: string;
        factor_id: string;
        code_hash: string;
        used_at: string | null;
        claimed_until: string | null;
        acknowledged_at: string | null;
      }>(
        "select tenant_id, set_id, factor_id, code_hash, used_at, claimed_until, acknowledged_at from public.mfa_recovery_codes where user_id = $1",
        [first.user.id],
      );
      expect(rows.rows.length).toBe(10);
      expect(rows.rows.map((row) => row.code_hash).sort()).toEqual([...list].sort());
      for (const row of rows.rows) {
        expect(row).toMatchObject({
          tenant_id: PLATFORM,
          set_id: second.set_id,
          factor_id: first.factorId,
          used_at: null,
          claimed_until: null,
          acknowledged_at: null,
        });
      }
      // Los códigos del juego anterior ya no sirven; los de otra cuenta siguen igual.
      expect(await claim(db, first.user.id, first.codeHashes[0])).toEqual({ result: "invalid" });
      expect(await countFor(db, bystander.user.id)).toBe(10);
      expect((await claim(db, bystander.user.id, bystander.codeHashes[0])).result).toBe("ok");
    }));

  it("RP4 · con un código tomado ahora mismo responde `busy` y no cambia nada; pasado el plazo, reemplaza", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const set = await withSet(db);
      const taken = await claim(db, set.user.id, set.codeHashes[3]);
      expect(taken.result).toBe("ok");
      expect(await replace(db, set.user.id, set.factorId, hashes())).toEqual({ result: "busy" });
      expect((await status(db, set.user.id)).set_id).toBe(set.setId);
      await db.query(
        "update public.mfa_recovery_codes set claimed_until = now() - interval '1 second' where id = $1",
        [taken.code_id],
      );
      expect((await replace(db, set.user.id, set.factorId, hashes())).result).toBe("ok");
    }));

  it("RP5 · dos `replace` a la vez de la misma cuenta dejan UN solo juego de 10", async () => {
    const account = await newMfaAccount();
    committedUsers.push(account.id);
    const { factorId } = await enrollAndVerifyWithPermit(db, await signIn(account.email));
    const other = await connect();
    try {
      const [first, second] = await Promise.all([
        replace(db, account.id, factorId, hashes()),
        replace(other, account.id, factorId, hashes()),
      ]);
      expect([first.result, second.result]).toEqual(["ok", "ok"]);
      const sets = await db.query<{ n: string }>(
        "select count(distinct set_id) as n from public.mfa_recovery_codes where user_id = $1",
        [account.id],
      );
      expect(Number(sets.rows[0].n)).toBe(1);
      expect(await countFor(db, account.id)).toBe(10);
    } finally {
      await other.end();
    }
  });
});

describe("mfa_recovery_code_claim", () => {
  it("CL1 · un código válido se toma por 2 minutos y la respuesta trae el id del código y el del factor, nada más", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const set = await withSet(db);
      const got = await claim(db, set.user.id, set.codeHashes[0]);
      const row = await rowOf(db, set.user.id, set.codeHashes[0]);
      expect(got).toEqual({ result: "ok", code_id: row.id, factor_id: set.factorId });
      const secs = await db.query<{ secs: number }>(
        "select extract(epoch from (claimed_until - now()))::int as secs from public.mfa_recovery_codes where id = $1",
        [row.id],
      );
      expect(secs.rows[0].secs).toBeGreaterThan(110);
      expect(secs.rows[0].secs).toBeLessThanOrEqual(120);
      // Los demás códigos del juego no se tocaron.
      const taken = await db.query<{ n: string }>(
        "select count(*) as n from public.mfa_recovery_codes where user_id = $1 and claimed_until is not null",
        [set.user.id],
      );
      expect(Number(taken.rows[0].n)).toBe(1);
    }));

  it("CL2 · huella inexistente, de otra cuenta, sin forma, código usado o tomado, cuenta sin códigos o argumentos nulos: TODOS dan exactamente lo mismo", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const mine = await withSet(db);
      const theirs = await withSet(db);
      const noCodes = await createUser(db);
      const results: unknown[] = [];
      results.push(await claim(db, mine.user.id, hex()));
      // El código de A buscado por la cuenta B (y al revés): la búsqueda filtra por cuenta.
      results.push(await claim(db, theirs.user.id, mine.codeHashes[0]));
      results.push(await claim(db, mine.user.id, theirs.codeHashes[0]));
      results.push(await claim(db, noCodes.id, mine.codeHashes[0]));
      results.push(await claim(db, randomUUID(), mine.codeHashes[0]));
      for (const garbage of [
        null,
        "",
        "abc",
        "g".repeat(64),
        "A".repeat(64),
        "a".repeat(63),
        "a".repeat(65),
      ]) {
        results.push(await claim(db, mine.user.id, garbage));
      }
      results.push(await claim(db, null, mine.codeHashes[0]));
      // Tomado y vuelto a pedir.
      expect((await claim(db, mine.user.id, mine.codeHashes[1])).result).toBe("ok");
      results.push(await claim(db, mine.user.id, mine.codeHashes[1]));
      // Usado.
      const used = await claim(db, theirs.user.id, theirs.codeHashes[2]);
      expect((await complete(db, used.code_id as string)).result).toBe("ok");
      results.push(await claim(db, theirs.user.id, theirs.codeHashes[2]));
      expect(results.length).toBeGreaterThan(14);
      for (const result of results) expect(result).toEqual({ result: "invalid" });
      // El juego de A quedó intacto: el intento de B no marcó nada en él.
      expect((await rowOf(db, mine.user.id, mine.codeHashes[0])).claimed_until).toBeNull();
    }));

  it("CL3 · un código cuyo plazo de 2 minutos ya pasó se puede tomar de nuevo", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const set = await withSet(db);
      const first = await claim(db, set.user.id, set.codeHashes[0]);
      await db.query(
        "update public.mfa_recovery_codes set claimed_until = now() - interval '1 second' where id = $1",
        [first.code_id],
      );
      expect(await claim(db, set.user.id, set.codeHashes[0])).toMatchObject({
        result: "ok",
        code_id: first.code_id,
      });
    }));

  it("CL4 · si el factor al que respalda se borró (por la API de Supabase, aal2), el código responde `invalid` y el estado queda en cero", async () => {
    const account = await newMfaAccount();
    committedUsers.push(account.id);
    const enrolled = await enrollAndVerifyWithPermit(db, await signIn(account.email));
    const list = hashes();
    expect((await replace(db, account.id, enrolled.factorId, list)).result).toBe("ok");
    expect((await status(db, account.id)).total).toBe(10);
    const removed = await gotrue(enrolled.aal2, "DELETE", `factors/${enrolled.factorId}`);
    expect(removed.status).toBe(200);
    expect(await claim(db, account.id, list[0])).toEqual({ result: "invalid" });
    expect(await status(db, account.id)).toEqual({ total: 0 });
    // Un `replace` con ese factor ya no se acepta.
    expect(await replace(db, account.id, enrolled.factorId, hashes())).toEqual({
      result: "no_factor",
    });
  });

  it("CL5 · dos tomas del mismo código a la vez (dos conexiones): gana UNA", async () => {
    const account = await newMfaAccount();
    committedUsers.push(account.id);
    const { factorId } = await enrollAndVerifyWithPermit(db, await signIn(account.email));
    const list = hashes();
    expect((await replace(db, account.id, factorId, list)).result).toBe("ok");
    const other = await connect();
    try {
      for (const target of [list[0], list[1]]) {
        const [first, second] = await Promise.all([
          claim(db, account.id, target),
          claim(other, account.id, target),
        ]);
        expect([first.result, second.result].sort()).toEqual(["invalid", "ok"]);
      }
    } finally {
      await other.end();
    }
  });
});

describe("mfa_recovery_code_complete y mfa_recovery_code_release", () => {
  it("CM1 · completar marca el código como usado, BORRA los demás de la cuenta, devuelve el correo de auth.users y no toca a otras cuentas", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const set = await withSet(db);
      const bystander = await withSet(db);
      const taken = await claim(db, set.user.id, set.codeHashes[4]);
      const done = await complete(db, taken.code_id as string);
      expect(done).toEqual({ result: "ok", email: set.user.email });
      const left = await db.query<{
        code_hash: string;
        used_at: string | null;
        claimed_until: string | null;
      }>(
        "select code_hash, used_at, claimed_until from public.mfa_recovery_codes where user_id = $1",
        [set.user.id],
      );
      expect(left.rows.length).toBe(1);
      expect(left.rows[0].code_hash).toBe(set.codeHashes[4]);
      expect(left.rows[0].used_at).not.toBeNull();
      expect(left.rows[0].claimed_until).toBeNull();
      expect(await countFor(db, bystander.user.id)).toBe(10);
      // Ya no sirve el mismo ni ningún otro del juego; completar otra vez no hace nada.
      for (const hash of set.codeHashes)
        expect(await claim(db, set.user.id, hash)).toEqual({ result: "invalid" });
      expect(await complete(db, taken.code_id as string)).toEqual({ result: "invalid" });
    }));

  it("CM2 · completar un código que no se tomó, que no existe, cuyo plazo venció o que ya se usó responde `invalid` y no borra nada; un argumento nulo da CP422", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const set = await withSet(db);
      const row = await rowOf(db, set.user.id, set.codeHashes[0]);
      expect(await complete(db, row.id)).toEqual({ result: "invalid" });
      expect(await complete(db, randomUUID())).toEqual({ result: "invalid" });
      const taken = await claim(db, set.user.id, set.codeHashes[0]);
      await db.query(
        "update public.mfa_recovery_codes set claimed_until = now() - interval '1 second' where id = $1",
        [taken.code_id],
      );
      expect(await complete(db, taken.code_id as string)).toEqual({ result: "invalid" });
      expect(await countFor(db, set.user.id)).toBe(10);
      expect(
        (await expectSqlError(db, "select public.mfa_recovery_code_complete(null)")).code,
      ).toBe("CP422");
    }));

  it("CM3 · soltar deja el código tomado disponible; uno ya usado o inexistente no se suelta; un argumento nulo da CP422", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const set = await withSet(db);
      const taken = await claim(db, set.user.id, set.codeHashes[0]);
      expect((await claim(db, set.user.id, set.codeHashes[0])).result).toBe("invalid");
      expect(await release(db, taken.code_id as string)).toBe(true);
      const again = await claim(db, set.user.id, set.codeHashes[0]);
      expect(again).toMatchObject({ result: "ok", code_id: taken.code_id });
      await complete(db, taken.code_id as string);
      expect(await release(db, taken.code_id as string)).toBe(false);
      expect(await release(db, randomUUID())).toBe(false);
      expect((await expectSqlError(db, "select public.mfa_recovery_code_release(null)")).code).toBe(
        "CP422",
      );
    }));
});

describe("mfa_recovery_codes_acknowledge, status y revoke", () => {
  it("AC1 · marca el juego vigente de ESA cuenta como guardado (repetirlo no lo cambia); un juego viejo, uno ajeno o argumentos nulos responden false o CP422", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const set = await withSet(db);
      const other = await withSet(db);
      expect(await acknowledge(db, set.user.id, randomUUID())).toBe(false);
      // El juego de otra cuenta no se marca desde esta.
      expect(await acknowledge(db, set.user.id, other.setId)).toBe(false);
      expect(await acknowledge(db, other.user.id, set.setId)).toBe(false);
      expect((await rowOf(db, set.user.id, set.codeHashes[0])).acknowledged_at).toBeNull();
      expect(await acknowledge(db, set.user.id, set.setId)).toBe(true);
      const firstMark = (await rowOf(db, set.user.id, set.codeHashes[0])).acknowledged_at;
      expect(firstMark).not.toBeNull();
      expect(await acknowledge(db, set.user.id, set.setId)).toBe(true);
      expect((await rowOf(db, set.user.id, set.codeHashes[0])).acknowledged_at).toEqual(firstMark);
      expect((await rowOf(db, other.user.id, other.codeHashes[0])).acknowledged_at).toBeNull();
      // Con un juego nuevo, el id del viejo ya no sirve.
      const fresh = await replace(db, set.user.id, set.factorId, hashes());
      expect(await acknowledge(db, set.user.id, set.setId)).toBe(false);
      expect(await acknowledge(db, set.user.id, fresh.set_id as string)).toBe(true);
      for (const [u, s] of [
        [null, set.setId],
        [set.user.id, null],
      ] as const) {
        const error = await expectSqlError(
          db,
          "select public.mfa_recovery_codes_acknowledge($1, $2)",
          [u, s],
        );
        expect(error.code).toBe("CP422");
      }
    }));

  it("ST1 · sin juego responde exactamente {total: 0}; con juego, total, guardado, id y fecha; un código tomado sigue contando; completar borra el juego", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const none = await createUser(db);
      expect(await status(db, none.id)).toEqual({ total: 0 });
      expect(await status(db, randomUUID())).toEqual({ total: 0 });
      const set = await withSet(db);
      const before = await status(db, set.user.id);
      expect(before).toMatchObject({ total: 10, acknowledged: false, set_id: set.setId });
      expect(typeof before.created_at).toBe("string");
      await acknowledge(db, set.user.id, set.setId);
      expect((await status(db, set.user.id)).acknowledged).toBe(true);
      const taken = await claim(db, set.user.id, set.codeHashes[0]);
      expect((await status(db, set.user.id)).total).toBe(10);
      await complete(db, taken.code_id as string);
      expect(await status(db, set.user.id)).toEqual({ total: 0 });
      expect((await expectSqlError(db, "select public.mfa_recovery_codes_status(null)")).code).toBe(
        "CP422",
      );
    }));

  it("ST2 · si el factor del juego se borró, el estado responde {total: 0}", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const set = await withSet(db);
      await db.query("delete from auth.mfa_factors where id = $1", [set.factorId]);
      expect(await status(db, set.user.id)).toEqual({ total: 0 });
    }));

  it("RV1 · revoke borra solo los códigos de esa cuenta y devuelve cuántos; sin códigos devuelve 0; un argumento nulo da CP422", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const set = await withSet(db);
      const other = await withSet(db);
      expect(await revoke(db, set.user.id)).toBe(10);
      expect(await countFor(db, set.user.id)).toBe(0);
      expect(await countFor(db, other.user.id)).toBe(10);
      expect(await revoke(db, set.user.id)).toBe(0);
      expect(await revoke(db, randomUUID())).toBe(0);
      expect((await expectSqlError(db, "select public.mfa_recovery_codes_revoke(null)")).code).toBe(
        "CP422",
      );
    }));
});

describe("limpieza y retención", () => {
  const age = (id: string, field: "created_at" | "used_at", interval: string) =>
    db.query(
      `update public.mfa_recovery_codes set ${field} = now() - $2::interval where user_id = $1`,
      [id, interval],
    );
  const sweepers: [string, (user: TestUser) => Promise<unknown>][] = [
    ["replace", async (u) => replace(db, u.id, await addFactor(db, u.id), hashes())],
    ["claim", (u) => claim(db, u.id, hex())],
    ["status", (u) => status(db, u.id)],
  ];

  for (const [name, sweep] of sweepers) {
    it(`LP · ${name} borra los juegos sin factor de más de 1 día y los códigos usados hace más de 30 días; conserva el resto`, () =>
      withTx(db, async () => {
        await actAsPostgres(db);
        const caller = await createUser(db);
        // Sin factor y de más de 1 día: se borra. Sin factor pero de hoy: se conserva (puede ser una caída entre pasos).
        const staleOld = await withSet(db);
        await db.query("delete from auth.mfa_factors where id = $1", [staleOld.factorId]);
        await age(staleOld.user.id, "created_at", "2 days");
        const staleFresh = await withSet(db);
        await db.query("delete from auth.mfa_factors where id = $1", [staleFresh.factorId]);
        // Con factor vivo y de más de 1 día: se conserva.
        const alive = await withSet(db);
        await age(alive.user.id, "created_at", "40 days");
        // Un usado hace 31 días se borra; uno usado hace 10 días se conserva.
        const usedOld = await withSet(db);
        const usedYoung = await withSet(db);
        for (const [who, interval] of [
          [usedOld, "31 days"],
          [usedYoung, "10 days"],
        ] as const) {
          const taken = await claim(db, who.user.id, who.codeHashes[0]);
          await complete(db, taken.code_id as string);
          await age(who.user.id, "used_at", interval);
        }
        await sweep(caller);
        expect(await countFor(db, staleOld.user.id)).toBe(0);
        expect(await countFor(db, staleFresh.user.id)).toBe(10);
        expect(await countFor(db, alive.user.id)).toBe(10);
        expect(await countFor(db, usedOld.user.id)).toBe(0);
        expect(await countFor(db, usedYoung.user.id)).toBe(1);
      }));
  }
});

describe("la tabla y los permisos", () => {
  it("TB1 · borrar la cuenta borra sus códigos en cascada; el tenant_id por defecto es el de la plataforma y no se puede cambiar ni forzar a otro", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const set = await withSet(db);
      const tenant = await createTenantAs(db, await createUser(db), "76086428-5", "Ajena");
      const row = await rowOf(db, set.user.id, set.codeHashes[0]);
      const t = await db.query<{ tenant_id: string }>(
        "select tenant_id from public.mfa_recovery_codes where id = $1",
        [row.id],
      );
      expect(t.rows[0].tenant_id).toBe(PLATFORM);
      expect(
        (
          await expectSqlError(
            db,
            "update public.mfa_recovery_codes set tenant_id = $2 where id = $1",
            [row.id, tenant],
          )
        ).message,
      ).toMatch(/./);
      expect(
        (
          await expectSqlError(
            db,
            `insert into public.mfa_recovery_codes (tenant_id, user_id, set_id, factor_id, code_hash)
             values ($1, $2, gen_random_uuid(), gen_random_uuid(), $3)`,
            [tenant, set.user.id, hex()],
          )
        ).code,
      ).toBe("23514");
      expect(
        (
          await expectSqlError(
            db,
            `insert into public.mfa_recovery_codes (user_id, set_id, factor_id, code_hash)
             values ($1, gen_random_uuid(), gen_random_uuid(), 'no-es-una-huella')`,
            [set.user.id],
          )
        ).code,
      ).toBe("23514");
      expect(
        (
          await expectSqlError(
            db,
            `insert into public.mfa_recovery_codes (user_id, set_id, factor_id, code_hash)
             values ($1, gen_random_uuid(), gen_random_uuid(), $2)`,
            [set.user.id, set.codeHashes[0]],
          )
        ).code,
      ).toBe("23505");
      await db.query("delete from auth.users where id = $1", [set.user.id]);
      expect(await countFor(db, set.user.id)).toBe(0);
    }));

  it("TB2 · las siete funciones son `security definer` con `search_path` vacío, no usan la sesión y solo `service_role` las ejecuta; la tabla tiene RLS y solo `service_role` la toca", async () => {
    const functions = [
      "public.mfa_recovery_codes_replace(uuid, uuid, text[])",
      "public.mfa_recovery_code_claim(uuid, text)",
      "public.mfa_recovery_code_complete(uuid)",
      "public.mfa_recovery_code_release(uuid)",
      "public.mfa_recovery_codes_acknowledge(uuid, uuid)",
      "public.mfa_recovery_codes_status(uuid)",
      "public.mfa_recovery_codes_revoke(uuid)",
    ];
    for (const fn of functions) {
      const { rows } = await db.query<{
        secdef: boolean;
        config: string[] | null;
        src: string;
        anon: boolean;
        auth: boolean;
        service: boolean;
      }>(
        `select p.prosecdef as secdef, p.proconfig as config, p.prosrc as src,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as service
           from pg_proc p where p.oid = to_regprocedure($1)`,
        [fn],
      );
      expect(rows[0].secdef, fn).toBe(true);
      expect(rows[0].config, fn).toEqual(['search_path=""']);
      expect(rows[0].src, fn).not.toMatch(
        /auth\.uid\(|auth\.jwt\(|auth\.email\(|current_setting\('request/,
      );
      expect({ anon: rows[0].anon, auth: rows[0].auth, service: rows[0].service }, fn).toEqual({
        anon: false,
        auth: false,
        service: true,
      });
    }
    const table = await db.query<{ rls: boolean; anon: boolean; auth: boolean; service: boolean }>(
      `select c.relrowsecurity as rls,
              has_table_privilege('anon', c.oid, 'select, insert, update, delete') as anon,
              has_table_privilege('authenticated', c.oid, 'select, insert, update, delete') as auth,
              has_table_privilege('service_role', c.oid, 'select, insert, update, delete') as service
         from pg_class c where c.oid = 'public.mfa_recovery_codes'::regclass`,
    );
    expect(table.rows[0]).toEqual({ rls: true, anon: false, auth: false, service: true });
  });

  it("TB3 · desde la base: `anon` y `authenticated` no leen, escriben ni ejecutan nada de esto (42501)", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const attacks = [
        "select * from public.mfa_recovery_codes",
        "insert into public.mfa_recovery_codes (user_id, set_id, factor_id, code_hash) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), repeat('a', 64))",
        "update public.mfa_recovery_codes set used_at = now()",
        "delete from public.mfa_recovery_codes",
        "select public.mfa_recovery_codes_status(gen_random_uuid())",
        "select public.mfa_recovery_codes_revoke(gen_random_uuid())",
        "select public.mfa_recovery_code_claim(gen_random_uuid(), repeat('a', 64))",
        "select public.mfa_recovery_code_complete(gen_random_uuid())",
        "select public.mfa_recovery_code_release(gen_random_uuid())",
        "select public.mfa_recovery_codes_acknowledge(gen_random_uuid(), gen_random_uuid())",
        "select public.mfa_recovery_codes_replace(gen_random_uuid(), gen_random_uuid(), array[]::text[])",
      ];
      for (const who of ["anon", "authenticated"] as const) {
        if (who === "anon") await actAsAnon(db);
        else await actAs(db, user);
        for (const sql of attacks) {
          expect((await expectSqlError(db, sql)).code, `${who}: ${sql}`).toBe("42501");
        }
      }
    }));

  it("TB4 · por la API: sin sesión, con pase de solo contraseña (aal1) y con pase completo (aal2) ni se lee ni se escribe la tabla ni se llaman las siete funciones", async () => {
    const partialAccount = await newMfaAccount();
    const fullAccount = await newMfaAccount();
    committedUsers.push(partialAccount.id, fullAccount.id);
    const partial = await signIn(partialAccount.email);
    const full = await enrollAndVerifyWithPermit(db, await signIn(fullAccount.email));
    expect((await replace(db, fullAccount.id, full.factorId, hashes())).result).toBe("ok");
    const args: Record<string, object> = {
      mfa_recovery_codes_replace: {
        p_user_id: fullAccount.id,
        p_factor_id: full.factorId,
        p_code_hashes: hashes(),
      },
      mfa_recovery_code_claim: { p_user_id: fullAccount.id, p_code_hash: hex() },
      mfa_recovery_code_complete: { p_code_id: randomUUID() },
      mfa_recovery_code_release: { p_code_id: randomUUID() },
      mfa_recovery_codes_acknowledge: { p_user_id: fullAccount.id, p_set_id: randomUUID() },
      mfa_recovery_codes_status: { p_user_id: fullAccount.id },
      mfa_recovery_codes_revoke: { p_user_id: fullAccount.id },
    };
    for (const [who, token] of [
      ["sin sesión", null],
      ["solo contraseña", partial.accessToken],
      ["pase completo", full.aal2],
    ] as const) {
      for (const [name, body] of Object.entries(args)) {
        const res = await rpc(token, name, body);
        expect([401, 403], `${who} llama ${name}: ${res.text}`).toContain(res.status);
      }
      const attempts: [string, string, unknown?][] = [
        ["GET", "mfa_recovery_codes?select=*"],
        [
          "POST",
          "mfa_recovery_codes",
          {
            user_id: fullAccount.id,
            set_id: randomUUID(),
            factor_id: randomUUID(),
            code_hash: hex(),
          },
        ],
        ["PATCH", "mfa_recovery_codes?user_id=eq." + fullAccount.id, { used_at: new Date() }],
        ["DELETE", "mfa_recovery_codes?user_id=eq." + fullAccount.id],
      ];
      for (const [method, path, body] of attempts) {
        const res = await rest(token, path, { method, body });
        expect([401, 403], `${who} ${method} ${path}: ${res.text}`).toContain(res.status);
      }
    }
    // Nada de lo anterior tocó el juego de la cuenta con pase completo.
    expect(await countFor(db, fullAccount.id)).toBe(10);
    expect((await gotrue(full.aal2, "GET", "user")).status).toBe(200);
  });
});
