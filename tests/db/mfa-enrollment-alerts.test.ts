// 🟢 PRUEBAS · Supabase local, datos ficticios.
// H-118a · migración 20261113100000_mfa_enrollment_alerts: las tablas `mfa_enrollment_alerts` y `mfa_annul_links`, las cuatro
// funciones solo del servidor (`mfa_alert_expect`, `mfa_alerts_reserve`, `mfa_alert_settle`, `mfa_alert_revert`) y el
// disparador sobre `auth.mfa_factors` (`app.mfa_factor_verify_gate`). Lo que hace GoTrue frente al disparador está en
// `mfa-annul-gotrue.test.ts` (paso 0); aquí se prueba la base sola, con SQL, y el acceso por la API.
//
// Solo cuentas nuevas `@ejemplo.test` creadas aquí. Las pruebas que necesitan filas confirmadas (dos conexiones, o la API)
// limpian al terminar; las demás corren dentro de una transacción que se deshace.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rest, rpc, signIn } from "../support/local-supabase";
import { enrollAndVerifyWithPermit, newMfaAccount } from "../support/mfa-gate";
import {
  actAsPostgres,
  connect,
  createUser,
  expectSqlError,
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

/** Un factor TOTP sin verificar (o de otro tipo) escrito directo en `auth.mfa_factors`. */
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
      options.status ?? "unverified",
      type === "phone" ? `+569${Math.floor(Math.random() * 1e8)}` : null,
    ],
  );
  return rows[0].id;
}

const expectPermit = async (client: Client, user: string, factor: string | null) =>
  (
    await client.query<{ ok: boolean }>("select public.mfa_alert_expect($1, $2) as ok", [
      user,
      factor,
    ])
  ).rows[0].ok;
const verifyFactor = (client: Client, factorId: string) =>
  client.query("update auth.mfa_factors set status = 'verified' where id = $1", [factorId]);
const alertsOf = async (client: Client, userId: string) =>
  (
    await client.query<{
      state: string;
      attempts: number;
      error_code: string | null;
      verified_at: Date | null;
      sent_at: Date | null;
      factor_id: string;
      id: string;
    }>("select * from public.mfa_enrollment_alerts where user_id = $1 order by created_at", [
      userId,
    ])
  ).rows;

