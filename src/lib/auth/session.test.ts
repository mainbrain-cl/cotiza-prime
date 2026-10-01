import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundSignal, RedirectSignal, queryBuilder } from "@/test/supabase-mock";

const getUser = vi.fn();
const getSession = vi.fn();
const from = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
  notFound: () => {
    throw new NotFoundSignal();
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser, getSession }, from }),
}));

import { ACCEPT_TERMS_PATH, LOGIN_PATH } from "./paths";
import { getOptionalUser, requireUser } from "./session";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ana@ejemplo.test",
  email_confirmed_at: "2026-10-01",
};

function legalRows(currentIds: string[], acceptedIds: string[]) {
  from.mockImplementation((table: string) =>
    table === "legal_documents"
      ? queryBuilder({ data: currentIds.map((id) => ({ id })), error: null })
      : queryBuilder({ data: acceptedIds.map((document_id) => ({ document_id })), error: null }),
  );
}

beforeEach(() => {
  getUser.mockReset();
  getSession.mockReset();
  from.mockReset();
});

describe("getOptionalUser", () => {
  it("verifica el pase con getUser y nunca con getSession", async () => {
    getUser.mockResolvedValue({ data: { user: USER }, error: null });
    const user = await getOptionalUser();
    expect(user).toEqual({ id: USER.id, email: USER.email, emailVerified: true });
    expect(getUser).toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("devuelve null si el pase no es válido o la sesión fue cerrada", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "session_not_found" } });
    expect(await getOptionalUser()).toBeNull();
  });
});

describe("requireUser", () => {
  it("sin sesión redirige a ingresar", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "sin sesión" } });
    await expect(requireUser()).rejects.toMatchObject({ target: LOGIN_PATH });
  });

  it("con sesión y todos los documentos vigentes aceptados, deja pasar", async () => {
    getUser.mockResolvedValue({ data: { user: USER }, error: null });
    legalRows(["t1", "p1"], ["t1", "p1", "viejo"]);
    await expect(requireUser()).resolves.toMatchObject({ id: USER.id });
  });

  it("si falta aceptar una versión vigente, redirige a 'Acepta la nueva versión'", async () => {
    getUser.mockResolvedValue({ data: { user: USER }, error: null });
    legalRows(["t2", "p1"], ["t1", "p1"]);
    await expect(requireUser()).rejects.toMatchObject({ target: ACCEPT_TERMS_PATH });
  });

  it("si no se puede leer la aceptación, asume que falta (lado seguro)", async () => {
    getUser.mockResolvedValue({ data: { user: USER }, error: null });
    from.mockImplementation(() => queryBuilder({ data: null, error: { code: "XX000" } }));
    await expect(requireUser()).rejects.toMatchObject({ target: ACCEPT_TERMS_PATH });
  });

  it("la pantalla de aceptación puede saltarse la puerta", async () => {
    getUser.mockResolvedValue({ data: { user: USER }, error: null });
    await expect(requireUser({ skipLegalGate: true })).resolves.toMatchObject({ id: USER.id });
    expect(from).not.toHaveBeenCalled();
  });
});
