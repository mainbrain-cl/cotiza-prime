import { describe, expect, it } from "vitest";
import { fieldErrorsOf } from "@/lib/auth/schemas";
import {
  APPROVAL_DISCOUNT_TOO_HIGH_MESSAGE,
  APPROVAL_MISSING_CONDITION_MESSAGE,
  approvalRuleSchema,
  ruleToFormValues,
} from "./schemas";

const parse = (over: Record<string, string> = {}) =>
  approvalRuleSchema.safeParse({
    mode: "conditional",
    amount: "",
    discount: "",
    expectedVersion: "3",
    ...over,
  });

const okData = (over: Record<string, string> = {}) => {
  const result = parse(over);
  if (!result.success) throw new Error(JSON.stringify(fieldErrorsOf(result.error)));
  return result.data;
};
const errorsOf = (over: Record<string, string> = {}) => {
  const result = parse(over);
  if (result.success) throw new Error("se esperaba un error");
  return fieldErrorsOf(result.error);
};

describe("approvalRuleSchema: lo que llega del formulario", () => {
  it.each([
    ["2.000.000", 2_000_000],
    ["$ 2.000.000", 2_000_000],
    ["2000000", 2_000_000],
    ["1", 1],
    ["999.999.999.999", 999_999_999_999],
  ])("el monto «%s» es %i pesos", (amount, clp) => {
    expect(okData({ amount }).amountThresholdClp).toBe(clp);
  });

  it.each([
    ["10", 1_000],
    ["10,5", 1_050],
    ["12,25", 1_225],
    ["0", 0],
    ["99,99", 9_999],
    ["10 %", 1_000],
  ])("el descuento «%s» es %i centésimas de punto", (discount, bp) => {
    expect(okData({ discount }).discountThresholdBp).toBe(bp);
  });

  it("acepta un monto, un descuento o los dos, y deja vacío lo que no se escribió", () => {
    expect(okData({ amount: "500.000" })).toEqual({
      mode: "conditional",
      amountThresholdClp: 500_000,
      discountThresholdBp: null,
      expectedVersion: 3,
    });
    expect(okData({ discount: "5" })).toEqual({
      mode: "conditional",
      amountThresholdClp: null,
      discountThresholdBp: 500,
      expectedVersion: 3,
    });
    expect(okData({ amount: "500.000", discount: "5" })).toMatchObject({
      amountThresholdClp: 500_000,
      discountThresholdBp: 500,
    });
  });

  it.each(["0", "-1", "2.000,5", "2000000,5", "abc", "1.2.3", "1000000000000"])(
    "rechaza el monto «%s»",
    (amount) => {
      expect(errorsOf({ amount })).toHaveProperty("amount");
    },
  );

  it.each(["100", "100,00", "10,005", "-1", "abc", "10.5", "150"])(
    "rechaza el descuento «%s»",
    (discount) => {
      expect(errorsOf({ discount })).toHaveProperty("discount");
    },
  );

  it("el 100 % se rechaza diciendo por qué", () => {
    expect(errorsOf({ discount: "100" }).discount).toBe(APPROVAL_DISCOUNT_TOO_HIGH_MESSAGE);
  });

  it("el modo condicional sin condiciones se rechaza", () => {
    expect(errorsOf({}).condition).toBe(APPROVAL_MISSING_CONDITION_MESSAGE);
    expect(errorsOf({ amount: "   ", discount: " " }).condition).toBe(
      APPROVAL_MISSING_CONDITION_MESSAGE,
    );
  });

  it("«Nunca» y «Siempre» ignoran los umbrales que hayan quedado escritos, aunque sean ilegibles", () => {
    for (const mode of ["never", "always"] as const) {
      expect(okData({ mode, amount: "basura", discount: "200" })).toEqual({
        mode,
        amountThresholdClp: null,
        discountThresholdBp: null,
        expectedVersion: 3,
      });
    }
  });

  it("rechaza un modo desconocido y una versión ilegible", () => {
    expect(errorsOf({ mode: "a_veces" })).toHaveProperty("mode");
    for (const expectedVersion of ["", "0", "-2", "1,5", "abc", "12345678901"]) {
      expect(errorsOf({ amount: "1", expectedVersion })).toHaveProperty("expectedVersion");
    }
  });
});

describe("ruleToFormValues: de la regla guardada a los campos", () => {
  it("monto y descuento", () => {
    expect(
      ruleToFormValues({
        mode: "conditional",
        amountThresholdClp: 2_000_000,
        discountThresholdBp: 1_050,
      }),
    ).toEqual({ mode: "conditional", amount: "2000000", discount: "10,5" });
  });
  it("sin umbrales, vacío; el umbral 0 se muestra como 0", () => {
    expect(
      ruleToFormValues({ mode: "never", amountThresholdClp: null, discountThresholdBp: null }),
    ).toEqual({ mode: "never", amount: "", discount: "" });
    expect(
      ruleToFormValues({ mode: "conditional", amountThresholdClp: null, discountThresholdBp: 0 }),
    ).toEqual({ mode: "conditional", amount: "", discount: "0" });
  });
  it("lo que muestra se vuelve a leer igual", () => {
    const values = ruleToFormValues({
      mode: "conditional",
      amountThresholdClp: 750_000,
      discountThresholdBp: 1_250,
    });
    expect(okData({ ...values, expectedVersion: "1" })).toMatchObject({
      amountThresholdClp: 750_000,
      discountThresholdBp: 1_250,
    });
  });
});
