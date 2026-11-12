// 🟢 PRUEBAS · Supabase local, datos ficticios.
// H-118a · PASO 0: cómo se comporta Supabase Auth (GoTrue) con el disparador de la migración 20261113100000, que exige un
// «permiso» de NUESTRO servidor para que un factor pase a «verificado». El diseño de H-118 se apoya en esto; si una
// actualización de Supabase cambia alguno de estos comportamientos, estas pruebas avisan antes que las pantallas.
//
// Lo que quedó fijado (Supabase local, GoTrue de la CLI vigente):
//   1. Sin permiso, GoTrue responde 500 `unexpected_failure` (sin detalle), el factor queda SIN verificar y no se cierra
//      ninguna sesión (la que verificó y las demás siguen sirviendo).
//   2. El rol que aplica las migraciones (`postgres`) puede crear el disparador sobre `auth.mfa_factors` (tiene el permiso
//      TRIGGER, aunque la tabla es de `supabase_auth_admin`). EN UN PROYECTO ALOJADO hay que comprobarlo aparte.
//   3. El disparador solo actúa en la transición a «verificado»: GoTrue actualiza la fila en cada desafío y los ingresos con
//      un factor ya verificado no se ven afectados.
//   4. `DELETE /auth/v1/admin/users/{id}/factors/{factorId}` con la llave maestra borra un factor VERIFICADO (sirve para
//      revertir una activación) y no toca las sesiones.
//   5. La forma del rechazo: status 500, `error_code: "unexpected_failure"`; la aplicación lo ve como un error desconocido.
//
// Solo cuentas nuevas `@ejemplo.test` creadas aquí.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshTotp } from "../../src/test/totp";
import { localEnv } from "../support/local-supabase";
import {
  challengeAndVerifyRaw,
  claimsOf,
  enrollAndVerifyWithPermit,
  gotrue,
  grantEnrollmentPermit,
  newMfaAccount,
  signIn,
  startEnrollment,
} from "../support/mfa-gate";
import { connect } from "./helpers";

vi.setConfig({ testTimeout: 90_000 });

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

const statusOf = async (factorId: string) =>
  (
    await db.query<{ status: string }>(
      "select status::text as status from auth.mfa_factors where id = $1",
      [factorId],
    )
  ).rows[0]?.status;
const sessionCount = async (userId: string) =>
  Number(
    (
      await db.query<{ n: string }>("select count(*) as n from auth.sessions where user_id = $1", [
        userId,
      ])
    ).rows[0].n,
  );

