"use client";

import { Loader2, Send } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-controls";
import { resendQuoteAction } from "@/lib/quotes/send/actions";

// La respuesta no llegó: el reenvío pudo haber salido. El historial de la cotización lo dice.
const OFFLINE_MESSAGE =
  "No sabemos si el reenvío alcanzó a salir. Revisa el historial de la cotización antes de volver a reenviar.";
const RESENT_MESSAGE = "Cotización reenviada con un enlace nuevo.";
const IN_PROGRESS_MESSAGE = "Este reenvío ya está en curso. Espera unos segundos.";

/**
 * Reenviar el correo al cliente (H-029): sale el MISMO PDF que ya se envió, con un enlace nuevo. Si
 * el correo del cliente estaba mal, se corrige en su ficha y se reenvía desde aquí.
 */
export function ResendButton({ tenantId, quoteId }: { tenantId: string; quoteId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Una clave por intento: un doble clic comparte la clave y no duplica el reenvío.
  const resendKey = useRef(crypto.randomUUID());
  const busy = useRef(false);

  async function resend() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await resendQuoteAction(tenantId, quoteId, { resendKey: resendKey.current });
      if (result.status === "sent") toast.success(RESENT_MESSAGE);
      else if (result.status === "in_progress") setNotice(IN_PROGRESS_MESSAGE);
      else setError(result.message);
      if (result.status !== "in_progress") resendKey.current = crypto.randomUUID();
    } catch {
      setError(OFFLINE_MESSAGE);
      // Un intento sin respuesta no deja la clave "gastada": el próximo clic parte con una nueva.
      resendKey.current = crypto.randomUUID();
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        onClick={() => void resend()}
        disabled={pending}
        aria-disabled={pending}
        data-testid="resend-quote"
      >
        {pending ? (
          <>
            <Loader2 aria-hidden className="animate-spin" />
            Reenviando…
          </>
        ) : (
          <>
            <Send aria-hidden />
            Reenviar al cliente
          </>
        )}
      </Button>
      {error ? <FormAlert>{error}</FormAlert> : null}
      {notice ? <FormAlert tone="warning">{notice}</FormAlert> : null}
    </div>
  );
}
