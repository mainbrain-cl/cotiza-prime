import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readNoticeRecipients: vi.fn(),
  registerInternalNotice: vi.fn(),
  settleInternalNotice: vi.fn(),
  sendWithRetry: vi.fn(),
  serverLog: vi.fn(),
  send: vi.fn(),
}));

vi.mock("./gateway", () => ({
  ShareGatewayError: class ShareGatewayError extends Error {},
  readNoticeRecipients: mocks.readNoticeRecipients,
  registerInternalNotice: mocks.registerInternalNotice,
  settleInternalNotice: mocks.settleInternalNotice,
}));
vi.mock("@/lib/email/config", () => ({
  loadEmailConfig: () => ({ fromAddress: "no-responder@ejemplo.test" }),
}));
vi.mock("@/lib/email/transport", () => ({
  EmailConfigError: class EmailConfigError extends Error {},
  getEmailTransport: () => ({ provider: "mailpit", send: mocks.send }),
}));
vi.mock("@/lib/quotes/send/dispatch", () => ({ sendWithRetry: mocks.sendWithRetry }));
vi.mock("@/lib/http/request-context", () => ({ getAppOrigin: () => "http://localhost:3000" }));
vi.mock("@/lib/log/server-log", () => ({ serverLog: mocks.serverLog }));

import { onQuoteResponded, type QuoteRespondedInput } from "./after-response";

const TENANT = "11111111-1111-4111-8111-111111111111";
const QUOTE = "22222222-2222-4222-8222-222222222222";
const RESPONSE = "33333333-3333-4333-8333-333333333333";
const PACKAGE = "44444444-4444-4444-8444-444444444444";
const ANA = { userId: "55555555-5555-4555-8555-555555555555", email: "ana@ejemplo.test" };
const BETO = { userId: "66666666-6666-4666-8666-666666666666", email: "beto@ejemplo.test" };

const base: QuoteRespondedInput = {
  tenantId: TENANT,
  quoteId: QUOTE,
  numberDisplay: "COT-2026-0043",
  responseId: RESPONSE,
  decision: "accepted",
};

const recipientsOf = (recipients: unknown[], audience = "author") =>
  mocks.readNoticeRecipients.mockResolvedValue({ packageId: PACKAGE, audience, recipients });

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.registerInternalNotice.mockResolvedValue(undefined);
  mocks.settleInternalNotice.mockResolvedValue(undefined);
  mocks.sendWithRetry.mockResolvedValue({ ok: true, providerMessageId: "prov-1" });
});

describe("avisar al equipo de la respuesta del cliente (H-031)", () => {
  it("pide los destinatarios a la base con los ids de la respuesta registrada", async () => {
    recipientsOf([ANA]);
    await onQuoteResponded(base);
    expect(mocks.readNoticeRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, quoteId: QUOTE, responseId: RESPONSE }),
    );
  });

  it("autor activo: el aviso sale solo a él, queda anotado y se cierra como enviado", async () => {
    recipientsOf([ANA]);
    await onQuoteResponded(base);
    expect(mocks.sendWithRetry).toHaveBeenCalledTimes(1);
    const message = mocks.sendWithRetry.mock.calls[0][1];
    expect(message.to).toBe("ana@ejemplo.test");
    expect(mocks.registerInternalNotice).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: ANA, responseId: RESPONSE, tenantId: TENANT }),
    );
    const emailId = mocks.registerInternalNotice.mock.calls[0][0].emailId;
    expect(message.idempotencyKey).toBe(emailId);
    expect(mocks.settleInternalNotice).toHaveBeenCalledWith({
      emailId,
      tenantId: TENANT,
      sent: { provider: "mailpit", providerMessageId: "prov-1" },
    });
  });

  it("sin autor activo la base entrega al Dueño y a los Administradores: un aviso por cada uno", async () => {
    recipientsOf([ANA, BETO], "managers");
    await onQuoteResponded(base);
    expect(mocks.sendWithRetry.mock.calls.map((call) => call[1].to)).toEqual([
      "ana@ejemplo.test",
      "beto@ejemplo.test",
    ]);
    expect(mocks.registerInternalNotice).toHaveBeenCalledTimes(2);
    const ids = mocks.registerInternalNotice.mock.calls.map((call) => call[0].emailId);
    expect(new Set(ids).size).toBe(2);
  });

  it("sin destinatarios no envía nada", async () => {
    recipientsOf([], "managers");
    await onQuoteResponded(base);
    expect(mocks.sendWithRetry).not.toHaveBeenCalled();
    expect(mocks.serverLog).toHaveBeenCalledWith("warn", "quote_response_notice_skipped", {
      code: "no_recipients",
    });
  });

  it("si el envío falla, queda como fallido con su código y sin datos personales en el log", async () => {
    recipientsOf([ANA]);
    mocks.sendWithRetry.mockResolvedValue({
      ok: false,
      retryable: false,
      code: "provider_rejected",
    });
    await onQuoteResponded(base);
    expect(mocks.settleInternalNotice).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "provider_rejected" }),
    );
    expect(JSON.stringify(mocks.serverLog.mock.calls)).not.toContain("ana@ejemplo.test");
  });

  it("si no se pudo anotar, el aviso igual sale y no se intenta cerrar", async () => {
    recipientsOf([ANA]);
    mocks.registerInternalNotice.mockRejectedValue(new Error("db"));
    await onQuoteResponded(base);
    expect(mocks.sendWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.settleInternalNotice).not.toHaveBeenCalled();
  });

  it("si la base falla al elegir destinatarios, no lanza y no envía", async () => {
    mocks.readNoticeRecipients.mockRejectedValue(new Error("db"));
    await expect(onQuoteResponded(base)).resolves.toBeUndefined();
    expect(mocks.sendWithRetry).not.toHaveBeenCalled();
    expect(mocks.serverLog).toHaveBeenCalledWith("error", "quote_response_notice_failed", {
      code: "unexpected",
    });
  });

  it("rechazo con comentario libre: el correo solo avisa que existe, nunca lo copia", async () => {
    recipientsOf([ANA]);
    await onQuoteResponded({
      ...base,
      decision: "rejected",
      reasonCode: "other",
      hasFreeText: true,
    });
    const message = mocks.sendWithRetry.mock.calls[0][1];
    expect(message.text).toContain("Motivo: Otro motivo.");
    expect(message.text).toContain("El cliente dejó un comentario; míralo en la cotización");
    expect(message.subject).toBe("El cliente rechazó la cotización COT-2026-0043");
    expect(message.html).toContain(`/cotizaciones/${QUOTE}`);
  });
});