describe("el disparador de auth.mfa_factors (app.mfa_factor_verify_gate)", () => {
  it("T1 · sin permiso, un factor no pasa a verificado (42501) y queda sin verificar; no queda ningún aviso", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const factor = await addFactor(db, user.id);
      const error = await expectSqlError(
        db,
        "update auth.mfa_factors set status = 'verified' where id = $1",
        [factor],
      );
      expect(error.code).toBe("42501");
      expect(error.message).toMatch(/mfa_enrollment_not_allowed/);
      const row = await db.query("select status::text as s from auth.mfa_factors where id = $1", [
        factor,
      ]);
      expect(row.rows[0].s).toBe("unverified");
      expect(await alertsOf(db, user.id)).toEqual([]);
    }));

  it("T2 · con permiso vigente se verifica y el aviso pasa a `pending` con la hora; la fecha de verificación queda escrita", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const factor = await addFactor(db, user.id);
      expect(await expectPermit(db, user.id, factor)).toBe(true);
      await verifyFactor(db, factor);
      const [alert] = await alertsOf(db, user.id);
      expect(alert).toMatchObject({ state: "pending", factor_id: factor, attempts: 0 });
      expect(alert.verified_at).toBeInstanceOf(Date);
    }));

  it("T3 · un permiso vencido no sirve", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const factor = await addFactor(db, user.id);
      await expectPermit(db, user.id, factor);
      await db.query(
        "update public.mfa_enrollment_alerts set expected_until = now() - interval '1 second'",
      );
      const error = await expectSqlError(
        db,
        "update auth.mfa_factors set status = 'verified' where id = $1",
        [factor],
      );
      expect(error.code).toBe("42501");
      expect((await alertsOf(db, user.id))[0].state).toBe("expected");
    }));

  it("T4 · el permiso de OTRO factor de la misma cuenta, o de otra cuenta, no sirve", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const other = await createUser(db);
      const mine = await addFactor(db, user.id);
      const permitted = await addFactor(db, user.id, { type: "totp" });
      const theirs = await addFactor(db, other.id);
      expect(await expectPermit(db, user.id, permitted)).toBe(true);
      expect(await expectPermit(db, other.id, theirs)).toBe(true);
      expect(
        (
          await expectSqlError(
            db,
            "update auth.mfa_factors set status = 'verified' where id = $1",
            [mine],
          )
        ).code,
      ).toBe("42501");
      // El permiso de la otra cuenta tampoco sirve para el factor de esta (el permiso es de cuenta Y factor).
      await db.query("update public.mfa_enrollment_alerts set user_id = $1 where factor_id = $2", [
        user.id,
        theirs,
      ]);
      expect(
        (
          await expectSqlError(
            db,
            "update auth.mfa_factors set status = 'verified' where id = $1",
            [theirs],
          )
        ).code,
      ).toBe("42501");
    }));

  it("T5 · un factor que no es TOTP se rechaza aunque exista un permiso escrito a mano para su id", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const factor = await addFactor(db, user.id, { type: "phone" });
      expect(await expectPermit(db, user.id, factor)).toBe(false);
      await db.query(
        `insert into public.mfa_enrollment_alerts (user_id, factor_id, state, expected_until)
         values ($1, $2, 'expected', now() + interval '2 minutes')`,
        [user.id, factor],
      );
      expect(
        (
          await expectSqlError(
            db,
            "update auth.mfa_factors set status = 'verified' where id = $1",
            [factor],
          )
        ).code,
      ).toBe("42501");
    }));

  it("T6 · el permiso se gasta una vez: tras verificarse, volver a pasar un factor a verificado exige otro permiso (que no se concede a uno ya verificado)", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const factor = await addFactor(db, user.id);
      await expectPermit(db, user.id, factor);
      await verifyFactor(db, factor);
      // Un factor ya verificado: la base no concede un permiso nuevo para él.
      expect(await expectPermit(db, user.id, factor)).toBe(false);
      // Cambios que no son la transición a verificado no están sujetos al permiso (así GoTrue puede anotar cada desafío).
      await db.query("update auth.mfa_factors set last_challenged_at = now() where id = $1", [
        factor,
      ]);
      await db.query(
        "update auth.mfa_factors set updated_at = now(), status = 'verified' where id = $1",
        [factor],
      );
      expect((await alertsOf(db, user.id)).map((a) => a.state)).toEqual(["pending"]);
    }));

  it("T8 · cambiar el tipo en la misma sentencia no esquiva la regla: un factor que no era TOTP no pasa a verificado aunque se vuelva TOTP, ni uno TOTP si deja de serlo", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const phone = await addFactor(db, user.id, { type: "phone" });
      await db.query(
        `insert into public.mfa_enrollment_alerts (user_id, factor_id, state, expected_until)
         values ($1, $2, 'expected', now() + interval '2 minutes')`,
        [user.id, phone],
      );
      const becomesTotp = await expectSqlError(
        db,
        "update auth.mfa_factors set factor_type = 'totp', status = 'verified', phone = null where id = $1",
        [phone],
      );
      expect(becomesTotp.code).toBe("42501");
      const totp = await addFactor(db, user.id);
      expect(await expectPermit(db, user.id, totp)).toBe(true);
      const stopsBeingTotp = await expectSqlError(
        db,
        "update auth.mfa_factors set factor_type = 'phone', status = 'verified', phone = '+56922222222' where id = $1",
        [totp],
      );
      expect(stopsBeingTotp.code).toBe("42501");
      expect((await alertsOf(db, user.id)).find((a) => a.factor_id === totp)?.state).toBe(
        "expected",
      );
    }));

  it("T7 · quien ya tenía un factor verificado antes de la migración no se ve afectado (no se toca una fila ya verificada)", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const factor = await addFactor(db, user.id, { status: "verified" });
      await db.query(
        "update auth.mfa_factors set last_challenged_at = now(), updated_at = now() where id = $1",
        [factor],
      );
      await db.query("update auth.mfa_factors set friendly_name = 'renombrado' where id = $1", [
        factor,
      ]);
      expect(await alertsOf(db, user.id)).toEqual([]);
    }));
});

