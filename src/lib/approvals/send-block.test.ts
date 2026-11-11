import { describe, expect, it } from "vitest";
import {
  APPROVAL_ALWAYS_NOT_AVAILABLE_MESSAGE,
  APPROVAL_NOT_AVAILABLE_YET,
  APPROVAL_REQUIRED_GENERIC_MESSAGE,
  APPROVAL_RULE_UNAVAILABLE_MESSAGE,
  approvalBlockMessage,
  approvalPrepareError,
} from "./send-block";
import type { ApprovalRule } from "./rule";

const totals = (over = {}) => ({
  subtotalClp: 1_974_790,
  lineDiscountsClp: 0,
  globalDiscountClp: 0,
  totalClp: 2_350_000,
  priceRebateClp: 0,
  ...over,
});
const conditional = (over: Partial<ApprovalRule>): ApprovalRule => ({
  mode: "conditional",
  amountThresholdClp: null,
  discountThresholdBp: null,
  ...over,
});

describe("approvalBlockMessage: el bloqueo de /enviar", () => {
  it("con «Nunca» no bloquea", () => {
    expect(
      approvalBlockMessage(
        { mode: "never", amountThresholdClp: null, discountThresholdBp: null },
        totals(),
      ),
    ).toBeNull();
  });
  it("monto: dice el total y el límite, y que la solicitud todavía no existe", () => {
    expect(approvalBlockMessage(conditional({ amountThresholdClp: 2_000_000 }), totals())).toBe(
      `Esta cotización necesita aprobación: el total ($2.350.000) supera $2.000.000. ${APPROVAL_NOT_AVAILABLE_YET}`,
    );
  });
  it("la frase completa que ve el Comercial", () => {
    expect(APPROVAL_NOT_AVAILABLE_YET).toBe(
      "La solicitud de aprobación todavía no está disponible; ajusta la cotización o pide a quien administra la organización que revise la regla.",
    );
  });
  it("una rebaja de precio contra el catálogo cuenta como descuento y el mensaje lo dice", () => {
    const message = approvalBlockMessage(
      conditional({ discountThresholdBp: 1_000 }),
      totals({ subtotalClp: 800_000, priceRebateClp: 200_000 }),
    );
    expect(message).toContain(
      "el descuento (20%) supera 10% (incluye $200.000 por precios más bajos que el de catálogo)",
    );
    expect(message).toContain(APPROVAL_NOT_AVAILABLE_YET);
    // sin la rebaja, el mismo precio no bloquea
    expect(
      approvalBlockMessage(
        conditional({ discountThresholdBp: 1_000 }),
        totals({ subtotalClp: 800_000 }),
      ),
    ).toBeNull();
  });
  it("exactamente en el umbral no bloquea", () => {
    expect(
      approvalBlockMessage(conditional({ amountThresholdClp: 2_350_000 }), totals()),
    ).toBeNull();
  });
  it("descuento", () => {
    expect(
      approvalBlockMessage(
        conditional({ discountThresholdBp: 1_000 }),
        totals({ subtotalClp: 800_000, lineDiscountsClp: 200_000 }),
      ),
    ).toContain("el descuento (20%) supera 10%");
  });
  it("siempre: no sugiere ajustar la cotización, dice que hoy no puede enviarse", () => {
    const message = approvalBlockMessage(
      { mode: "always", amountThresholdClp: null, discountThresholdBp: null },
      totals(),
    );
    expect(message).toBe(APPROVAL_ALWAYS_NOT_AVAILABLE_MESSAGE);
    expect(message).toContain("no se puede enviar por ahora");
    expect(message).toContain("todavía no está disponible");
    expect(message).not.toMatch(/ajusta la cotización/i);
  });
});

describe("approvalPrepareError: el rechazo de la base al enviar", () => {
  it("reconoce el motivo de la regla antes del mensaje general de CP423", () => {
    expect(approvalPrepareError("approval_required")).toBe(APPROVAL_REQUIRED_GENERIC_MESSAGE);
    expect(approvalPrepareError("approval_rule_missing")).toBe(APPROVAL_RULE_UNAVAILABLE_MESSAGE);
  });
  it("con «Siempre» (detail) tampoco sugiere ajustar la cotización", () => {
    expect(approvalPrepareError("approval_required", "always")).toBe(
      APPROVAL_ALWAYS_NOT_AVAILABLE_MESSAGE,
    );
    expect(approvalPrepareError("approval_required", "amount,discount")).toBe(
      APPROVAL_REQUIRED_GENERIC_MESSAGE,
    );
    expect(approvalPrepareError("approval_required", null)).toBe(APPROVAL_REQUIRED_GENERIC_MESSAGE);
  });
  it("lo demás no es de la regla (siguen siendo «ya no está en borrador»)", () => {
    expect(approvalPrepareError("not_editable")).toBeNull();
    expect(approvalPrepareError("")).toBeNull();
  });
  it("el mensaje no tiene detalle técnico", () => {
    expect(APPROVAL_REQUIRED_GENERIC_MESSAGE).not.toMatch(/CP4|approval_|trigger|sql/i);
  });
});
