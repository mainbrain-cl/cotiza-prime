"use client";

import { Toaster as SonnerToaster } from "sonner";

const TOAST_DURATION_MS = 4000;

/**
 * Avisos breves (docs/DISENO.md): vidrio, entran y salen con animación y no tapan acciones.
 * En teléfono suben por encima de la barra inferior flotante; en escritorio van abajo a la derecha.
 * Sonner apaga sus animaciones con "reducir movimiento" y anuncia cada aviso con `aria-live`.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      duration={TOAST_DURATION_MS}
      visibleToasts={3}
      closeButton
      offset={{ bottom: "1.5rem", right: "1.5rem" }}
      mobileOffset={{ bottom: "6.5rem", left: "1rem", right: "1rem" }}
      containerAriaLabel="Avisos"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "glass flex w-full items-center gap-3 rounded-md px-4 py-3 text-sm font-medium text-fg",
          title: "text-sm font-semibold text-fg",
          description: "text-sm text-fg-muted",
          success: "[&_[data-icon]]:text-success",
          error: "[&_[data-icon]]:text-danger",
          icon: "shrink-0",
          closeButton: "border-border bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg",
        },
      }}
    />
  );
}
