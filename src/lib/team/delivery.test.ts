import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "@/lib/email/types";

const gateway = {
  readInvitationNotice: vi.fn(),
  registerInvitationNotice: vi.fn(),
  settleInvitationEmail: vi.fn(),
  reserveInvitationNotices: vi.fn(),
};
vi.mock("./gateway", () => ({
  TeamGatewayError: class extends Error {},
  readInvitationNotice: (...args: unknown[]) => gateway.readInvitationNotice(...args),
  registerInvitationNotice: (...args: unknown[]) => gateway.registerInvitationNotice(...args),
  settleInvitationEmail: (...args: unknown[]) => gateway.settleInvitationEmail(...args),
  reserveInvitationNotices: (...args: unknown[]) => gateway.reserveInvitationNotices(...args),
}));

const send = vi.fn();
const getEmailTransport = vi.fn();
vi.mock("@/lib/email/transport", () => ({
  EmailConfigError: class EmailConfigError extends Error {},
  getEmailTransport: () => getEmailTransport(),
}));
vi.mock("@/lib/email/config", () => ({
  loadEmailConfig: () => ({ fromAddress: "cotizaciones@ejemplo.test" }),
}));
const getAppOrigin = vi.fn();
vi.mock("@/lib/http/request-context", () => ({ getAppOrigin: () => getAppOrigin() }));
const serverLog = vi.fn();
vi.mock("@/lib/log/server-log", () => ({
  serverLog: (...args: unknown[]) => serverLog(...args),
}));

import { deliverPendingInvitationNotices, notifyOwnerOfInvitation } from "./delivery";

const TENANT = "11111111-1111-4111-8111-111111111111";
const INVITATION = "22222222-2222-4222-8222-222222222222";
const OWNER = "44444444-4444-4444-8444-444444444444";
const INVITEE = "persona.nueva@ejemplo.test";

const info = (over: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  tenantName: "Negocio Demo",
  inviterName: "Mixta Doble",
  role: "admin",
  invitedAt: "2026-10-30T15:00:00.000Z",
  invitationStatus: "pending",
  recipients: [{ userId: OWNER, email: "duena@ejemplo.test" }],
  ...over,
});

/** Lo que entrega `readInvitationNotice` con un intento reservado. */
const read = (over: Record<string, unknown> = {}) => ({
  notice: info(over),
  exhaustedReason: null,
});

beforeEach(() => {
  for (const fn of [...Object.values(gateway), send, getEmailTransport, getAppOrigin, serverLog]) {
    fn.mockReset();
  }
  gateway.reserveInvitationNotices.mockResolvedValue({ invitationIds: [INVITATION], exhausted: 0 });
  gateway.readInvitationNotice.mockResolvedValue(read());
  gateway.registerInvitationNotice.mockResolvedValue(true);
  gateway.settleInvitationEmail.mockResolvedValue({ exhausted: false });
  send.mockResolvedValue({ ok: true, providerMessageId: "msg-1" });
  getEmailTransport.mockReturnValue({ provider: "memory", send });
  getAppOrigin.mockReturnValue("http://localhost:3000");
});

const logged = () => JSON.stringify(serverLog.mock.calls);

