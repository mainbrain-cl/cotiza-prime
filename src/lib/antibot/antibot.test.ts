import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AntibotConfigError,
  createAntibotVerifier,
  getAntibotVerifier,
  loadAntibotConfig,
  resetAntibotVerifierForTests,
} from "./config";
import { MEMORY_FAIL_TOKEN, MEMORY_PASS_TOKEN, createMemoryAntibot } from "./memory";
import {
  TURNSTILE_TOKEN_MAX_LENGTH,
  TURNSTILE_VERIFY_URL,
  createTurnstileVerifier,
} from "./turnstile";

const BASE_INPUT = {
  token: "token-de-prueba",
  remoteIp: "203.0.113.7",
  expectedHostname: "cotizaprime.test",
  expectedAction: "intake_submit",
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}

describe("adaptador memory", () => {
  const verifier = createMemoryAntibot();

  it("acepta test-pass", async () => {
    expect(await verifier.verify({ ...BASE_INPUT, token: MEMORY_PASS_TOKEN })).toEqual({
      ok: true,
    });
  });

  it("rechaza test-fail y cualquier otro token", async () => {
    expect(await verifier.verify({ ...BASE_INPUT, token: MEMORY_FAIL_TOKEN })).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(await verifier.verify({ ...BASE_INPUT, token: "otro" })).toMatchObject({ ok: false });
  });

  it("rechaza un token vacío", async () => {
    expect(await verifier.verify({ ...BASE_INPUT, token: "" })).toEqual({
      ok: false,
      reason: "missing_token",
    });
  });
});

