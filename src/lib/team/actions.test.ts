import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptPii } from "@/lib/crypto/pii";
import { MEMBER_ROLES, NO_PERMISSION_MESSAGE } from "@/lib/permissions/matrix";
import { hashInvitationToken, invitationEmailBinding } from "./invitation-code";

// Las acciones de «Tu equipo» con un falso miembro de cada rol: quien no maneja el equipo recibe el mensaje
// único y la base NI SE CONSULTA; quien sí, llega a las funciones de la base con el correo cifrado.

const TENANT_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0001";
const USER_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0002";
const INVITATION_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0003";
const EMAIL = "persona.nueva@ejemplo.test";

const rpc = vi.fn();
const from = vi.fn();
const deliver = vi.fn();
const notifyOwner = vi.fn();
let role = "owner";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// `after` corre lo que se le da DESPUÉS de responder; en la prueba se junta y se vacía a mano.
const afterTasks: (() => Promise<void>)[] = [];
vi.mock("next/server", () => ({
  after: (task: () => Promise<void>) => {
    afterTasks.push(task);
  },
}));
const runAfter = async () => {
  for (const task of afterTasks.splice(0)) await task();
};
vi.mock("@/lib/tenant/active-tenant", () => ({
  requireActiveTenant: vi.fn(async () => ({
    tenantId: TENANT_ID,
    tenantName: "Negocio de Prueba",
    role,
    userId: USER_ID,
    supabase: { rpc, from },
  })),
}));
vi.mock("./delivery", () => ({
  deliverInvitationEmail: (input: unknown) => deliver(input),
  notifyOwnerOfInvitation: (id: string) => notifyOwner(id),
}));

const { inviteMemberAction, resendInvitationAction, revokeInvitationAction } =
  await import("./actions");

const ENV_VARS = ["CP_PII_KEY_CURRENT", "CP_PII_KEY_V1", "CP_SEARCH_KEY_V1"] as const;
const saved: Record<string, string | undefined> = {};
const logged: string[] = [];

beforeEach(() => {
  for (const name of ENV_VARS) saved[name] = process.env[name];
  process.env.CP_PII_KEY_CURRENT = "v1";
  process.env.CP_PII_KEY_V1 = randomBytes(32).toString("base64");
  process.env.CP_SEARCH_KEY_V1 = randomBytes(32).toString("base64");
  role = "owner";
  rpc.mockReset();
  from.mockReset();
  deliver.mockReset();
  deliver.mockResolvedValue(true);
  afterTasks.length = 0;
  notifyOwner.mockReset();
  notifyOwner.mockResolvedValue(undefined);
  logged.length = 0;
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.restoreAllMocks();
});

const form = (email: string, roleValue: string) => {
  const data = new FormData();
  data.set("email", email);
  data.set("role", roleValue);
  return data;
};
const IDLE = { status: "idle" } as const;
const MANAGERS = ["owner", "admin"];

describe("quien no maneja el equipo no llega a la base", () => {
  const withoutPermission = MEMBER_ROLES.filter((r) => !MANAGERS.includes(r));

  it.each(withoutPermission)(
    "%s: invitar da «sin permiso» y no se consulta nada",
    async (memberRole) => {
      role = memberRole;
      const state = await inviteMemberAction(TENANT_ID, IDLE, form(EMAIL, "viewer"));
      expect(state.status).toBe("error");
      expect(state.message).toBe(NO_PERMISSION_MESSAGE);
      expect(rpc).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    },
  );

  it.each(withoutPermission)(
    "%s: reenviar da «sin permiso» y no se consulta nada",
    async (memberRole) => {
      role = memberRole;
      const result = await resendInvitationAction(TENANT_ID, INVITATION_ID);
      expect(result).toEqual({
        status: "error",
        kind: "forbidden",
        message: NO_PERMISSION_MESSAGE,
      });
      expect(rpc).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    },
  );

  it.each(withoutPermission)(
    "%s: cancelar da «sin permiso» y no se consulta nada",
    async (memberRole) => {
      role = memberRole;
      const result = await revokeInvitationAction(TENANT_ID, INVITATION_ID);
      expect(result).toEqual({
        status: "error",
        kind: "forbidden",
        message: NO_PERMISSION_MESSAGE,
      });
      expect(rpc).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
    },
  );
});

