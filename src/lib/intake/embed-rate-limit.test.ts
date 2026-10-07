import { describe, expect, it } from "vitest";
import {
  EMBED_READ_MAX_PER_WINDOW,
  EMBED_READ_WINDOW_MS,
  FixedWindowLimiter,
  UNKNOWN_IP_KEY,
  allowEmbedRead,
  clearEmbedReadLimiter,
  embedClientKey,
} from "./embed-rate-limit";

describe("FixedWindowLimiter", () => {
  it("deja pasar hasta el tope de la ventana y corta el resto", () => {
    const limiter = new FixedWindowLimiter(1_000, 3, 10);
    expect([1, 2, 3, 4, 5].map(() => limiter.allow("ip", 0))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(limiter.allow("otra", 0)).toBe(true);
  });

  it("al terminar la ventana vuelve a empezar", () => {
    const limiter = new FixedWindowLimiter(1_000, 1, 10);
    expect(limiter.allow("ip", 0)).toBe(true);
    expect(limiter.allow("ip", 999)).toBe(false);
    expect(limiter.allow("ip", 1_000)).toBe(true);
  });

  it("la memoria está acotada: nunca hay más de maxKeys claves", () => {
    const limiter = new FixedWindowLimiter(60_000, 5, 50);
    for (let i = 0; i < 500; i += 1) limiter.allow(`ip-${i}`, i);
    expect(limiter.size).toBeLessThanOrEqual(50);
  });
});

describe("límite de lecturas del marco incrustable", () => {
  it("toma la primera IP válida de x-forwarded-for; sin IP válida comparte una sola clave", () => {
    expect(embedClientKey("203.0.113.9, 10.0.0.1")).toBe("203.0.113.9");
    expect(embedClientKey("no-es-ip")).toBe(UNKNOWN_IP_KEY);
    expect(embedClientKey(null)).toBe(UNKNOWN_IP_KEY);
  });

  it("pasado el tope por IP niega; otra IP no se ve afectada", () => {
    clearEmbedReadLimiter();
    const now = 5_000_000;
    for (let i = 0; i < EMBED_READ_MAX_PER_WINDOW; i += 1) {
      expect(allowEmbedRead("203.0.113.9", now)).toBe(true);
    }
    expect(allowEmbedRead("203.0.113.9", now)).toBe(false);
    expect(allowEmbedRead("203.0.113.10", now)).toBe(true);
    expect(allowEmbedRead("203.0.113.9", now + EMBED_READ_WINDOW_MS)).toBe(true);
    clearEmbedReadLimiter();
  });
});
