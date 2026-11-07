// H-011a · La matriz de permisos de TypeScript (`src/lib/permissions/matrix.ts`) y la de la base de datos
// (`app.role_can`, migración `role_matrix`) tienen que decir EXACTAMENTE lo mismo para cada acción, cada rol y
// cada caso de «es suyo». Si alguien cambia una y olvida la otra, esta prueba falla.
//
// Tres niveles:
//  1. la función pura `app.role_can` contra `can()` de TypeScript (todas las combinaciones);
//  2. el listado de acciones de la migración contra el de TypeScript (ni una de más ni una de menos);
//  3. una sesión real: `app.effective_role()`, `app.can()` y `app.has_role()` para una persona de cada rol.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMBER_ROLES,
  PERMISSION_ACTIONS,
  can,
  type MemberRole,
} from "../../src/lib/permissions/matrix";
import {
  TENANT_HEADER,
  actAs,
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  withTx,
  type TestUser,
} from "./helpers";

/** Las acciones (en orden) que lista una definición de `app.role_can`: una fila `('accion', array[...` por acción. */
function actionsIn(sql: string): string[] {
  return [...sql.matchAll(/^\s*\('([a-z_.]+)',\s*array\[/gm)].map((m) => m[1]);
}

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "..", "supabase", "migrations");
type Migration = { name: string; sql: string };
function readMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS_DIR, name), "utf8") }));
}

/**
 * La ÚLTIMA migración (por nombre) que define `app.role_can`: si una posterior a `role_matrix` la redefine, la
 * lista de acciones que vale es la suya. Antes se miraba siempre la original y una acción nueva pasaba sin que nadie
 * la comprobara.
 */
function latestRoleCanDefinition(migrations: Migration[]): Migration | null {
  const defining = migrations
    .filter((m) => /create (or replace )?function app\.role_can\(/i.test(m.sql))
    .sort((a, b) => a.name.localeCompare(b.name));
  return defining.at(-1) ?? null;
}

/** El cuerpo de `app.role_can` tal como está HOY en la base. */
async function liveRoleCanSource(): Promise<string> {
  const { rows } = await db.query<{ prosrc: string }>(
    "select prosrc from pg_proc where oid = 'app.role_can(text, text, boolean)'::regprocedure",
  );
  return rows[0].prosrc;
}

const ROLE_CAN_SAMPLE = `create function app.role_can(p_role text, p_action text, p_own boolean default false) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select 1 from (values
  ('org.view', array['owner']::text[], array[]::text[]),
  ('quote.create', array['owner']::text[], array[]::text[])
  ) as m(action, any_roles, own_roles)
$$;`;

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

async function dbCan(role: string | null, action: string, own?: boolean): Promise<boolean | null> {
  const { rows } =
    own === undefined
      ? await db.query<{ ok: boolean | null }>("select app.role_can($1, $2) as ok", [role, action])
      : await db.query<{ ok: boolean | null }>("select app.role_can($1, $2, $3) as ok", [
          role,
          action,
          own,
        ]);
  return rows[0].ok;
}

describe("app.role_can y can() de TypeScript dicen lo mismo", () => {
  it("coinciden en cada acción, cada rol y cada caso de «es suyo»", async () => {
    const differences: string[] = [];
    for (const action of PERMISSION_ACTIONS) {
      for (const role of MEMBER_ROLES) {
        for (const isOwn of [false, true]) {
          const fromDb = await dbCan(role, action, isOwn);
          const fromCode = can(role, action, { isOwn });
          if (fromDb !== fromCode) {
            differences.push(
              `${action} · ${role} · isOwn=${isOwn}: base=${fromDb} código=${fromCode}`,
            );
          }
        }
        // Sin el tercer argumento: «no es suyo».
        expect(await dbCan(role, action)).toBe(can(role, action));
      }
    }
    expect(differences).toEqual([]);
  });

  it("una acción desconocida da «no» (nunca nulo) para todos los roles", async () => {
    for (const role of MEMBER_ROLES) {
      expect(await dbCan(role, "no.existe", true)).toBe(false);
      expect(await dbCan(role, "", true)).toBe(false);
    }
    expect(await dbCan("owner", null as unknown as string, true)).toBe(false);
  });

  it("un rol desconocido o nulo da «no»", async () => {
    for (const role of ["superadmin", "", "Owner", null]) {
      expect(await dbCan(role, "org.view", true)).toBe(false);
    }
  });

  it("las acciones de la migración que define `app.role_can` hoy son exactamente las de TypeScript", () => {
    const defining = latestRoleCanDefinition(readMigrations());
    expect(defining, "ninguna migración define app.role_can").not.toBeNull();
    expect(actionsIn(defining!.sql)).toEqual([...PERMISSION_ACTIONS]);
  });

  it("la definición VIVA de `app.role_can` en la base lista exactamente las acciones de TypeScript", async () => {
    expect(actionsIn(await liveRoleCanSource())).toEqual([...PERMISSION_ACTIONS]);
  });

  it("una migración POSTERIOR que redefina `app.role_can` es la que se compara, no la original (prueba negativa)", () => {
    const original = { name: "20261028100000_role_matrix.sql", sql: ROLE_CAN_SAMPLE };
    const later = {
      name: "20261201100000_otra.sql",
      sql: ROLE_CAN_SAMPLE.replace(
        "('org.view',",
        "('quote.archive', array['owner']::text[], array[]::text[]),\n  ('org.view',",
      ).replace("create function", "create or replace function"),
    };
    // Con solo la original, la lista coincide; al sumar la posterior, la que manda es la posterior y la lista cambia.
    expect(actionsIn(latestRoleCanDefinition([original])!.sql)).toEqual([
      "org.view",
      "quote.create",
    ]);
    const picked = latestRoleCanDefinition([later, original]);
    expect(picked?.name).toBe(later.name);
    expect(actionsIn(picked!.sql)).toEqual(["quote.archive", "org.view", "quote.create"]);
    expect(actionsIn(picked!.sql)).not.toEqual(["org.view", "quote.create"]);
  });

  it("si la definición viva cambia (una acción de más), la lectura de la base lo detecta (prueba negativa)", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const source = await liveRoleCanSource();
      const before = actionsIn(source);
      const redefined = source.replace(
        "('org.view',",
        "('prueba.accion_nueva', array['owner']::text[], array[]::text[]),\n        ('org.view',",
      );
      expect(redefined).not.toBe(source);
      await db.query(
        `create or replace function app.role_can(p_role text, p_action text, p_own boolean default false)
         returns boolean language sql immutable parallel safe set search_path = '' as $fn$${redefined}$fn$`,
      );
      const after = actionsIn(await liveRoleCanSource());
      expect(after).toEqual(["prueba.accion_nueva", ...before]);
      expect(after).not.toEqual([...PERMISSION_ACTIONS]);
    }));
});

