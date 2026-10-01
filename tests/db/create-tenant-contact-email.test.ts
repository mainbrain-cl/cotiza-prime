// create_tenant valida el formato del correo de contacto también en la base (no solo en la pantalla).
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAs, actAsPostgres, connect, createUser, expectSqlError, withTx } from "./helpers";

const INVALID_PARAMETER = "22023";
const FICTIONAL_RUT = "76086428-5";

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

describe("create_tenant: correo de contacto", () => {
  it.each(["sin-arroba", "a@b", "a b@c.cl", "@c.cl", "a@.cl"])("rechaza %s", (email) =>
    withTx(db, async () => {
      const user = await createUser(db);
      await actAs(db, user);
      const err = await expectSqlError(
        db,
        "select public.create_tenant('Mi Negocio', $1, 'services', $2)",
        [FICTIONAL_RUT, email],
      );
      expect(err.code).toBe(INVALID_PARAMETER);
    }),
  );

  it("acepta un correo válido y también la ausencia de correo", () =>
    withTx(db, async () => {
      const user = await createUser(db);
      await actAs(db, user);
      const { rows } = await db.query<{ id: string }>(
        "select public.create_tenant('Mi Negocio', $1, 'services', $2) as id",
        [FICTIONAL_RUT, "contacto@ejemplo.test"],
      );
      expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
      await actAsPostgres(db);

      const other = await createUser(db);
      await actAs(db, other);
      const { rows: second } = await db.query<{ id: string }>(
        "select public.create_tenant('Otro Negocio', $1, 'services') as id",
        ["96511460-2"],
      );
      expect(second[0].id).toMatch(/^[0-9a-f-]{36}$/);
    }));
});
