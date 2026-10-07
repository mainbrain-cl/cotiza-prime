import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RENDER_AGE_SECONDS,
  MIN_FILL_SECONDS,
  RenderTokenConfigError,
  createRenderToken,
  verifyRenderToken,
} from "./render-token";

const SECRET = "secreto-de-prueba-con-mas-de-32-caracteres";
const FORM = "Xk3aBcDeFgHiJkLmNoPqRs";
const OTHER_FORM = "Zz3aBcDeFgHiJkLmNoPqRs";
const KEY = "11111111-1111-4111-8111-111111111111";
const OTHER_KEY = "22222222-2222-4222-8222-222222222222";
const T0 = 1_800_000_000;

function make(at = T0, form = FORM) {
  return createRenderToken(form, KEY, { secret: SECRET, nowSeconds: at });
}

describe("verifyRenderToken", () => {
  it("acepta un sello válido pasado el mínimo", () => {
    const result = verifyRenderToken(make(), FORM, KEY, {
      secret: SECRET,
      nowSeconds: T0 + MIN_FILL_SECONDS,
    });
    expect(result).toEqual({ ok: true, issuedAt: T0 });
  });

  it("acepta justo antes de las 24 horas y rechaza después", () => {
    const token = make();
    expect(
      verifyRenderToken(token, FORM, KEY, {
        secret: SECRET,
        nowSeconds: T0 + MAX_RENDER_AGE_SECONDS,
      }),
    ).toMatchObject({ ok: true });
    expect(
      verifyRenderToken(token, FORM, KEY, {
        secret: SECRET,
        nowSeconds: T0 + MAX_RENDER_AGE_SECONDS + 1,
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("rechaza si pasaron menos de 3 segundos", () => {
    for (const delta of [0, 1, MIN_FILL_SECONDS - 1]) {
      expect(
        verifyRenderToken(make(), FORM, KEY, { secret: SECRET, nowSeconds: T0 + delta }),
      ).toEqual({
        ok: false,
        reason: "too_fast",
      });
    }
  });

  it("rechaza un sello del futuro (más allá de la tolerancia de relojes)", () => {
    expect(
      verifyRenderToken(make(T0 + 600), FORM, KEY, { secret: SECRET, nowSeconds: T0 }),
    ).toEqual({
      ok: false,
      reason: "future",
    });
  });

  it("rechaza un sello de otro formulario", () => {
    expect(
      verifyRenderToken(make(T0, OTHER_FORM), FORM, KEY, { secret: SECRET, nowSeconds: T0 + 10 }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rechaza un sello atado a otra clave de envío (no sirve para otro envío)", () => {
    expect(
      verifyRenderToken(make(), FORM, OTHER_KEY, { secret: SECRET, nowSeconds: T0 + 10 }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyRenderToken(make(), FORM, "", { secret: SECRET, nowSeconds: T0 + 10 })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rechaza si cambia la hora o la firma", () => {
    const [v, , signature] = make().split(".");
    const forgedTime = `${v}.${T0 - 100}.${signature}`;
    expect(
      verifyRenderToken(forgedTime, FORM, KEY, { secret: SECRET, nowSeconds: T0 + 10 }),
    ).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const flipped = `${v}.${T0}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    expect(verifyRenderToken(flipped, FORM, KEY, { secret: SECRET, nowSeconds: T0 + 10 })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rechaza si se firmó con otro secreto", () => {
    const token = createRenderToken(FORM, KEY, {
      secret: "otro-secreto-distinto-de-32-caracteres-o-mas",
      nowSeconds: T0,
    });
    expect(verifyRenderToken(token, FORM, KEY, { secret: SECRET, nowSeconds: T0 + 10 })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it.each([
    undefined,
    null,
    42,
    {},
    "",
    "basura",
    "v1.123.",
    "v1..abc",
    "v2.1800000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "v1.-5.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "v1.1800000000.corta",
    `v1.1800000000.${"A".repeat(300)}`,
    "v1.1800000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.extra",
    "v1.99999999999999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ])("rechaza el sello mal formado %j", (token) => {
    expect(verifyRenderToken(token, FORM, KEY, { secret: SECRET, nowSeconds: T0 + 10 })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("el sello no contiene el secreto ni el id del formulario", () => {
    const token = make();
    expect(token).not.toContain(SECRET);
    expect(token).not.toContain(FORM);
  });
});

describe("secreto", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("falla si falta o es corto", () => {
    vi.stubEnv("INTAKE_RENDER_SECRET", "");
    expect(() => createRenderToken(FORM, KEY)).toThrow(RenderTokenConfigError);
    expect(() => createRenderToken(FORM, KEY, { secret: "corto" })).toThrow(RenderTokenConfigError);
    expect(() => verifyRenderToken("x", FORM, KEY)).toThrow(RenderTokenConfigError);
  });

  it("lee INTAKE_RENDER_SECRET del entorno", () => {
    vi.stubEnv("INTAKE_RENDER_SECRET", SECRET);
    const token = createRenderToken(FORM, KEY, { nowSeconds: T0 });
    expect(verifyRenderToken(token, FORM, KEY, { nowSeconds: T0 + 5 })).toMatchObject({ ok: true });
  });

  it("el mensaje de error no incluye el valor", () => {
    try {
      createRenderToken(FORM, KEY, { secret: "valor-corto" });
    } catch (error) {
      expect((error as Error).message).not.toContain("valor-corto");
    }
  });
});
