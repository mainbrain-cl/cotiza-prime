import { cn } from "@/lib/utils";

/**
 * «Paso 1 de 2» del registro en dos pasos (H-116): dos barras y un texto. Las tres pantallas del registro (`/registro`,
 * `/confirmar-correo` y `/crear-cuenta`) lo llevan para que la persona sepa dónde está. Es solo orientación: el texto dice el
 * paso, así que no depende del color.
 */
export function FlowSteps({ current, label }: { current: 1 | 2; label: string }) {
  return (
    <div className="flex items-center gap-3" data-testid="flow-steps">
      <div aria-hidden className="flex gap-1.5">
        {[1, 2].map((step) => (
          <span
            key={step}
            className={cn(
              "h-1.5 w-8 rounded-full transition-colors duration-(--dur-base)",
              step <= current ? "bg-accent" : "bg-border-strong",
            )}
          />
        ))}
      </div>
      <p className="text-xs font-semibold tracking-[0.08em] text-fg-subtle uppercase">
        Paso {current} de 2 · {label}
      </p>
    </div>
  );
}
