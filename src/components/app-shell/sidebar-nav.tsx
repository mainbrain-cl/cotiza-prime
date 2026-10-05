"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_ITEMS, isActive } from "./nav-items";

/** Navegación de la barra lateral. En tableta (768–1.279 px) muestra solo íconos. */
export function SidebarNav({ basePath }: { basePath: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Principal" className="flex flex-col gap-1">
      {NAV_ITEMS.map(({ segment, label, icon: Icon }) => {
        const active = isActive(pathname, basePath, segment);
        return (
          <Link
            key={segment || "inicio"}
            href={segment ? `${basePath}/${segment}` : basePath}
            aria-current={active ? "page" : undefined}
            title={label}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-sm px-3 text-sm font-semibold transition-[background-color,color,transform] duration-(--dur-fast) ease-ios outline-none focus-visible:ring-3 focus-visible:ring-ring/40 active:scale-[0.97] max-xl:justify-center max-xl:px-0",
              active
                ? "bg-accent-soft text-accent glass-strong"
                : "text-fg-muted hover:bg-surface/70 hover:text-fg",
            )}
          >
            <Icon aria-hidden strokeWidth={1.75} className="size-[18px] shrink-0" />
            <span className="max-xl:sr-only">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
