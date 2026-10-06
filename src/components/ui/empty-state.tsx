import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AnimatedBackdrop } from "@/components/ui/animated-backdrop";

/** Estado vacío: dice qué falta y cómo empezar. Los fondos animados están permitidos aquí (DISENO.md). */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="relative flex flex-col items-center gap-4 overflow-hidden rounded-lg border border-border bg-surface px-6 py-14 text-center shadow-1 md:py-20">
      <AnimatedBackdrop className="opacity-60" />
      <div className="relative flex size-14 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <Icon aria-hidden strokeWidth={1.75} className="size-7" />
      </div>
      <div className="relative flex max-w-md flex-col gap-2">
        <h2 className="text-lg">{title}</h2>
        <p className="text-fg-muted">{description}</p>
      </div>
      {children ? <div className="relative">{children}</div> : null}
    </section>
  );
}
