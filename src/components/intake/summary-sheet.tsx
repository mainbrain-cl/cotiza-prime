"use client";

import { ListChecks, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Teléfono (H-088): botón fijo «Ver resumen (N)» y una hoja que sube desde abajo con el resumen. Usa el
 * elemento `<dialog>` del navegador: foco atrapado, Escape para cerrar y el resto de la página inerte, sin
 * dependencias. Los campos del formulario NO viven aquí dentro, así que abrirla no desmonta nada y lo
 * escrito se conserva. El contenido de la hoja solo existe mientras está abierta.
 */
export function SummarySheet({ count, children }: { count: number; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const show = () => {
    dialogRef.current?.showModal();
    setOpen(true);
  };
  const close = () => dialogRef.current?.close();

  return (
    <div className="lg:hidden">
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          ref={triggerRef}
          type="button"
          onClick={show}
          data-testid="summary-open"
          className="pointer-events-auto inline-flex h-12 min-w-44 items-center justify-center gap-2 rounded-full border border-border-strong bg-surface px-5 text-sm font-semibold text-fg shadow-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        >
          <ListChecks aria-hidden strokeWidth={1.75} className="size-5 text-[var(--brand-text)]" />
          Ver resumen ({count})
        </button>
      </div>

      <dialog
        ref={dialogRef}
        aria-labelledby="summary-sheet-title"
        data-testid="summary-sheet"
        onClose={() => {
          setOpen(false);
          triggerRef.current?.focus();
        }}
        onClick={(event) => {
          // Un toque en el fondo oscuro (el propio <dialog>, no su contenido) cierra la hoja.
          if (event.target === dialogRef.current) close();
        }}
        className={cn(
          "customer-light m-0 mt-auto max-h-[85dvh] w-full max-w-none overflow-y-auto rounded-t-lg border border-border bg-surface p-0 text-fg shadow-3",
          "backdrop:bg-black/40",
          "open:animate-[summary-sheet-in_320ms_cubic-bezier(.22,1,.36,1)] motion-reduce:open:animate-none",
        )}
      >
        {open ? (
          <div className="flex flex-col gap-4 p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <div className="flex items-center justify-between gap-3">
              <h2 id="summary-sheet-title" className="text-lg font-semibold">
                Resumen de tu solicitud
              </h2>
              <button
                type="button"
                onClick={close}
                data-testid="summary-close"
                aria-label="Cerrar el resumen"
                className="inline-flex size-11 items-center justify-center rounded-full text-fg-muted outline-none hover:bg-surface-2 focus-visible:ring-3 focus-visible:ring-ring/40"
              >
                <X aria-hidden strokeWidth={1.75} className="size-5" />
              </button>
            </div>
            {children}
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
