import type { LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/** Destino del menú que todavía no existe: lo dice con honestidad en vez de fingir. */
export function ComingSoon({
  title,
  icon,
  description,
}: {
  title: string;
  icon: LucideIcon;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl md:text-2xl">{title}</h1>
      <EmptyState icon={icon} title="Disponible pronto" description={description} />
    </div>
  );
}
