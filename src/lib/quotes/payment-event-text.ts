import { formatClp } from "@/lib/money/clp";
import {
  MILESTONE_LABELS,
  PAYMENT_TERMS_LABELS,
  isPaymentTerms,
  type MilestoneKind,
} from "@/lib/payments/model";

/** Los eventos del cobro en la línea de tiempo (H-053 a H-056), con su monto. Sin datos personales. */
export const PAYMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "payment_pending",
  "payment_email_sent",
  "payment_email_failed",
  "payment_recorded",
  "payment_reversed",
  "second_payment_requested",
]);

const KINDS: ReadonlySet<string> = new Set(["full", "deposit", "balance"]);

function field(data: unknown, key: string): unknown {
  return data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined;
}

function amount(data: unknown): string | null {
  const value = field(data, "amount_clp");
  return typeof value === "number" && Number.isSafeInteger(value) ? formatClp(value) : null;
}

function kindLabel(data: unknown): string | null {
  const kind = field(data, "kind");
  return typeof kind === "string" && KINDS.has(kind)
    ? MILESTONE_LABELS[kind as MilestoneKind]
    : null;
}

export function describePaymentEvent(type: string, data: unknown): string {
  switch (type) {
    case "payment_pending": {
      const terms = field(data, "terms");
      return isPaymentTerms(terms)
        ? `Quedó pendiente el pago del cliente: ${PAYMENT_TERMS_LABELS[terms]}`
        : "Quedó pendiente el pago del cliente";
    }
    case "payment_email_sent":
      return field(data, "kind") === "payment_2"
        ? "Se envió al cliente el correo con el saldo"
        : "Se envió al cliente el correo con los datos para pagar";
    case "payment_email_failed":
      return field(data, "kind") === "payment_2"
        ? "No se pudo enviar al cliente el correo con el saldo"
        : "No se pudo enviar al cliente el correo con los datos para pagar";
    case "payment_recorded": {
      const label = kindLabel(data);
      const value = amount(data);
      return `Pago recibido${label ? `: ${label.toLowerCase()}` : ""}${value ? ` por ${value}` : ""}`;
    }
    case "payment_reversed": {
      const label = kindLabel(data);
      const reason = field(data, "reason");
      const text = `Se deshizo un pago${label ? ` (${label.toLowerCase()})` : ""}`;
      return typeof reason === "string" && reason.trim() !== ""
        ? `${text}. Motivo: ${reason}`
        : text;
    }
    case "second_payment_requested": {
      const value = amount(data);
      return value
        ? `Se pidió el segundo pago al cliente: ${value}`
        : "Se pidió el segundo pago al cliente";
    }
    default:
      return "Cambio registrado";
  }
}
