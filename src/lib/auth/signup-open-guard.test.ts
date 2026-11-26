import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `signup-open-guard` (H-116, J5): con el registro público de Supabase abierto en PRODUCCIÓN se bloquea nuestro formulario.

const mocks = vi.hoisted(() => ({ serverLog: vi.fn() }));
vi.mock("@/lib/log/server-log", () => ({ serverLog: mocks.serverLog }));

import {
  SIGNUP_GUARD_TTL_MS,
  interpretSettings,
  isSignupBlockedByOpenSupabase,
  readSignupOpenState,
  resetSignupGuardCache,
} from "./signup-open-guard";

const settings = (disableSignup: unknown) =>
  vi.fn(
    async () => new Response(JSON.stringify({ disable_signup: disableSignup }), { status: 200 }),
  );

beforeEach(() => {
  resetSignupGuardCache();
  mocks.serverLog.mockReset();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proyecto.supabase.example");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "llave-publica");
});
afterEach(() => vi.unstubAllEnvs());

describe("interpretSettings", () => {
  it("solo `disable_signup` booleano cuenta; todo lo demás es «no se sabe»", () => {
    expect(interpretSettings({ disable_signup: true })).toBe("closed");
    expect(interpretSettings({ disable_signup: false })).toBe("open");
    for (const body of [
      null,
      undefined,
      "x",
      7,
      {},
      { disable_signup: "false" },
      { disable_signup: null },
    ]) {
      expect(interpretSettings(body)).toBe("unknown");
    }
  });
});

describe("isSignupBlockedByOpenSupabase", () => {
  it("en producción, con el registro abierto: bloquea y deja una alerta (sin datos personales)", async () => {
    const fetchImpl = settings(false);
    expect(await isSignupBlockedByOpenSupabase({ env: "production", fetchImpl })).toBe(true);
    expect(mocks.serverLog).toHaveBeenCalledWith("error", "signup_open_in_supabase", {
      blocked: true,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proyecto.supabase.example/auth/v1/settings");
    expect((init.headers as Record<string, string>).apikey).toBe("llave-publica");
  });

  it("en producción, con el registro cerrado: no bloquea y no alerta", async () => {
    expect(
      await isSignupBlockedByOpenSupabase({ env: "production", fetchImpl: settings(true) }),
    ).toBe(false);
    expect(mocks.serverLog).not.toHaveBeenCalled();
  });

  it("si no se puede leer (red caída, error del servidor, respuesta rara, sin variables) NO bloquea", async () => {
    const failing = vi.fn(async () => {
      throw new Error("sin red");
    });
    expect(await isSignupBlockedByOpenSupabase({ env: "production", fetchImpl: failing })).toBe(
      false,
    );
    resetSignupGuardCache();
    const broken = vi.fn(async () => new Response("{}", { status: 503 }));
    expect(await isSignupBlockedByOpenSupabase({ env: "production", fetchImpl: broken })).toBe(
      false,
    );
    resetSignupGuardCache();
    expect(
      await isSignupBlockedByOpenSupabase({ env: "production", fetchImpl: settings("no sé") }),
    ).toBe(false);
    resetSignupGuardCache();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    const never = settings(false);
    expect(await isSignupBlockedByOpenSupabase({ env: "production", fetchImpl: never })).toBe(
      false,
    );
    expect(never).not.toHaveBeenCalled();
    expect(mocks.serverLog).not.toHaveBeenCalled();
  });

  it("fuera de producción no consulta nada: ni en pruebas, ni sin la variable, ni con un valor raro", async () => {
    const fetchImpl = settings(false);
    for (const env of ["test", undefined, "", "Production", "prod"]) {
      expect(await isSignupBlockedByOpenSupabase({ env, fetchImpl })).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("guarda la lectura 5 minutos y después vuelve a leer (así se entera de que se corrigió, o de que se abrió)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ disable_signup: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ disable_signup: true }), { status: 200 }),
      );
    const t0 = 1_000_000;
    expect(await isSignupBlockedByOpenSupabase({ env: "production", fetchImpl, now: t0 })).toBe(
      true,
    );
    expect(
      await isSignupBlockedByOpenSupabase({
        env: "production",
        fetchImpl,
        now: t0 + SIGNUP_GUARD_TTL_MS - 1,
      }),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      await isSignupBlockedByOpenSupabase({
        env: "production",
        fetchImpl,
        now: t0 + SIGNUP_GUARD_TTL_MS,
      }),
    ).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("`readSignupOpenState` distingue abierto, cerrado y desconocido", async () => {
    expect(await readSignupOpenState({ fetchImpl: settings(false) })).toBe("open");
    resetSignupGuardCache();
    expect(await readSignupOpenState({ fetchImpl: settings(true) })).toBe("closed");
    resetSignupGuardCache();
    expect(await readSignupOpenState({ fetchImpl: settings(undefined) })).toBe("unknown");
  });
});
