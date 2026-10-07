"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Falla inesperada al abrir el formulario incrustado: un mensaje simple y reintentar, sin detalles técnicos. */
export default function EmbeddedIntakeError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="customer-light">
      <style>{`html,body{background:transparent!important;height:auto!important;min-height:0!important;color-scheme:light}`}</style>
      <main
        role="alert"
        className="mx-auto flex w-full max-w-md flex-col items-center gap-5 px-4 py-8 text-center"
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
