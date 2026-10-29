"use client";

import { Menu } from "@base-ui/react/menu";
import { Ellipsis, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { signOutAction } from "@/lib/auth/actions";
import { cn } from "@/lib/utils";
import {
  MOBILE_PRIMARY_SEGMENTS,
  badgeText,
  isActive,
  labelWithBadge,
  visibleNavItems,
  type NavBadges,
} from "./nav-items";

const TAB_CLASS =
  "flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 text-xs font-semibold outline-none transition-[background-color,color,transform] duration-(--dur-fast) ease-ios active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/40";

/** Barra inferior flotante del teléfono: tres destinos y "Más". Cada uno mide al menos 44 px. */
export function MobileNav({
  basePath,
  role,
  badges,
}: {
  basePath: string;
  role: string;
  badges: NavBadges;
}) {
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const navItems = visibleNavItems(role);
  const primary = navItems.filter((item) =>
    (MOBILE_PRIMARY_SEGMENTS as readonly string[]).includes(item.segment),
  );
  const secondary = navItems.filter((item) => !primary.includes(item));
  const moreActive = secondary.some((item) => isActive(pathname, basePath, item.segment));
  // Lo que espera a la persona dentro de «Más»: se avisa en el propio botón para que no pase inadvertido.
  const morePending = secondary.reduce((sum, item) => sum + (badges[item.segment] ?? 0), 0);

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
          aria-label={labelWithBadge("Más opciones", morePending)}
        >
          <span className="relative flex">
            <Ellipsis aria-hidden strokeWidth={1.75} className="size-6" />
            {morePending > 0 ? (
              <span
                aria-hidden
                data-testid="more-badge"
                className="absolute -top-1 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold text-on-accent"
              >
                {badgeText(morePending)}
              </span>
            ) : null}
          </span>
          Más
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="end" sideOffset={12} className="z-50">
            <Menu.Popup className="min-w-56 menu-popup rounded-md p-1.5 glass outline-none">
              {secondary.map(({ segment, label, icon: Icon }) => (
                <Menu.LinkItem
                  key={segment}
                  render={<Link href={`${basePath}/${segment}`} />}
                  className="flex min-h-11 items-center gap-3 rounded-sm px-3 py-2 text-sm font-semibold outline-none data-highlighted:bg-accent-soft data-highlighted:text-accent"
                >
                  <Icon aria-hidden strokeWidth={1.75} className="size-5" />
                  {label}
                  {badges[segment] ? (
                    <span
                      data-testid={`menu-badge-${segment}`}
                      aria-label={labelWithBadge("", badges[segment]).replace(/^, /, "")}
                      className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold text-on-accent"
                    >
                      {badgeText(badges[segment])}
                    </span>
                  ) : null}
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
