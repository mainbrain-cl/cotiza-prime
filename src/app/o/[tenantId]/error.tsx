"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Error inesperado en una pantalla de la organización. Nunca muestra el detalle técnico
 * (SEGURIDAD.md §4, "Configuración incorrecta"): solo qué hacer.
 */
export default function TenantError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-center gap-5 px-4 py-16 text-center">
      <div className="flex size-14 items-center justify-center rounded-lg bg-danger-soft text-danger">
        <TriangleAlert aria-hidden strokeWidth={1.75} className="size-7" />
      </div>
      <div className="flex max-w-md flex-col gap-2">
        <h1 className="text-xl">Algo salió mal</h1>
        <p className="text-fg-muted">
          No pudimos mostrar esta pantalla. Tus datos están a salvo. Intenta de nuevo; si sigue
          pasando, espera unos minutos.
        </p>
      </div>
      <Button size="lg" onClick={() => retry()}>
        Reintentar
      </Button>
    </div>
  );
}
