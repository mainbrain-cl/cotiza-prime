import { CircleAlert } from "lucide-react";
import Link from "next/link";
import {
  DAILY_CAP_MAX,
  formCapReachedText,
  organizationCapReachedText,
  type CapState,
} from "@/lib/intake/protection-model";

/**
 * Aviso de que un formulario llegó a su tope de hoy (H-092). Solo cuentas, nunca datos de quien envió.
 * `href`: dónde se sube el tope (en el editor es la ancla del control; en la lista, el editor).
 */
export function CapReachedAlert({
  state,
  href,
  compact = false,
}: {
  state: CapState;
  href: string;
  compact?: boolean;
}) {
  if (!state.reached) return null;
  const canRaise = state.kind === "form" && state.cap < DAILY_CAP_MAX;
  return (
    <div
      role="status"
      data-testid="cap-reached"
      className={
        compact
          ? "flex min-w-0 items-start gap-2 rounded-sm bg-warning-soft px-3 py-2 text-sm font-medium text-warning"
          : "flex min-w-0 items-start gap-2 rounded-md bg-warning-soft px-3 py-2.5 text-sm font-medium text-warning"
      }
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0">
        {state.kind === "form"
          ? formCapReachedText(state.accepted)
          : organizationCapReachedText(state.cap)}
        .{" "}
        {state.kind === "org" ? (
          <span className="font-normal">
            Mañana (hora de Chile) vuelve a recibir. Este tope no se puede subir desde aquí.
          </span>
        ) : canRaise ? (
          <Link href={href} className="font-semibold underline" data-testid="cap-raise-link">
            Subir el tope
          </Link>
        ) : (
          <span className="font-normal">Ya está en el máximo permitido ({DAILY_CAP_MAX}).</span>
        )}
      </p>
    </div>
  );
}
