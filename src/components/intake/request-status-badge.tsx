import { TONE_CLASSES, type StatusTone } from "@/components/ui/status-badge";
import { REQUEST_STATUS_LABELS, type RequestStatus } from "@/lib/intake/requests-model";
import { cn } from "@/lib/utils";

const TONES: Record<RequestStatus, StatusTone> = {
  new: "warning",
  assigned: "accent",
  converted: "success",
  discarded: "neutral",
};

/** Estado de la solicitud: siempre punto + texto + color, nunca solo color (docs/DISENO.md). */
export function RequestStatusBadge({
  status,
  className,
}: {
  status: RequestStatus;
  className?: string;
}) {
  const classes = TONE_CLASSES[TONES[status]];
  return (
    <span
      data-slot="request-status-badge"
      data-status={status}
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap",
        classes.badge,
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", classes.dot)} />
      {REQUEST_STATUS_LABELS[status]}
    </span>
  );
}
