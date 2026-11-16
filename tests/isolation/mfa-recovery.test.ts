// H-004b etapa B · Códigos de respaldo del segundo paso: cuenta contra cuenta. El código de la cuenta A usado como si fuera de la cuenta
// B no sirve ni toca el juego de A; las siete funciones no aceptan ningún pase (solo el servidor, con la llave maestra) y la tabla no
// se lee ni se escribe con ningún pase, ni siquiera con el de una persona de una organización. Se llaman las funciones directo en la
// base (como las llama el servidor con la llave maestra). Cuentas nuevas `@ejemplo.test`, nunca las de la fixture ni las de la semilla.
//
// PENDIENTE (pasos 3 a 6 de H-004b: aún no existe el código de la aplicación que escribe la auditoría): que `session.mfa_disabled` y
// `session.mfa_recovery_used` aparezcan solo en la plataforma y en las organizaciones donde la persona está ACTIVA (no en una que dejó
// ni en una ajena), y que el registro de actividad de la organización B no muestre eventos de una persona de A.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { adminCreateUser, rest, rpc, signIn } from "../support/local-supabase";
import { enrollAndVerifyWithPermit, gotrue } from "../support/mfa-gate";
import { openDb, tokenOf } from "./context";

vi.setConfig({ testTimeout: 90_000 });

const hex = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const hashes = () => Array.from({ length: 10 }, hex);

let db: Client;
const created: string[] = [];
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  if (created.length > 0) await db.query("delete from auth.users where id = any($1)", [created]);
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

  it.todo(
    "pasos 3 a 6: `session.mfa_disabled` y `session.mfa_recovery_used` aparecen en la plataforma y solo en las organizaciones donde la persona está activa; el registro de B no muestra eventos de una persona de A",
  );
});
