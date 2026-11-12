import { beforeEach, describe, expect, it, vi } from "vitest";

const logAuditEvent = vi.fn();
vi.mock("@/lib/audit/log", () => ({ logAuditEvent: (event: unknown) => logAuditEvent(event) }));

import { logTenantLogins } from "./login-audit";

const USER = "11111111-1111-4111-8111-111111111111";

function clientReturning(result: { data: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) chain[method] = vi.fn(() => chain);
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const from = vi.fn(() => chain);
  return { client: { from } as never, from, chain };
}

beforeEach(() => logAuditEvent.mockReset());

describe("logTenantLogins", () => {
  it("escribe un ingreso por cada organización activa de la persona, a su nombre", async () => {
    const { client } = clientReturning({ data: [{ tenant_id: "t1" }, { tenant_id: "t2" }] });
    await logTenantLogins(client, USER);
    expect(logAuditEvent.mock.calls.map(([event]) => event)).toEqual([
      { action: "session.login", result: "success", actorUserId: USER, tenantId: "t1" },
      { action: "session.login", result: "success", actorUserId: USER, tenantId: "t2" },
    ]);
  });

  it("pide solo membresías activas de organizaciones activas de esa persona", async () => {
    const { client, from, chain } = clientReturning({ data: [] });
    await logTenantLogins(client, USER);
    expect(from).toHaveBeenCalledWith("members");
    expect((chain.eq as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ["user_id", USER],
      ["status", "active"],
      ["tenants.status", "active"],
      ["tenants.kind", "organization"],
    ]);
  });

  it("sin organizaciones (o con la sesión parcial, que no ve ninguna) no escribe nada", async () => {
    await logTenantLogins(clientReturning({ data: [] }).client, USER);
    await logTenantLogins(clientReturning({ data: null }).client, USER);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});
