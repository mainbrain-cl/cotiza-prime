import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin-client", () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock("@/lib/crypto/pii", () => ({
  encryptPii: (
    plain: string,
    ctx: { table: string; field: string; tenantId: string; rowId: string },
  ) => `cifrado(${plain})|${ctx.table}.${ctx.field}|${ctx.tenantId}|${ctx.rowId}`,
}));
vi.mock("@/lib/crypto/search-hash", () => ({
  searchHash: (field: string, tenantId: string, value: string) =>
    `huella(${field}|${tenantId}|${value})`,
}));

import {
  TeamGatewayError,
  reserveInvitationNotices,
  readInvitationNotice,
  registerInvitationNotice,
  settleInvitationEmail,
} from "./gateway";

const TENANT = "11111111-1111-4111-8111-111111111111";
const INVITATION = "22222222-2222-4222-8222-222222222222";
const EMAIL_ID = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";

beforeEach(() => rpc.mockReset());

describe("settleInvitationEmail", () => {
  it("envía el proveedor y su identificador cuando salió", async () => {
    rpc.mockResolvedValue({ data: { status: "sent" }, error: null });
    const result = await settleInvitationEmail({
      emailId: EMAIL_ID,
      sent: { provider: "mailpit", providerMessageId: "abc" },
    });
    expect(result).toEqual({ exhausted: false });
    expect(rpc).toHaveBeenCalledWith("invitation_email_settle", {
      p_email_id: EMAIL_ID,
      p_provider: "mailpit",
      p_provider_message_id: "abc",
      p_error_code: null,
    });
  });

  it("si falló, envía solo un código (y «unknown» si no hay)", async () => {
    rpc.mockResolvedValue({ data: { status: "failed", exhausted: true }, error: null });
    expect(await settleInvitationEmail({ emailId: EMAIL_ID, errorCode: "timeout" })).toEqual({
      exhausted: true,
    });
    expect(rpc).toHaveBeenLastCalledWith("invitation_email_settle", {
      p_email_id: EMAIL_ID,
      p_provider: null,
      p_provider_message_id: null,
      p_error_code: "timeout",
    });
    await settleInvitationEmail({ emailId: EMAIL_ID });
    expect(rpc).toHaveBeenLastCalledWith(
      "invitation_email_settle",
      expect.objectContaining({ p_error_code: "unknown" }),
    );
  });

  it("un error de la base se convierte en un error con solo el código", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "CP404", message: "algo@ejemplo.test" } });
    const error = await settleInvitationEmail({ emailId: EMAIL_ID }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamGatewayError);
    expect((error as Error).message).toBe("team_gateway_settle:CP404");
  });
});

describe("reserveInvitationNotices", () => {
  it("reserva hasta el tope y entrega solo identificadores y la cuenta de agotados", async () => {
    rpc.mockResolvedValue({ data: { invitation_ids: [INVITATION], exhausted: 2 }, error: null });
    expect(await reserveInvitationNotices(20)).toEqual({
      invitationIds: [INVITATION],
      exhausted: 2,
    });
    expect(rpc).toHaveBeenCalledWith("invitation_notices_pending", {
      p_limit: 20,
      p_invitation_id: null,
    });
  });

  it("con un identificador reserva solo ese aviso (el intento inmediato)", async () => {
    rpc.mockResolvedValue({ data: { invitation_ids: [INVITATION], exhausted: 0 }, error: null });
    await reserveInvitationNotices(1, INVITATION);
    expect(rpc).toHaveBeenCalledWith("invitation_notices_pending", {
      p_limit: 1,
      p_invitation_id: INVITATION,
    });
  });

  it("una respuesta mal formada o un error de la base lanzan un error con código", async () => {
    rpc.mockResolvedValue({ data: { invitation_ids: ["no-uuid"], exhausted: 0 }, error: null });
    await expect(reserveInvitationNotices(5)).rejects.toThrow("team_gateway_notices_pending:shape");
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "x" } });
    await expect(reserveInvitationNotices(5)).rejects.toThrow("team_gateway_notices_pending:42501");
  });
});

