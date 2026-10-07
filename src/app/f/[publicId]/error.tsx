"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Falla inesperada al abrir el formulario: un mensaje simple y reintentar, sin detalles técnicos. */
export default function IntakeError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="customer-light flex min-h-dvh flex-col">
      <main
        role="alert"
        className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-5 px-4 py-10 text-center"
      >
        <div className="flex size-14 items-center justify-center rounded-lg bg-danger-soft text-danger">
          <TriangleAlert aria-hidden strokeWidth={1.75} className="size-7" />
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="text-xl">No pudimos abrir el formulario</h1>
          <p className="text-fg-muted">
            Tuvimos un problema de nuestro lado. Inténtalo de nuevo en un momento.
          </p>
        </div>
        <Button size="lg" onClick={reset}>
          Intentar de nuevo
        </Button>
      </main>
    </div>
  );
}
