import { TONE_CLASSES, type StatusTone } from "@/components/ui/status-badge";
import { FORM_STATUS_LABELS, type FormStatus } from "@/lib/intake/builder-model";
import { cn } from "@/lib/utils";

const TONES: Record<FormStatus, StatusTone> = {
  draft: "neutral",
  published: "success",
  paused: "warning",
  archived: "neutral",
};

/** Estado del formulario: siempre punto + texto + color, nunca solo color (docs/DISENO.md). */
export function FormStatusBadge({ status, className }: { status: FormStatus; className?: string }) {
  const classes = TONE_CLASSES[TONES[status]];
  return (
    <span
      data-slot="form-status-badge"
      data-status={status}
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap",
        classes.badge,
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", classes.dot)} />
      {FORM_STATUS_LABELS[status]}
    </span>
  );
}
