import { describe, expect, it } from "vitest";
import { buildPaymentEmail } from "./payment-email";

const base = {
  recipientAddress: "cliente@ejemplo.test",
  fromAddress: "cotizaciones@ejemplo.test",
  organizationName: "Negocio <Ficticio>",
  brandPrimary: "#123456",
  brandSecondary: null,
  customerName: "Cliente Uno",
  quoteNumber: "COT-2026-0001",
  amountClp: 5_950,
  milestoneLabel: "Anticipo (50 %)",
  bankLines: [
    { label: "Banco", value: "BancoEstado" },
    { label: "Número de cuenta", value: "12345678" },
  ],
};

describe("correos de cobro (H-053 y H-056)", () => {
  it("al aceptar: monto, datos de transferencia y marca de la organización, con el texto escapado", () => {
    const built = buildPaymentEmail({ ...base, kind: "payment_1" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.message.subject).toBe("Datos para pagar la cotización COT-2026-0001");
    expect(built.message.text).toContain("$5.950");
    expect(built.message.text).toContain("Número de cuenta: 12345678");
    expect(built.message.html).toContain("#123456");
    expect(built.message.html).not.toContain("<Ficticio>");
  });

  it("el saldo tiene su propio asunto", () => {
    const built = buildPaymentEmail({ ...base, kind: "payment_2", amountClp: 5_951 });
    expect(built.ok && built.message.subject).toBe("Saldo de la cotización COT-2026-0001");
    expect(built.ok && built.message.text).toContain("$5.951");
  });

  it("sin cuenta congelada no inventa datos: dice que la organización los enviará", () => {
    const built = buildPaymentEmail({ ...base, kind: "payment_1", bankLines: null });
    expect(built.ok && built.message.text).toContain("te enviará los datos");
    expect(built.ok && built.message.text).not.toContain("Banco:");
  });

  it("rechaza un destinatario inválido", () => {
    expect(buildPaymentEmail({ ...base, kind: "payment_1", recipientAddress: "x" }).ok).toBe(false);
  });
});
