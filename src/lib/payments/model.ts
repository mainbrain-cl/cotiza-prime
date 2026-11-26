/**
 * El cobro por transferencia (H-052 a H-057), en datos puros: sirve en el servidor y en las pantallas.
 *
 * Reglas de dinero (PROYECTO.md §13.7): pesos enteros; el 50/50 se calcula UNA vez (al aceptar, en la base) y el peso sobrante
 * de un total impar va al segundo pago, así la suma de los hitos es siempre el total. `splitPayment` repite exactamente el cálculo
 * de la base (`app.quote_responses_start_payments`) para mostrar los montos antes de enviar.
 */

export const PAYMENT_TERMS = ["full", "split_50_50"] as const;
export type PaymentTerms = (typeof PAYMENT_TERMS)[number];

export type MilestoneKind = "full" | "deposit" | "balance";
export type MilestoneStatus = "pending" | "requested" | "paid";

export type PlannedMilestone = { seq: 1 | 2; kind: MilestoneKind; amountClp: number };

export const PAYMENT_TERMS_LABELS: Readonly<Record<PaymentTerms, string>> = {
  full: "100 % al aceptar",
  split_50_50: "50 % al aceptar y 50 % al final",
};

export const MILESTONE_LABELS: Readonly<Record<MilestoneKind, string>> = {
  full: "Pago total (100 %)",
  deposit: "Anticipo (50 %)",
  balance: "Saldo (50 %)",
};

export const MILESTONE_STATUS_LABELS: Readonly<Record<MilestoneStatus, string>> = {
  pending: "Por pagar",
  requested: "Pedido al cliente",
  paid: "Recibido",
};

export function isPaymentTerms(value: unknown): value is PaymentTerms {
  return value === "full" || value === "split_50_50";
}

/** Los pagos que se esperarán según la condición. Total entero y no negativo. */
export function splitPayment(totalClp: number, terms: PaymentTerms): PlannedMilestone[] {
  if (!Number.isSafeInteger(totalClp) || totalClp < 0) {
    throw new RangeError("El total debe ser un entero no negativo.");
  }
  if (terms === "full") return [{ seq: 1, kind: "full", amountClp: totalClp }];
  const deposit = Math.floor(totalClp / 2);
  return [
    { seq: 1, kind: "deposit", amountClp: deposit },
    { seq: 2, kind: "balance", amountClp: totalClp - deposit },
  ];
}

type MilestoneLike = { amountClp: number; status: MilestoneStatus };

/** Lo que falta por cobrar: la suma de los hitos que no están recibidos. */
export function outstandingClp(milestones: readonly MilestoneLike[]): number {
  return milestones.reduce((sum, m) => (m.status === "paid" ? sum : sum + m.amountClp), 0);
}

/** El primer hito sin pagar (el que corresponde pagar ahora), o `null` si ya está todo pagado. */
export function nextDueMilestone<T extends MilestoneLike & { seq: number }>(
  milestones: readonly T[],
): T | null {
  return [...milestones].sort((a, b) => a.seq - b.seq).find((m) => m.status !== "paid") ?? null;
}

/**
 * Lo que el CLIENTE debe pagar ahora (enlace y correo): el anticipo o el pago total mientras no estén recibidos; el saldo, solo
 * cuando la organización ya lo PIDIÓ («Solicitar segundo pago»). Con el anticipo pagado y el saldo sin pedir, no hay nada que
 * pagar todavía (`awaitingBalance`): el saldo se pide cuando el trabajo esté listo (§6.6).
 */
export function customerPaymentDue<T extends MilestoneLike & { seq: number; kind: MilestoneKind }>(
  milestones: readonly T[],
): { due: T | null; awaitingBalance: boolean } {
  const next = nextDueMilestone(milestones);
  if (next && next.kind === "balance" && next.status !== "requested") {
    return { due: null, awaitingBalance: true };
  }
  return { due: next, awaitingBalance: false };
}
