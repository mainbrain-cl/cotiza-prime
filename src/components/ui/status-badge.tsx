import { cn } from "@/lib/utils";

export const QUOTE_STATUSES = [
  "draft",
  "pending_approval",
  "changes_requested",
  "rejected_internal",
  "sent",
  "viewed",
  "rejected_by_client",
  "expired",
  "accepted",
  "pending_payment",
  "pending_deposit",
  "deposit_paid",
  "pending_balance",
  "paid",
  "replaced",
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export type StatusTone = "neutral" | "accent" | "warning" | "success" | "success-solid" | "danger";

type StatusDefinition = { label: string; tone: StatusTone; strikethrough?: boolean };

/** Estados de la cotización y su color, según docs/DISENO.md (sección Color). */
export const STATUS_DEFINITIONS: Record<QuoteStatus, StatusDefinition> = {
  draft: { label: "Borrador", tone: "neutral" },
  pending_approval: { label: "Pendiente de aprobación", tone: "warning" },
  changes_requested: { label: "Cambios solicitados", tone: "warning" },
  rejected_internal: { label: "Rechazada internamente", tone: "danger" },
  sent: { label: "Enviada", tone: "accent" },
  viewed: { label: "Vista", tone: "accent" },
  rejected_by_client: { label: "Rechazada por el cliente", tone: "danger" },
  expired: { label: "Vencida", tone: "neutral" },
  accepted: { label: "Aceptada", tone: "success" },
  pending_payment: { label: "Pendiente de pago", tone: "warning" },
  pending_deposit: { label: "Pendiente de anticipo", tone: "warning" },
  deposit_paid: { label: "Anticipo pagado", tone: "success" },
  pending_balance: { label: "Pendiente de saldo", tone: "warning" },
  paid: { label: "Pagada", tone: "success-solid" },
  replaced: { label: "Reemplazada", tone: "neutral", strikethrough: true },
};

export const TONE_CLASSES: Record<StatusTone, { badge: string; dot: string }> = {
  neutral: { badge: "bg-surface-2 text-fg-muted", dot: "bg-fg-subtle" },
  accent: { badge: "bg-accent-soft text-accent", dot: "bg-accent" },
  warning: { badge: "bg-warning-soft text-warning", dot: "bg-warning" },
  success: { badge: "bg-success-soft text-success", dot: "bg-success" },
  "success-solid": { badge: "bg-success text-on-accent", dot: "bg-on-accent" },
  danger: { badge: "bg-danger-soft text-danger", dot: "bg-danger" },
};

export function getStatusDefinition(status: QuoteStatus): StatusDefinition {
  return STATUS_DEFINITIONS[status];
}

/** Insignia de estado: siempre punto + texto + color, nunca solo color. */
export function StatusBadge({ status, className }: { status: QuoteStatus; className?: string }) {
  const { label, tone, strikethrough } = STATUS_DEFINITIONS[status];
  const classes = TONE_CLASSES[tone];

  return (
    <span
      data-slot="status-badge"
      data-status={status}
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap",
        classes.badge,
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", classes.dot)} />
      <span className={cn(strikethrough && "line-through")}>{label}</span>
    </span>
  );
}
