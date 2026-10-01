"use client";

import { Menu } from "@base-ui/react/menu";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { NEW_TENANT_PATH } from "@/lib/auth/paths";
import { switchTenantAction } from "@/lib/tenant/actions";
import { cn } from "@/lib/utils";

export type SwitcherTenant = { tenantId: string; name: string; roleLabel: string };

export function tenantInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Muestra la organización activa y deja pasar a otra. La elección va en la dirección, no en una cookie. */
export function TenantSwitcher({
  activeTenantId,
  tenants,
  collapsed = false,
  className,
}: {
  activeTenantId: string;
  tenants: SwitcherTenant[];
  /** En tableta la barra lateral muestra solo íconos. */
  collapsed?: boolean;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const active = tenants.find((tenant) => tenant.tenantId === activeTenantId);
  const activeName = active?.name ?? "Organización";

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Organización activa: ${activeName}. Cambiar de organización`}
        data-testid="tenant-switcher"
        className={cn(
          "border-glass-border flex min-h-11 w-full items-center gap-3 rounded-md border bg-surface/60 p-2 text-left transition-colors duration-(--dur-fast) ease-ios outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/40",
          pending && "opacity-60",
          className,
        )}
      >
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-accent-soft text-sm font-semibold text-accent"
        >
          {tenantInitials(activeName)}
        </span>
        <span className={cn("min-w-0 flex-1", collapsed && "max-xl:hidden")}>
          <span className="block truncate text-sm font-semibold text-fg">{activeName}</span>
          {active ? (
            <span className="block truncate text-xs text-fg-muted">{active.roleLabel}</span>
          ) : null}
        </span>
        <ChevronsUpDown
          aria-hidden
          strokeWidth={1.75}
          className={cn("size-[18px] shrink-0 text-fg-subtle", collapsed && "max-xl:hidden")}
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="start" className="z-50">
          <Menu.Popup className="min-w-64 rounded-md p-1.5 glass outline-none">
            <Menu.Group>
              <Menu.GroupLabel className="px-3 py-2 text-xs font-medium text-fg-muted">
                Tus organizaciones
              </Menu.GroupLabel>
              {tenants.map((tenant) => {
                const isActive = tenant.tenantId === activeTenantId;
                return (
                  <Menu.Item
                    key={tenant.tenantId}
                    onClick={() => startTransition(() => switchTenantAction(tenant.tenantId))}
                    className="flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-sm outline-none data-highlighted:bg-accent-soft data-highlighted:text-accent"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{tenant.name}</span>
                      <span className="block truncate text-xs text-fg-muted">
                        {tenant.roleLabel}
                      </span>
                    </span>
                    {isActive ? (
                      <Check aria-label="Organización activa" className="size-[18px]" />
                    ) : null}
                  </Menu.Item>
                );
              })}
            </Menu.Group>
            <Menu.Separator className="my-1.5 h-px bg-border" />
            <Menu.LinkItem
              render={<Link href={NEW_TENANT_PATH} />}
              className="flex min-h-11 items-center gap-3 rounded-sm px-3 py-2 text-sm font-semibold outline-none data-highlighted:bg-accent-soft data-highlighted:text-accent"
            >
              <Plus aria-hidden strokeWidth={1.75} className="size-[18px]" />
              Crear otra organización
            </Menu.LinkItem>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
