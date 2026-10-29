// H-011a · Las políticas de la base que pasaron a la matriz (`app.can`): con una persona real de cada uno de
// los cinco roles, lo permitido pasa y lo prohibido da 42501 (o cero filas). Cada prueba corre en una
// transacción que se deshace. La paridad con TypeScript está en permissions-parity.test.ts.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMBER_ROLES, can, type MemberRole } from "../../src/lib/permissions/matrix";
import {
  TENANT_HEADER,
  actAs,
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  expectSqlError,
  withTx,
  type TestUser,
} from "./helpers";

const INSUFFICIENT_PRIVILEGE = "42501";
const HEX64 = "a".repeat(64);

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

type Team = { users: Record<MemberRole, TestUser>; tenantId: string; otherTenantId: string };

async function team(): Promise<Team> {
  const users = {} as Record<MemberRole, TestUser>;
  for (const role of MEMBER_ROLES) users[role] = await createUser(db);
  const tenantId = await createTenantAs(db, users.owner);
  const otherOwner = await createUser(db);
  const otherTenantId = await createTenantAs(db, otherOwner);
  for (const role of MEMBER_ROLES) {
    if (role === "owner") continue;
    await db.query("insert into public.members (tenant_id, user_id, role) values ($1, $2, $3)", [
      tenantId,
      users[role].id,
      role,
    ]);
  }
  return { users, tenantId, otherTenantId };
}

async function as(t: Team, role: MemberRole) {
  await actAs(db, t.users[role], { [TENANT_HEADER]: t.tenantId });
}

describe("catálogo (catalog.manage)", () => {
  it("solo el Dueño y el Administrador crean y editan; los demás reciben 42501 o cero filas", () =>
    withTx(db, async () => {
      const t = await team();
      await as(t, "owner");
      const { rows } = await db.query<{ id: string }>(
        "insert into public.catalog_items (name, unit, unit_price_clp) values ('Base', 'km', 1000) returning id",
      );
      const itemId = rows[0].id;
      for (const role of MEMBER_ROLES) {
        await as(t, role);
        const allowed = can(role, "catalog.manage");
        if (allowed) {
          await db.query(
            "insert into public.catalog_items (name, unit, unit_price_clp) values ($1, 'km', 1)",
            [`Servicio de ${role}`],
          );
          expect(
            (
              await db.query("update public.catalog_items set name = $2 where id = $1", [
                itemId,
                `Editado por ${role}`,
              ])
            ).rowCount,
          ).toBe(1);
        } else {
          expect(
            (
              await expectSqlError(
                db,
                "insert into public.catalog_items (name, unit, unit_price_clp) values ('X', 'km', 1)",
              )
            ).code,
          ).toBe(INSUFFICIENT_PRIVILEGE);
          expect(
            (
              await db.query("update public.catalog_items set name = 'hack' where id = $1", [
                itemId,
              ])
            ).rowCount,
          ).toBe(0);
        }
        // Todos ven el catálogo (decisión 009).
        expect(
          (await db.query("select 1 from public.catalog_items where id = $1", [itemId])).rowCount,
        ).toBe(1);
      }
    }));
});

describe("clientes (customer.write)", () => {
  it("el Dueño, el Administrador y el Comercial escriben; el Aprobador y el Observador no", () =>
    withTx(db, async () => {
      const t = await team();
      await as(t, "owner");
      const customerId = randomUUID();
      await db.query(
        "insert into public.customers (id, kind, display_name) values ($1, 'person', 'Base')",
        [customerId],
      );
      for (const role of MEMBER_ROLES) {
        await as(t, role);
        const allowed = can(role, "customer.write");
        const insert =
          "insert into public.customers (id, kind, display_name) values ($1, 'person', 'Nuevo')";
        if (allowed) {
          await db.query(insert, [randomUUID()]);
          // Cualquier Comercial edita cualquier cliente (supuesto 19).
          expect(
            (
              await db.query("update public.customers set display_name = $2 where id = $1", [
                customerId,
                `Por ${role}`,
              ])
            ).rowCount,
          ).toBe(1);
        } else {
          expect((await expectSqlError(db, insert, [randomUUID()])).code).toBe(
            INSUFFICIENT_PRIVILEGE,
          );
          expect(
            (
              await db.query("update public.customers set display_name = 'hack' where id = $1", [
                customerId,
              ])
            ).rowCount,
          ).toBe(0);
        }
      }
    }));

  it("el correo cifrado y la huella siguen exigiendo la regla de forma (la matriz no la relaja)", () =>
    withTx(db, async () => {
      const t = await team();
      await as(t, "sales");
      const error = await expectSqlError(
        db,
        "insert into public.customers (id, kind, display_name, email_hash) values (gen_random_uuid(), 'person', 'X', $1)",
        [HEX64],
      );
      expect(error.code).toBe("23514");
    }));
});

