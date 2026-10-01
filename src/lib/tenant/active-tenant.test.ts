import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundSignal, RedirectSignal, queryBuilder } from "@/test/supabase-mock";

const requireUser = vi.fn();
const logAuditEvent = vi.fn();
const createClient = vi.fn();
const from = vi.fn();
const rpc = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
  notFound: () => {
    throw new NotFoundSignal();
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7", "user-agent": "prueba" }),
}));
vi.mock("@/lib/auth/session", () => ({
  requireUser: (...args: unknown[]) => requireUser(...args),
}));
vi.mock("@/lib/audit/log", () => ({
  logAuditEvent: (...args: unknown[]) => logAuditEvent(...args),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => createClient(...args),
}));

import { requireActiveTenant, resolveActiveTenant, resolveLandingTenant } from "./active-tenant";
import { TENANT_HEADER } from "./constants";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ana@ejemplo.test",
  emailVerified: true,
};
const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function membershipsAre(
  rows: { tenant_id: string; role: string; tenants: { name: string } }[],
  lastTenantId: string | null = null,
) {
  from.mockImplementation(() => queryBuilder({ data: rows, error: null }));
  // La última organización se lee con la función `my_last_tenant_id`, nunca con un select a profiles.
  rpc.mockResolvedValue({ data: lastTenantId, error: null });
}

beforeEach(() => {
  requireUser.mockReset().mockResolvedValue(USER);
  logAuditEvent.mockReset();
  createClient.mockReset().mockImplementation(async () => ({ from, rpc }));
  from.mockReset();
  rpc.mockReset();
});

describe("resolveActiveTenant", () => {
  it("si es miembro, entrega la organización, el rol y un cliente con la cabecera puesta", async () => {
    membershipsAre([{ tenant_id: TENANT_A, role: "owner", tenants: { name: "Negocio 1" } }]);
    const active = await resolveActiveTenant({ userId: USER.id, requestedTenantId: TENANT_A });

    expect(active).toMatchObject({ tenantId: TENANT_A, tenantName: "Negocio 1", role: "owner" });
    const headersUsed = createClient.mock.calls.at(-1)?.[0] as Record<string, string>;
    expect(headersUsed[TENANT_HEADER]).toBe(TENANT_A);
    expect(headersUsed["x-cp-client-ip"]).toBe("203.0.113.7");
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("si no es miembro, devuelve null y deja el intento en la auditoría", async () => {
    membershipsAre([{ tenant_id: TENANT_A, role: "owner", tenants: { name: "Negocio 1" } }]);
    const active = await resolveActiveTenant({ userId: USER.id, requestedTenantId: TENANT_B });

    expect(active).toBeNull();
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tenant.access_denied",
        result: "denied",
        resourceId: TENANT_B,
      }),
    );
  });

  it("si la dirección no es un UUID, ni siquiera consulta las membresías", async () => {
    const active = await resolveActiveTenant({
      userId: USER.id,
      requestedTenantId: "no-es-un-uuid",
    });
    expect(active).toBeNull();
    expect(from).not.toHaveBeenCalled();
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ details: { reason: "invalid_id" } }),
    );
  });
});

describe("resolveActiveTenant: solo UUID canónico en minúsculas", () => {
  it("un UUID en mayúsculas no se acepta aunque sea miembro (404 idéntico)", async () => {
    membershipsAre([{ tenant_id: TENANT_A, role: "owner", tenants: { name: "Negocio 1" } }]);
    const active = await resolveActiveTenant({
      userId: USER.id,
      requestedTenantId: TENANT_A.toUpperCase(),
    });
    expect(active).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("el registro de acceso denegado no lleva id de recurso si lo pedido no es un UUID", async () => {
    await resolveActiveTenant({ userId: USER.id, requestedTenantId: "<script>" });
    const event = logAuditEvent.mock.calls.at(-1)?.[0];
    expect(event).toMatchObject({
      action: "tenant.access_denied",
      result: "denied",
      resourceType: "tenant",
      actorUserId: USER.id,
    });
    expect(event.resourceId).toBeUndefined();
    // Sin organización: lo recibe la "plataforma" (el valor por defecto del registro de auditoría)
    expect(event.tenantId).toBeUndefined();
  });
});

describe("requireActiveTenant", () => {
  it("responde 'No encontrado' (nunca 'Prohibido') a quien no es miembro", async () => {
    membershipsAre([]);
    await expect(requireActiveTenant(TENANT_A)).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("responde 'No encontrado' ante un UUID inválido", async () => {
    await expect(requireActiveTenant("123")).rejects.toBeInstanceOf(NotFoundSignal);
  });
});

describe("resolveLandingTenant", () => {
  const rows = [
    { tenant_id: TENANT_A, role: "owner", tenants: { name: "Negocio A" } },
    { tenant_id: TENANT_B, role: "admin", tenants: { name: "Negocio B" } },
  ];

  it("lleva a la última organización usada si sigue siendo suya", async () => {
    membershipsAre(rows, TENANT_B);
    expect(await resolveLandingTenant(USER)).toBe(TENANT_B);
  });

  it("si la última ya no es suya, usa la primera de su lista", async () => {
    membershipsAre(rows, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(await resolveLandingTenant(USER)).toBe(TENANT_A);
  });

  it("lee la última organización con my_last_tenant_id y nunca con una consulta a profiles (H-012)", async () => {
    membershipsAre(rows, TENANT_B);
    await resolveLandingTenant(USER);
    expect(rpc).toHaveBeenCalledWith("my_last_tenant_id");
    expect(from).not.toHaveBeenCalledWith("profiles");
  });

  it("sin organizaciones devuelve null", async () => {
    membershipsAre([]);
    expect(await resolveLandingTenant(USER)).toBeNull();
  });
});