describe("readInvitationNotice", () => {
  const body = {
    tenant_id: TENANT,
    tenant_name: "Negocio Demo",
    inviter_name: "Mixta Doble",
    role: "admin",
    invited_at: "2026-10-30T15:00:00.000Z",
    recipients: [{ user_id: OWNER, email: "duena@ejemplo.test" }],
  };

  it("devuelve los datos del aviso y a quién va", async () => {
    rpc.mockResolvedValue({ data: body, error: null });
    expect(await readInvitationNotice(INVITATION)).toEqual({
      exhaustedReason: null,
      notice: {
        tenantId: TENANT,
        tenantName: "Negocio Demo",
        inviterName: "Mixta Doble",
        role: "admin",
        invitedAt: "2026-10-30T15:00:00.000Z",
        recipients: [{ userId: OWNER, email: "duena@ejemplo.test" }],
      },
    });
    expect(rpc).toHaveBeenCalledWith("invitation_notice_recipients", {
      p_invitation_id: INVITATION,
    });
  });

  it("sin intento reservado la base no entrega destinatarios: no hay aviso", async () => {
    rpc.mockResolvedValue({ data: { recipients: [] }, error: null });
    expect(await readInvitationNotice(INVITATION)).toEqual({ notice: null, exhaustedReason: null });
  });

  it("si no hay un Dueño con correo, la base lo da por agotado y lo dice (no_recipient)", async () => {
    rpc.mockResolvedValue({ data: { recipients: [], exhausted: "no_recipient" }, error: null });
    expect(await readInvitationNotice(INVITATION)).toEqual({
      notice: null,
      exhaustedReason: "no_recipient",
    });
  });

  it("sin nombre de quien invita, lo entrega como nulo (el armador usa el respaldo)", async () => {
    rpc.mockResolvedValue({ data: { ...body, inviter_name: null }, error: null });
    expect((await readInvitationNotice(INVITATION)).notice?.inviterName).toBeNull();
  });

  it("una respuesta incompleta o un error de la base lanzan un error con código", async () => {
    rpc.mockResolvedValue({ data: { ...body, tenant_name: undefined }, error: null });
    await expect(readInvitationNotice(INVITATION)).rejects.toThrow(
      "team_gateway_notice_recipients:shape",
    );
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "x" } });
    await expect(readInvitationNotice(INVITATION)).rejects.toThrow(
      "team_gateway_notice_recipients:XX000",
    );
  });
});

describe("registerInvitationNotice", () => {
  const input = {
    emailId: EMAIL_ID,
    invitationId: INVITATION,
    tenantId: TENANT,
    recipient: { userId: OWNER, email: "  Duena@Ejemplo.TEST " },
  };

  it("cifra el correo del Dueño con el sello del registro y manda su huella; nunca el correo en claro", async () => {
    rpc.mockResolvedValue({ data: { registered: true }, error: null });
    expect(await registerInvitationNotice(input)).toBe(true);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, string>];
    expect(name).toBe("invitation_notice_register");
    expect(args.p_to_email_enc).toBe(
      `cifrado(duena@ejemplo.test)|email_messages.to_email|${TENANT}|${EMAIL_ID}`,
    );
    expect(args.p_to_email_hash).toBe(`huella(email|${TENANT}|duena@ejemplo.test)`);
    expect(args.p_to_user_id).toBe(OWNER);
    expect(args.p_invitation_id).toBe(INVITATION);
    expect(Object.keys(args)).not.toContain("p_tenant_id");
    expect(JSON.stringify(args)).not.toContain("Duena@Ejemplo");
  });

  it("si la base dice que no lo anotó, devuelve falso (no se envía)", async () => {
    rpc.mockResolvedValue({ data: { registered: false }, error: null });
    expect(await registerInvitationNotice(input)).toBe(false);
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await registerInvitationNotice(input)).toBe(false);
  });

  it("«el destinatario no es el Dueño» y otros errores de la base se lanzan solo con su código", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "recipient_not_owner" } });
    await expect(registerInvitationNotice(input)).rejects.toThrow(
      "team_gateway_notice_register:42501",
    );
  });
});
