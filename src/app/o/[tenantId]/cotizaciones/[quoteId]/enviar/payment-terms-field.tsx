"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { FormAlert } from "@/components/ui/form-controls";
import { formatClp } from "@/lib/money/clp";
import { setPaymentTermsAction } from "@/lib/payments/actions";
import {
  MILESTONE_LABELS,
  PAYMENT_TERMS,
  PAYMENT_TERMS_LABELS,
  splitPayment,
  type PaymentTerms,
} from "@/lib/payments/model";
import { cn } from "@/lib/utils";

/**
 * H-052: la condición de pago, elegida antes de enviar. Se guarda en la cotización al elegirla (así el PDF de la vista previa la
 * muestra) y el envío la vuelve a fijar en el servidor. Por defecto, 100 % al aceptar. Sin datos de transferencia en la organización
 * no hay condición: la cotización sale sin cobro y se dice por qué.
 */
export function PaymentTermsField({
  tenantId,
  quoteId,
  totalClp,
  hasBankAccount,
  initialTerms,
  canManageBank,
  bankSettingsHref,
}: {
  tenantId: string;
  quoteId: string;
  totalClp: number;
  hasBankAccount: boolean;
  initialTerms: PaymentTerms | null;
  canManageBank: boolean;
  bankSettingsHref: string;
}) {
  const router = useRouter();
  const [terms, setTerms] = useState<PaymentTerms>(initialTerms ?? "full");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const defaulted = useRef(false);

  function save(next: PaymentTerms) {
    startTransition(async () => {
      try {
        const result = await setPaymentTermsAction(tenantId, quoteId, next);
        if (result.status === "error") setError(result.message);
        else router.refresh();
      } catch {
        setError("No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.");
      }
    });
  }

  function choose(next: PaymentTerms) {
    setTerms(next);
    setError(null);
    save(next);
  }

  // Sin condición guardada, se fija la de siempre (100 %) para que la vista previa del PDF ya la muestre.
  useEffect(() => {
    if (hasBankAccount && initialTerms === null && !defaulted.current) {
      defaulted.current = true;
      save("full");
    }
    // Solo al abrir la pantalla.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!hasBankAccount) {
    return (
      <FormAlert tone="warning">
        <span data-testid="payment-terms-no-bank">
          Tu organización todavía no tiene datos de transferencia: esta cotización se enviará sin
          condición de pago y el cliente no recibirá los datos para pagar al aceptarla.{" "}
          {canManageBank ? (
            <a href={bankSettingsHref} className="underline">
              Registrar los datos de transferencia
            </a>
          ) : (
            "Pide al Dueño o a un Administrador que los registre en Configuración."
          )}
        </span>
      </FormAlert>
    );
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 md:p-5">
      <legend className="px-1 text-sm font-semibold text-fg">Condición de pago</legend>
      <div className="grid gap-2 md:grid-cols-2">
        {PAYMENT_TERMS.map((option) => {
          const parts = splitPayment(totalClp, option);
          const checked = terms === option;
          return (
            <label
              key={option}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-3",
                checked ? "border-accent bg-accent-soft" : "border-border",
              )}
            >
              <input
                type="radio"
                name="paymentTerms"
                value={option}
                checked={checked}
                onChange={() => choose(option)}
                disabled={pending}
                className="mt-1 size-5 accent-[var(--accent)]"
                data-testid={`payment-terms-${option}`}
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-semibold text-fg">{PAYMENT_TERMS_LABELS[option]}</span>
                {parts.map((part) => (
                  <span key={part.seq} className="text-sm text-fg-muted tabular-nums">
                    {MILESTONE_LABELS[part.kind]}: {formatClp(part.amountClp)}
                  </span>
                ))}
              </span>
            </label>
          );
        })}
      </div>
      <p className="flex items-center gap-2 text-sm text-fg-muted" aria-live="polite">
        {pending ? (
          <>
            <Loader2 aria-hidden className="size-4 animate-spin" />
            Guardando la condición…
          </>
        ) : (
          "Al aceptar, el cliente recibe por correo el monto y los datos de transferencia."
        )}
      </p>
      {error ? <FormAlert>{error}</FormAlert> : null}
    </fieldset>
  );
}
