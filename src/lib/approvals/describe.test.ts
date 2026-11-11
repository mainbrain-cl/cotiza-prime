import { describe, expect, it } from "vitest";
import { APPROVAL_RULE_HELP, describeApprovalReasons, describeApprovalRule } from "./describe";
import type { ApprovalRule } from "./rule";

const rule = (over: Partial<ApprovalRule>): ApprovalRule => ({
  mode: "conditional",
  amountThresholdClp: null,
  discountThresholdBp: null,
  ...over,
});

describe("describeApprovalRule: la frase de la regla", () => {
  it.each<[string, ApprovalRule, string]>([
    [
      "nunca",
      rule({ mode: "never" }),
      "No se pide aprobación: las cotizaciones se envían directo.",
    ],
    ["siempre", rule({ mode: "always" }), "Se pide aprobación para todas las cotizaciones."],
    [
      "monto",
      rule({ amountThresholdClp: 2_000_000 }),
      "Se pide aprobación si el total supera $2.000.000.",
    ],
    [
      "descuento",
      rule({ discountThresholdBp: 1_000 }),
      "Se pide aprobación si el descuento supera 10%.",
    ],
    [
      "descuento con decimales",
      rule({ discountThresholdBp: 1_250 }),
      "Se pide aprobación si el descuento supera 12,5%.",
    ],
    [
      "descuento con dos decimales",
      rule({ discountThresholdBp: 1_005 }),
      "Se pide aprobación si el descuento supera 10,05%.",
    ],
    [
      "umbral 0",
      rule({ discountThresholdBp: 0 }),
      "Se pide aprobación si la cotización tiene cualquier descuento.",
    ],
    [
      "monto y descuento",
      rule({ amountThresholdClp: 2_000_000, discountThresholdBp: 1_000 }),
      "Se pide aprobación si el total supera $2.000.000 o el descuento supera 10%.",
    ],
    [
      "monto y umbral 0",
      rule({ amountThresholdClp: 500_000, discountThresholdBp: 0 }),
      "Se pide aprobación si el total supera $500.000 o la cotización tiene cualquier descuento.",
    ],
  ])("%s", (_name, input, expected) => {
    expect(describeApprovalRule(input)).toBe(expected);
  });

  it("una regla condicional sin condiciones (no debería existir) se cuenta como «nunca»", () => {
    expect(describeApprovalRule(rule({}))).toBe(
      "No se pide aprobación: las cotizaciones se envían directo.",
    );
  });
});

describe("describeApprovalReasons: por qué ESTA cotización necesita aprobación", () => {
  const metrics = {
    totalClp: 2_350_000,
    discountClp: 300_000,
    discountBp: 1_250,
    priceRebateClp: 0,
  };

  it("monto", () => {
    expect(
      describeApprovalReasons(rule({ amountThresholdClp: 2_000_000 }), ["amount"], metrics),
    ).toBe("el total ($2.350.000) supera $2.000.000");
  });
  it("descuento", () => {
    expect(
      describeApprovalReasons(rule({ discountThresholdBp: 1_000 }), ["discount"], metrics),
    ).toBe("el descuento (12,5%) supera 10%");
  });
  it("descuento con umbral 0", () => {
    expect(describeApprovalReasons(rule({ discountThresholdBp: 0 }), ["discount"], metrics)).toBe(
      "la cotización tiene un descuento de $300.000",
    );
  });
  it("los dos, en orden", () => {
    expect(
      describeApprovalReasons(
        rule({ amountThresholdClp: 2_000_000, discountThresholdBp: 1_000 }),
        ["amount", "discount"],
        metrics,
      ),
    ).toBe("el total ($2.350.000) supera $2.000.000 y el descuento (12,5%) supera 10%");
  });
  it("descuento con rebaja de precio: dice cuánto es por precios más bajos que el de catálogo", () => {
    const withRebate = { ...metrics, priceRebateClp: 200_000 };
    expect(
      describeApprovalReasons(rule({ discountThresholdBp: 1_000 }), ["discount"], withRebate),
    ).toBe(
      "el descuento (12,5%) supera 10% (incluye $200.000 por precios más bajos que los del catálogo)",
    );
    expect(
      describeApprovalReasons(rule({ discountThresholdBp: 0 }), ["discount"], withRebate),
    ).toBe(
      "la cotización tiene un descuento de $300.000, que incluye $200.000 por precios más bajos que los del catálogo",
    );
  });
  it("siempre", () => {
    expect(describeApprovalReasons(rule({ mode: "always" }), ["always"], metrics)).toBe(
      "la organización pide aprobación para todas las cotizaciones",
    );
  });
  it("sin motivos, vacío", () => {
    expect(describeApprovalReasons(rule({ mode: "never" }), [], metrics)).toBe("");
  });
});

describe("el texto de ayuda de la regla", () => {
  it("aclara qué cuenta como descuento y qué no", () => {
    expect(APPROVAL_RULE_HELP).toContain("El total incluye IVA.");
    expect(APPROVAL_RULE_HELP).toContain(
      "la rebaja: lo que un servicio del catálogo cuesta menos que su precio de catálogo (el menor entre el que tenía al agregarlo y el de hoy)",
    );
    expect(APPROVAL_RULE_HELP).toContain(
      "escrito a mano, que no es del catálogo, no cuenta como rebaja",
    );
    expect(APPROVAL_RULE_HELP).not.toContain("no cuenta como descuento");
  });
});
