import { TONE_CLASSES, type StatusTone } from "@/components/ui/status-badge";
import type { DeliveryStatus } from "@/lib/quotes/delivery-model";
import { cn } from "@/lib/utils";

type DeliveryDefinition = { label: string; tone: StatusTone };

/** Entrega del correo al cliente y su color (docs/DISENO.md): enviado neutro, entregado verde, rebotado rojo. */
export const DELIVERY_DEFINITIONS: Record<DeliveryStatus, DeliveryDefinition> = {
  sent: { label: "Correo enviado", tone: "neutral" },
  delivered: { label: "Correo entregado", tone: "success" },
  bounced: { label: "Correo rebotado", tone: "danger" },
  complained: { label: "Marcado como spam", tone: "warning" },
};

/** Insignia de entrega del correo: siempre punto + texto + color, nunca solo color. */
export function DeliveryBadge({
  status,
  className,
}: {
  status: DeliveryStatus;
  className?: string;
}) {
  const { label, tone } = DELIVERY_DEFINITIONS[status];
  const classes = TONE_CLASSES[tone];
  return (
    <span
      data-slot="delivery-badge"
      data-delivery={status}
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap",
        classes.badge,
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", classes.dot)} />
      <span>{label}</span>
    </span>
  );
}