describe("notifyOwnerOfInvitation", () => {
  it("camino feliz: anota el intento, envía el aviso al Dueño y cierra el registro como enviado", async () => {
    await notifyOwnerOfInvitation(INVITATION);
    // El intento inmediato RESERVA primero (gasta un intento en la base) y solo ese aviso.
    expect(gateway.reserveInvitationNotices).toHaveBeenCalledWith(1, INVITATION);
    expect(gateway.readInvitationNotice).toHaveBeenCalledWith(INVITATION);
    expect(gateway.registerInvitationNotice).toHaveBeenCalledTimes(1);
    const registered = gateway.registerInvitationNotice.mock.calls[0][0] as {
      emailId: string;
      invitationId: string;
      tenantId: string;
      recipient: { userId: string };
    };
    expect(registered).toMatchObject({ invitationId: INVITATION, tenantId: TENANT });
    expect(registered.recipient.userId).toBe(OWNER);

    const message = send.mock.calls[0][0] as EmailMessage;
    expect(message.to).toBe("duena@ejemplo.test");
    expect(message.subject).toBe(
      "Mixta Doble invitó a una persona a Negocio Demo como Administrador",
    );
    expect(message.html).toContain(`href="http://localhost:3000/o/${TENANT}/equipo"`);
    expect(message.idempotencyKey).toBe(registered.emailId);
    expect(gateway.settleInvitationEmail).toHaveBeenCalledWith({
      emailId: registered.emailId,
      sent: { provider: "memory", providerMessageId: "msg-1" },
    });
    expect(serverLog).not.toHaveBeenCalled();
  });

  it("una invitación ya aceptada: el aviso no promete cancelar y el botón lleva al inicio, no a «Tu equipo»", async () => {
    gateway.readInvitationNotice.mockResolvedValue(read({ invitationStatus: "accepted" }));
    await notifyOwnerOfInvitation(INVITATION);
    const message = send.mock.calls[0][0] as EmailMessage;
    expect(message.text).toContain("La persona ya aceptó y es Administrador de tu organización.");
    expect(message.text).not.toMatch(/cancel/i);
    expect(message.html).toContain(`href="http://localhost:3000/o/${TENANT}"`);
    expect(message.html).not.toContain("/equipo");
  });

  it("si la base no entrega la reserva (no toca, ya se hizo o lo tomó otra tarea) no se lee ni se envía nada", async () => {
    gateway.reserveInvitationNotices.mockResolvedValue({ invitationIds: [], exhausted: 0 });
    await notifyOwnerOfInvitation(INVITATION);
    expect(gateway.readInvitationNotice).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // ...ni se atiende una reserva de OTRA invitación.
    gateway.reserveInvitationNotices.mockResolvedValue({
      invitationIds: ["55555555-5555-4555-8555-555555555555"],
      exhausted: 0,
    });
    await notifyOwnerOfInvitation(INVITATION);
    expect(gateway.readInvitationNotice).not.toHaveBeenCalled();
  });

  it("sin Dueño con correo la base lo da por agotado: queda en el log con su código y no se envía", async () => {
    gateway.readInvitationNotice.mockResolvedValue({
      notice: null,
      exhaustedReason: "no_recipient",
    });
    await notifyOwnerOfInvitation(INVITATION);
    expect(serverLog).toHaveBeenCalledWith("error", "invitation_notice_exhausted", {
      code: "no_recipient",
    });
    expect(gateway.registerInvitationNotice).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("un rol desconocido cierra el intento con su propio código (invalid_role), no con «unexpected»", async () => {
    gateway.readInvitationNotice.mockResolvedValue(read({ role: "otro-rol" }));
    await notifyOwnerOfInvitation(INVITATION);
    expect(send).not.toHaveBeenCalled();
    expect(gateway.settleInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "invalid_role" }),
    );
    expect(serverLog).toHaveBeenCalledWith("warn", "invitation_notice_failed", {
      code: "invalid_role",
    });
  });

  it("la base no lo anota (no corresponde, ya se hizo o aún no toca): no se registra ni se envía nada", async () => {
    gateway.readInvitationNotice.mockResolvedValue({ notice: null, exhaustedReason: null });
    await notifyOwnerOfInvitation(INVITATION);
    expect(gateway.registerInvitationNotice).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(gateway.settleInvitationEmail).not.toHaveBeenCalled();
  });

  it("la base se niega a registrar el intento: no se envía", async () => {
    gateway.registerInvitationNotice.mockResolvedValue(false);
    await notifyOwnerOfInvitation(INVITATION);
    expect(send).not.toHaveBeenCalled();
    expect(gateway.settleInvitationEmail).not.toHaveBeenCalled();
  });

  it("no se pudo armar el correo: se cierra como fallido con el código y no se envía", async () => {
    gateway.readInvitationNotice.mockResolvedValue(
      read({ recipients: [{ userId: OWNER, email: "no-es-un-correo" }] }),
    );
    await notifyOwnerOfInvitation(INVITATION);
    expect(send).not.toHaveBeenCalled();
    expect(gateway.settleInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "invalid_input" }),
    );
    expect(serverLog).toHaveBeenCalledWith("warn", "invitation_notice_failed", {
      code: "invalid_input",
    });
  });

  it("el envío falla: se cierra como fallido con el código del proveedor", async () => {
    send.mockResolvedValue({ ok: false, retryable: false, code: "provider_rejected" });
    await notifyOwnerOfInvitation(INVITATION);
    expect(gateway.settleInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "provider_rejected" }),
    );
    expect(serverLog).toHaveBeenCalledWith("warn", "invitation_notice_failed", {
      code: "provider_rejected",
    });
    expect(serverLog).not.toHaveBeenCalledWith(
      "error",
      "invitation_notice_exhausted",
      expect.anything(),
    );
  });

  it("si era el último intento permitido, queda a la vista en el log (solo un código)", async () => {
    send.mockResolvedValue({ ok: false, retryable: false, code: "provider_rejected" });
    gateway.settleInvitationEmail.mockResolvedValue({ exhausted: true });
    await notifyOwnerOfInvitation(INVITATION);
    expect(serverLog).toHaveBeenCalledWith("error", "invitation_notice_exhausted", {
      code: "max_attempts",
    });
  });

  it("si algo falla entre anotar y cerrar (p. ej. la dirección de la aplicación), el registro se cierra igual", async () => {
    getAppOrigin.mockImplementation(() => {
      throw new Error("Falta APP_ORIGIN");
    });
    await expect(notifyOwnerOfInvitation(INVITATION)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(gateway.settleInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "unexpected" }),
    );
  });

  it("si el proveedor lanza una excepción, también se cierra como fallido", async () => {
    getEmailTransport.mockImplementation(() => {
      throw new Error("sin proveedor");
    });
    await notifyOwnerOfInvitation(INVITATION);
    expect(gateway.settleInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "unexpected" }),
    );
  });

  it.each([" ", "", "​", "‮"])(
    "un nombre de quien invita sin texto visible (%j) NO silencia el aviso",
    async (name) => {
      gateway.readInvitationNotice.mockResolvedValue(read({ inviterName: name }));
      await notifyOwnerOfInvitation(INVITATION);
      expect(send).toHaveBeenCalledTimes(1);
      expect((send.mock.calls[0][0] as EmailMessage).subject).toContain(
        "Un miembro del equipo invitó a una persona",
      );
      expect(gateway.settleInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ sent: expect.anything() }),
      );
    },
  );

  it("sin nombre (nulo) tampoco", async () => {
    gateway.readInvitationNotice.mockResolvedValue(read({ inviterName: null }));
    await notifyOwnerOfInvitation(INVITATION);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("NUNCA lanza: ni si la base falla al leer, ni al registrar, ni al cerrar", async () => {
    gateway.readInvitationNotice.mockRejectedValue(new Error("boom " + INVITEE));
    await expect(notifyOwnerOfInvitation(INVITATION)).resolves.toBeUndefined();
    gateway.readInvitationNotice.mockResolvedValue(read());
    gateway.registerInvitationNotice.mockRejectedValue(new Error("boom " + INVITEE));
    await expect(notifyOwnerOfInvitation(INVITATION)).resolves.toBeUndefined();
    gateway.registerInvitationNotice.mockResolvedValue(true);
    gateway.settleInvitationEmail.mockRejectedValue(new Error("boom " + INVITEE));
    await expect(notifyOwnerOfInvitation(INVITATION)).resolves.toBeUndefined();
    expect(serverLog).toHaveBeenCalled();
    // Los registros llevan solo códigos: nada del mensaje de los errores ni de correos.
    expect(logged()).not.toContain(INVITEE);
    expect(logged()).not.toContain("duena@ejemplo.test");
  });
});

