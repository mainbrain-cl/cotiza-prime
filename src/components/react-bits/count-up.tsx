"use client";

/*
 * Basado en "Count Up" de React Bits (https://reactbits.dev, David Haz), licencia MIT + Commons
 * Clause: ver ./LICENSE.md. Adaptado para Cotiza Prime: el valor final ya viene escrito desde el
 * servidor (sin parpadeo ni números en blanco), puntos de miles a la chilena, cifras de ancho fijo,
 * lectores de pantalla leen solo el valor final, y sin animación con "reducir movimiento".
 */

import { animate, useInView } from "motion/react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const DURATION_SECONDS = 1.1;

/** `1250` -> `1.250` (punto como separador de miles). */
export function formatCount(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Número que sube desde cero hasta su valor la primera vez que se ve en pantalla. */
export function CountUp({
  to,
  prefix = "",
  className,
}: {
  to: number;
  /** Texto fijo antes del número, por ejemplo `$`. */
  prefix?: string;
  className?: string;
}) {
  const visibleRef = useRef<HTMLSpanElement>(null);
  const inView = useInView(visibleRef, { once: true });

  useEffect(() => {
    const node = visibleRef.current;
    if (!inView || !node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const controls = animate(0, to, {
      duration: DURATION_SECONDS,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (latest) => {
        node.textContent = `${prefix}${formatCount(latest)}`;
      },
      onComplete: () => {
        node.textContent = `${prefix}${formatCount(to)}`;
      },
    });
    return () => controls.stop();
  }, [inView, to, prefix]);

  const finalText = `${prefix}${formatCount(to)}`;
  return (
    // La `key` rehace el nodo si cambia el valor, porque la animación escribe el texto a mano.
    <span key={finalText} className={cn("tabular-nums", className)}>
      <span ref={visibleRef} aria-hidden>
        {finalText}
      </span>
      <span className="sr-only">{finalText}</span>
    </span>
  );
}
