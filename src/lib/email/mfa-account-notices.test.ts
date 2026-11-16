import { describe, expect, it } from "vitest";
import { MFA_ACCOUNT_NOTICE_IF_NOT_YOU, MFA_ACCOUNT_NOTICE_IF_YOU } from "./mfa-account-notice";
import { buildMfaDisabledNotice, MFA_DISABLED_SUBJECT } from "./mfa-disabled-notice";
import {
  buildMfaRecoveryCodesCreatedNotice,
  MFA_RECOVERY_CODES_CREATED_SUBJECT,
} from "./mfa-recovery-codes-created-notice";
import { buildMfaRecoveryUsedNotice, MFA_RECOVERY_USED_SUBJECT } from "./mfa-recovery-used-notice";

const base = {
  recipientAddress: "duena@ejemplo.test",
  fromAddress: "cotizaciones@ejemplo.test",
  happenedAt: "2026-11-12T20:05:00Z",
  forgotPasswordUrl: "https://app.ejemplo.test/recuperar-contrasena",
  idempotencyKey: "aviso-1",
};

const notices = [
  {
    name: "desactivar",
    build: buildMfaDisabledNotice,
    subject: MFA_DISABLED_SUBJECT,
    mentions: ["se pidió desactivar la verificación en dos pasos", "cierra tu sesión"],
  },
  {
    name: "se usó un código de respaldo",
    build: buildMfaRecoveryUsedNotice,
    subject: MFA_RECOVERY_USED_SUBJECT,
    mentions: ["con un código de respaldo", "desactivamos la verificación en dos pasos"],
  },
  {
    name: "códigos de respaldo nuevos",
    build: buildMfaRecoveryCodesCreatedNotice,
    subject: MFA_RECOVERY_CODES_CREATED_SUBJECT,
    mentions: [
      "se crearon códigos de respaldo nuevos",
      "Si había otros códigos de respaldo, ya no sirven",
    ],
  },
] as const;

describe.each(notices)("correo «$name»", ({ build, subject, mentions }) => {
  it("lleva el asunto, la fecha con la hora de Chile, la cuenta, «Si fuiste tú…» y el botón a recuperar la contraseña", () => {
    const built = build(base);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { message } = built;
    expect(message.subject).toBe(subject);
    expect(message.to).toBe("duena@ejemplo.test");
    expect(message.from).toEqual({ name: "Cotiza Prime", address: "cotizaciones@ejemplo.test" });
    expect(message.idempotencyKey).toBe("aviso-1");
    expect(message.text).toContain("12-11-2026 17:05");
    expect(message.text).toContain("(duena@ejemplo.test)");
    expect(message.text).toContain(MFA_ACCOUNT_NOTICE_IF_YOU);
    expect(message.text).toContain(MFA_ACCOUNT_NOTICE_IF_NOT_YOU);
    for (const mention of mentions) expect(message.text).toContain(mention);
    expect(message.text).toContain("https://app.ejemplo.test/recuperar-contrasena");
    expect(message.html).toContain('href="https://app.ejemplo.test/recuperar-contrasena"');
    expect(message.html).toContain("Cambiar mi contraseña");
    // Nada con código: ni «#» ni consulta en ningún enlace.
    expect(message.html).not.toMatch(/href="[^"]*[#?]/);
    expect(message.text).not.toMatch(/https?:\/\/\S*[#?]/);
  });

  it("nunca lleva un código de respaldo: ni uno con la forma de los códigos ni siquiera la palabra «código» seguida de un valor", () => {
    const built = build(base);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const all = `${built.message.subject}\n${built.message.text}\n${built.message.html}`;
    // Los códigos son 12 símbolos del alfabeto Crockford en grupos de 4 (con o sin guiones).
    expect(all).not.toMatch(
      /\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/,
    );
    expect(all).not.toMatch(/\b(?=[0-9A-HJKMNP-TV-Z]*\d)[0-9A-HJKMNP-TV-Z]{12}\b/);
    // Tampoco un número de 6 dígitos (el código de la aplicación).
    expect(all).not.toMatch(/\b\d{6}\b/);
  });

  it("escapa el texto: un correo con caracteres de HTML no abre una etiqueta", () => {
    const built = build({ ...base, recipientAddress: "o'brien@ejemplo.test" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.message.html).toContain("o&#39;brien@ejemplo.test");
    expect(built.message.html).not.toContain("(o'brien@ejemplo.test)");
  });

  it("no sale con datos inválidos", () => {
    for (const bad of [
      { recipientAddress: "no-es-correo" },
      { fromAddress: "tampoco" },
      { forgotPasswordUrl: "no es una dirección" },
      { forgotPasswordUrl: "javascript:alert(1)" },
      // Un enlace con código no es de este aviso
      { forgotPasswordUrl: "https://app.ejemplo.test/recuperar-contrasena#codigo" },
      { forgotPasswordUrl: "https://app.ejemplo.test/recuperar-contrasena?token=x" },
      { happenedAt: "ayer" },
    ]) {
      expect(build({ ...base, ...bad }), JSON.stringify(bad)).toEqual({
        ok: false,
        code: "invalid_input",
      });
    }
  });
});

describe("el correo de desactivar va en presente", () => {
  it("no afirma que la verificación ya quedó desactivada (sale antes de desactivar)", () => {
    const built = buildMfaDisabledNotice(base);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.message.text).not.toMatch(
      /\b(desactivamos|desactivó|quedó desactivada|ya está desactivada)\b/i,
    );
  });
});
