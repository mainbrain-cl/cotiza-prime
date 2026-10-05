// Límite de intentos de ingreso (H-002): contadores en la base, solo para el servidor.
// Cada prueba corre dentro de una transacción que se deshace.
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actAs,
  actAsAnon,
  actAsPostgres,
  connect,
  createUser,
  expectSqlError,
  withTx,
} from "./helpers";

const INSUFFICIENT_PRIVILEGE = "42501";
const MAX_FAILURES = 5;
const WINDOW_SECONDS = 900;
const LOCK_SECONDS = 900;

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

const hash = () => randomBytes(32).toString("hex");

async function fail(scope: string, key: string, max = MAX_FAILURES): Promise<Date | null> {
  const { rows } = await db.query<{ r: Date | null }>(
    "select public.auth_limit_record_failure($1, $2, $3, $4, $5) as r",
    [scope, key, max, WINDOW_SECONDS, LOCK_SECONDS],
  );
  return rows[0].r;
}

async function lockedUntil(scope: string, key: string): Promise<Date | null> {
  const { rows } = await db.query<{ r: Date | null }>(
    "select public.auth_limit_locked_until($1, $2) as r",
    [scope, key],
  );
  return rows[0].r;
}

describe("auth_rate_limits", () => {
  it("bloquea al llegar al máximo de fallos, no antes", () =>
    withTx(db, async () => {
      const key = hash();
      for (let i = 1; i < MAX_FAILURES; i++) {
        expect(await fail("login_email", key)).toBeNull();
        expect(await lockedUntil("login_email", key)).toBeNull();
      }
      const until = await fail("login_email", key);
      expect(until).not.toBeNull();
      expect(until!.getTime()).toBeGreaterThan(Date.now() + (LOCK_SECONDS - 60) * 1000);
      expect(await lockedUntil("login_email", key)).not.toBeNull();
    }));

  it.each(["pdf_user", "pdf_tenant"])(
    "el alcance %s (tope de PDF) bloquea al llegar al máximo",
    (scope) =>
      withTx(db, async () => {
        const key = hash();
        for (let i = 1; i < MAX_FAILURES; i++) expect(await fail(scope, key)).toBeNull();
        expect(await fail(scope, key)).not.toBeNull();
      }),
  );

  it("un alcance desconocido sigue rechazado", () =>
    withTx(db, async () => {
      const error = await expectSqlError(
        db,
        "select public.auth_limit_record_failure('pdf_otro', 'x', 5, 60, 60)",
      );
      expect(error.code).toBe("23514");
    }));

  it("seguir fallando con la cuenta bloqueada no alarga el bloqueo", () =>
    withTx(db, async () => {
      const key = hash();
      let first: Date | null = null;
      for (let i = 0; i < MAX_FAILURES; i++) first = await fail("login_email", key);
      const again = await fail("login_email", key);
      expect(again?.getTime()).toBe(first?.getTime());
    }));

  it("un ingreso exitoso (clear) deja la cuenta en cero", () =>
    withTx(db, async () => {
      const key = hash();
      for (let i = 0; i < MAX_FAILURES; i++) await fail("login_email", key);
      await db.query("select public.auth_limit_clear('login_email', $1)", [key]);
      expect(await lockedUntil("login_email", key)).toBeNull();
      // Vuelve a tener todos sus intentos
      for (let i = 1; i < MAX_FAILURES; i++) expect(await fail("login_email", key)).toBeNull();
    }));

  it("los contadores de cuenta y de IP son independientes", () =>
    withTx(db, async () => {
      const key = hash();
      for (let i = 0; i < MAX_FAILURES; i++) await fail("login_email", key);
      expect(await lockedUntil("login_ip", key)).toBeNull();
      expect(await lockedUntil("signup_ip", key)).toBeNull();
    }));

  it("una ventana vencida reinicia la cuenta", () =>
    withTx(db, async () => {
      const key = hash();
      for (let i = 0; i < MAX_FAILURES - 1; i++) await fail("login_email", key);
      await db.query(
        "update public.auth_rate_limits set window_started_at = now() - interval '1 hour' where key_hash = $1",
        [key],
      );
      // Sin la ventana vencida este sería el quinto fallo y bloquearía
      expect(await fail("login_email", key)).toBeNull();
      const { rows } = await db.query<{ failures: number }>(
        "select failures from public.auth_rate_limits where key_hash = $1",
        [key],
      );
      expect(rows[0].failures).toBe(1);
    }));

  it("un bloqueo terminado deja intentar de nuevo", () =>
    withTx(db, async () => {
      const key = hash();
      for (let i = 0; i < MAX_FAILURES; i++) await fail("login_email", key);
      await db.query(
        "update public.auth_rate_limits set locked_until = now() - interval '1 second' where key_hash = $1",
        [key],
      );
      expect(await lockedUntil("login_email", key)).toBeNull();
      expect(await fail("login_email", key)).toBeNull();
    }));

  it("la fila queda en la organización de la plataforma y no cambia de organización", () =>
    withTx(db, async () => {
      const key = hash();
      await fail("login_ip", key, 20);
      const { rows } = await db.query<{ tenant_id: string }>(
        "select tenant_id from public.auth_rate_limits where key_hash = $1",
        [key],
      );
      expect(rows[0].tenant_id).toBe("00000000-0000-4000-8000-000000000001");
      const err = await expectSqlError(
        db,
        "update public.auth_rate_limits set tenant_id = gen_random_uuid() where key_hash = $1",
        [key],
      );
      expect(err.code).toBeDefined();
    }));

  it("no acepta una clave que no sea una huella ni un tipo desconocido", () =>
    withTx(db, async () => {
      await expectSqlError(
        db,
        "select public.auth_limit_record_failure('login_email', 'ana@x.cl', 5, 900, 900)",
      );
      await expectSqlError(db, "select public.auth_limit_record_failure('otro', $1, 5, 900, 900)", [
        hash(),
      ]);
    }));

  it("la llave maestra (service_role) puede usarla", () =>
    withTx(db, async () => {
      await db.query("set local role service_role");
      const key = hash();
      const { rows } = await db.query(
        "select public.auth_limit_record_failure('login_email', $1, 5, 900, 900) as r",
        [key],
      );
      expect(rows[0].r).toBeNull();
      await actAsPostgres(db);
    }));

  it("ninguna persona (authenticated) ni anónimo la puede leer, escribir ni llamar", () =>
    withTx(db, async () => {
      const user = await createUser(db);
      const key = hash();
      await actAs(db, user);
      for (const sql of [
        "select * from public.auth_rate_limits",
        "delete from public.auth_rate_limits",
        "select public.auth_limit_locked_until('login_email', $1)",
        "select public.auth_limit_record_failure('login_email', $1, 5, 900, 900)",
        "select public.auth_limit_clear('login_email', $1)",
      ]) {
        const err = await expectSqlError(db, sql, sql.includes("$1") ? [key] : []);
        expect(err.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
      await actAsAnon(db);
      const err = await expectSqlError(
        db,
        "select public.auth_limit_locked_until('login_email', $1)",
        [key],
      );
      expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
      await actAsPostgres(db);
    }));
});