describe("el rol efectivo en una sesión real", () => {
  /** Una organización con una persona de cada rol y una persona de otra organización. */
  async function team() {
    const users = {} as Record<MemberRole, TestUser>;
    for (const role of MEMBER_ROLES) users[role] = await createUser(db);
    const outsider = await createUser(db);
    const tenantId = await createTenantAs(db, users.owner);
    await createTenantAs(db, outsider);
    for (const role of MEMBER_ROLES) {
      if (role === "owner") continue;
      await db.query("insert into public.members (tenant_id, user_id, role) values ($1, $2, $3)", [
        tenantId,
        users[role].id,
        role,
      ]);
    }
    return { users, outsider, tenantId };
  }

  it("effective_role() es el rol de la membresía y can() coincide con TypeScript para los cinco roles", () =>
    withTx(db, async () => {
      const { users, tenantId } = await team();
      for (const role of MEMBER_ROLES) {
        await actAs(db, users[role], { [TENANT_HEADER]: tenantId });
        const { rows: effective } = await db.query<{ r: string | null }>(
          "select app.effective_role() as r",
        );
        expect(effective[0].r).toBe(role);
        for (const action of PERMISSION_ACTIONS) {
          for (const isOwn of [false, true]) {
            const { rows } = await db.query<{ ok: boolean }>("select app.can($1, $2) as ok", [
              action,
              isOwn,
            ]);
            expect(rows[0].ok, `${role} · ${action} · isOwn=${isOwn}`).toBe(
              can(role, action, { isOwn }),
            );
          }
          const { rows: noArg } = await db.query<{ ok: boolean }>("select app.can($1) as ok", [
            action,
          ]);
          expect(noArg[0].ok).toBe(can(role, action));
        }
        // has_role pasa a leer el rol efectivo y sigue funcionando igual.
        const { rows: has } = await db.query<{ yes: boolean; no: boolean }>(
          "select app.has_role($1) as yes, app.has_role('otro') as no",
          [role],
        );
        expect(has[0]).toEqual({ yes: true, no: false });
      }
    }));

  it("sin ser miembro de la organización activa nadie puede nada", () =>
    withTx(db, async () => {
      const { users, outsider, tenantId } = await team();
      // Otra persona, con la cabecera de una organización que no es suya.
      await actAs(db, outsider, { [TENANT_HEADER]: tenantId });
      const { rows } = await db.query<{ r: string | null; ok: boolean }>(
        "select app.effective_role() as r, app.can('org.view', true) as ok",
      );
      expect(rows[0]).toEqual({ r: null, ok: false });
      // Sin cabecera de organización: tampoco.
      await actAs(db, users.owner, {});
      const none = await db.query<{ r: string | null; ok: boolean }>(
        "select app.effective_role() as r, app.can('org.view', true) as ok",
      );
      expect(none.rows[0]).toEqual({ r: null, ok: false });
    }));

  it("un miembro quitado pierde el rol efectivo en la consulta siguiente", () =>
    withTx(db, async () => {
      const { users, tenantId } = await team();
      await actAs(db, users.sales, { [TENANT_HEADER]: tenantId });
      expect((await db.query("select app.can('customer.write') as ok")).rows[0].ok).toBe(true);
      await actAsPostgres(db);
      await db.query(
        "update public.members set status = 'removed', removed_at = now() where tenant_id = $1 and user_id = $2",
        [tenantId, users.sales.id],
      );
      await actAs(db, users.sales, { [TENANT_HEADER]: tenantId });
      const { rows } = await db.query<{ r: string | null; ok: boolean }>(
        "select app.effective_role() as r, app.can('customer.write') as ok",
      );
      expect(rows[0]).toEqual({ r: null, ok: false });
    }));
});
