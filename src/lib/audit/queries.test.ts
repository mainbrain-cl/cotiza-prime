import { describe, expect, it, vi } from "vitest";
import type { ActiveTenant, MemberRole } from "@/lib/tenant/active-tenant";
import {
  AUDIT_PAGE_SIZE,
  canViewAuditLog,
  listAuditEntries,
  sanitizeAuditFilters,
} from "./queries";

vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn() }));

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

/** Cliente falso: anota las llamadas y entrega las filas indicadas para `audit_log`. */
function fakeActive(role: MemberRole, rows: unknown[] = [], count = rows.length) {
  const calls: [string, ...unknown[]][] = [];
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "range"]) {
      builder[method] = vi.fn((...args: unknown[]) => {
        calls.push([`${table}.${method}`, ...args]);
        return builder;
      });
    }
    const result =
      table === "audit_log"
        ? { data: rows, error: null, count }
        : table === "members"
          ? { data: [{ user_id: USER_ID }], error: null }
          : { data: [{ user_id: USER_ID, full_name: "Ana Prueba" }], error: null };
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return builder;
  });
  const active = {
    tenantId: TENANT_ID,
    role,
    userId: USER_ID,
    supabase: { from },
  } as unknown as ActiveTenant;
  return { active, from, calls };
}

describe("permiso del registro de actividad", () => {
  it("solo el Dueño lo ve", () => {
    expect(canViewAuditLog("owner")).toBe(true);
    for (const role of ["admin", "approver", "sales", "viewer"] as const) {
      expect(canViewAuditLog(role)).toBe(false);
    }
  });

  it.each(["admin", "approver", "sales", "viewer"] as const)(
    "si quien pregunta es %s no se consulta nada",
    async (role) => {
      const { active, from } = fakeActive(role);
      expect(await listAuditEntries(active)).toBeNull();
      expect(from).not.toHaveBeenCalled();
    },
  );
});

describe("filtros del registro", () => {
  it("ignora lo que no reconoce", () => {
    expect(sanitizeAuditFilters({ actor: "no-es-uuid", action: "x.y", page: -3 })).toEqual({
      actor: null,
      action: null,
      page: 1,
    });
    expect(
      sanitizeAuditFilters({ actor: USER_ID.toUpperCase(), action: "member.updated", page: 3 }),
    ).toEqual({
      actor: USER_ID,
      action: "member.updated",
      page: 3,
    });
  });

  it("consulta solo la organización activa, con los filtros y de a páginas", async () => {
    const { active, calls } = fakeActive("owner", [
      {
        id: 7,
        occurred_at: "2026-10-05T12:00:00Z",
        actor_type: "user",
        actor_user_id: USER_ID,
        action: "member.updated",
        resource_type: "member",
        result: "success",
        origin_ip: "127.0.0.1",
        details: {},
      },
    ]);
    const page = await listAuditEntries(active, { actor: USER_ID, action: "member.updated" });
    expect(calls).toContainEqual(["audit_log.eq", "tenant_id", TENANT_ID]);
    expect(calls).toContainEqual(["audit_log.eq", "actor_user_id", USER_ID]);
    expect(calls).toContainEqual(["audit_log.eq", "action", "member.updated"]);
    expect(calls).toContainEqual(["audit_log.range", 0, AUDIT_PAGE_SIZE - 1]);
    expect(page?.entries[0]).toMatchObject({
      id: 7,
      actorName: "Ana Prueba",
      action: "member.updated",
    });
    expect(page?.pageCount).toBe(1);
  });
});
