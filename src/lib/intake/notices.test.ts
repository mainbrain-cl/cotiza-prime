import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readIntakeNoticeRecipients: vi.fn(),
  registerIntakeNotice: vi.fn(),
  settleIntakeNotice: vi.fn(),
  sendWithRetry: vi.fn(),
  serverLog: vi.fn(),
  send: vi.fn(),
}));

vi.mock("./gateway", () => ({
  IntakeGatewayError: class IntakeGatewayError extends Error {},
  readIntakeNoticeRecipients: mocks.readIntakeNoticeRecipients,
  registerIntakeNotice: mocks.registerIntakeNotice,
  settleIntakeNotice: mocks.settleIntakeNotice,
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

import { notifyCapReached, notifyRequestReceived } from "./notices";

const TENANT = "11111111-1111-4111-8111-111111111111";
const FORM = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const ANA = { userId: "55555555-5555-4555-8555-555555555555", email: "ana@ejemplo.test" };
const BETO = { userId: "66666666-6666-4666-8666-666666666666", email: "beto@ejemplo.test" };

const info = (overrides: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  formId: FORM,
  formName: "Fletes web",
  limited: false,
  recipients: [ANA, BETO],
  ...overrides,
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.readIntakeNoticeRecipients.mockResolvedValue(info());
  mocks.registerIntakeNotice.mockResolvedValue({ registered: true });
  mocks.settleIntakeNotice.mockResolvedValue(undefined);
  mocks.sendWithRetry.mockResolvedValue({ ok: true, providerMessageId: "m-1" });
});

describe("«Llegó una solicitud»", () => {
  it("avisa a cada destinatario que entrega la base: lo anota, lo envía y lo cierra", async () => {
    await notifyRequestReceived(REQUEST);
    expect(mocks.readIntakeNoticeRecipients).toHaveBeenCalledWith({
      kind: "request_received",
      requestId: REQUEST,
    });
    expect(mocks.registerIntakeNotice).toHaveBeenCalledTimes(2);
    expect(mocks.registerIntakeNotice.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      kind: "request_received",
      requestId: REQUEST,
      recipient: ANA,
    });
    expect(mocks.sendWithRetry).toHaveBeenCalledTimes(2);
    expect(mocks.settleIntakeNotice).toHaveBeenCalledTimes(2);
    expect(mocks.settleIntakeNotice.mock.calls[0][0]).toMatchObject({
      sent: { provider: "mailpit", providerMessageId: "m-1" },
    });
  });

  it("el correo lleva solo el nombre del formulario y un botón a la aplicación, sin datos del visitante", async () => {
    await notifyRequestReceived(REQUEST);
    const message = mocks.sendWithRetry.mock.calls[0][1];
    expect(message.to).toBe("ana@ejemplo.test");
    expect(message.subject).toBe("Llegó una solicitud");
    expect(message.text).toContain("Fletes web");
    expect(message.text).toContain(`http://localhost:3000/o/${TENANT}/solicitudes`);
    expect(message.html).toContain(`http://localhost:3000/o/${TENANT}/solicitudes`);
    // nunca el identificador de la solicitud ni nada del visitante
    expect(message.text + message.html).not.toContain(REQUEST);
    expect(message.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("con el tope diario alcanzado o sin destinatarios no envía nada", async () => {
    mocks.readIntakeNoticeRecipients.mockResolvedValue(info({ limited: true, recipients: [] }));
    await notifyRequestReceived(REQUEST);
    mocks.readIntakeNoticeRecipients.mockResolvedValue(info({ recipients: [] }));
    await notifyRequestReceived(REQUEST);
    expect(mocks.sendWithRetry).not.toHaveBeenCalled();
    expect(mocks.registerIntakeNotice).not.toHaveBeenCalled();
  });

  it("si hay más de 10 destinatarios, avisa a 10 y deja el corte anotado en el log, sin direcciones", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      userId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      email: `admin${i}@ejemplo.test`,
    }));
    mocks.readIntakeNoticeRecipients.mockResolvedValue(info({ recipients: many }));
    await notifyRequestReceived(REQUEST);
    expect(mocks.sendWithRetry).toHaveBeenCalledTimes(10);
    const logged = mocks.serverLog.mock.calls.find(
      ([, message]) => message === "intake_notice_recipients_truncated",
    );
    expect(logged?.[2]).toEqual({ code: "recipients_over_limit", recipients: 12, limit: 10 });
    expect(JSON.stringify(mocks.serverLog.mock.calls)).not.toContain("@ejemplo.test");
  });

  it("si la base responde que no se registró, el correo NO sale", async () => {
    mocks.registerIntakeNotice.mockResolvedValue({ registered: false, reason: "daily_limit" });
    await notifyRequestReceived(REQUEST);
    expect(mocks.sendWithRetry).not.toHaveBeenCalled();
    expect(mocks.settleIntakeNotice).not.toHaveBeenCalled();
  });

  it("si el registro falla, el correo no sale y no se lanza nada", async () => {
    mocks.registerIntakeNotice.mockRejectedValue(new Error("boom"));
    await expect(notifyRequestReceived(REQUEST)).resolves.toBeUndefined();
    expect(mocks.sendWithRetry).not.toHaveBeenCalled();
  });

  it("un envío fallido se cierra con solo un código y el log no lleva el correo", async () => {
    mocks.sendWithRetry.mockResolvedValue({ ok: false, code: "timeout", retryable: true });
    await notifyRequestReceived(REQUEST);
    expect(mocks.settleIntakeNotice.mock.calls[0][0]).toMatchObject({ errorCode: "timeout" });
    const logged = JSON.stringify(mocks.serverLog.mock.calls);
    expect(logged).not.toContain("ana@ejemplo.test");
    expect(logged).not.toContain("Fletes web");
  });

  it("si la lectura de destinatarios falla, no lanza: solo deja un código en el log", async () => {
    mocks.readIntakeNoticeRecipients.mockRejectedValue(new Error("intake_gateway_x"));
    await expect(notifyRequestReceived(REQUEST)).resolves.toBeUndefined();
    expect(mocks.serverLog).toHaveBeenCalledWith("error", "intake_notice_failed", {
      code: "unexpected",
    });
  });
});

describe("«Tu formulario llegó al tope de hoy»", () => {
  it("avisa por el formulario, con el texto según el tipo de tope y un botón al formulario", async () => {
    await notifyCapReached(FORM, "form");
    expect(mocks.readIntakeNoticeRecipients).toHaveBeenCalledWith({
      kind: "intake_cap_reached",
      formId: FORM,
    });
    expect(mocks.registerIntakeNotice.mock.calls[0][0]).toMatchObject({
      kind: "intake_cap_reached",
      formId: FORM,
    });
    const form = mocks.sendWithRetry.mock.calls[0][1];
    expect(form.subject).toBe("Tu formulario llegó al tope de hoy");
    expect(form.text).toContain(`http://localhost:3000/o/${TENANT}/formularios/${FORM}`);

    mocks.sendWithRetry.mockClear();
    await notifyCapReached(FORM, "org");
    expect(mocks.sendWithRetry.mock.calls[0][1].subject).toBe(
      "Tu organización llegó al tope diario de solicitudes",
    );
  });
});
