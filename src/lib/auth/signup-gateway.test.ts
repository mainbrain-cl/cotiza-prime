import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const generateLink = vi.fn();
const updateUserById = vi.fn();
vi.mock("@/lib/supabase/admin-client", () => ({
  createAdminClient: () => ({ auth: { admin: { generateLink, updateUserById } } }),
}));

import { SignupGatewayError, prepareSignupLink } from "./signup-gateway";

const EMAIL = "nueva@ejemplo.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
type FakeUser = { id: string; email: string; email_confirmed_at: string | null };
const unverified: FakeUser = { id: USER_ID, email: EMAIL, email_confirmed_at: null };
const link = (hash: string, user: FakeUser = unverified) => ({
  data: {
    user,
    properties: {
      hashed_token: hash,
      action_link: "http://x/verify?token=SECRETO",
      email_otp: "0123456789",
    },
  },
  error: null,
});

beforeEach(() => {
  calls.length = 0;
  generateLink.mockReset().mockImplementation(async () => {
    calls.push("generateLink");
    return link(`hash-${calls.length}`);
  });
  updateUserById.mockReset().mockImplementation(async () => {
    calls.push("updateUserById");
    return { data: { user: unverified }, error: null };
  });
});

describe("la pasarela del registro (H-116)", () => {
  it("con una cuenta nueva o sin verificar: enlace → contraseña al azar → enlace, y entrega SOLO el código del último", async () => {
    const result = await prepareSignupLink(EMAIL);
    expect(calls).toEqual(["generateLink", "updateUserById", "generateLink"]);
    expect(result).toEqual({ status: "ready", tokenHash: "hash-3" });
    // Ambos enlaces son de invitación y para el mismo correo.
    for (const [params] of generateLink.mock.calls) {
      expect(params).toEqual({ type: "invite", email: EMAIL });
    }
  });

  it("la contraseña es de la cuenta que devolvió el primer enlace, larga, al azar y distinta cada vez", async () => {
    await prepareSignupLink(EMAIL);
    await prepareSignupLink(EMAIL);
    const [first, second] = updateUserById.mock.calls;
    expect(first[0]).toBe(USER_ID);
    expect(Object.keys(first[1])).toEqual(["password"]);
    expect(first[1].password.length).toBeGreaterThanOrEqual(60);
    expect(first[1].password).not.toBe(second[1].password);
    // Cumple cualquier regla de composición (mayúscula, minúscula, número y símbolo).
    expect(first[1].password).toMatch(/Aa1!$/);
  });

  it("con una cuenta ya verificada (email_exists) termina SIN poner contraseña ni segundo enlace, y no entrega ningún código", async () => {
    generateLink.mockReset().mockImplementation(async () => {
      calls.push("generateLink");
      return {
        data: { user: null, properties: null },
        error: { code: "email_exists", status: 422 },
      };
    });
    expect(await prepareSignupLink(EMAIL)).toEqual({ status: "already_registered" });
    expect(calls).toEqual(["generateLink"]);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("si GoTrue entregara un enlace para una cuenta con el correo ya confirmado, tampoco envía nada", async () => {
    generateLink.mockReset().mockResolvedValue(
      link("h", {
        ...unverified,
        email_confirmed_at: "2026-11-01T00:00:00Z",
      }),
    );
    expect(await prepareSignupLink(EMAIL)).toEqual({ status: "already_registered" });
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("si la persona verificó entre los dos pasos, el segundo enlace responde email_exists y no se envía nada", async () => {
    generateLink
      .mockResolvedValueOnce(link("h1"))
      .mockResolvedValueOnce({ data: null, error: { code: "email_exists", status: 422 } });
    expect(await prepareSignupLink(EMAIL)).toEqual({ status: "already_registered" });
  });

  it("si falla fijar la contraseña al azar NO hay enlace: el primer código no se entrega", async () => {
    updateUserById.mockResolvedValue({
      data: null,
      error: { code: "unexpected_failure", status: 500 },
    });
    await expect(prepareSignupLink(EMAIL)).rejects.toThrow(
      "signup_gateway_password:unexpected_failure",
    );
    expect(generateLink).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["el primer enlace", 0, "account"],
    ["el segundo enlace", 1, "link"],
  ])("si falla %s lanza un error con solo un código", async (_name, index, operation) => {
    generateLink.mockReset();
    for (let i = 0; i < 2; i += 1) {
      generateLink.mockResolvedValueOnce(
        i === index
          ? { data: null, error: { code: "over_email_send_rate_limit", status: 429 } }
          : link("h"),
      );
    }
    const error = await prepareSignupLink(EMAIL).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SignupGatewayError);
    expect((error as SignupGatewayError).message).toBe(
      `signup_gateway_${operation}:over_email_send_rate_limit`,
    );
    // Ni el correo, ni el enlace, ni el código llegan al mensaje del error.
    expect((error as Error).message).not.toContain(EMAIL);
    expect((error as Error).message).not.toContain("SECRETO");
  });

  it("sin código en la respuesta del segundo enlace no hay enlace que enviar", async () => {
    generateLink
      .mockResolvedValueOnce(link("h1"))
      .mockResolvedValueOnce({ data: { user: unverified, properties: {} }, error: null });
    await expect(prepareSignupLink(EMAIL)).rejects.toThrow("signup_gateway_link:no_token");
  });

  it("nunca devuelve el enlace de GoTrue ni el código en claro", async () => {
    const result = await prepareSignupLink(EMAIL);
    expect(JSON.stringify(result)).not.toContain("SECRETO");
    expect(JSON.stringify(result)).not.toContain("0123456789");
    expect(Object.keys(result).sort()).toEqual(["status", "tokenHash"]);
  });
});