describe("mfa_alert_expect", () => {
  it("E1 · solo concede el permiso a un TOTP sin verificar de ESA cuenta; con datos nulos, factor ajeno, inexistente o verificado devuelve false y no crea nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const other = await createUser(db);
      const unverified = await addFactor(db, user.id);
      const verified = await addFactor(db, other.id, { status: "verified" });
      expect(await expectPermit(db, user.id, null)).toBe(false);
      expect(await expectPermit(db, null as unknown as string, unverified)).toBe(false);
      expect(await expectPermit(db, user.id, randomUUID())).toBe(false);
      expect(await expectPermit(db, other.id, unverified)).toBe(false);
      expect(await expectPermit(db, other.id, verified)).toBe(false);
      expect(await alertsOf(db, user.id)).toEqual([]);
      expect(await alertsOf(db, other.id)).toEqual([]);
      expect(await expectPermit(db, user.id, unverified)).toBe(true);
    }));

  it("E2 · pedir el permiso otra vez solo renueva el plazo (una sola fila viva); vive 2 minutos", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const factor = await addFactor(db, user.id);
      await expectPermit(db, user.id, factor);
      await db.query(
        "update public.mfa_enrollment_alerts set expected_until = now() + interval '5 seconds'",
      );
      await expectPermit(db, user.id, factor);
      const rows = await alertsOf(db, user.id);
      expect(rows).toHaveLength(1);
      const { rows: window } = await db.query<{ secs: number }>(
        "select extract(epoch from (expected_until - now()))::int as secs from public.mfa_enrollment_alerts where user_id = $1",
        [user.id],
      );
      expect(window[0].secs).toBeGreaterThan(110);
      expect(window[0].secs).toBeLessThanOrEqual(120);
    }));

  it("E3 · retención: borra los enlaces vencidos hace más de 30 días y los avisos sin enlaces de más de 30 días; un aviso viejo con un enlace reservado tarde se queda; los recientes también", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const oldFactor = await addFactor(db, user.id);
      const recentFactor = await addFactor(db, user.id);
      const insertAlert = async (factor: string, ageDays: number) =>
        (
          await db.query<{ id: string }>(
            `insert into public.mfa_enrollment_alerts (user_id, factor_id, state, expected_until, created_at)
             values ($1, $2, 'sent', now(), now() - make_interval(days => $3)) returning id`,
            [user.id, factor, ageDays],
          )
        ).rows[0].id;
      const oldAlert = await insertAlert(oldFactor, 40);
      const recentAlert = await insertAlert(recentFactor, 5);
      await db.query(
        `insert into public.mfa_annul_links (alert_id, user_id, token_sha256, expires_at) values
           ($1, $3, $4, now() - interval '31 days'), ($2, $3, $5, now() + interval '1 hour')`,
        [oldAlert, recentAlert, user.id, sha(), sha()],
      );
      // Un tercer enlace de un aviso reciente pero vencido hace 31 días.
      await db.query(
        `insert into public.mfa_annul_links (alert_id, user_id, token_sha256, expires_at) values ($1, $2, $3, now() - interval '31 days')`,
        [recentAlert, user.id, sha()],
      );
      // Un aviso de 40 días con un enlace reservado tarde, vencido hace solo 10 días: se queda con su enlace.
      const lateAlert = await insertAlert(await addFactor(db, user.id), 40);
      await db.query(
        `insert into public.mfa_annul_links (alert_id, user_id, token_sha256, expires_at) values ($1, $2, $3, now() - interval '10 days')`,
        [lateAlert, user.id, sha()],
      );
      await expectPermit(db, user.id, await addFactor(db, user.id));
      const states = (await alertsOf(db, user.id)).map((a) => a.id);
      expect(states).toContain(lateAlert);
      expect(states).toContain(recentAlert);
      expect(states).not.toContain(oldAlert);
      const links = await db.query(
        "select alert_id from public.mfa_annul_links where user_id = $1",
        [user.id],
      );
      // El enlace del aviso viejo se fue con su aviso (cascada) y el vencido hace 31 días también; queda el vigente.
      expect(links.rows.map((row: { alert_id: string }) => row.alert_id).sort()).toEqual(
        [lateAlert, recentAlert].sort(),
      );
    }));
});

