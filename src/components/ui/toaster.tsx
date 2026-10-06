"use client";

import { Toaster as SonnerToaster } from "sonner";

const TOAST_DURATION_MS = 4000;

/**
 * Avisos breves (docs/DISENO.md): vidrio, entran y salen con animación y no tapan acciones.
 * Van arriba (a la derecha en escritorio, a lo ancho en teléfono): los formularios y sus botones de
 * acción quedan abajo, y como Sonner pausa el temporizador con el mouse encima, un aviso puesto
 * sobre el botón se quedaba pegado. Arriba solo cubre el encabezado, nunca la acción que se acaba de usar.
 * Sonner apaga sus animaciones con "reducir movimiento" y anuncia cada aviso con `aria-live`.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="top-right"
      duration={TOAST_DURATION_MS}
      visibleToasts={3}
      closeButton
      offset={{ top: "1.5rem", right: "1.5rem" }}
      mobileOffset={{ top: "1rem", left: "1rem", right: "1rem" }}
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
