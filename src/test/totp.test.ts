import { describe, expect, it } from "vitest";
import { base32ToBuffer, freshTotp, totpAt } from "./totp";

// Clave de los vectores de prueba del RFC 6238 (ASCII "12345678901234567890") en base32.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("generador de códigos de prueba (RFC 6238, SHA-1, 6 dígitos)", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ])("a los %i segundos da %s", (seconds, expected) => {
    expect(totpAt(RFC_SECRET, seconds)).toBe(expected);
  });

  it("respeta los dígitos pedidos (8 dígitos, vector del RFC)", () => {
    expect(totpAt(RFC_SECRET, 59, { digits: 8 })).toBe("94287082");
  });

  it("base32 ignora espacios, guiones, minúsculas y relleno", () => {
    expect(base32ToBuffer("gezd gnbv-GY3T QOJQ====").toString("utf8")).toBe("1234567890");
    expect(base32ToBuffer(RFC_SECRET).toString("utf8")).toBe("12345678901234567890");
  });

  it("base32 rechaza caracteres que no existen", () => {
    expect(() => base32ToBuffer("AB1!")).toThrow();
  });
});

describe("freshTotp", () => {
  const fakeClock = (startMs: number) => {
    let ms = startMs;
    const waits: number[] = [];
    return {
      now: () => ms,
      wait: async (delay: number) => {
        waits.push(delay);
        ms += delay;
      },
      waits,
    };
  };

  it("devuelve el código del período actual si quedan segundos de sobra", async () => {
    const clock = fakeClock(1_000_000_000_000 - (1_000_000_000 % 30) * 1000 + 3_000);
    const fresh = await freshTotp(RFC_SECRET, clock);
    expect(clock.waits).toEqual([]);
    expect(fresh.code).toBe(totpAt(RFC_SECRET, clock.now() / 1000));
    expect(fresh.step).toBe(Math.floor(clock.now() / 1000 / 30));
  });

  it("espera al siguiente período si quedan menos de 5 segundos", async () => {
    const periodStartMs = 1_000_000_020_000 - (1_000_000_020_000 % 30_000);
    const clock = fakeClock(periodStartMs + 27_000);
    const fresh = await freshTotp(RFC_SECRET, clock);
    expect(clock.waits).toHaveLength(1);
    expect(fresh.step).toBe(periodStartMs / 30_000 + 1);
  });

  it("espera al siguiente si el período es el que hay que evitar", async () => {
    const periodStartMs = 1_000_000_020_000 - (1_000_000_020_000 % 30_000);
    const clock = fakeClock(periodStartMs + 2_000);
    const used = periodStartMs / 30_000;
    const fresh = await freshTotp(RFC_SECRET, { ...clock, avoidStep: used });
    expect(fresh.step).toBe(used + 1);
    expect(fresh.code).not.toBe(totpAt(RFC_SECRET, periodStartMs / 1000));
  });
});
