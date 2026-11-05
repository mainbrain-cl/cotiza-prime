// H-011a · El «deshacer» de la migración `role_matrix` hace lo que dice: devuelve las políticas a sus listas de
// roles escritas a mano (el Administrador vuelve a leer el registro de actividad), deja `has_role` leyendo el
// rol directo y borra las funciones nuevas. Se ejecuta el archivo real dentro de una transacción que se deshace;
// el deshacer completo y en orden lo prueba `npm run test:db:rollbacks`.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TENANT_HEADER,
  actAs,
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  withTx,
} from "./helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const NAME = "20261028100000_role_matrix";
const sql = (kind: "migrations" | "rollbacks", suffix: string) =>
  readFileSync(path.join(ROOT, kind, `${NAME}${suffix}.sql`), "utf8");

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

async function functionExists(signature: string): Promise<boolean> {
  const { rows } = await db.query<{ found: boolean }>(
    "select to_regprocedure($1) is not null as found",
    [signature],
  );
  return rows[0].found;
}

/**
 * Las migraciones POSTERIORES a role_matrix que ya decidieron con `app.can(...)` (las invitaciones del sprint 5,
 * H-008, y la política `members_select` de H-010) dependen de esa función: aquí, dentro de la transacción de la prueba, se les quita esa dependencia para
 * poder deshacer SOLO role_matrix. (El deshacer completo y en orden, que primero deshace las más nuevas, lo
 * prueba `npm run test:db:rollbacks`.)
 */
async function releaseLaterMigrations(): Promise<void> {
  await db.query("drop policy invitations_select on public.invitations");
  await db.query(
    `alter policy email_messages_select on public.email_messages
       using (tenant_id = (select app.current_tenant_id()))`,
  );
  await db.query(
    `alter policy members_select on public.members
       using (user_id = (select auth.uid()) or tenant_id = (select app.current_tenant_id()))`,
  );
}

describe("el deshacer de role_matrix", () => {
  it("borra las funciones nuevas y deja las políticas con sus listas de roles", () =>
    withTx(db, async () => {
      const owner = await createUser(db);
      const admin = await createUser(db);
      const tenantId = await createTenantAs(db, owner);
      await db.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'admin')",
        [tenantId, admin.id],
      );

      // Antes: el Administrador no lee el registro de actividad.
      await actAs(db, admin, { [TENANT_HEADER]: tenantId });
      expect((await db.query("select 1 from public.audit_log")).rowCount).toBe(0);

      await actAsPostgres(db);
      await releaseLaterMigrations();
      await db.query(sql("rollbacks", ".down"));

      expect(await functionExists("app.role_can(text,text,boolean)")).toBe(false);
      expect(await functionExists("app.effective_role()")).toBe(false);
      expect(await functionExists("app.can(text,boolean)")).toBe(false);
      expect(await functionExists("app.has_role(text[])")).toBe(true);

      // Después: has_role sigue funcionando y el Administrador vuelve a leer el registro.
      await actAs(db, admin, { [TENANT_HEADER]: tenantId });
      expect((await db.query("select app.has_role('admin') as ok")).rows[0].ok).toBe(true);
      expect((await db.query("select 1 from public.audit_log")).rowCount).toBeGreaterThan(0);
      expect(
        (await db.query("update public.tenants set name = 'Por el Administrador'")).rowCount,
      ).toBe(1);
    }));

  it("se puede volver a aplicar la migración después de deshacerla", () =>
    withTx(db, async () => {
      await releaseLaterMigrations();
      await db.query(sql("rollbacks", ".down"));
      await db.query(sql("migrations", ""));
      expect(await functionExists("app.role_can(text,text,boolean)")).toBe(true);
      expect(await functionExists("app.effective_role()")).toBe(true);
      expect(await functionExists("app.can(text,boolean)")).toBe(true);
      const { rows } = await db.query<{ ok: boolean }>(
        "select app.role_can('owner', 'audit.read') as ok",
      );
      expect(rows[0].ok).toBe(true);
    }));
});
