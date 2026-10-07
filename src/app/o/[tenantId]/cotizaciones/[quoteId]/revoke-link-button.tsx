"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Link2Off, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-controls";
import { revokeQuoteLinksAction } from "@/lib/quotes/send/actions";

const REVOKED_MESSAGE = "Enlace revocado. El cliente ya no puede abrir esta cotización.";
const NOTHING_MESSAGE = "Este enlace ya estaba revocado.";
const OFFLINE_MESSAGE =
  "No sabemos si el enlace alcanzó a revocarse. Revisa el historial de la cotización antes de volver a intentarlo.";

/**
 * Revocar el enlace que se envió al cliente (H-035), con confirmación. Explica la consecuencia antes
 * de hacerlo: el cliente deja de poder ver y aceptar la cotización, y para volver a ofrecérsela hay
 * que reenviarla con un enlace nuevo.
 */
export function RevokeLinkButton({ tenantId, quoteId }: { tenantId: string; quoteId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  async function revoke() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await revokeQuoteLinksAction(tenantId, quoteId);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      toast.success(result.status === "revoked" ? REVOKED_MESSAGE : NOTHING_MESSAGE);
      setOpen(false);
    } catch {
      setError(OFFLINE_MESSAGE);
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
      }}
    >
      <AlertDialog.Trigger
        data-testid="revoke-link"
        render={
          <Button type="button" variant="secondary">
            <Link2Off aria-hidden />
            Revocar enlace
          </Button>
        }
      />
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="bg-black/40 fixed inset-0 z-50 transition-opacity duration-(--dur-base) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
        <AlertDialog.Viewport className="fixed inset-0 z-50 flex items-end justify-center p-4 md:items-center">
          <AlertDialog.Popup
            data-testid="revoke-dialog"
            className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-surface p-5 shadow-3 transition-[opacity,transform] duration-(--dur-slow) ease-ios outline-none data-[ending-style]:translate-y-2 data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0 motion-reduce:transition-none"
          >
            <AlertDialog.Title className="text-lg">
              ¿Revocar el enlace del cliente?
            </AlertDialog.Title>
            <AlertDialog.Description className="text-fg-muted">
              El cliente ya no podrá abrir esta cotización ni aceptarla con el enlace que le
              enviaste. Si cambias de opinión, puedes reenviarla y le llegará un enlace nuevo.
            </AlertDialog.Description>
            {error ? <FormAlert>{error}</FormAlert> : null}
            <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
              <AlertDialog.Close
                data-testid="revoke-cancel"
                disabled={pending}
                render={
                  <Button type="button" variant="secondary">
                    Cancelar
                  </Button>
                }
              />
              <Button
                type="button"
                variant="danger"
                onClick={() => void revoke()}
                disabled={pending}
                aria-disabled={pending}
                data-testid="revoke-confirm"
              >
                {pending ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    Revocando…
                  </>
                ) : (
                  "Sí, revocar enlace"
                )}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
