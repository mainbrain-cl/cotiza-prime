import { describe, expect, it } from "vitest";
import { INVITATION_ACCEPT_PATH } from "@/lib/team/accept-model";
import { HOME_PATH, RESET_PASSWORD_PATH } from "./paths";
import { MFA_ISSUER, afterSecondStepPath, formatManualKey } from "./second-step";

describe("afterSecondStepPath", () => {
  it("venía de recuperar la contraseña: a elegir la nueva", () => {
    expect(afterSecondStepPath({ recovery: true, invitation: false })).toBe(RESET_PASSWORD_PATH);
  });

  it("venía de una invitación: a unirse", () => {
    expect(afterSecondStepPath({ recovery: false, invitation: true })).toBe(INVITATION_ACCEPT_PATH);
  });

  it("si venía de las dos, manda la recuperación (lo que acaba de abrir)", () => {
    expect(afterSecondStepPath({ recovery: true, invitation: true })).toBe(RESET_PASSWORD_PATH);
  });

  it("si no, al inicio", () => {
    expect(afterSecondStepPath({ recovery: false, invitation: false })).toBe(HOME_PATH);
  });
});

describe("formatManualKey", () => {
  it("agrupa de a 4 y deja el último grupo más corto", () => {
    expect(formatManualKey("TWQ3UWF4FFRW5AA2")).toBe("TWQ3 UWF4 FFRW 5AA2");
    expect(formatManualKey("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
  });

  it("ignora espacios y guiones y pasa a mayúsculas", () => {
    expect(formatManualKey("twq3 uwf4-ffrw")).toBe("TWQ3 UWF4 FFRW");
  });

  it("una clave vacía da texto vacío", () => {
    expect(formatManualKey("")).toBe("");
  });
});

describe("constantes", () => {
  it("el nombre que ve la persona en su aplicación es Cotiza Prime", () => {
    expect(MFA_ISSUER).toBe("Cotiza Prime");
  });
});
