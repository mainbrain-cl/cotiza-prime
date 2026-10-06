"use client";

/*
 * Basado en "Spotlight Card" de React Bits (https://reactbits.dev, David Haz), licencia
 * MIT + Commons Clause: ver ./LICENSE.md. Adaptado para Cotiza Prime: superficie sólida del sistema
 * de diseño (el texto nunca queda sobre vidrio), foco de luz suave con el color de acento, y sin
 * foco de luz con "reducir movimiento".
 */

import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Tarjeta sólida con un foco de luz tenue que sigue al ratón. El contenido manda: el foco es decoración. */
export function SpotlightCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [visible, setVisible] = useState(false);

  function onMouseMove(event: MouseEvent<HTMLDivElement>) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  return (
    <div
      ref={ref}
      onMouseMove={onMouseMove}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      className={cn(
        "relative overflow-hidden rounded-lg border border-border bg-surface shadow-1 transition-shadow duration-(--dur-base) ease-ios focus-within:ring-3 focus-within:ring-ring/40 hover:shadow-2",
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 transition-opacity duration-(--dur-slow) ease-ios motion-reduce:hidden"
        style={{
          opacity: visible ? 1 : 0,
          background: `radial-gradient(260px circle at ${position.x}px ${position.y}px, color-mix(in srgb, var(--accent) 12%, transparent), transparent 80%)`,
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
