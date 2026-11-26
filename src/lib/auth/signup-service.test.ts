import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareSignupLink: vi.fn(),
  send: vi.fn(),
  serverLog: vi.fn(),
  getAppOrigin: vi.fn(),
}));
vi.mock("./signup-gateway", () => ({
  prepareSignupLink: mocks.prepareSignupLink,
  SignupGatewayError: class SignupGatewayError extends Error {},
}));
vi.mock("@/lib/email/transport", () => ({
  getEmailTransport: () => ({ provider: "memory", send: mocks.send }),
  EmailConfigError: class EmailConfigError extends Error {},
}));
vi.mock("@/lib/email/config", () => ({
  loadEmailConfig: () => ({ fromAddress: "cotizaciones@ejemplo.test" }),
}));
vi.mock("@/lib/quotes/send/dispatch", () => ({
  sendWithRetry: (transport: { send: (message: unknown) => unknown }, message: unknown) =>
    transport.send(message),
}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: mocks.serverLog }));
vi.mock("@/lib/http/request-context", () => ({ getAppOrigin: mocks.getAppOrigin }));

import { confirmEmailUrl, sendSignupLink } from "./signup-service";

const EMAIL = "nueva@ejemplo.test";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getAppOrigin.mockReturnValue("https://app.cotizaprime.example");
  mocks.send.mockResolvedValue({ ok: true, providerMessageId: "m1" });
  mocks.prepareSignupLink.mockResolvedValue({ status: "ready", tokenHash: "hash-abc_123" });
});

describe("el enlace del correo del registro", () => {
  it("se arma SIEMPRE con APP_ORIGIN, con el código y el tipo invite", () => {
    expect(confirmEmailUrl("hash-abc_123")).toBe(
      "https://app.cotizaprime.example/confirmar-correo?token_hash=hash-abc_123&type=invite",
    );
  });

  it("un código con caracteres raros no puede cambiar la dirección ni el sitio", () => {
    const url = new URL(confirmEmailUrl("a&type=otro#x/../../evil"));
    expect(url.origin).toBe("https://app.cotizaprime.example");
    expect(url.pathname).toBe("/confirmar-correo");
    expect(url.searchParams.get("type")).toBe("invite");
    expect(url.searchParams.get("token_hash")).toBe("a&type=otro#x/../../evil");
  });
});

describe("sendSignupLink", () => {
  it("prepara la cuenta y envía UN correo al correo pedido, con el enlace de nuestra aplicación", async () => {
    expect(await sendSignupLink(EMAIL)).toBe("sent");
    expect(mocks.prepareSignupLink).toHaveBeenCalledWith(EMAIL);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const message = mocks.send.mock.calls[0][0];
    expect(message.to).toBe(EMAIL);
    expect(message.subject).toBe("Confirma tu correo para crear tu cuenta en Cotiza Prime");
    expect(message.text).toContain(
      "https://app.cotizaprime.example/confirmar-correo?token_hash=hash-abc_123&type=invite",
    );
  });

  it("cada correo lleva una clave anti-duplicado nueva (cada enlace es distinto)", async () => {
    await sendSignupLink(EMAIL);
    await sendSignupLink(EMAIL);
    const [a, b] = mocks.send.mock.calls.map(([message]) => message.idempotencyKey);
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("con una cuenta ya verificada no envía NADA", async () => {
    mocks.prepareSignupLink.mockResolvedValue({ status: "already_registered" });
    expect(await sendSignupLink(EMAIL)).toBe("already_registered");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("si falla la pasarela o el proveedor, no lanza: deja solo un código en el registro (sin correo ni enlace)", async () => {
    mocks.prepareSignupLink.mockRejectedValue(new Error("signup_gateway_password:500"));
    expect(await sendSignupLink(EMAIL)).toBe("not_sent");
    mocks.prepareSignupLink.mockResolvedValue({ status: "ready", tokenHash: "hash-secreto" });
    mocks.send.mockResolvedValue({ ok: false, retryable: false, code: "provider_rejected" });
    expect(await sendSignupLink(EMAIL)).toBe("not_sent");
    const logged = JSON.stringify(mocks.serverLog.mock.calls);
    expect(mocks.serverLog).toHaveBeenCalledTimes(2);
    expect(logged).toContain("provider_rejected");
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain("hash-secreto");
  });

  it("si falta APP_ORIGIN en producción no lanza ni envía un enlace a otro sitio", async () => {
    mocks.getAppOrigin.mockImplementation(() => {
      throw new Error("Falta la variable de entorno APP_ORIGIN");
    });
    expect(await sendSignupLink(EMAIL)).toBe("not_sent");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
