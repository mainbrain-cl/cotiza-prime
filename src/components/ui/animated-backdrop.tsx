"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { AuroraBackground } from "@/components/ui/aurora-background";

// Las líneas onduladas (React Bits, ver decisión 018) se descargan solo si se van a mostrar.
const Waves = dynamic(() => import("@/components/react-bits/waves"), { ssr: false });

/** Espera antes de montar las líneas, para que no compitan con lo que la persona vino a ver. */
const MOUNT_DELAY_MS = 400;
const PHONE_QUERY = "(max-width: 767px)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** Equipos con poca memoria o pocos núcleos se quedan con el fondo simple. */
const MODEST_MEMORY_GB = 4;
const MODEST_CORES = 4;

function canAnimate(): boolean {
  if (window.matchMedia(REDUCED_MOTION_QUERY).matches) return false;
  if (window.matchMedia(PHONE_QUERY).matches) return false;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (memory !== undefined && memory <= MODEST_MEMORY_GB) return false;
  const cores = navigator.hardwareConcurrency;
  if (cores !== undefined && cores <= MODEST_CORES) return false;
  return true;
}

/**
 * Fondo con movimiento de ingreso, registro y estados vacíos (docs/DISENO.md y decisión 018).
 * Siempre lleva el fondo suave de CSS; encima, en escritorio con equipo suficiente y sin
 * "reducir movimiento", se cargan las líneas onduladas de React Bits. Nunca en pantallas de trabajo.
 */
export function AnimatedBackdrop({ className }: { className?: string }) {
  const [waves, setWaves] = useState(false);

  useEffect(() => {
    const update = () => setWaves(canAnimate());
    const timer = setTimeout(update, MOUNT_DELAY_MS);
    const queries = [PHONE_QUERY, REDUCED_MOTION_QUERY].map((query) => window.matchMedia(query));
    for (const query of queries) query.addEventListener("change", update);
    return () => {
      clearTimeout(timer);
      for (const query of queries) query.removeEventListener("change", update);
    };
  }, []);

  return (
    <>
      <AuroraBackground className={className} />
      {waves ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 text-accent opacity-20">
          <Waves />
        </div>
      ) : null}
    </>
  );
}