/** Un aviso `pending` listo para reservar: cuenta nueva, factor TOTP ya verificado por el camino normal (con permiso). */
async function pendingAlert(client: Client): Promise<{ user: TestUser; factor: string }> {
  const user = await createUser(client);
  const factor = await addFactor(client, user.id);
  await expectPermit(client, user.id, factor);
  await verifyFactor(client, factor);
  return { user, factor };
}
const reserve = async (client: Client, userId: string, token = sha()) =>
  (
    await client.query<{ r: Record<string, unknown> }>(
      "select public.mfa_alerts_reserve($1, $2) as r",
      [userId, token],
    )
  ).rows[0].r;

describe("mfa_alerts_reserve, mfa_alert_settle y mfa_alert_revert", () => {
  it("R1 · reservar toma el aviso pendiente, gasta un intento, crea el enlace de 72 horas y devuelve el correo de auth.users; sin pendientes no hay nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const { user, factor } = await pendingAlert(db);
      const token = sha();
      const got = await reserve(db, user.id, token);
      expect(got).toMatchObject({ reserved: true, factor_id: factor, email: user.email });
      // Devuelve el id del enlace (clave anti-duplicado del correo), no su huella.
      const linkRow = await db.query<{ id: string; token_sha256: string }>(
        "select id, token_sha256 from public.mfa_annul_links where user_id = $1",
        [user.id],
      );
      expect(got.link_id).toBe(linkRow.rows[0].id);
      expect(JSON.stringify(got)).not.toContain(linkRow.rows[0].token_sha256);
      expect(typeof got.alert_id).toBe("string");
      const link = await db.query<{
        hours: number;
        token_sha256: string;
        used_at: unknown;
        tenant_id: string;
      }>(
        `select extract(epoch from (expires_at - now())) / 3600 as hours, token_sha256, used_at, tenant_id
           from public.mfa_annul_links where user_id = $1`,
        [user.id],
      );
      expect(link.rows).toHaveLength(1);
      expect(Number(link.rows[0].hours)).toBeGreaterThan(71.9);
      expect(Number(link.rows[0].hours)).toBeLessThanOrEqual(72);
      expect(link.rows[0]).toMatchObject({
        token_sha256: token,
        used_at: null,
        tenant_id: PLATFORM,
      });
      expect((await alertsOf(db, user.id))[0].attempts).toBe(1);
      // Una cuenta sin avisos pendientes: nada que reservar.
      const nobody = await createUser(db);
      expect(await reserve(db, nobody.id)).toEqual({ reserved: false });
    }));

  it("R2 · no se reserva dos veces en 20 segundos, el tope es de 5 intentos y la forma de la huella se revisa", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const { user } = await pendingAlert(db);
      expect((await reserve(db, user.id)).reserved).toBe(true);
      expect(await reserve(db, user.id)).toEqual({ reserved: false });
      for (let i = 2; i <= 5; i += 1) {
        await db.query(
          "update public.mfa_enrollment_alerts set last_attempt_at = now() - interval '1 minute'",
        );
        expect((await reserve(db, user.id)).reserved, `intento ${i}`).toBe(true);
      }
      await db.query(
        "update public.mfa_enrollment_alerts set last_attempt_at = now() - interval '1 minute'",
      );
      expect(await reserve(db, user.id)).toEqual({ reserved: false });
      expect((await alertsOf(db, user.id))[0]).toMatchObject({ attempts: 5, state: "pending" });
      for (const bad of ["", "ABC", "g".repeat(64), "A".repeat(64)]) {
        const error = await expectSqlError(db, "select public.mfa_alerts_reserve($1, $2)", [
          user.id,
          bad,
        ]);
        expect(error.code, bad).toBe("CP422");
      }
    }));

  it("R3 · si el factor ya no está verificado, el aviso se cierra sin enviar; sin correo en la cuenta se reserva con correo nulo y sin enlace", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const gone = await pendingAlert(db);
      await db.query("delete from auth.mfa_factors where id = $1", [gone.factor]);
      expect(await reserve(db, gone.user.id)).toEqual({ reserved: false });
      expect((await alertsOf(db, gone.user.id))[0]).toMatchObject({
        state: "closed",
        error_code: "factor_gone",
      });

      const mute = await pendingAlert(db);
      await db.query("update auth.users set email = null where id = $1", [mute.user.id]);
      const got = await reserve(db, mute.user.id);
      expect(got).toMatchObject({ reserved: true, email: null, expires_at: null });
      const links = await db.query("select 1 from public.mfa_annul_links where user_id = $1", [
        mute.user.id,
      ]);
      expect(links.rowCount).toBe(0);
    }));

  it("R4 · settle: con el id del proveedor el aviso queda `sent`; con un código queda con el error y `pending`; no toca avisos que ya no están pendientes; limpia códigos raros", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const { user } = await pendingAlert(db);
      const got = await reserve(db, user.id);
      const alertId = got.alert_id as string;
      const settle = async (provider: string | null, message: string | null, code: string | null) =>
        (
          await db.query<{ r: string }>("select public.mfa_alert_settle($1, $2, $3, $4) as r", [
            alertId,
            provider,
            message,
            code,
          ])
        ).rows[0].r;
      expect(await settle(null, null, "timeout")).toBe("failed");
      expect((await alertsOf(db, user.id))[0]).toMatchObject({
        state: "pending",
        error_code: "timeout",
      });
      expect(await settle(null, null, "Correo: a@b.cl")).toBe("failed");
      expect((await alertsOf(db, user.id))[0].error_code).toBe("unknown");
      expect(await settle("memory", "msg-1", null)).toBe("sent");
      expect((await alertsOf(db, user.id))[0]).toMatchObject({ state: "sent", error_code: null });
      expect((await alertsOf(db, user.id))[0].sent_at).toBeInstanceOf(Date);
      expect(await settle("memory", "msg-2", null)).toBe("unchanged");
      expect(await settle(null, null, "timeout")).toBe("unchanged");
      const error = await expectSqlError(
        db,
        "select public.mfa_alert_settle(null, null, null, null)",
      );
      expect(error.code).toBe("CP422");
    }));

  it("R5 · revert: un permiso vivo solo se cierra; un aviso pendiente queda `reverted` y sus enlaces se borran; uno enviado nunca se revierte", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const revert = async (user: string, factor: string, code = "provider_rejected") =>
        (
          await db.query<{ r: string }>("select public.mfa_alert_revert($1, $2, $3) as r", [
            user,
            factor,
            code,
          ])
        ).rows[0].r;

      const waiting = await createUser(db);
      const waitingFactor = await addFactor(db, waiting.id);
      await expectPermit(db, waiting.id, waitingFactor);
      expect(await revert(waiting.id, waitingFactor, "verify_failed")).toBe("closed");
      expect((await alertsOf(db, waiting.id))[0]).toMatchObject({
        state: "closed",
        error_code: "verify_failed",
      });
      // Con el permiso cerrado, la base rechaza verificar.
      expect(
        (
          await expectSqlError(
            db,
            "update auth.mfa_factors set status = 'verified' where id = $1",
            [waitingFactor],
          )
        ).code,
      ).toBe("42501");

      // Con `p_only_permit` (al fallar un código) un aviso pendiente NO se toca: lo devuelve como `pending`.
      const untouched = await pendingAlert(db);
      await reserve(db, untouched.user.id);
      const onlyPermit = await db.query<{ r: string }>(
        "select public.mfa_alert_revert($1, $2, 'verify_failed', true) as r",
        [untouched.user.id, untouched.factor],
      );
      expect(onlyPermit.rows[0].r).toBe("pending");
      expect((await alertsOf(db, untouched.user.id))[0].state).toBe("pending");
      expect(
        (
          await db.query("select 1 from public.mfa_annul_links where user_id = $1", [
            untouched.user.id,
          ])
        ).rowCount,
      ).toBe(1);

      const pending = await pendingAlert(db);
      await reserve(db, pending.user.id);
      expect(await revert(pending.user.id, pending.factor)).toBe("reverted");
      expect((await alertsOf(db, pending.user.id))[0]).toMatchObject({
        state: "reverted",
        error_code: "provider_rejected",
      });
      const links = await db.query("select 1 from public.mfa_annul_links where user_id = $1", [
        pending.user.id,
      ]);
      expect(links.rowCount).toBe(0);
      // Revertir otra vez no hace nada.
      expect(await revert(pending.user.id, pending.factor)).toBe("none");

      const sent = await pendingAlert(db);
      const got = await reserve(db, sent.user.id);
      await db.query("select public.mfa_alert_settle($1, 'memory', 'm', null)", [got.alert_id]);
      expect(await revert(sent.user.id, sent.factor)).toBe("none");
      expect((await alertsOf(db, sent.user.id))[0].state).toBe("sent");
      const error = await expectSqlError(db, "select public.mfa_alert_revert(null, null, null)");
      expect(error.code).toBe("CP422");
    }));
});