describe("Supabase Auth con el disparador de la activación (paso 0 de H-118)", () => {
  it("(1 y 5) sin permiso GoTrue responde 500 unexpected_failure, el factor queda sin verificar y no se cierra ninguna sesión", async () => {
    const account = await newMfaAccount();
    const mine = await signIn(account.email);
    const other = await signIn(account.email);
    const { factorId, secret } = await startEnrollment(mine);
    expect(await sessionCount(account.id)).toBe(2);

    const rejected = await challengeAndVerifyRaw(mine, factorId, secret);
    expect(rejected.status).toBe(500);
    expect(rejected.json?.error_code).toBe("unexpected_failure");
    expect(await statusOf(factorId)).toBe("unverified");
    // Ninguna sesión se cerró: ni la que intentó verificar ni la otra.
    expect(await sessionCount(account.id)).toBe(2);
    expect((await gotrue(mine.accessToken, "GET", "user")).status).toBe(200);
    expect((await gotrue(other.accessToken, "GET", "user")).status).toBe(200);
    // Y no quedó rastro de aviso alguno.
    const alerts = await db.query("select 1 from public.mfa_enrollment_alerts where user_id = $1", [
      account.id,
    ]);
    expect(alerts.rowCount).toBe(0);

    // Con el permiso, el MISMO factor se verifica y ahí sí se cierran las otras sesiones (comportamiento de siempre).
    expect(await grantEnrollmentPermit(db, account.id, factorId)).toBe(true);
    const accepted = await challengeAndVerifyRaw(mine, factorId, secret);
    expect(accepted.status).toBe(200);
    expect(claimsOf(accepted.json!.access_token).aal).toBe("aal2");
    expect(await statusOf(factorId)).toBe("verified");
    expect((await gotrue(other.accessToken, "GET", "user")).status).toBe(403);
  });

  it("(2) el disparador existe sobre auth.mfa_factors, está activo, es solo de actualización y dispara solo al pasar a verificado", async () => {
    const { rows } = await db.query<{ tgenabled: string; tgtype: number; def: string }>(
      `select t.tgenabled, t.tgtype, pg_get_triggerdef(t.oid) as def
         from pg_trigger t
        where t.tgrelid = 'auth.mfa_factors'::regclass and t.tgname = 'mfa_factor_verify_gate'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tgenabled).toBe("O");
    expect(rows[0].def).toMatch(/BEFORE UPDATE ON auth\.mfa_factors/);
    expect(rows[0].def).toMatch(/FOR EACH ROW/);
    expect(rows[0].def).toMatch(/new\.status = 'verified'/i);
    expect(rows[0].def).toMatch(/old\.status IS DISTINCT FROM 'verified'/i);
  });

  it("(3) con un factor ya verificado, los ingresos posteriores (desafío y código) no se ven afectados, una y otra vez", async () => {
    const account = await newMfaAccount();
    const first = await enrollAndVerifyWithPermit(db, await signIn(account.email));
    for (let round = 0; round < 2; round += 1) {
      const partial = await signIn(account.email);
      expect(claimsOf(partial.accessToken).aal).toBe("aal1");
      const challenge = await gotrue(
        partial.accessToken,
        "POST",
        `factors/${first.factorId}/challenge`,
        {},
      );
      expect(challenge.status).toBe(200);
      const { code } = await freshTotp(first.secret);
      const verified = await gotrue(
        partial.accessToken,
        "POST",
        `factors/${first.factorId}/verify`,
        {
          challenge_id: challenge.json!.id,
          code,
        },
      );
      // Puede ser 200 (código aceptado) o un rechazo por el código ya usado en este período: nunca 500 por el disparador.
      expect([200, 422]).toContain(verified.status);
      expect(verified.json?.error_code).not.toBe("unexpected_failure");
    }
    expect(await statusOf(first.factorId)).toBe("verified");
    // El aviso de la activación sigue siendo uno solo.
    const alerts = await db.query(
      "select state from public.mfa_enrollment_alerts where user_id = $1",
      [account.id],
    );
    expect(alerts.rows).toEqual([{ state: "pending" }]);
  });

  it("(4) la llave maestra borra un factor verificado por la API de administración y no toca las sesiones", async () => {
    const account = await newMfaAccount();
    const session = await signIn(account.email);
    const { factorId, aal2 } = await enrollAndVerifyWithPermit(db, session);
    const before = await sessionCount(account.id);
    const { apiUrl, secretKey } = localEnv();
    const removed = await fetch(`${apiUrl}/auth/v1/admin/users/${account.id}/factors/${factorId}`, {
      method: "DELETE",
      headers: { apikey: secretKey, authorization: `Bearer ${secretKey}` },
    });
    expect(removed.status).toBe(200);
    expect(await statusOf(factorId)).toBeUndefined();
    expect(await sessionCount(account.id)).toBe(before);
    expect((await gotrue(aal2, "GET", "user")).status).toBe(200);
  });

  it("(extra) un factor que no es TOTP no puede pasar a verificado aunque haya un «permiso» con su id", async () => {
    const account = await newMfaAccount();
    const factorId = (
      await db.query<{ id: string }>(
        `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, phone)
         values (gen_random_uuid(), $1, 'telefono', 'phone', 'unverified', now(), now(), '+56911111111') returning id`,
        [account.id],
      )
    ).rows[0].id;
    // El permiso ni siquiera se concede a un factor que no es TOTP...
    expect(await grantEnrollmentPermit(db, account.id, factorId)).toBe(false);
    // ...y aunque alguien escribiera la fila a mano, el disparador rechaza.
    await db.query(
      `insert into public.mfa_enrollment_alerts (user_id, factor_id, state, expected_until)
       values ($1, $2, 'expected', now() + interval '2 minutes')`,
      [account.id, factorId],
    );
    await expect(
      db.query("update auth.mfa_factors set status = 'verified' where id = $1", [factorId]),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await statusOf(factorId)).toBe("unverified");
  });
});
