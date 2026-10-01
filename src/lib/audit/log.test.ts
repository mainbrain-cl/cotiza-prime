import { beforeEach, describe, expect, it, vi } from "vitest";

const insert = vi.fn();

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "198.51.100.4", "user-agent": "prueba" }),
}));
vi.mock("@/lib/supabase/admin-client", () => ({
  createAdminClient: () => ({ from: () => ({ insert }) }),
}));

import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { logAuditEvent } from "./log";

beforeEach(() => insert.mockReset().mockResolvedValue({ error: null }));

describe("logAuditEvent", () => {
  it("los eventos sin organización van a la organización de la plataforma", async () => {
    await logAuditEvent({
      action: "tenant.access_denied",
      result: "denied",
      actorUserId: "u1",
      resourceType: "tenant",
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: PLATFORM_TENANT_ID,
        actor_type: "user",
        actor_user_id: "u1",
        result: "denied",
        origin_ip: "198.51.100.4",
      }),
    );
  });

  it("sin actor se registra como público y nunca incluye correo ni contraseña", async () => {
    await logAuditEvent({
      action: "session.login_failed",
      result: "failure",
      details: { reason: "invalid_credentials" },
    });
    const row = insert.mock.calls[0][0];
    expect(row.actor_type).toBe("public");
    expect(JSON.stringify(row)).not.toMatch(/@|password|contraseña/i);
  });

  it("si falla el registro no rompe la petición", async () => {
    insert.mockResolvedValue({ error: { code: "XX000" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      logAuditEvent({ action: "session.login", result: "success" }),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
