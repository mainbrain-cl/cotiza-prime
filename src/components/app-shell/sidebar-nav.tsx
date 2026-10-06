"use client";

import { usePathname } from "next/navigation";
import { DockItem } from "@/components/react-bits/dock";
import { NAV_ITEMS, isActive } from "./nav-items";

/** Destinos del menú flotante vertical (tableta y escritorio). Cada uno es un enlace real. */
export function SidebarNav({ basePath }: { basePath: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Principal" className="flex flex-col items-center gap-1">
      {NAV_ITEMS.map(({ segment, label, icon: Icon }) => (
        <DockItem
          key={segment || "inicio"}
          href={segment ? `${basePath}/${segment}` : basePath}
          label={label}
          active={isActive(pathname, basePath, segment)}
          icon={<Icon aria-hidden strokeWidth={1.75} className="size-5" />}
        />
      ))}
    </nav>
  );
}
