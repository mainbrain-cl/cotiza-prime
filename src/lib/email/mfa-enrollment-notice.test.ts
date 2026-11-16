import { describe, expect, it } from "vitest";
import {
  MFA_NOTICE_BUTTON_LABEL,
  MFA_NOTICE_SUBJECT,
  buildMfaEnrollmentNotice,
} from "./mfa-enrollment-notice";

const base = {
  recipientAddress: "duena@ejemplo.test",
  fromAddress: "cotizaciones@ejemplo.test",
  enrolledAt: "2026-11-12T20:05:00Z",
  annulUrl: "https://app.ejemplo.test/cuenta/anular-dos-pasos#abcDEF_-123",
  expiresAt: "2026-11-15T20:05:00Z",
  idempotencyKey: "alerta-1",
};

describe("correo de aviso de la activación del segundo paso", () => {
  it("lleva el asunto, la fecha con la hora de Chile, el botón con el «#», el vencimiento y las frases pedidas", () => {
    const built = buildMfaEnrollmentNotice(base);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { message } = built;
    expect(message.subject).toBe(MFA_NOTICE_SUBJECT);
    expect(message.to).toBe("duena@ejemplo.test");
    expect(message.from).toEqual({ name: "Cotiza Prime", address: "cotizaciones@ejemplo.test" });
    expect(message.idempotencyKey).toBe("alerta-1");
    // 20:05 UTC del 12-11-2026 son las 17:05 en Chile (horario de verano, UTC-3).
    expect(message.text).toContain("el 12-11-2026 17:05, hora de Chile");
    expect(message.text).toContain("hasta el 15-11-2026 17:05");
    expect(message.text).toContain("Si fuiste tú, no hagas nada.");
    expect(message.text).toContain("No lo reenvíes.");
    expect(message.text).toContain(
      "Después de anular, revisa «Tu equipo» y el registro de actividad.",
    );
    expect(message.text).toContain(`${MFA_NOTICE_BUTTON_LABEL}: ${base.annulUrl}`);
    expect(message.html).toContain(`href="${base.annulUrl}"`);
    expect(message.html).toContain(MFA_NOTICE_BUTTON_LABEL);
    expect(message.html).toContain('lang="es-CL"');
  });

  it("escapa el HTML de lo que escribe una persona (el correo) y del enlace", () => {
    const built = buildMfaEnrollmentNotice({
      ...base,
      recipientAddress: 'a"<b>@ejemplo.test',
      annulUrl: 'https://app.ejemplo.test/cuenta/anular-dos-pasos#a"onmouseover="x',
    });
    // Una dirección con comillas o «<» no es un correo válido: no sale.
    expect(built).toEqual({ ok: false, code: "invalid_input" });
    const withAmp = buildMfaEnrollmentNotice({
      ...base,
      recipientAddress: "a.b@ejemplo.test",
      annulUrl: "https://app.ejemplo.test/cuenta/anular-dos-pasos?x=1&y=2#codigo",
    });
    expect(withAmp.ok).toBe(true);
    if (!withAmp.ok) return;
    expect(withAmp.message.html).toContain("?x=1&amp;y=2#codigo");
    expect(withAmp.message.html).not.toContain("x=1&y=2");
  });

  it("no sale con datos inválidos: destinatario, remitente, enlace sin código, enlace que no es http(s) o fechas", () => {
    for (const bad of [
      { recipientAddress: "no-es-correo" },
      { fromAddress: "tampoco" },
      { annulUrl: "no es una dirección" },
      { annulUrl: "https://app.ejemplo.test/cuenta/anular-dos-pasos" },
      { annulUrl: "https://app.ejemplo.test/cuenta/anular-dos-pasos#" },
      { annulUrl: "javascript:alert(1)#x" },
      { enrolledAt: "ayer" },
      { expiresAt: "mañana" },
    ]) {
      expect(buildMfaEnrollmentNotice({ ...base, ...bad }), JSON.stringify(bad)).toEqual({
        ok: false,
        code: "invalid_input",
      });
    }
  });
});
