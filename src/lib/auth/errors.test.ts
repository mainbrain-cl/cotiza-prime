import { describe, expect, it } from "vitest";
import { AUTH_MESSAGES, classifyAuthError } from "./errors";
import { RESET_REQUEST_SENT_MESSAGE } from "./messages";
import {
  fieldErrorsOf,
  forgotPasswordSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
} from "./schemas";

describe("classifyAuthError", () => {
  it("reconoce el bloqueo por demasiados intentos", () => {
    expect(classifyAuthError({ status: 429 })).toBe("rate_limited");
    expect(classifyAuthError({ code: "over_request_rate_limit" })).toBe("rate_limited");
    expect(classifyAuthError({ code: "over_email_send_rate_limit" })).toBe("rate_limited");
  });

  it("separa credenciales, contraseña débil y correo sin verificar", () => {
    expect(classifyAuthError({ code: "invalid_credentials" })).toBe("invalid_credentials");
    expect(classifyAuthError({ code: "weak_password" })).toBe("weak_password");
    expect(classifyAuthError({ code: "email_not_confirmed" })).toBe("email_not_confirmed");
    expect(classifyAuthError({ code: "otra_cosa" })).toBe("unknown");
  });

  it("el mensaje de credenciales no distingue entre correo y contraseña", () => {
    expect(AUTH_MESSAGES.invalid_credentials).toBe("Correo o contraseña incorrectos.");
  });
});

describe("restablecer contraseña (H-003)", () => {
  it("la contraseña nueva exige el largo mínimo y que ambas coincidan", () => {
    const short = resetPasswordSchema.safeParse({ password: "corta", confirmPassword: "corta" });
    expect(short.success).toBe(false);
    if (!short.success) {
      expect(fieldErrorsOf(short.error).password).toBe(
        "La contraseña debe tener al menos 10 caracteres.",
      );
    }

    const mismatch = resetPasswordSchema.safeParse({
      password: "una-clave-larga",
      confirmPassword: "otra-clave-larga",
    });
    expect(mismatch.success).toBe(false);
    if (!mismatch.success) {
      expect(fieldErrorsOf(mismatch.error).confirmPassword).toBe("Las contraseñas no coinciden.");
    }

    expect(
      resetPasswordSchema.safeParse({
        password: "una-clave-larga",
        confirmPassword: "una-clave-larga",
      }).success,
    ).toBe(true);
  });

  it("el correo del pedido se limpia y se valida", () => {
    const ok = forgotPasswordSchema.safeParse({ email: "  ANA@Ejemplo.test " });
    expect(ok.success && ok.data.email).toBe("ana@ejemplo.test");
    expect(forgotPasswordSchema.safeParse({ email: "no-es-correo" }).success).toBe(false);
  });

  it("reconoce la contraseña repetida y el mensaje del pedido no depende de la cuenta", () => {
    expect(classifyAuthError({ code: "same_password" })).toBe("same_password");
    expect(AUTH_MESSAGES.same_password).toContain("distinta");
    expect(RESET_REQUEST_SENT_MESSAGE).toMatch(/^Si ese correo tiene una cuenta/);
  });
});

describe("schemas de cuenta", () => {
  const valid = {
    fullName: "  Ana Pérez ",
    email: " ANA@Ejemplo.test ",
    password: "una-clave-larga",
    acceptLegal: "on",
  };

  it("normaliza nombre y correo", () => {
    const parsed = signUpSchema.parse(valid);
    expect(parsed.fullName).toBe("Ana Pérez");
    expect(parsed.email).toBe("ana@ejemplo.test");
  });

  it("exige al menos 10 caracteres y lo dice", () => {
    const result = signUpSchema.safeParse({ ...valid, password: "corta" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(fieldErrorsOf(result.error).password).toContain("10 caracteres");
    }
  });

  it("exige aceptar términos y privacidad", () => {
    const result = signUpSchema.safeParse({ ...valid, acceptLegal: undefined });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(fieldErrorsOf(result.error).acceptLegal).toContain("términos");
    }
  });

  it("rechaza correos mal escritos al ingresar", () => {
    expect(signInSchema.safeParse({ email: "no-es-correo", password: "x" }).success).toBe(false);
    expect(signInSchema.safeParse({ email: "a@b.test", password: "x" }).success).toBe(true);
  });
});
