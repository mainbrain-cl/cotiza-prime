import { z } from "zod";
import { parseClp } from "@/lib/money/clp";
import { formatPercentBp } from "@/lib/quotes/format";
import { parsePercent } from "@/lib/quotes/parse";
import {
  APPROVAL_AMOUNT_MAX_CLP,
  APPROVAL_DISCOUNT_MAX_BP,
  APPROVAL_MODES,
  type ApprovalMode,
} from "./rule";

/**
 * Lo que llega del formulario de «Aprobaciones» (H-040). Los montos y porcentajes se escriben como los escribe una persona
 * (`2.000.000`, `$ 2.000.000`, `10`, `10,5`) y aquí pasan a enteros: pesos y centésimas de punto. La base de datos vuelve a
 * revisar todo (`set_approval_rule`). En «Nunca» y «Siempre» los umbrales que hayan quedado escritos se ignoran.
 */

const AMOUNT_MESSAGES = {
  empty: "Escribe el monto.",
  negative: "El monto no puede ser negativo.",
  decimal: "Usa pesos enteros, sin decimales. Por ejemplo, 2000000 o 2.000.000.",
  invalid: "Escribe solo números. Por ejemplo, 2000000 o 2.000.000.",
  too_large: "El monto es demasiado alto. Revisa los ceros.",
  zero: "El monto debe ser mayor que $0.",
} as const;

export const APPROVAL_DISCOUNT_TOO_HIGH_MESSAGE = `El descuento debe ser menor que 100%. Escribe, por ejemplo, 10 o 12,5.`;
export const APPROVAL_MISSING_CONDITION_MESSAGE =
  "Escribe un monto, un porcentaje de descuento o los dos.";

export type ApprovalRuleInput = {
  mode: ApprovalMode;
  amountThresholdClp: number | null;
  discountThresholdBp: number | null;
  expectedVersion: number;
};

const rawSchema = z.object({
  mode: z.enum(APPROVAL_MODES, { error: "Elige cuándo se pide aprobación." }),
  amount: z.string().default(""),
  discount: z.string().default(""),
  expectedVersion: z
    .string({ error: "No pudimos leer la versión de la regla." })
    .regex(/^[1-9]\d{0,8}$/, "No pudimos leer la versión de la regla."),
});

export const approvalRuleSchema = rawSchema.transform((raw, context): ApprovalRuleInput => {
  const expectedVersion = Number(raw.expectedVersion);
  const none = z.NEVER;
  if (raw.mode !== "conditional") {
    return { mode: raw.mode, amountThresholdClp: null, discountThresholdBp: null, expectedVersion };
  }
  let amountThresholdClp: number | null = null;
  let discountThresholdBp: number | null = null;
  let failed = false;

  if (raw.amount.trim() !== "") {
    const parsed = parseClp(raw.amount);
    if (!parsed.ok) {
      context.addIssue({
        code: "custom",
        path: ["amount"],
        message: AMOUNT_MESSAGES[parsed.reason],
      });
      failed = true;
    } else if (parsed.value < 1) {
      context.addIssue({ code: "custom", path: ["amount"], message: AMOUNT_MESSAGES.zero });
      failed = true;
    } else if (parsed.value > APPROVAL_AMOUNT_MAX_CLP) {
      context.addIssue({ code: "custom", path: ["amount"], message: AMOUNT_MESSAGES.too_large });
      failed = true;
    } else {
      amountThresholdClp = parsed.value;
    }
  }

  if (raw.discount.trim() !== "") {
    const parsed = parsePercent(raw.discount);
    if (!parsed.ok) {
      context.addIssue({ code: "custom", path: ["discount"], message: parsed.message });
      failed = true;
    } else if (parsed.value > APPROVAL_DISCOUNT_MAX_BP) {
      context.addIssue({
        code: "custom",
        path: ["discount"],
        message: APPROVAL_DISCOUNT_TOO_HIGH_MESSAGE,
      });
      failed = true;
    } else {
      discountThresholdBp = parsed.value;
    }
  }

  if (!failed && amountThresholdClp === null && discountThresholdBp === null) {
    context.addIssue({
      code: "custom",
      path: ["condition"],
      message: APPROVAL_MISSING_CONDITION_MESSAGE,
    });
    failed = true;
  }
  return failed
    ? none
    : { mode: "conditional", amountThresholdClp, discountThresholdBp, expectedVersion };
});

/** Los textos del formulario que representan una regla ya guardada. */
export function ruleToFormValues(rule: {
  mode: ApprovalMode;
  amountThresholdClp: number | null;
  discountThresholdBp: number | null;
}): { mode: ApprovalMode; amount: string; discount: string } {
  return {
    mode: rule.mode,
    amount: rule.amountThresholdClp === null ? "" : String(rule.amountThresholdClp),
    discount: rule.discountThresholdBp === null ? "" : formatPercentBp(rule.discountThresholdBp),
  };
}
