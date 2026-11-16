import { beforeEach, describe, expect, it, vi } from "vitest";

const loadEmailConfig = vi.fn();
const getEmailTransport = vi.fn();
const sendWithRetry = vi.fn();
const serverLog = vi.fn();

vi.mock("@/lib/email/config", () => ({ loadEmailConfig: () => loadEmailConfig() }));
vi.mock("@/lib/email/transport", () => ({
  EmailConfigError: class extends Error {},
  getEmailTransport: (...args: unknown[]) => getEmailTransport(...args),
}));
vi.mock("@/lib/quotes/send/dispatch", () => ({
  sendWithRetry: (...args: unknown[]) => sendWithRetry(...args),
}));
vi.mock("@/lib/http/request-context", () => ({ getAppOrigin: () => "https://app.ejemplo.test" }));
vi.mock("@/lib/log/server-log", () => ({
  serverLog: (...args: unknown[]) => serverLog(...args),
}));

const { sendRecoveryCodesCreatedNotice } = await import("./mfa-account-notice-send");

const RECIPIENT = "ana@ejemplo.test";

beforeEach(() => {
  for (const mock of [loadEmailConfig, getEmailTransport, sendWithRetry, serverLog]) {
    mock.mockReset();
  }
  loadEmailConfig.mockReturnValue({ fromAddress: "cotizaciones@ejemplo.test" });
  getEmailTransport.mockReturnValue({ name: "transporte" });
  sendWithRetry.mockResolvedValue({ ok: true });
});

describe("sendRecoveryCodesCreatedNotice", () => {
  it("envía el aviso al correo dado, con el botón a «recuperar contraseña» y sin ningún código", async () => {
    expect(await sendRecoveryCodesCreatedNotice(RECIPIENT, new Date("2026-11-16T15:00:00Z"))).toBe(
      true,
    );
    const [transport, message] = sendWithRetry.mock.calls[0];
    expect(transport).toEqual({ name: "transporte" });
    expect(message.to).toBe(RECIPIENT);
    expect(message.subject).toBe("Creaste códigos de respaldo nuevos en tu cuenta");
    expect(message.text).toContain("https://app.ejemplo.test/recuperar-contrasena");
    expect(message.text).not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/);
  });

  it("si el proveedor rechaza, devuelve false y registra solo el código", async () => {
    sendWithRetry.mockResolvedValue({ ok: false, retryable: false, code: "provider_rejected" });
    expect(await sendRecoveryCodesCreatedNotice(RECIPIENT)).toBe(false);
    expect(serverLog).toHaveBeenCalledWith("warn", "mfa_recovery_codes_notice_failed", {
      code: "provider_rejected",
    });
    expect(JSON.stringify(serverLog.mock.calls)).not.toContain(RECIPIENT);
  });

  it("si la configuración del correo falla (o el correo no es válido), devuelve false sin lanzar", async () => {
    loadEmailConfig.mockImplementation(() => {
      throw new Error("sin configuración");
    });
    expect(await sendRecoveryCodesCreatedNotice(RECIPIENT)).toBe(false);
    loadEmailConfig.mockReturnValue({ fromAddress: "cotizaciones@ejemplo.test" });
    expect(await sendRecoveryCodesCreatedNotice("no-es-un-correo")).toBe(false);
    expect(sendWithRetry).not.toHaveBeenCalled();
  });
});
