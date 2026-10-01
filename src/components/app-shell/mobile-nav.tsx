"use client";

import { Menu } from "@base-ui/react/menu";
import { Ellipsis, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { signOutAction } from "@/lib/auth/actions";
import { cn } from "@/lib/utils";
import { MOBILE_PRIMARY_SEGMENTS, NAV_ITEMS, isActive } from "./nav-items";

const TAB_CLASS =
  "flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 text-xs font-semibold outline-none transition-colors duration-(--dur-fast) ease-ios focus-visible:ring-3 focus-visible:ring-ring/40";

/** Barra inferior flotante del teléfono: tres destinos y "Más". Cada uno mide al menos 44 px. */
export function MobileNav({ basePath }: { basePath: string }) {
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const primary = NAV_ITEMS.filter((item) =>
    (MOBILE_PRIMARY_SEGMENTS as readonly string[]).includes(item.segment),
  );
  const secondary = NAV_ITEMS.filter((item) => !primary.includes(item));
  const moreActive = secondary.some((item) => isActive(pathname, basePath, item.segment));

  return (
    <nav
      aria-label="Principal"
      className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-40 flex items-stretch gap-1 rounded-xl p-1.5 glass md:hidden"
    >
      {primary.map(({ segment, label, icon: Icon }) => {
        const active = isActive(pathname, basePath, segment);
        return (
          <Link
            key={segment || "inicio"}
            href={segment ? `${basePath}/${segment}` : basePath}
            aria-current={active ? "page" : undefined}
            className={cn(
              TAB_CLASS,
              active ? "bg-accent-soft text-accent glass-strong" : "text-fg-muted",
            )}
          >
            <Icon aria-hidden strokeWidth={1.75} className="size-6" />
            {label}
          </Link>
        );
      })}

      <Menu.Root>
        <Menu.Trigger
          className={cn(
            TAB_CLASS,
            moreActive ? "bg-accent-soft text-accent glass-strong" : "text-fg-muted",
          )}
          aria-label="Más opciones"
        >
          <Ellipsis aria-hidden strokeWidth={1.75} className="size-6" />
          Más
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="end" sideOffset={12} className="z-50">
            <Menu.Popup className="min-w-56 rounded-md p-1.5 glass outline-none">
              {secondary.map(({ segment, label, icon: Icon }) => (
                <Menu.LinkItem
                  key={segment}
                  render={<Link href={`${basePath}/${segment}`} />}
                  className="flex min-h-11 items-center gap-3 rounded-sm px-3 py-2 text-sm font-semibold outline-none data-highlighted:bg-accent-soft data-highlighted:text-accent"
                >
                  <Icon aria-hidden strokeWidth={1.75} className="size-5" />
                  {label}
                </Menu.LinkItem>
              ))}
              <Menu.Separator className="my-1.5 h-px bg-border" />
              <Menu.Item
                onClick={() => startTransition(() => signOutAction())}
                disabled={pending}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-sm font-semibold text-danger outline-none data-highlighted:bg-danger-soft"
              >
                <LogOut aria-hidden strokeWidth={1.75} className="size-5" />
                Cerrar sesión
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </nav>
  );
}