describe("empresa (settings.manage)", () => {
  it("solo el Dueño y el Administrador editan la organización", () =>
    withTx(db, async () => {
      const t = await team();
      for (const role of MEMBER_ROLES) {
        await as(t, role);
        const rows = (await db.query("update public.tenants set name = $1", [`Nombre de ${role}`]))
          .rowCount;
        expect(rows, role).toBe(can(role, "settings.manage") ? 1 : 0);
      }
    }));
});

describe("registro de actividad (audit.read)", () => {
  it("solo el Dueño lo lee; el Administrador ya no (supuesto 13)", () =>
    withTx(db, async () => {
      const t = await team();
      await actAsPostgres(db);
      const { rows } = await db.query<{ n: number }>(
        "select count(*)::int as n from public.audit_log where tenant_id = $1",
        [t.tenantId],
      );
      expect(rows[0].n).toBeGreaterThan(0);
      for (const role of MEMBER_ROLES) {
        await as(t, role);
        const visible = (await db.query("select 1 from public.audit_log")).rowCount;
        if (can(role, "audit.read")) expect(visible, role).toBeGreaterThan(0);
        else expect(visible, role).toBe(0);
      }
      // Y el Dueño nunca ve las filas de otra organización.
      await as(t, "owner");
      const foreign = await db.query("select 1 from public.audit_log where tenant_id = $1", [
        t.otherTenantId,
      ]);
      expect(foreign.rowCount).toBe(0);
    }));
});

describe("aperturas del enlace y contadores del formulario", () => {
  it("las lee quien tiene quote.link_views.read / intake.protection.read, nadie más", () =>
    withTx(db, async () => {
      const t = await team();
      await actAsPostgres(db);
      // Filas de prueba sin armar toda la cadena de cotización: se apaga el chequeo de relaciones solo aquí.
      await db.query("set local session_replication_role = replica");
      await db.query(
        "insert into public.share_link_views (tenant_id, share_link_id) values ($1, gen_random_uuid())",
        [t.tenantId],
      );
      await db.query(
        "insert into public.intake_daily_counters (tenant_id, form_id, day) values ($1, gen_random_uuid(), current_date)",
        [t.tenantId],
      );
      await db.query("set local session_replication_role = origin");
      for (const role of MEMBER_ROLES) {
        await as(t, role);
        const views = (await db.query("select 1 from public.share_link_views")).rowCount;
        const counters = (await db.query("select 1 from public.intake_daily_counters")).rowCount;
        expect(views, `aperturas · ${role}`).toBe(can(role, "quote.link_views.read") ? 1 : 0);
        expect(counters, `contadores · ${role}`).toBe(can(role, "intake.protection.read") ? 1 : 0);
      }
    }));
});

describe("logo (settings.manage en Storage)", () => {
  // Storage no deja borrar por SQL directo (solo por su API; ver tests/isolation/storage.test.ts). Aquí se
  // comprueba que la política decide con la matriz y que la matriz da lo esperado para cada rol.
  it("la política de borrado decide con app.can('settings.manage') y no con una lista de roles", async () => {
    const { rows } = await db.query<{ qual: string }>(
      "select qual from pg_policies where schemaname = 'storage' and policyname = 'tenant_logos_delete'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].qual).toContain("app.can('settings.manage'");
    expect(rows[0].qual).not.toMatch(/has_role|'owner'|'admin'/);
  });
});

describe("el rol efectivo no abre nada entre organizaciones", () => {
  it("un Dueño, con la cabecera de otra organización, no puede escribir en el catálogo de ella", () =>
    withTx(db, async () => {
      const t = await team();
      await actAs(db, t.users.owner, { [TENANT_HEADER]: t.otherTenantId });
      expect(
        (
          await expectSqlError(
            db,
            "insert into public.catalog_items (name, unit, unit_price_clp) values ('X', 'km', 1)",
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }));
});
