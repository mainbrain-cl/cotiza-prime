import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INVITATION_GENERIC_FAILURE,
  INVITATION_VIEW_FIELD,
  MISSING_CODE_MESSAGE,
  RESULT_MESSAGES,
} from "./accept-model";
import {
  hashInvitationToken,
  invitationViewFingerprint,
  newInvitationToken,
} from "./invitation-code";

// Las acciones de la pantalla de invitación (H-009) con falsos servicios: el código sale de la cookie, aceptar
// borra la cookie solo cuando el código ya no sirve o se usó, y del formulario solo cuenta la huella de la
// invitación que se mostró (si no es la del código de la cookie, no se acepta nada).

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

/** El formulario de «Unirme» tal como lo dibuja la pantalla para el código `code`. */
function formFor(code: string, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set(INVITATION_VIEW_FIELD, invitationViewFingerprint(code));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

/** Guarda `code` en la cookie (falsa) y devuelve el formulario que se mostró para él. */
function viewing(code: string): FormData {
  readCode.mockResolvedValue(code);
  return formFor(code);
}

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
    await acceptInvitationAction(new FormData());
    expect(requireUser).toHaveBeenCalled();
  });

  it("sin cookie no llama a la base y dice que se abra de nuevo el enlace", async () => {
    readCode.mockResolvedValue(null);
    const state = await acceptInvitationAction(new FormData());
    expect(state).toEqual({ status: "error", message: MISSING_CODE_MESSAGE, dead: true });
    expect(accept).not.toHaveBeenCalled();
  });

  it("al aceptar, borra el código, refresca el selector y entra a la organización", async () => {
    const code = newInvitationToken();
    const form = viewing(code);
    accept.mockResolvedValue({ status: "joined", tenantId: TENANT_ID, alreadyMember: false });
    const to = await redirectOf(() => acceptInvitationAction(form));
    expect(to).toBe(`/o/${TENANT_ID}`);
    expect(accept).toHaveBeenCalledWith(code);
    expect(clearCode).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("del formulario no se usa ni rol, ni organización, ni código: el código es siempre el de la cookie", async () => {
    const code = newInvitationToken();
    readCode.mockResolvedValue(code);
    accept.mockResolvedValue({ status: "unavailable", result: "wrong_email" });
    await acceptInvitationAction(
      formFor(code, { role: "owner", tenant_id: TENANT_ID, code: newInvitationToken() }),
    );
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith(code);
  });

  it("si la cookie cambió entre ver y pulsar (otra invitación), no acepta nada ni llama a la base: vuelve a mostrarla con un aviso", async () => {
    const shown = newInvitationToken();
    const form = formFor(shown);
    // Una página ajena abrió /invitacion/<otro código> y la cookie ya tiene otro.
    readCode.mockResolvedValue(newInvitationToken());
    const to = await redirectOf(() => acceptInvitationAction(form));
    expect(to).toBe("/invitacion?aviso=invitacion-cambio");
    expect(accept).not.toHaveBeenCalled();
    expect(clearCode).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["sin la huella", new FormData()],
    ["con la huella de la base (sha256 del código), que nunca va en la página", "sha"],
    ["con el código en vez de la huella", "code"],
    ["con una huella mal formada", "zz"],
  ] as const)("%s: tampoco acepta", async (_label, kind) => {
    const code = newInvitationToken();
    readCode.mockResolvedValue(code);
    let form: FormData;
    if (kind instanceof FormData) form = kind;
    else {
      form = new FormData();
      const value =
        kind === "sha" ? hashInvitationToken(code) : kind === "code" ? code : "z".repeat(64);
      form.set(INVITATION_VIEW_FIELD, value);
    }
    expect(await redirectOf(() => acceptInvitationAction(form))).toBe(
      "/invitacion?aviso=invitacion-cambio",
    );
    expect(accept).not.toHaveBeenCalled();
  });

  it("si el campo no es texto (un archivo con la huella correcta dentro), tampoco acepta", async () => {
    const code = newInvitationToken();
    readCode.mockResolvedValue(code);
    const form = new FormData();
    form.set(INVITATION_VIEW_FIELD, new Blob([invitationViewFingerprint(code)]), "huella.txt");
    expect(await redirectOf(() => acceptInvitationAction(form))).toBe(
      "/invitacion?aviso=invitacion-cambio",
    );
    expect(accept).not.toHaveBeenCalled();
  });

  // Cada caso trae la huella CORRECTA cuando puede: lo que se rechaza es que no llegue un formulario.
  it.each([
    ["nada", () => undefined],
    ["null", () => null],
    ["la huella suelta", (code: string) => invitationViewFingerprint(code)],
    [
      "un objeto con el campo",
      (code: string) => ({ [INVITATION_VIEW_FIELD]: invitationViewFingerprint(code) }),
    ],
    [
      "un objeto con un `get` propio",
      (code: string) => ({ get: () => invitationViewFingerprint(code) }),
    ],
  ] as const)(
    "llamada desde fuera con %s en vez de un formulario: rechaza igual, sin romperse ni llamar a la base",
    async (_label, argumentFor) => {
      const code = newInvitationToken();
      readCode.mockResolvedValue(code);
      expect(await redirectOf(() => acceptInvitationAction(argumentFor(code)))).toBe(
        "/invitacion?aviso=invitacion-cambio",
      );
      expect(accept).not.toHaveBeenCalled();
      expect(clearCode).not.toHaveBeenCalled();
    },
  );

  it.each(["not_found", "revoked", "inviter_inactive", "expired", "used", "archived"] as const)(
    "«%s»: el código ya no sirve y se ofrece salir; la cookie se borra al salir, no antes (si no, el motivo se pierde)",
    async (result) => {
      const form = viewing(newInvitationToken());
      accept.mockResolvedValue({ status: "unavailable", result });
      const state = await acceptInvitationAction(form);
      expect(state).toEqual({ status: "error", message: RESULT_MESSAGES[result], dead: true });
      expect(clearCode).not.toHaveBeenCalled();
    },
  );

  it.each(["wrong_email", "unverified", "rate_limited"] as const)(
    "«%s»: se conserva el código para reintentar con otra cuenta o más tarde",
    async (result) => {
      const form = viewing(newInvitationToken());
      accept.mockResolvedValue({ status: "unavailable", result });
      const state = await acceptInvitationAction(form);
      expect(state).toEqual({ status: "error", message: RESULT_MESSAGES[result], dead: false });
      expect(clearCode).not.toHaveBeenCalled();
    },
  );

  it("si la base falla, mensaje genérico y el código se conserva", async () => {
    const form = viewing(newInvitationToken());
    accept.mockResolvedValue({ status: "failed", message: "x" });
    const state = await acceptInvitationAction(form);
    expect(state).toEqual({ status: "error", message: INVITATION_GENERIC_FAILURE });
    expect(clearCode).not.toHaveBeenCalled();
  });

  it("si la sesión se perdió, vuelve a ingresar sin borrar el código", async () => {
    const form = viewing(newInvitationToken());
    accept.mockResolvedValue({ status: "no_session" });
    expect(await redirectOf(() => acceptInvitationAction(form))).toBe("/ingresar");
    expect(clearCode).not.toHaveBeenCalled();
  });
});

describe("seguir sin unirme", () => {
  it("borra el código y vuelve al inicio", async () => {
    expect(await redirectOf(() => leaveInvitationAction())).toBe("/");
    expect(clearCode).toHaveBeenCalledTimes(1);
  });
});

describe("el archivo de acciones", () => {
  it("solo exporta funciones (un archivo «use server» no admite otra cosa; Next lo rechaza al abrir la pantalla)", async () => {
    const exported = await import("./accept-actions");
    expect(Object.keys(exported).sort()).toEqual([
      "acceptInvitationAction",
      "leaveInvitationAction",
    ]);
    for (const value of Object.values(exported)) expect(typeof value).toBe("function");
  });
});
