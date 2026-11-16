import { describe, expect, it } from "vitest";
import {
  MFA_ANNUL_PATH,
  MFA_ANNUL_TOKEN_LENGTH,
  hashMfaAnnulToken,
  isWellFormedMfaAnnulToken,
  mfaAnnulUrl,
  newMfaAnnulToken,
} from "./mfa-annul-token";

describe("código del enlace de anulación", () => {
  it("son 43 caracteres base64url, distintos cada vez", () => {
    const first = newMfaAnnulToken();
    const second = newMfaAnnulToken();
    expect(first).toHaveLength(MFA_ANNUL_TOKEN_LENGTH);
    expect(isWellFormedMfaAnnulToken(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("rechaza lo que no tiene la forma de un código", () => {
    for (const bad of [
      "",
      "abc",
      `${"a".repeat(42)}!`,
      "a".repeat(44),
      `${"a".repeat(42)} `,
      `${"a".repeat(42)}\n`,
    ]) {
      expect(isWellFormedMfaAnnulToken(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("la huella son 64 hexadecimales, estable, distinta por código y no contiene el código", () => {
    const token = newMfaAnnulToken();
    expect(hashMfaAnnulToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMfaAnnulToken(token)).toBe(hashMfaAnnulToken(token));
    expect(hashMfaAnnulToken(token)).not.toBe(hashMfaAnnulToken(newMfaAnnulToken()));
    expect(hashMfaAnnulToken(token)).not.toContain(token);
    // Vector fijo, para que nadie cambie el algoritmo sin darse cuenta (sha256 en hexadecimal).
    expect(hashMfaAnnulToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("la dirección lleva el código tras el «#», nunca en la ruta ni en la consulta; sin barras repetidas del origen", () => {
    const token = newMfaAnnulToken();
    const url = mfaAnnulUrl("https://app.ejemplo.test/", token);
    expect(url).toBe(`https://app.ejemplo.test${MFA_ANNUL_PATH}#${token}`);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(MFA_ANNUL_PATH);
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe(`#${token}`);
  });
});