describe("deliverPendingInvitationNotices (la tarea)", () => {
  it("atiende cada invitación pendiente que entrega la base", async () => {
    gateway.reserveInvitationNotices.mockResolvedValue({
      invitationIds: [INVITATION, "55555555-5555-4555-8555-555555555555"],
      exhausted: 0,
    });
    const result = await deliverPendingInvitationNotices(7);
    // Una sola reserva para toda la tanda; cada aviso reservado se envía sin volver a reservar.
    expect(gateway.reserveInvitationNotices).toHaveBeenCalledTimes(1);
    expect(gateway.reserveInvitationNotices).toHaveBeenCalledWith(7);
    expect(gateway.readInvitationNotice).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ attended: 2, exhausted: 0, failed: false });
  });

  it("deja en el log los avisos que acaban de agotar sus intentos", async () => {
    gateway.reserveInvitationNotices.mockResolvedValue({ invitationIds: [], exhausted: 3 });
    expect(await deliverPendingInvitationNotices()).toEqual({
      attended: 0,
      exhausted: 3,
      failed: false,
    });
    expect(serverLog).toHaveBeenCalledWith("error", "invitation_notice_exhausted", {
      code: "max_attempts",
    });
  });

  it("si la base falla al listar, no lanza y lo deja en el log", async () => {
    gateway.reserveInvitationNotices.mockRejectedValue(new Error("boom"));
    expect(await deliverPendingInvitationNotices()).toEqual({
      attended: 0,
      exhausted: 0,
      failed: true,
    });
    expect(serverLog).toHaveBeenCalledWith(
      "error",
      "invitation_notice_job_failed",
      expect.anything(),
    );
  });

  it("un aviso que falla no impide atender los demás", async () => {
    gateway.reserveInvitationNotices.mockResolvedValue({
      invitationIds: [INVITATION, "55555555-5555-4555-8555-555555555555"],
      exhausted: 0,
    });
    gateway.readInvitationNotice.mockRejectedValueOnce(new Error("boom"));
    const result = await deliverPendingInvitationNotices();
    expect(result.attended).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