describe("invitar", () => {
  const created = {
    result: "created",
    invitation_id: randomUUID(),
    email_message_id: randomUUID(),
    expires_at: "2026-11-06T15:00:00.000Z",
  };

  it.each(MANAGERS)(
    "%s invita: la base recibe el correo cifrado y el código solo como huella",
    async (memberRole) => {
      role = memberRole;
      rpc.mockResolvedValue({ data: created, error: null });
      from.mockReturnValue({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { full_name: "Ana Ficticia" } }) }),
        }),
      });
      const state = await inviteMemberAction(
        TENANT_ID,
        IDLE,
        form(`  ${EMAIL.toUpperCase()} `, "sales"),
      );
      expect(state).toEqual({ status: "sent", message: `Enviamos la invitación a ${EMAIL}.` });

      expect(rpc).toHaveBeenCalledTimes(1);
      const [name, params] = rpc.mock.calls[0] as [string, Record<string, string>];
      expect(name).toBe("create_invitation");
      expect(params.p_role).toBe("sales");
      // Nada del correo en claro viaja a la base, ni el código.
      const sent = JSON.stringify(params);
      expect(sent.toLowerCase()).not.toContain("persona.nueva");
      expect(params.p_email_enc).toMatch(/^v1\./);
      expect(params.p_to_email_enc).toMatch(/^v1\./);
      expect(params.p_email_hash).toMatch(/^[0-9a-f]{64}$/);

      // El correo recibe el código; su huella y el vínculo son los que se mandaron a la base.
      expect(deliver).toHaveBeenCalledTimes(1);
      const delivery = deliver.mock.calls[0][0] as Record<string, string>;
      expect(delivery.recipientAddress).toBe(EMAIL);
      expect(delivery.organizationName).toBe("Negocio de Prueba");
      expect(delivery.inviterName).toBe("Ana Ficticia");
      expect(delivery.role).toBe("sales");
      expect(delivery.emailId).toBe(params.p_email_message_id);
      expect(hashInvitationToken(delivery.token)).toBe(params.p_token_sha256);
      expect(params.p_email_binding).toBe(invitationEmailBinding(params.p_token_sha256, EMAIL));
      expect(sent).not.toContain(delivery.token);
    },
  );

  it("si la base pide avisar al Dueño, se le avisa DESPUÉS de enviar la invitación, con el id de la invitación (nunca con el correo)", async () => {
    rpc.mockResolvedValue({ data: { ...created, notify_owner: true }, error: null });
    from.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    });
    const state = await inviteMemberAction(TENANT_ID, IDLE, form(EMAIL, "admin"));
    expect(state.status).toBe("sent");
    // Se responde primero: el intento inmediato del aviso corre DESPUÉS (`after`).
    expect(notifyOwner).not.toHaveBeenCalled();
    await runAfter();
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner).toHaveBeenCalledWith(
      (rpc.mock.calls[0][1] as { p_invitation_id: string }).p_invitation_id,
    );
    expect(deliver.mock.invocationCallOrder[0]).toBeLessThan(
      notifyOwner.mock.invocationCallOrder[0],
    );
    expect(JSON.stringify(notifyOwner.mock.calls).toLowerCase()).not.toContain("persona.nueva");
  });

  it("si la base no pide avisar (notify_owner falso o ausente), no se avisa a nadie", async () => {
    from.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    });
    rpc.mockResolvedValue({ data: { ...created, notify_owner: false }, error: null });
    await inviteMemberAction(TENANT_ID, IDLE, form(EMAIL, "sales"));
    rpc.mockResolvedValue({ data: created, error: null });
    await inviteMemberAction(TENANT_ID, IDLE, form(EMAIL, "sales"));
    await runAfter();
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("un aviso que falla no cambia el resultado: la invitación sigue creada y enviada", async () => {
    from.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    });
    rpc.mockResolvedValue({ data: { ...created, notify_owner: true }, error: null });
    notifyOwner.mockRejectedValue(new Error("boom: " + EMAIL));
    const state = await inviteMemberAction(TENANT_ID, IDLE, form(EMAIL, "admin"));
    expect(state).toEqual({ status: "sent", message: `Enviamos la invitación a ${EMAIL}.` });
    await runAfter(); // el fallo del aviso no sale de la acción
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    for (const line of logged) expect(line.toLowerCase()).not.toContain("persona.nueva");
  });

  it("no se avisa si la invitación nunca se creó (ya es miembro, ya hay una pendiente o la base falla)", async () => {
    rpc.mockResolvedValueOnce({
      data: { result: "already_member", notify_owner: true },
      error: null,
    });
    await inviteMemberAction(TENANT_ID, IDLE, form(EMAIL, "admin"));
    rpc.mockResolvedValueOnce({ data: null, error: { code: "CP429", message: "limit_pending" } });
    await inviteMemberAction(TENANT_ID, IDLE, form(EMAIL, "admin"));
    await runAfter();
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("valida en el borde: correo inválido, sin rol, y el Dueño no se puede invitar (la base no se consulta)", async () => {
    for (const [email, roleValue, field] of [
      ["no-es-un-correo", "sales", "email"],
      ["", "sales", "email"],
      [EMAIL, "", "role"],
      [EMAIL, "owner", "role"],
      [EMAIL, "root", "role"],
    ] as const) {
      const state = await inviteMemberAction(TENANT_ID, IDLE, form(email, roleValue));
      expect(state.status, `${email}/${roleValue}`).toBe("error");
      expect(state.fieldErrors?.[field], `${email}/${roleValue}`).toBeTruthy();
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("si el correo no pudo enviarse, lo dice y la invitación igual existe", async () => {
    rpc.mockResolvedValue({ data: created, error: null });
    from.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    });
    deliver.mockResolvedValue(false);
    const state = await inviteMemberAction(TENANT_ID, IDLE, form(EMAIL, "viewer"));
    expect(state.status).toBe("error");
    expect(state.message).toContain("no pudimos enviar el correo");
    // Sin nombre, el correo usa el texto de respaldo del armador (una sola constante).
    expect((deliver.mock.calls[0][0] as { inviterName: string }).inviterName).toBe("");
  });

  it("«ya es miembro» y «ya hay una invitación pendiente» se dicen sin enviar nada", async () => {
    rpc.mockResolvedValueOnce({ data: { result: "already_member" }, error: null });
    const member = await inviteMemberAction(TENANT_ID, IDLE, form(EMAIL, "sales"));
    expect(member.message).toBe("Esa persona ya es parte de tu equipo.");
    rpc.mockResolvedValueOnce({
      data: { result: "already_pending", invitation_id: INVITATION_ID },
      error: null,
    });
    const pending = await inviteMemberAction(TENANT_ID, IDLE, form(EMAIL, "sales"));
    expect(pending.message).toContain("Ya hay una invitación pendiente");
    expect(pending.invitationId).toBe(INVITATION_ID);
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", "", NO_PERMISSION_MESSAGE],
    ["CP429", "limit_user_hour", "Enviaste muchas invitaciones en la última hora"],
    ["CP429", "limit_tenant_day", "máximo de 50 invitaciones por día"],
    ["CP429", "limit_pending", "50 invitaciones pendientes"],
    ["CP422", "invalid_role", "Revisa el correo y el rol"],
    ["XX000", "boom", "No pudimos completar la acción"],
  ])(
    "un error %s %s de la base se traduce a un mensaje claro, sin detalle técnico",
    async (code, message, expected) => {
      rpc.mockResolvedValue({ data: null, error: { code, message } });
      const state = await inviteMemberAction(TENANT_ID, IDLE, form(EMAIL, "sales"));
      expect(state.status).toBe("error");
      expect(state.message).toContain(expected);
      expect(state.message).not.toContain(message === "" ? "\u0000" : message);
      expect(deliver).not.toHaveBeenCalled();
    },
  );

  it("nada de lo que se registra en el log lleva el correo ni el código", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: EMAIL } });
    await inviteMemberAction(TENANT_ID, IDLE, form(EMAIL, "sales"));
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line.toLowerCase()).not.toContain("persona.nueva");
      expect(line).toContain("invitation_create_failed");
    }
  });
});

