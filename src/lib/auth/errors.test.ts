import { describe, expect, it } from "vitest";
import { AUTH_MESSAGES, classifyAuthError } from "./errors";
import { fieldErrorsOf, signInSchema, signUpSchema } from "./schemas";

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