describe("las tablas", () => {
  it("S1 · tenant_id es el de la plataforma por defecto, no admite otro valor ni cambiarlo; los códigos de error se revisan; user_id borra en cascada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const { user } = await pendingAlert(db);
      await reserve(db, user.id);
      for (const table of ["mfa_enrollment_alerts", "mfa_annul_links"]) {
        const row = await db.query<{ tenant_id: string }>(
          `select tenant_id from public.${table} where user_id = $1`,
          [user.id],
        );
        expect(row.rows[0].tenant_id).toBe(PLATFORM);
        const change = await expectSqlError(
          db,
          `update public.${table} set tenant_id = $1 where user_id = $2`,
          [randomUUID(), user.id],
        );
        expect(["23514", "23503", "42501", "P0001"]).toContain(change.code);
      }
      const bad = await expectSqlError(
        db,
        "update public.mfa_enrollment_alerts set error_code = 'Correo a@b.cl' where user_id = $1",
        [user.id],
      );
      expect(bad.code).toBe("23514");
      const badToken = await expectSqlError(
        db,
        "update public.mfa_annul_links set token_sha256 = 'no-es-una-huella' where user_id = $1",
        [user.id],
      );
      expect(badToken.code).toBe("23514");
      await db.query("delete from auth.users where id = $1", [user.id]);
      expect(
        (await db.query("select 1 from public.mfa_enrollment_alerts where user_id = $1", [user.id]))
          .rowCount,
      ).toBe(0);
      expect(
        (await db.query("select 1 from public.mfa_annul_links where user_id = $1", [user.id]))
          .rowCount,
      ).toBe(0);
    }));

  it("S2 · el enlace es único por huella", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const { user } = await pendingAlert(db);
      const token = sha();
      await reserve(db, user.id, token);
      await db.query(
        "update public.mfa_enrollment_alerts set last_attempt_at = now() - interval '1 minute'",
      );
      const error = await expectSqlError(db, "select public.mfa_alerts_reserve($1, $2)", [
        user.id,
        token,
      ]);
      expect(error.code).toBe("23505");
    }));

  it("S3 · los dos alcances nuevos del límite de intentos se aceptan; uno desconocido sigue rechazado", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      for (const scope of ["mfa_annul_ip", "mfa_annul_token"]) {
        const key = randomBytes(32).toString("hex");
        await db.query("select public.auth_limit_record_failure($1, $2, 5, 900, 900)", [
          scope,
          key,
        ]);
        const rows = await db.query(
          "select 1 from public.auth_rate_limits where scope = $1 and key_hash = $2",
          [scope, key],
        );
        expect(rows.rowCount).toBe(1);
      }
      const unknown = await expectSqlError(
        db,
        "select public.auth_limit_record_failure('mfa_annul_otro', 'x', 5, 900, 900)",
      );
      expect(unknown.code).toBe("23514");
    }));

  it("S4 · dos reservas a la vez no toman el mismo aviso (candado con skip locked)", async () => {
    const { user } = await (async () => {
      const u = await createUser(db);
      const factor = await addFactor(db, u.id);
      await expectPermit(db, u.id, factor);
      await verifyFactor(db, factor);
      return { user: u };
    })();
    const second = await connect();
    try {
      await db.query("begin");
      const first = await reserve(db, user.id);
      expect(first.reserved).toBe(true);
      // Mientras la primera transacción tiene la fila, la segunda conexión no la ve: no hay nada que reservar.
      expect((await reserve(second, user.id)).reserved).toBe(false);
      await db.query("commit");
    } finally {
      await db.query("rollback").catch(() => undefined);
      await db.query("delete from auth.users where id = $1", [user.id]);
      await second.end();
    }
  });
});