describe("reenviar", () => {
  const storedEmail = () =>
    encryptPii(EMAIL, {
      table: "invitations",
      field: "email",
      tenantId: TENANT_ID,
      rowId: INVITATION_ID,
    });
  const readRow = (row: unknown) =>
    from.mockImplementation((table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
          maybeSingle: async () => ({ data: { full_name: "Ana Ficticia" } }),
        }),
      }),
      __table: table,
    }));

  it("descifra el correo, pide un código nuevo y reenvía; la base solo recibe huellas", async () => {
    readRow({ id: INVITATION_ID, email_enc: storedEmail(), role: "approver", status: "pending" });
    rpc.mockResolvedValue({
      data: {
        result: "resent",
        email_message_id: randomUUID(),
        expires_at: "2026-11-06T15:00:00.000Z",
      },
      error: null,
    });
    const result = await resendInvitationAction(TENANT_ID, INVITATION_ID);
    expect(result).toEqual({
      status: "ok",
      delivered: true,
      message: `Reenviamos la invitación a ${EMAIL}.`,
    });
    const [name, params] = rpc.mock.calls[0] as [string, Record<string, string>];
    expect(name).toBe("resend_invitation");
    expect(params.p_invitation_id).toBe(INVITATION_ID);
    expect(JSON.stringify(params).toLowerCase()).not.toContain("persona.nueva");
    expect(params.p_email_binding).toBe(invitationEmailBinding(params.p_token_sha256, EMAIL));
    const delivery = deliver.mock.calls[0][0] as Record<string, string>;
    expect(delivery.role).toBe("approver");
    expect(delivery.recipientAddress).toBe(EMAIL);
    expect(hashInvitationToken(delivery.token)).toBe(params.p_token_sha256);
  });

  it("una invitación que no existe en esta organización, o ya cancelada, no se reenvía", async () => {
    readRow(null);
    expect((await resendInvitationAction(TENANT_ID, INVITATION_ID)).status).toBe("error");
    readRow({ id: INVITATION_ID, email_enc: storedEmail(), role: "sales", status: "revoked" });
    const revoked = await resendInvitationAction(TENANT_ID, INVITATION_ID);
    expect(revoked.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("un identificador que no es UUID se rechaza sin consultar", async () => {
    const result = await resendInvitationAction(TENANT_ID, "no-es-uuid");
    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("un correo que no se puede descifrar (otro sello) se informa sin revelar nada", async () => {
    const foreign = encryptPii(EMAIL, {
      table: "invitations",
      field: "email",
      tenantId: TENANT_ID,
      rowId: randomUUID(),
    });
    readRow({ id: INVITATION_ID, email_enc: foreign, role: "sales", status: "pending" });
    const result = await resendInvitationAction(TENANT_ID, INVITATION_ID);
    expect(result.status).toBe("error");
    expect(result.message).toContain("Cancélala y crea una nueva");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("los topes de reenvío se explican", async () => {
    readRow({ id: INVITATION_ID, email_enc: storedEmail(), role: "sales", status: "pending" });
    rpc.mockResolvedValue({ data: null, error: { code: "CP429", message: "resend_too_soon" } });
    const tooSoon = await resendInvitationAction(TENANT_ID, INVITATION_ID);
    expect(tooSoon.message).toContain("Espera 10 minutos");
    rpc.mockResolvedValue({ data: null, error: { code: "CP429", message: "limit_resends" } });
    const limit = await resendInvitationAction(TENANT_ID, INVITATION_ID);
    expect(limit.message).toContain("5 veces");
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("cancelar", () => {
  it("llama a la función de la base con el id y avisa que el enlace dejó de servir", async () => {
    rpc.mockResolvedValue({ data: { result: "revoked" }, error: null });
    const result = await revokeInvitationAction(TENANT_ID, INVITATION_ID);
    expect(result.status).toBe("ok");
    expect(rpc).toHaveBeenCalledWith("revoke_invitation", { p_invitation_id: INVITATION_ID });
  });

  it("una invitación ya aceptada no se puede cancelar: se explica", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "CP423", message: "not_pending" } });
    const result = await revokeInvitationAction(TENANT_ID, INVITATION_ID);
    expect(result.status).toBe("error");
    expect(result.message).toContain("ya no está pendiente");
  });
});
