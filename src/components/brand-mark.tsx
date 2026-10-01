import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";

/** Marca de Cotiza Prime en la aplicación (la que ven los miembros, no los clientes finales). */
export function BrandMark({
  className,
  compact,
  labelClassName,
}: {
  className?: string;
  compact?: boolean;
  labelClassName?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-accent text-on-accent shadow-1">
        <FileText aria-hidden strokeWidth={1.75} className="size-5" />
      </span>
      {compact ? null : (
        <span className={cn("text-md font-semibold tracking-tight", labelClassName)}>
          Cotiza Prime
        </span>
      )}
    </div>
  );
}