describe("adaptador turnstile", () => {
  it("acepta cuando Cloudflare confirma, con hostname y acción correctos", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, hostname: "cotizaprime.test", action: "intake_submit" }),
    );
    const verifier = createTurnstileVerifier({ secretKey: "secreto-largo", fetchImpl });
    expect(await verifier.verify(BASE_INPUT)).toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TURNSTILE_VERIFY_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = init.body as URLSearchParams;
    expect(body.get("secret")).toBe("secreto-largo");
    expect(body.get("response")).toBe(BASE_INPUT.token);
    expect(body.get("remoteip")).toBe("203.0.113.7");
  });

  it("no manda remoteip si no hay IP", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, hostname: "cotizaprime.test", action: "intake_submit" }),
    );
    const verifier = createTurnstileVerifier({ secretKey: "secreto-largo", fetchImpl });
    await verifier.verify({ ...BASE_INPUT, remoteIp: null });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.body as URLSearchParams).has("remoteip")).toBe(false);
  });

  it("rechaza si Cloudflare dice success:false", async () => {
    const verifier = createTurnstileVerifier({
      secretKey: "secreto-largo",
      fetchImpl: async () =>
        jsonResponse({ success: false, "error-codes": ["invalid-input-response"] }),
    });
    expect(await verifier.verify(BASE_INPUT)).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rechaza si el hostname es distinto", async () => {
    const verifier = createTurnstileVerifier({
      secretKey: "secreto-largo",
      fetchImpl: async () =>
        jsonResponse({ success: true, hostname: "otro.test", action: "intake_submit" }),
    });
    expect(await verifier.verify(BASE_INPUT)).toEqual({ ok: false, reason: "hostname_mismatch" });
  });

  it("rechaza si falta el hostname o la acción en la respuesta", async () => {
    const noHost = createTurnstileVerifier({
      secretKey: "secreto-largo",
      fetchImpl: async () => jsonResponse({ success: true, action: "intake_submit" }),
    });
    expect(await noHost.verify(BASE_INPUT)).toEqual({ ok: false, reason: "hostname_mismatch" });
    const noAction = createTurnstileVerifier({
      secretKey: "secreto-largo",
      fetchImpl: async () => jsonResponse({ success: true, hostname: "cotizaprime.test" }),
    });
    expect(await noAction.verify(BASE_INPUT)).toEqual({ ok: false, reason: "action_mismatch" });
  });

  it("rechaza si la acción es distinta", async () => {
    const verifier = createTurnstileVerifier({
      secretKey: "secreto-largo",
      fetchImpl: async () =>
        jsonResponse({ success: true, hostname: "cotizaprime.test", action: "login" }),
    });
    expect(await verifier.verify(BASE_INPUT)).toEqual({ ok: false, reason: "action_mismatch" });
  });

  it("bloquea si fetch falla", async () => {
    const verifier = createTurnstileVerifier({
      secretKey: "secreto-largo",
      fetchImpl: async () => {
        throw new TypeError("network down");
      },
    });
    expect(await verifier.verify(BASE_INPUT)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("bloquea si Cloudflare responde con error HTTP", async () => {
    const verifier = createTurnstileVerifier({
      secretKey: "secreto-largo",
      fetchImpl: async () => jsonResponse({ success: true }, { status: 503 }),
    });
    expect(await verifier.verify(BASE_INPUT)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("bloquea si hubo redirección", async () => {
    const response = jsonResponse({ success: true, hostname: "cotizaprime.test" });
    Object.defineProperty(response, "redirected", { value: true });
    const verifier = createTurnstileVerifier({
      secretKey: "secreto-largo",
      fetchImpl: async () => response,
    });
    expect(await verifier.verify(BASE_INPUT)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("bloquea si la respuesta no es JSON, no tiene la forma esperada o es enorme", async () => {
    const make = (response: Response) =>
      createTurnstileVerifier({ secretKey: "secreto-largo", fetchImpl: async () => response });
    expect(await make(new Response("<html>")).verify(BASE_INPUT)).toEqual({
      ok: false,
      reason: "bad_response",
    });
    expect(await make(jsonResponse({ ok: true })).verify(BASE_INPUT)).toEqual({
      ok: false,
      reason: "bad_response",
    });
    expect(await make(jsonResponse({ success: "true" })).verify(BASE_INPUT)).toEqual({
      ok: false,
      reason: "bad_response",
    });
    expect(await make(jsonResponse([1, 2])).verify(BASE_INPUT)).toEqual({
      ok: false,
      reason: "bad_response",
    });
    expect(await make(new Response("x".repeat(20_000))).verify(BASE_INPUT)).toEqual({
      ok: false,
      reason: "bad_response",
    });
  });

  it("corta a los 5 segundos si Cloudflare no contesta", async () => {
    const verifier = createTurnstileVerifier({
      secretKey: "secreto-largo",
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    expect(await verifier.verify(BASE_INPUT)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("no consulta a Cloudflare con un token vacío o enorme", async () => {
    const fetchImpl = vi.fn();
    const verifier = createTurnstileVerifier({ secretKey: "secreto-largo", fetchImpl });
    expect(await verifier.verify({ ...BASE_INPUT, token: "" })).toEqual({
      ok: false,
      reason: "missing_token",
    });
    expect(
      await verifier.verify({ ...BASE_INPUT, token: "a".repeat(TURNSTILE_TOKEN_MAX_LENGTH + 1) }),
    ).toEqual({ ok: false, reason: "invalid_token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("la dirección de consulta es fija: no depende de la entrada", () => {
    expect(TURNSTILE_VERIFY_URL).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
  });
});

describe("loadAntibotConfig", () => {
  it("fuera de producción usa memory por defecto", () => {
    expect(loadAntibotConfig({ NEXT_PUBLIC_APP_ENV: "test" }).provider).toBe("memory");
    expect(loadAntibotConfig({}).provider).toBe("memory");
  });

  it("en producción exige el proveedor", () => {
    expect(() => loadAntibotConfig({ NEXT_PUBLIC_APP_ENV: "production" })).toThrow(
      AntibotConfigError,
    );
  });

  it("en producción se niega a arrancar con memory", () => {
    expect(() =>
      loadAntibotConfig({ NEXT_PUBLIC_APP_ENV: "production", ANTIBOT_PROVIDER: "memory" }),
    ).toThrow(/no se permite en producción/);
  });

  it("turnstile exige las dos claves", () => {
    expect(() => loadAntibotConfig({ ANTIBOT_PROVIDER: "turnstile" })).toThrow(
      /TURNSTILE_SECRET_KEY/,
    );
    expect(() =>
      loadAntibotConfig({ ANTIBOT_PROVIDER: "turnstile", TURNSTILE_SECRET_KEY: "secreto-largo" }),
    ).toThrow(/NEXT_PUBLIC_TURNSTILE_SITE_KEY/);
  });

  it("acepta turnstile completo en producción", () => {
    const config = loadAntibotConfig({
      NEXT_PUBLIC_APP_ENV: "production",
      ANTIBOT_PROVIDER: "turnstile",
      TURNSTILE_SECRET_KEY: "secreto-largo",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "sitio-publico",
    });
    expect(config).toEqual({
      provider: "turnstile",
      turnstileSecretKey: "secreto-largo",
      turnstileSiteKey: "sitio-publico",
    });
    expect(createAntibotVerifier(config).provider).toBe("turnstile");
  });

  it("rechaza proveedores desconocidos sin mostrar valores", () => {
    try {
      loadAntibotConfig({ ANTIBOT_PROVIDER: "recaptcha", TURNSTILE_SECRET_KEY: "valor-secreto-x" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("ANTIBOT_PROVIDER");
      expect((error as Error).message).not.toContain("valor-secreto-x");
      expect((error as Error).message).not.toContain("recaptcha");
    }
  });

  it("trata variables vacías como ausentes", () => {
    expect(loadAntibotConfig({ ANTIBOT_PROVIDER: "  ", TURNSTILE_SECRET_KEY: "" }).provider).toBe(
      "memory",
    );
  });

  it("una clave demasiado corta es inválida", () => {
    expect(() =>
      loadAntibotConfig({
        ANTIBOT_PROVIDER: "turnstile",
        TURNSTILE_SECRET_KEY: "corta",
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: "sitio-publico",
      }),
    ).toThrow(/TURNSTILE_SECRET_KEY/);
  });
});

describe("getAntibotVerifier", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetAntibotVerifierForTests();
  });

  it("devuelve el adaptador según ANTIBOT_PROVIDER y lo reutiliza", () => {
    vi.stubEnv("ANTIBOT_PROVIDER", "memory");
    resetAntibotVerifierForTests();
    const first = getAntibotVerifier();
    expect(first.provider).toBe("memory");
    expect(getAntibotVerifier()).toBe(first);
  });

  it("en producción con memory lanza", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    vi.stubEnv("ANTIBOT_PROVIDER", "memory");
    resetAntibotVerifierForTests();
    expect(() => getAntibotVerifier()).toThrow(AntibotConfigError);
  });
});
