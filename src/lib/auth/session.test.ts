import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundSignal, RedirectSignal, queryBuilder } from "@/test/supabase-mock";

const getUser = vi.fn();
const getSession = vi.fn();
const getClaims = vi.fn();
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
  createClient: async () => ({ auth: { getUser, getSession, getClaims }, from }),
}));

import { ACCEPT_TERMS_PATH, HOME_PATH, LOGIN_PATH, SECOND_STEP_PATH } from "./paths";
import { getOptionalUser, getSessionState, requirePendingSecondStep, requireUser } from "./session";

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
  getClaims.mockReset();
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

// H-004a · verificación en dos pasos. Una cuenta con un factor VERIFICADO solo tiene sesión completa si el pase es aal2.
const VERIFIED = {
  id: "f1",
  status: "verified",
  factor_type: "totp",
  created_at: "2026-11-02T10:00:00Z",
};
const UNVERIFIED = { ...VERIFIED, id: "f2", status: "unverified" };
const userWith = (factors: unknown[]) => ({ ...USER, factors });

describe("getSessionState (verificación en dos pasos)", () => {
  it("sin sesión: signed_out", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "sin sesión" } });
    expect(await getSessionState()).toEqual({ status: "signed_out" });
    expect(getClaims).not.toHaveBeenCalled();
  });

  it("sin factor: sesión completa y no se consulta getClaims (las cuentas de hoy no pagan nada extra)", async () => {
    getUser.mockResolvedValue({ data: { user: userWith([]) }, error: null });
    expect(await getSessionState()).toMatchObject({
      status: "complete",
      secondStep: { active: false, since: null },
    });
    expect(getClaims).not.toHaveBeenCalled();
  });

  it("un usuario sin la lista de factores tampoco consulta getClaims", async () => {
    getUser.mockResolvedValue({ data: { user: USER }, error: null });
    expect((await getSessionState()).status).toBe("complete");
    expect(getClaims).not.toHaveBeenCalled();
  });

  it("solo un factor sin verificar: sesión completa (activar a medias no bloquea a nadie)", async () => {
    getUser.mockResolvedValue({ data: { user: userWith([UNVERIFIED]) }, error: null });
    expect(await getSessionState()).toMatchObject({ status: "complete" });
    expect(getClaims).not.toHaveBeenCalled();
  });

  it("con factor verificado y pase aal2: sesión completa, con la fecha desde que está activa", async () => {
    getUser.mockResolvedValue({ data: { user: userWith([VERIFIED]) }, error: null });
    getClaims.mockResolvedValue({ data: { claims: { aal: "aal2" } }, error: null });
    expect(await getSessionState()).toEqual({
      status: "complete",
      user: { id: USER.id, email: USER.email, emailVerified: true },
      secondStep: { active: true, since: VERIFIED.created_at },
    });
  });

  it("con factor verificado y pase aal1: sesión parcial", async () => {
    getUser.mockResolvedValue({ data: { user: userWith([VERIFIED]) }, error: null });
    getClaims.mockResolvedValue({ data: { claims: { aal: "aal1" } }, error: null });
    expect(await getSessionState()).toEqual({
      status: "second_step_pending",
      user: { id: USER.id, email: USER.email, emailVerified: true },
    });
  });

  it.each([
    ["getClaims devuelve un error", { data: null, error: { message: "boom" } }],
    ["getClaims no trae datos", { data: null, error: null }],
    ["el pase no dice su nivel", { data: { claims: {} }, error: null }],
    ["el nivel es desconocido", { data: { claims: { aal: "aal3" } }, error: null }],
  ])("ante la duda se cierra: %s => sesión parcial", async (_name, claimsResult) => {
    getUser.mockResolvedValue({ data: { user: userWith([VERIFIED]) }, error: null });
    getClaims.mockResolvedValue(claimsResult);
    expect((await getSessionState()).status).toBe("second_step_pending");
  });

  it("decide con getUser (servidor) y getClaims; nunca con getSession", async () => {
    getUser.mockResolvedValue({ data: { user: userWith([VERIFIED]) }, error: null });
    getClaims.mockResolvedValue({ data: { claims: { aal: "aal2" } }, error: null });
    await getSessionState();
    expect(getUser).toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("la sesión parcial no da acceso", () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: userWith([VERIFIED]) }, error: null });
    getClaims.mockResolvedValue({ data: { claims: { aal: "aal1" } }, error: null });
  });

  it("getOptionalUser devuelve nada (las rutas de la API responden 401)", async () => {
    expect(await getOptionalUser()).toBeNull();
  });

  it("requireUser manda a la pantalla del código SIN leer los términos", async () => {
    await expect(requireUser()).rejects.toMatchObject({ target: SECOND_STEP_PATH });
    expect(from).not.toHaveBeenCalled();
  });

  it("requireUser con skipLegalGate también manda al código", async () => {
    await expect(requireUser({ skipLegalGate: true })).rejects.toMatchObject({
      target: SECOND_STEP_PATH,
    });
  });

  it("requirePendingSecondStep devuelve a la persona con sesión parcial", async () => {
    await expect(requirePendingSecondStep()).resolves.toMatchObject({ id: USER.id });
  });
});

describe("requirePendingSecondStep", () => {
  it("sin sesión va a ingresar", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "sin sesión" } });
    await expect(requirePendingSecondStep()).rejects.toMatchObject({ target: LOGIN_PATH });
  });

  it("con sesión completa va al inicio (no hay nada que verificar)", async () => {
    getUser.mockResolvedValue({ data: { user: userWith([]) }, error: null });
    await expect(requirePendingSecondStep()).rejects.toMatchObject({ target: HOME_PATH });
  });

  it("con factor y aal2 también va al inicio", async () => {
    getUser.mockResolvedValue({ data: { user: userWith([VERIFIED]) }, error: null });
    getClaims.mockResolvedValue({ data: { claims: { aal: "aal2" } }, error: null });
    await expect(requirePendingSecondStep()).rejects.toMatchObject({ target: HOME_PATH });
  });
});

describe("requireUser con sesión completa y verificación activa", () => {
  it("deja pasar y revisa los términos como siempre", async () => {
    getUser.mockResolvedValue({ data: { user: userWith([VERIFIED]) }, error: null });
    getClaims.mockResolvedValue({ data: { claims: { aal: "aal2" } }, error: null });
    legalRows(["t2", "p1"], ["t1", "p1"]);
    await expect(requireUser()).rejects.toMatchObject({ target: ACCEPT_TERMS_PATH });
    legalRows(["t1"], ["t1"]);
    await expect(requireUser()).resolves.toMatchObject({ id: USER.id });
  });
});
