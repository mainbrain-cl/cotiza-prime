import { beforeEach, describe, expect, it, vi } from "vitest";

const { readShareLink, respondShareLink } = vi.hoisted(() => ({
  readShareLink: vi.fn(),
  respondShareLink: vi.fn(),
}));
vi.mock("./gateway", () => ({ readShareLink, respondShareLink }));
vi.mock("@/lib/crypto/pii", () => ({
  encryptPii: (plain: string, ctx: { field: string; tenantId: string; rowId: string }) =>
    `enc(${ctx.field}|${ctx.tenantId}|${ctx.rowId}|${plain})`,
}));
vi.mock("@/lib/http/request-context", () => ({
  getRequestContext: async () => ({ requestId: "r", clientIp: "203.0.113.9", userAgent: "UA" }),
}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn() }));

import { respondToShare } from "./respond-service";

const TENANT = "11111111-1111-4111-8111-111111111111";
const QUOTE = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";
const AUTHOR = "44444444-4444-4444-8444-444444444444";
const available = { state: "ok", tenantId: TENANT, quoteId: QUOTE };
const accept = {
  decision: "accepted" as const,
  input: { responseKey: KEY, name: "Ana", confirmed: true as const },
};

beforeEach(() => {
  readShareLink.mockReset().mockResolvedValue(available);
  respondShareLink.mockReset();
});

describe("respondToShare (H-031)", () => {
  it("aceptar: cifra nombre e IP con el sello de la fila, manda la IP del servidor y avisa", async () => {
    respondShareLink.mockResolvedValue({
      result: "ok",
      replayed: false,
      decision: "accepted",
      author_id: AUTHOR,
      number_display: "COT-1",
    });
    const result = await respondToShare("tok", accept);
    expect(result.outcome).toEqual({ status: "ok", decision: "accepted" });
    const args = respondShareLink.mock.calls[0][0];
    expect(args.acceptorNameEnc).toBe(`enc(acceptor_name|${TENANT}|${args.responseId}|Ana)`);
    expect(args.ipEnc).toBe(`enc(ip|${TENANT}|${args.responseId}|203.0.113.9)`);
    expect(args).toMatchObject({
      originIp: "203.0.113.9",
      userAgent: "UA",
      responseKey: KEY,
      reasonCode: null,
      reasonTextEnc: null,
      acceptanceTextVersion: "v1",
    });
    expect(result.notify).toMatchObject({ authorId: AUTHOR, decision: "accepted", quoteId: QUOTE });
  });

  it("rechazar con «otro»: cifra el texto y no manda nombre", async () => {
    respondShareLink.mockResolvedValue({ result: "ok", replayed: false, decision: "rejected" });
    const result = await respondToShare("tok", {
      decision: "rejected",
      input: { responseKey: KEY, reasonCode: "other", reasonText: "muy caro" },
    });
    const args = respondShareLink.mock.calls[0][0];
    expect(args.reasonCode).toBe("other");
    expect(args.reasonTextEnc).toBe(`enc(reason_text|${TENANT}|${args.responseId}|muy caro)`);
    expect(args.acceptorNameEnc).toBeNull();
    expect(args.acceptanceTextVersion).toBeNull();
    expect(result.notify?.reasonText).toBe("muy caro");
  });

  it("el mismo envío repetido no vuelve a avisar", async () => {
    respondShareLink.mockResolvedValue({ result: "ok", replayed: true, decision: "accepted" });
    const result = await respondToShare("tok", accept);
    expect(result.outcome).toEqual({ status: "ok", decision: "accepted" });
    expect(result.notify).toBeNull();
  });

  it("ya respondida: informa lo que quedó, sin avisar", async () => {
    respondShareLink.mockResolvedValue({ result: "already_responded", decision: "rejected" });
    const result = await respondToShare("tok", accept);
    expect(result).toEqual({
      outcome: { status: "already_responded", decision: "rejected" },
      notify: null,
    });
  });

  it("vencida, revocada o reemplazada: lo decide la base y no se avisa", async () => {
    for (const reason of ["expired", "revoked", "superseded", "not_allowed"]) {
      respondShareLink.mockResolvedValue({ result: reason });
      const result = await respondToShare("tok", accept);
      expect(result.outcome).toEqual({ status: "unavailable", reason });
      expect(result.notify).toBeNull();
    }
  });

  it("si la lectura ya dice que no está disponible, no llega a la base", async () => {
    readShareLink.mockResolvedValue({ state: "revoked", contact: {} });
    expect((await respondToShare("tok", accept)).outcome).toEqual({
      status: "unavailable",
      reason: "revoked",
    });
    readShareLink.mockResolvedValue({ state: "not_found" });
    expect((await respondToShare("tok", accept)).outcome).toEqual({
      status: "unavailable",
      reason: "not_found",
    });
    expect(respondShareLink).not.toHaveBeenCalled();
  });

  it("un resultado desconocido es un error, nunca una decisión ambigua", async () => {
    respondShareLink.mockResolvedValue({ result: "raro" });
    expect((await respondToShare("tok", accept)).outcome).toEqual({ status: "error" });
  });
});
