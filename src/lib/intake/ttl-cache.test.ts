import { describe, expect, it } from "vitest";
import { TtlCache } from "./ttl-cache";

describe("TtlCache", () => {
  it("guarda y devuelve hasta que vence", () => {
    const cache = new TtlCache<string[]>(60_000, 10);
    cache.set("a", ["x"], 1_000);
    expect(cache.get("a", 60_999)).toEqual(["x"]);
    expect(cache.get("a", 61_000)).toBeUndefined();
    expect(cache.get("otra", 1_000)).toBeUndefined();
  });

  it("nunca pasa del máximo: descarta primero lo vencido y luego lo más antiguo", () => {
    const cache = new TtlCache<number>(100, 3);
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    cache.set("c", 3, 0);
    cache.set("d", 4, 1_000); // a, b y c ya vencieron
    expect(cache.size).toBe(1);
    cache.set("e", 5, 1_001);
    cache.set("f", 6, 1_002);
    cache.set("g", 7, 1_003); // lleno y nada vencido: sale el más antiguo
    expect(cache.size).toBe(3);
    expect(cache.get("d", 1_003)).toBeUndefined();
    expect(cache.get("g", 1_003)).toBe(7);
  });

  it("volver a guardar una clave la renueva sin crecer", () => {
    const cache = new TtlCache<number>(100, 2);
    cache.set("a", 1, 0);
    cache.set("a", 2, 50);
    expect(cache.size).toBe(1);
    expect(cache.get("a", 140)).toBe(2);
  });

  it("clear lo vacía", () => {
    const cache = new TtlCache<number>(100, 2);
    cache.set("a", 1, 0);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
