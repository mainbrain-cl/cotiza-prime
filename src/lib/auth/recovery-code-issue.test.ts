import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FACTOR_ID = "22222222-2222-4222-8222-222222222222";
const SET_ID = "33333333-3333-4333-8333-333333333333";

const replaceRecoveryCodes = vi.fn();
const logAuditEvent = vi.fn();
const serverLog = vi.fn();
vi.mock("@/lib/audit/log", () => ({ logAuditEvent: (e: unknown) => logAuditEvent(e) }));
vi.mock("@/lib/log/server-log", () => ({
  serverLog: (...args: unknown[]) => serverLog(...args),
}));
vi.mock("@/lib/security/mfa-recovery-gateway", () => ({
  MfaRecoveryGatewayError: class extends Error {
    code = "CP422";
  },
  replaceRecoveryCodes: (...args: unknown[]) => replaceRecoveryCodes(...args),
}));
vi.mock("@/lib/crypto/search-hash", () => ({
  searchHash: (_purpose: string, _tenant: string, value: string) =>
    createHash("sha256").update(value).digest("hex"),
}));

const { issueRecoveryCodes } = await import("./recovery-code-issue");

const FORMATTED = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

beforeEach(() => {
  replaceRecoveryCodes.mockReset();
  logAuditEvent.mockReset();
  serverLog.mockReset();
  replaceRecoveryCodes.mockResolvedValue({ result: "ok", setId: SET_ID, total: 10 });
});

describe("issueRecoveryCodes", () => {
  it("crea 10 códigos distintos, ya formateados, y guarda solo sus huellas atadas al factor", async () => {
    const result = await issueRecoveryCodes(USER_ID, FACTOR_ID, "enrollment");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setId).toBe(SET_ID);
    expect(result.recoveryCodes).toHaveLength(10);
    expect(new Set(result.recoveryCodes).size).toBe(10);
    for (const code of result.recoveryCodes) expect(code).toMatch(FORMATTED);
    const [userId, factorId, hashes] = replaceRecoveryCodes.mock.calls[0];
    expect(userId).toBe(USER_ID);
    expect(factorId).toBe(FACTOR_ID);
    expect(hashes).toHaveLength(10);
    // La base recibe huellas, nunca un código.
    for (const code of result.recoveryCodes) {
      expect(JSON.stringify(hashes)).not.toContain(code);
      expect(JSON.stringify(hashes)).not.toContain(code.replaceAll("-", ""));
    }
  });

  it("deja la auditoría con solo la etapa (sin códigos ni huellas)", async () => {
    const result = await issueRecoveryCodes(USER_ID, FACTOR_ID, "regenerate");
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).toHaveBeenCalledWith({
      action: "session.mfa_recovery_codes_created",
      result: "success",
      actorUserId: USER_ID,
      details: { stage: "regenerate" },
    });
    if (result.ok) {
      const recorded = JSON.stringify([...logAuditEvent.mock.calls, ...serverLog.mock.calls]);
      for (const code of result.recoveryCodes) expect(recorded).not.toContain(code);
    }
  });

  it.each(["no_factor", "busy"] as const)(
    "si la base responde «%s», no hay códigos ni auditoría de creación",
    async (reason) => {
      replaceRecoveryCodes.mockResolvedValue({ result: reason });
      expect(await issueRecoveryCodes(USER_ID, FACTOR_ID, "enrollment")).toEqual({
        ok: false,
        reason,
      });
      expect(logAuditEvent).not.toHaveBeenCalled();
    },
  );

  it("si la pasarela falla, no lanza: responde «error» y registra solo el código del error", async () => {
    replaceRecoveryCodes.mockRejectedValue(new Error("boom"));
    expect(await issueRecoveryCodes(USER_ID, FACTOR_ID, "enrollment")).toEqual({
      ok: false,
      reason: "error",
    });
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(serverLog).toHaveBeenCalledWith("error", "mfa_recovery_codes_failed", {
      code: "unexpected",
      stage: "enrollment",
    });
    expect(JSON.stringify(serverLog.mock.calls)).not.toContain("boom");
  });
});
