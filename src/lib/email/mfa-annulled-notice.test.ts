import { describe, expect, it } from "vitest";
import { MFA_ANNULLED_SUBJECT, buildMfaAnnulledNotice } from "./mfa-annulled-notice";

const base = {
  recipientAddress: "duena@ejemplo.test",
  fromAddress: "cotizaciones@ejemplo.test",
  annulledAt: "2026-11-12T20:05:00Z",
  forgotPasswordUrl: "https://app.ejemplo.test/recuperar-contrasena",
  idempotencyKey: "alerta-1",
};

describe("correo «Anulamos la verificación en dos pasos de tu cuenta»", () => {
  it("lleva el asunto, la fecha con la hora de Chile, qué se hizo y qué sigue, y solo la dirección pública de recuperar", () => {
    const built = buildMfaAnnulledNotice(base);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { message } = built;
    expect(message.subject).toBe(MFA_ANNULLED_SUBJECT);
    expect(message.to).toBe("duena@ejemplo.test");
    expect(message.idempotencyKey).toBe("alerta-1");
    expect(message.text).toContain("12-11-2026 17:05");
    expect(message.text).toContain("cerramos todas las sesiones");
    expect(message.text).toContain("«¿Olvidaste tu contraseña?»");
    expect(message.text).toContain("«Tu equipo»");
    expect(message.html).toContain('href="https://app.ejemplo.test/recuperar-contrasena"');
    // Nada con código: ni «#» ni consulta.
    expect(message.html).not.toMatch(/href="[^"]*[#?]/);
  });

  it("no sale con datos inválidos", () => {
    for (const bad of [
      { recipientAddress: "no-es-correo" },
      { fromAddress: "tampoco" },
      { forgotPasswordUrl: "no es una dirección" },
      { forgotPasswordUrl: "javascript:alert(1)" },
      { annulledAt: "ayer" },
    ]) {
      expect(buildMfaAnnulledNotice({ ...base, ...bad }), JSON.stringify(bad)).toEqual({
        ok: false,
        code: "invalid_input",
      });
    }
  });
});
