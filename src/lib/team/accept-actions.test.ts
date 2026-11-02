import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INVITATION_GENERIC_FAILURE, MISSING_CODE_MESSAGE, RESULT_MESSAGES } from "./accept-model";
import { newInvitationToken } from "./invitation-code";

// Las acciones de la pantalla de invitación (H-009) con falsos servicios: el código sale de la cookie, aceptar
// borra la cookie solo cuando el código ya no sirve o se usó, y nada de lo que manda el formulario cuenta.

const TENANT_ID = randomUUID();
const accept = vi.fn();
const readCode = vi.fn();
const clearCode = vi.fn(async () => undefined);
const requireUser = vi.fn(async () => ({
  id: randomUUID(),
  email: "x@ejemplo.test",
  emailVerified: true,
}));
const revalidatePath = vi.fn();

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: () => requireUser() }));
vi.mock("./accept-service", () => ({ acceptInvitation: (c: string) => accept(c) }));
vi.mock("./invitation-cookie", () => ({
  readInvitationCode: () => readCode(),
  clearInvitationCode: () => clearCode(),
}));

const { acceptInvitationAction, leaveInvitationAction } = await import("./accept-actions");

beforeEach(() => {
  accept.mockReset();
  readCode.mockReset();
  clearCode.mockClear();
  revalidatePath.mockClear();
  requireUser.mockClear();
});

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Redirected) return error.to;
    throw error;
  }
  throw new Error("se esperaba una redirección");
}

describe("unirme", () => {
  it("exige sesión antes de hacer nada", async () => {
    readCode.mockResolvedValue(null);
    await acceptInvitationAction();
    expect(requireUser).toHaveBeenCalled();
  });

  it("sin cookie no llama a la base y dice que se abra de nuevo el enlace", async () => {
    readCode.mockResolvedValue(null);
    const state = await acceptInvitationAction();
    expect(state).toEqual({ status: "error", message: MISSING_CODE_MESSAGE, dead: true });
    expect(accept).not.toHaveBeenCalled();
  });

  it("al aceptar, borra el código, refresca el selector y entra a la organización", async () => {
    const code = newInvitationToken();
    readCode.mockResolvedValue(code);
    accept.mockResolvedValue({ status: "joined", tenantId: TENANT_ID, alreadyMember: false });
    const to = await redirectOf(() => acceptInvitationAction());
    expect(to).toBe(`/o/${TENANT_ID}`);
    expect(accept).toHaveBeenCalledWith(code);
    expect(clearCode).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("la acción no recibe nada del formulario: ni rol, ni organización, ni código", async () => {
    const code = newInvitationToken();
    readCode.mockResolvedValue(code);
    accept.mockResolvedValue({ status: "unavailable", result: "wrong_email" });
    await acceptInvitationAction();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith(code);
  });

  it.each(["not_found", "revoked", "expired", "used", "archived"] as const)(
    "«%s»: el código ya no sirve, se borra y se ofrece salir",
    async (result) => {
      readCode.mockResolvedValue(newInvitationToken());
      accept.mockResolvedValue({ status: "unavailable", result });
      const state = await acceptInvitationAction();
      expect(state).toEqual({ status: "error", message: RESULT_MESSAGES[result], dead: true });
      expect(clearCode).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["wrong_email", "unverified", "rate_limited"] as const)(
    "«%s»: se conserva el código para reintentar con otra cuenta o más tarde",
    async (result) => {
      readCode.mockResolvedValue(newInvitationToken());
      accept.mockResolvedValue({ status: "unavailable", result });
      const state = await acceptInvitationAction();
      expect(state).toEqual({ status: "error", message: RESULT_MESSAGES[result], dead: false });
      expect(clearCode).not.toHaveBeenCalled();
    },
  );

  it("si la base falla, mensaje genérico y el código se conserva", async () => {
    readCode.mockResolvedValue(newInvitationToken());
    accept.mockResolvedValue({ status: "failed", message: "x" });
    const state = await acceptInvitationAction();
    expect(state).toEqual({ status: "error", message: INVITATION_GENERIC_FAILURE });
    expect(clearCode).not.toHaveBeenCalled();
  });

  it("si la sesión se perdió, vuelve a ingresar sin borrar el código", async () => {
    readCode.mockResolvedValue(newInvitationToken());
    accept.mockResolvedValue({ status: "no_session" });
    expect(await redirectOf(() => acceptInvitationAction())).toBe("/ingresar");
    expect(clearCode).not.toHaveBeenCalled();
  });
});

describe("seguir sin unirme", () => {
  it("borra el código y vuelve al inicio", async () => {
    expect(await redirectOf(() => leaveInvitationAction())).toBe("/");
    expect(clearCode).toHaveBeenCalledTimes(1);
  });
});
