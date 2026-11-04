import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INVITATION_GENERIC_FAILURE } from "./accept-model";
import { hashInvitationToken, newInvitationToken } from "./invitation-code";

// El servicio de aceptar una invitación (H-009) con un falso cliente de Supabase: qué manda a la base (solo la
// huella del código) y cómo entiende cada respuesta.

const rpc = vi.fn();
const createClient = vi.fn<(headers?: Record<string, string>) => Promise<{ rpc: typeof rpc }>>(
  async () => ({ rpc }),
);
const logged: unknown[][] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: (h?: Record<string, string>) => createClient(h),
}));
vi.mock("@/lib/http/request-context", () => ({
  getRequestContext: async () => ({ requestId: "req-1", clientIp: "203.0.113.9", userAgent: null }),
}));
vi.mock("@/lib/log/server-log", () => ({
  serverLog: async (...args: unknown[]) => {
    logged.push(args);
  },
}));

const { acceptInvitation, previewInvitation } = await import("./accept-service");

const TENANT_ID = randomUUID();
let code: string;

beforeEach(() => {
  rpc.mockReset();
  createClient.mockClear();
  logged.length = 0;
  code = newInvitationToken();
});

describe("qué se manda a la base", () => {
  it("solo la huella del código, con el pase de la persona y sin organización activa", async () => {
    rpc.mockResolvedValue({ data: { result: "not_found" }, error: null });
    await acceptInvitation(code);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("accept_invitation", {
      p_token_sha256: hashInvitationToken(code),
    });
    const headers = createClient.mock.calls[0][0] ?? {};
    expect(Object.keys(headers).sort()).toEqual(["x-cp-client-ip", "x-cp-request-id"]);
  });

  it("la vista previa también manda solo la huella", async () => {
    rpc.mockResolvedValue({ data: { result: "not_found" }, error: null });
    await previewInvitation(code);
    expect(rpc).toHaveBeenCalledWith("invitation_preview", {
      p_token_sha256: hashInvitationToken(code),
    });
  });

  it("el código no viaja en ninguna parte de la llamada", async () => {
    rpc.mockResolvedValue({ data: { result: "not_found" }, error: null });
    await acceptInvitation(code);
    await previewInvitation(code);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(code);
  });
});

describe("aceptar", () => {
  it("entra a la organización que dice la base", async () => {
    rpc.mockResolvedValue({
      data: { result: "accepted", tenant_id: TENANT_ID, role: "sales", already_member: false },
      error: null,
    });
    expect(await acceptInvitation(code)).toEqual({
      status: "joined",
      tenantId: TENANT_ID,
      alreadyMember: false,
    });
  });

  it("recuerda si ya era miembro", async () => {
    rpc.mockResolvedValue({
      data: { result: "accepted", tenant_id: TENANT_ID, already_member: true },
      error: null,
    });
    expect(await acceptInvitation(code)).toMatchObject({ status: "joined", alreadyMember: true });
  });

  it.each([
    "not_found",
    "revoked",
    "expired",
    "used",
    "archived",
    "wrong_email",
    "unverified",
    "rate_limited",
  ])("traduce «%s»", async (result) => {
    rpc.mockResolvedValue({ data: { result }, error: null });
    expect(await acceptInvitation(code)).toEqual({ status: "unavailable", result });
  });

  it("sin sesión (42501) pide ingresar", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "x" } });
    expect(await acceptInvitation(code)).toEqual({ status: "no_session" });
  });

  it("una falla de la base da el mensaje genérico y deja solo un código en el log", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "detalle técnico" } });
    expect(await acceptInvitation(code)).toEqual({
      status: "failed",
      message: INVITATION_GENERIC_FAILURE,
    });
    expect(JSON.stringify(logged)).not.toContain("detalle técnico");
    expect(JSON.stringify(logged)).not.toContain(code);
  });

  it("una respuesta con otra forma no entra a ninguna organización", async () => {
    for (const data of [
      null,
      "accepted",
      { result: "accepted" }, // sin organización
      { result: "accepted", tenant_id: "no-es-uuid" },
      { result: "ok" }, // «ok» es de la vista previa
      { result: "quizas" },
    ]) {
      rpc.mockResolvedValue({ data, error: null });
      expect((await acceptInvitation(code)).status, JSON.stringify(data)).toBe("failed");
    }
  });
});

describe("la vista previa", () => {
  it("entrega organización, quién invitó y rol solo cuando la invitación es para esta cuenta", async () => {
    rpc.mockResolvedValue({
      data: {
        result: "ok",
        tenant_id: TENANT_ID,
        tenant_name: "Negocio 1",
        inviter_name: "Ana",
        role: "sales",
        expires_at: "2026-11-10T12:00:00Z",
      },
      error: null,
    });
    expect(await previewInvitation(code)).toEqual({
      status: "ready",
      tenantId: TENANT_ID,
      organizationName: "Negocio 1",
      inviterName: "Ana",
      role: "sales",
      expiresAt: "2026-11-10T12:00:00Z",
      alreadyMember: false,
      currentRole: null,
    });
  });

  it("si ya es miembro activa, trae su rol actual", async () => {
    rpc.mockResolvedValue({
      data: {
        result: "ok",
        tenant_id: TENANT_ID,
        tenant_name: "Negocio 1",
        inviter_name: "Ana",
        role: "admin",
        already_member: true,
        current_role: "viewer",
      },
      error: null,
    });
    expect(await previewInvitation(code)).toMatchObject({
      status: "ready",
      role: "admin",
      alreadyMember: true,
      currentRole: "viewer",
    });
  });

  it("«inviter_inactive» llega como resultado definitivo", async () => {
    rpc.mockResolvedValue({ data: { result: "inviter_inactive" }, error: null });
    expect(await previewInvitation(code)).toEqual({
      status: "unavailable",
      result: "inviter_inactive",
    });
    expect(await acceptInvitation(code)).toEqual({
      status: "unavailable",
      result: "inviter_inactive",
    });
  });

  it("«aceptada por ti» lleva a la organización", async () => {
    rpc.mockResolvedValue({ data: { result: "accepted", tenant_id: TENANT_ID }, error: null });
    expect(await previewInvitation(code)).toEqual({
      status: "already_member",
      tenantId: TENANT_ID,
    });
  });

  it("para otro correo no trae ningún dato", async () => {
    rpc.mockResolvedValue({ data: { result: "wrong_email" }, error: null });
    expect(await previewInvitation(code)).toEqual({ status: "unavailable", result: "wrong_email" });
  });

  it("un «ok» sin organización o sin rol es una respuesta rota", async () => {
    rpc.mockResolvedValue({ data: { result: "ok", tenant_id: TENANT_ID }, error: null });
    expect((await previewInvitation(code)).status).toBe("failed");
  });

  it("sin sesión pide ingresar", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "x" } });
    expect(await previewInvitation(code)).toEqual({ status: "no_session" });
  });
});
