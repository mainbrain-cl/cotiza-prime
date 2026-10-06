import { describe, expect, it } from "vitest";
import { hashShareToken, isWellFormedShareToken, newShareToken, SHARE_TOKEN_LENGTH } from "./token";

describe("token del enlace del cliente", () => {
  it("tiene 43 caracteres en base64url", () => {
    for (let i = 0; i < 50; i += 1) {
      const token = newShareToken();
      expect(token).toHaveLength(SHARE_TOKEN_LENGTH);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(isWellFormedShareToken(token)).toBe(true);
    }
  });

  it("no se repite", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => newShareToken()));
    expect(tokens.size).toBe(500);
  });

  it("rechaza lo que no tiene la forma de un token", () => {
    expect(isWellFormedShareToken("")).toBe(false);
    expect(isWellFormedShareToken("a".repeat(42))).toBe(false);
    expect(isWellFormedShareToken("a".repeat(44))).toBe(false);
    expect(isWellFormedShareToken(`${"a".repeat(42)}+`)).toBe(false);
    expect(isWellFormedShareToken(`${"a".repeat(42)}\n`)).toBe(false);
  });

  it("el sello es sha256 en hexadecimal y distinto para cada token", () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(hashShareToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashShareToken(a)).toBe(hashShareToken(a));
    expect(hashShareToken(a)).not.toBe(hashShareToken(b));
    expect(hashShareToken(a)).not.toBe(a);
  });
});
