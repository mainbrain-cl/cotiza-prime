"use client";

import { usePathname } from "next/navigation";
import { ViewTransition, type ReactNode } from "react";

/**
 * Transición corta entre pantallas (docs/DISENO.md: `dur-fast` al salir, `dur-base` al entrar).
 * Cambia con la dirección de la pantalla; las animaciones están en `globals.css` y se apagan con
 * "reducir movimiento". Donde el navegador no la soporta, la pantalla simplemente cambia.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <ViewTransition key={pathname} enter="page-in" exit="page-out" default="none">
      {children}
    </ViewTransition>
  );
}
