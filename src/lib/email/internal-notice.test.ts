import { describe, expect, it } from "vitest";
import { buildInternalNotice, type InternalNoticeInput } from "./internal-notice";

const base: InternalNoticeInput = {
  recipientAddress: "autora@ejemplo.test",
  fromAddress: "cotizaciones@ejemplo.test",
  quoteNumber: "COT-2026-0043",
  decision: "accepted",
  acceptorName: "Ana Prueba",
  quoteUrl: "http://localhost:3000/o/aaaa/cotizaciones/bbbb",
  idempotencyKey: "r-1",
};

describe("aviso interno de respuesta del cliente (H-031)", () => {
  it("aceptada: número, quién aceptó y botón hacia la cotización", () => {
    const result = buildInternalNotice(base);
    if (!result.ok) throw new Error("debió armarse");
    const { message } = result;
    expect(message.to).toBe("autora@ejemplo.test");
    expect(message.subject).toBe("El cliente aceptó la cotización COT-2026-0043");
    expect(message.text).toContain("Aceptó: Ana Prueba.");
    expect(message.html).toContain("Ver la cotización");
    expect(message.html).toContain("http://localhost:3000/o/aaaa/cotizaciones/bbbb");
    expect(message.idempotencyKey).toBe("r-1");
  });

  it("rechazada: con el motivo y el detalle, escapados", () => {
    const result = buildInternalNotice({
      ...base,
      decision: "rejected",
      acceptorName: null,
      reasonLabel: "Otro motivo",
      reasonText: "<script>alert(1)</script> muy caro",
    });
    if (!result.ok) throw new Error("debió armarse");
    expect(result.message.subject).toBe("El cliente rechazó la cotización COT-2026-0043");
    expect(result.message.text).toContain("Motivo: Otro motivo.");
    expect(result.message.html).not.toContain("<script>");
    expect(result.message.html).toContain("&lt;script&gt;");
  });

  it("nunca lleva datos bancarios", () => {
    const result = buildInternalNotice(base);
    if (!result.ok) throw new Error("debió armarse");
    expect(`${result.message.html}${result.message.text}`).not.toMatch(/banco|cuenta bancaria/i);
  });

  it("direcciones inválidas no arman el correo", () => {
    expect(buildInternalNotice({ ...base, recipientAddress: "no-es-correo" }).ok).toBe(false);
    expect(buildInternalNotice({ ...base, quoteUrl: "esto no es una url" }).ok).toBe(false);
  });

  it("un número con saltos de línea no inyecta cabeceras", () => {
    const result = buildInternalNotice({ ...base, quoteNumber: "COT-1\r\nBcc: x@y.z" });
    if (!result.ok) throw new Error("debió armarse");
    expect(result.message.subject).not.toMatch(/[\r\n]/);
  });
});
