"use client";

import { TriangleAlert, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isNetworkError } from "@/lib/network-error";

/**
 * Pantalla de error inesperado, en español y sin detalle técnico (SEGURIDAD.md §4, "Configuración
 * incorrecta"): solo qué hacer. Si el fallo es de red, lo dice (la persona sabe qué revisar); si no,
 * el mensaje general. Lo usan el límite de errores de la organización, el raíz y el global.
 */
export function ErrorScreen({ error, retry }: { error: unknown; retry: () => void }) {
  const network = isNetworkError(error);
  const Icon = network ? WifiOff : TriangleAlert;
  return (
    <div
      role="alert"
      data-testid="error-screen"
      className="flex flex-col items-center gap-5 px-4 py-16 text-center"
    >
      <div className="flex size-14 items-center justify-center rounded-lg bg-danger-soft text-danger">
        <Icon aria-hidden strokeWidth={1.75} className="size-7" />
      </div>
      <div className="flex max-w-md flex-col gap-2">
        <h1 className="text-xl">{network ? "No pudimos conectarnos" : "Algo salió mal"}</h1>
        <p className="text-fg-muted">
          {network
            ? "Revisa tu conexión a internet e intenta de nuevo. Lo que ya estaba guardado sigue a salvo."
            : "No pudimos mostrar esta pantalla. Tus datos están a salvo. Intenta de nuevo; si sigue pasando, espera unos minutos."}
        </p>
      </div>
      <Button size="lg" onClick={() => retry()}>
        Reintentar
      </Button>
    </div>
  );
}