describe("quién puede usar las tablas y las funciones", () => {
  it("A1 · ni sin sesión, ni con pase de solo contraseña, ni con pase completo se leen o escriben las tablas ni se llaman las funciones por la API", async () => {
    const withoutFactor = await newMfaAccount();
    const partial = await signIn(withoutFactor.email);
    const full = await newMfaAccount();
    const { aal2 } = await enrollAndVerifyWithPermit(db, await signIn(full.email));
    const alertId = (await alertsOf(db, full.id))[0].id;
    try {
      const calls: [string, string | null][] = [
        ["sin sesión", null],
        ["solo contraseña", partial.accessToken],
        ["pase completo", aal2],
      ];
      for (const [who, token] of calls) {
        for (const table of ["mfa_enrollment_alerts", "mfa_annul_links"]) {
          const read = await rest(token, `${table}?select=*`, {
            headers: { Prefer: "count=exact" },
          });
          expect(read.status, `${who} lee ${table}`).toBeGreaterThanOrEqual(400);
          const insert = await rest(token, table, {
            method: "POST",
            body: {
              user_id: full.id,
              factor_id: randomUUID(),
              state: "pending",
              expected_until: new Date().toISOString(),
            },
          });
          expect(insert.status, `${who} inserta en ${table}`).toBeGreaterThanOrEqual(400);
          const update = await rest(token, `${table}?user_id=eq.${full.id}`, {
            method: "PATCH",
            body: { state: "closed" },
          });
          expect(update.status, `${who} cambia ${table}`).toBeGreaterThanOrEqual(400);
          const del = await rest(token, `${table}?user_id=eq.${full.id}`, { method: "DELETE" });
          expect(del.status, `${who} borra ${table}`).toBeGreaterThanOrEqual(400);
        }
        const args: Record<string, object> = {
          mfa_alert_expect: { p_user_id: full.id, p_factor_id: randomUUID() },
          mfa_alerts_reserve: { p_user_id: full.id, p_token_sha256: sha() },
          mfa_alert_settle: {
            p_alert_id: alertId,
            p_provider: "x",
            p_provider_message_id: "y",
            p_error_code: null,
          },
          mfa_alert_revert: { p_user_id: full.id, p_factor_id: randomUUID(), p_error_code: "x" },
        };
        for (const [name, body] of Object.entries(args)) {
          const res = await rpc(token, name, body);
          expect([401, 403], `${who} llama ${name}: ${res.text}`).toContain(res.status);
        }
      }
      // Nada cambió.
      expect((await alertsOf(db, full.id)).map((a) => a.state)).toEqual(["pending"]);
    } finally {
      await db.query("delete from auth.users where id = any($1)", [[withoutFactor.id, full.id]]);
    }
  });

  it("A2 · las funciones y el disparador no son ejecutables por anon ni authenticated; las tablas no tienen permisos para ellos", async () => {
    const fns = [
      "public.mfa_alert_expect(uuid, uuid)",
      "public.mfa_alerts_reserve(uuid, text)",
      "public.mfa_alert_settle(uuid, text, text, text)",
      "public.mfa_alert_revert(uuid, uuid, text, boolean)",
      "app.mfa_factor_verify_gate()",
    ];
    for (const fn of fns) {
      const { rows } = await db.query<{ anon: boolean; auth: boolean; service: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as service`,
        [fn],
      );
      expect(rows[0].anon, fn).toBe(false);
      expect(rows[0].auth, fn).toBe(false);
      expect(rows[0].service, fn).toBe(fn.startsWith("public."));
    }
    for (const table of ["mfa_enrollment_alerts", "mfa_annul_links"]) {
      const { rows } = await db.query<{ anon: boolean; auth: boolean; service: boolean }>(
        `select has_table_privilege('anon', $1, 'select, insert, update, delete') as anon,
                has_table_privilege('authenticated', $1, 'select, insert, update, delete') as auth,
                has_table_privilege('service_role', $1, 'select, insert, update, delete') as service`,
        [`public.${table}`],
      );
      expect(rows[0], table).toEqual({ anon: false, auth: false, service: true });
    }
  });
});
