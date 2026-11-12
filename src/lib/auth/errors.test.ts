import { describe, expect, it } from "vitest";
import { AUTH_MESSAGES, MFA_LOCKED_DAY_ENROLLMENT_MESSAGE, classifyAuthError } from "./errors";
import { RESET_REQUEST_SENT_MESSAGE } from "./messages";
import {
  fieldErrorsOf,
  forgotPasswordSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
  totpCodeSchema,
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

describe("verificación en dos pasos (H-004a): errores", () => {
  it("traduce los códigos de Supabase Auth a los cuatro casos de la pantalla", () => {
    expect(classifyAuthError({ code: "mfa_verification_failed" })).toBe("mfa_invalid_code");
    expect(classifyAuthError({ code: "mfa_challenge_expired" })).toBe("mfa_expired");
    expect(classifyAuthError({ code: "mfa_factor_not_found" })).toBe("mfa_expired");
    expect(classifyAuthError({ code: "insufficient_aal" })).toBe("mfa_unavailable");
    expect(classifyAuthError({ code: "mfa_ip_address_mismatch" })).toBe("mfa_unavailable");
  });

  it("el límite de Supabase sigue siendo «demasiados intentos», no un código incorrecto", () => {
    expect(classifyAuthError({ status: 429, code: "mfa_verification_failed" })).toBe(
      "rate_limited",
    );
    expect(classifyAuthError({ code: "over_request_rate_limit" })).toBe("rate_limited");
  });

  it("el bloqueo de 24 horas al activar manda a revisar la hora del teléfono y no habla de la contraseña", () => {
    expect(MFA_LOCKED_DAY_ENROLLMENT_MESSAGE).toMatch(/Demasiados intentos hoy/);
    expect(MFA_LOCKED_DAY_ENROLLMENT_MESSAGE).toMatch(/hora de tu teléfono/);
    expect(MFA_LOCKED_DAY_ENROLLMENT_MESSAGE).not.toMatch(/contraseña|alguien/);
  });

  it("un error desconocido de la verificación no revela detalles", () => {
    expect(classifyAuthError({ code: "mfa_algo_nuevo" })).toBe("unknown");
  });

  it("los mensajes son los del plan, en español de Chile y sin jerga", () => {
    expect(AUTH_MESSAGES.mfa_invalid_code).toBe(
      "El código no coincide. Escribe el que muestra ahora tu aplicación (cambia cada 30 segundos) y revisa que la hora de tu teléfono esté al día.",
    );
    expect(AUTH_MESSAGES.mfa_code_reused).toBe("Ese código ya se usó. Espera el siguiente.");
    expect(AUTH_MESSAGES.mfa_expired).toBe("La activación caducó. Vuelve a empezar.");
    expect(AUTH_MESSAGES.mfa_unavailable).toMatch(/No pudimos verificar el código/);
    for (const kind of [
      "mfa_invalid_code",
      "mfa_code_reused",
      "mfa_expired",
      "mfa_unavailable",
    ] as const) {
      expect(AUTH_MESSAGES[kind]).not.toMatch(/TOTP|aal|MFA|factor/i);
    }
  });
});

describe("totpCodeSchema (H-004a)", () => {
  const parse = (code: unknown) => totpCodeSchema.safeParse({ code });

  it("acepta 6 dígitos", () => {
    expect(parse("123456")).toMatchObject({ success: true, data: { code: "123456" } });
    expect(parse("000000")).toMatchObject({ success: true, data: { code: "000000" } });
  });

  it("quita espacios y guiones: «123 456», «123-456» y con espacios a los lados", () => {
    for (const typed of ["123 456", "123-456", " 123456 ", "1 2 3 4 5 6", "123\u00a0456"]) {
      expect(parse(typed)).toMatchObject({ success: true, data: { code: "123456" } });
    }
  });

  it.each(["12345", "1234567", "12345a", "abcdef", "12.456", "12345６", "123456 7", "+123456", ""])(
    "rechaza %j",
    (typed) => {
      const result = parse(typed);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(fieldErrorsOf(result.error).code).toMatch(/código|números/i);
      }
    },
  );

  it("rechaza lo que no es texto o viene vacío y un texto enorme", () => {
    expect(parse(undefined).success).toBe(false);
    expect(parse(123456).success).toBe(false);
    expect(parse(null).success).toBe(false);
    expect(parse("1".repeat(5000)).success).toBe(false);
  });
});
