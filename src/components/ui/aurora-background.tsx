import { cn } from "@/lib/utils";

/**
 * Fondo animado de CSS propio (docs/DISENO.md, "Fondos animados"): solo para ingreso, onboarding y
 * estados vacíos. Decorativo: no recibe foco ni lo lee un lector de pantalla.
 */
export function AuroraBackground({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      <div className="aurora-blob -top-24 -left-24 size-[28rem] animate-[aurora-drift-a_26s_ease-in-out_infinite] bg-accent" />
      <div className="aurora-blob top-1/4 -right-32 size-[32rem] animate-[aurora-drift-b_30s_ease-in-out_infinite] bg-success" />
      <div className="aurora-blob -bottom-40 left-1/4 size-[30rem] animate-[aurora-drift-c_22s_ease-in-out_infinite] bg-warning" />
    </div>
  );
}
