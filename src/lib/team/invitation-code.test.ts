import { describe, expect, it } from "vitest";
import {
  INVITATION_TOKEN_LENGTH,
  hashInvitationToken,
  invitationEmailBinding,
  invitationUrl,
  isWellFormedInvitationToken,
  newInvitationToken,
} from "./invitation-code";

describe("código de la invitación", () => {
  it("son 43 caracteres base64url, distintos cada vez", () => {
    const first = newInvitationToken();
    const second = newInvitationToken();
    expect(first).toHaveLength(INVITATION_TOKEN_LENGTH);
    expect(isWellFormedInvitationToken(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("rechaza lo que no tiene la forma de un código", () => {
    for (const bad of ["", "abc", `${"a".repeat(42)}!`, "a".repeat(44), `${"a".repeat(42)} `]) {
      expect(isWellFormedInvitationToken(bad), bad).toBe(false);
    }
  });

  it("la huella son 64 hexadecimales, estable y distinta por código", () => {
    const token = newInvitationToken();
    expect(hashInvitationToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInvitationToken(token)).toBe(hashInvitationToken(token));
    expect(hashInvitationToken(token)).not.toBe(hashInvitationToken(newInvitationToken()));
    // Valor conocido: sha256("abc")
    expect(hashInvitationToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  describe("el vínculo con el correo", () => {
    const sha = hashInvitationToken("codigo-de-prueba");

    it("es sha256 de «huella|correo normalizado» (valor conocido, el mismo que calcula la base)", () => {
      expect(invitationEmailBinding("aa", " A@b.c ")).toBe(
        "5d23333d4dcf25e9929463fb0b170fd263cbdb159a9b79063f4939cc9d1f092c",
      );
    });

    it("no depende de mayúsculas ni de espacios del correo", () => {
      expect(invitationEmailBinding(sha, "  Ana@Ejemplo.TEST ")).toBe(
        invitationEmailBinding(sha, "ana@ejemplo.test"),
      );
    });

    it("cambia con otro correo o con otro código", () => {
      expect(invitationEmailBinding(sha, "ana@ejemplo.test")).not.toBe(
        invitationEmailBinding(sha, "beto@ejemplo.test"),
      );
      expect(invitationEmailBinding(sha, "ana@ejemplo.test")).not.toBe(
        invitationEmailBinding(hashInvitationToken("otro"), "ana@ejemplo.test"),
      );
    });
  });

  it("arma la dirección del correo sin dobles barras", () => {
    expect(invitationUrl("https://app.ejemplo.test/", "abc")).toBe(
      "https://app.ejemplo.test/invitacion/abc",
    );
    expect(invitationUrl("http://localhost:3000", "abc")).toBe("http://localhost:3000/invitacion/abc");
  });
});
