import "server-only";
import { z } from "zod";
import { serverLog } from "@/lib/log/server-log";
import { bankDetailLines } from "@/lib/payments/bank";
import { MILESTONE_LABELS, MILESTONE_STATUS_LABELS, nextDueMilestone } from "@/lib/payments/model";
import { decryptBankDetails } from "@/lib/payments/notice";
import { readSharePayment } from "./gateway";

/**
 * Lo que el enlace del cliente muestra para pagar (H-053), ya listo para dibujar. La base solo lo entrega si el cliente ACEPTÓ
 * (antes, nada: los datos bancarios nunca aparecen antes de aceptar). Los datos son los CONGELADOS al aceptar.
 */

const sharePaymentSchema = z.object({
  tenant_id: z.uuid(),
  payment_terms: z.enum(["full", "split_50_50"]).nullable(),
  milestones: z.array(
    z.object({
      seq: z.number().int(),
      kind: z.enum(["full", "deposit", "balance"]),
      amount_clp: z.number().int().nonnegative(),
      status: z.enum(["pending", "requested", "paid"]),
    }),
  ),
  bank: z
    .object({ bank_account_id: z.uuid(), details_enc: z.string(), changed: z.boolean() })
    .nullable(),
});

export type SharePaymentView = {
  rows: { label: string; amountClp: number; statusLabel: string; paid: boolean }[];
  /** Lo que corresponde pagar ahora; `null` si ya está todo pagado. */
  due: { label: string; amountClp: number } | null;
  bankLines: { label: string; value: string }[] | null;
};

export async function readSharePaymentView(token: string): Promise<SharePaymentView | null> {
  const parsed = sharePaymentSchema.nullable().safeParse(await readSharePayment(token));
  if (!parsed.success) {
    await serverLog("error", "share_payment_shape");
    return null;
  }
  const data = parsed.data;
  if (!data || data.milestones.length === 0) return null;
  const bank = data.bank
    ? decryptBankDetails(data.bank.details_enc, data.tenant_id, data.bank.bank_account_id)
    : null;
  if (data.bank && !bank) await serverLog("error", "share_payment_bank_unreadable");
  const milestones = data.milestones.map((m) => ({
    seq: m.seq,
    kind: m.kind,
    amountClp: m.amount_clp,
    status: m.status,
  }));
  const due = nextDueMilestone(milestones);
  return {
    rows: milestones.map((m) => ({
      label: MILESTONE_LABELS[m.kind],
      amountClp: m.amountClp,
      statusLabel: m.status === "paid" ? "Pagado" : MILESTONE_STATUS_LABELS.pending,
      paid: m.status === "paid",
    })),
    due: due ? { label: MILESTONE_LABELS[due.kind], amountClp: due.amountClp } : null,
    bankLines: bank ? bankDetailLines(bank) : null,
  };
}
