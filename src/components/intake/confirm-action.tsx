"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Loader2 } from "lucide-react";
import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-controls";

type ConfirmActionProps = {
  /** Botón que abre la confirmación. */
  trigger: ReactElement;
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  /** Devuelve un mensaje de error para dejar el diálogo abierto, o `null` si todo salió bien. */
  onConfirm: () => Promise<string | null>;
  testId: string;
  /** Campos extra dentro del diálogo (por ejemplo, el motivo). */
  children?: ReactNode;
  /** Estilo del botón de confirmar. Por defecto, el de una acción destructiva. */
  confirmVariant?: "danger" | "primary";
  /** Avisa cuando el diálogo se abre o se cierra (por ejemplo, para reiniciar lo que se eligió dentro). */
  onOpenChange?: (open: boolean) => void;
};

/** Confirmación antes de una acción que no se puede deshacer, con la consecuencia explicada. */
export function ConfirmAction({
  trigger,
  title,
  description,
  confirmLabel,
  pendingLabel,
  onConfirm,
  testId,
  children,
  confirmVariant = "danger",
  onOpenChange,
}: ConfirmActionProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  async function confirm() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const failure = await onConfirm();
      if (failure) setError(failure);
      else setOpen(false);
    } catch {
      setError("No pudimos completar la acción. Revisa tu conexión y vuelve a intentar.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) setError(null);
        onOpenChange?.(next);
      }}
    >
      <AlertDialog.Trigger data-testid={`${testId}-open`} render={trigger} />
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="bg-black/40 fixed inset-0 z-50 transition-opacity duration-(--dur-base) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
        <AlertDialog.Viewport className="fixed inset-0 z-50 flex items-end justify-center p-4 md:items-center">
          <AlertDialog.Popup
            data-testid={`${testId}-dialog`}
            className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-surface p-5 shadow-3 transition-[opacity,transform] duration-(--dur-slow) ease-ios outline-none data-[ending-style]:translate-y-2 data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0 motion-reduce:transition-none"
          >
            <AlertDialog.Title className="text-lg">{title}</AlertDialog.Title>
            <AlertDialog.Description className="text-fg-muted">
              {description}
            </AlertDialog.Description>
            {children}
            {error ? <FormAlert>{error}</FormAlert> : null}
            <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
              <AlertDialog.Close
                data-testid={`${testId}-cancel`}
                disabled={pending}
                render={
                  <Button type="button" variant="secondary">
                    Cancelar
                  </Button>
                }
              />
              <Button
                type="button"
                variant={confirmVariant}
                onClick={() => void confirm()}
                disabled={pending}
                aria-disabled={pending}
                data-testid={`${testId}-confirm`}
              >
                {pending ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    {pendingLabel}
                  </>
                ) : (
                  confirmLabel
                )}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
