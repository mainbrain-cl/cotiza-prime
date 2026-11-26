import { formatClp } from "@/lib/money/clp";
import type { SharePaymentView } from "@/lib/share/payment";
import { cn } from "@/lib/utils";

/**
 * H-053: los datos para pagar en el enlace del cliente, ya aceptado. Con la marca de la organización (sus colores), nunca la de
 * Cotiza Prime. Solo se dibuja cuando la base entregó el cobro (es decir, después de aceptar).
 */
export function PaymentInstructions({
  payment,
  organizationName,
  quoteNumber,
}: {
  payment: SharePaymentView;
  organizationName: string;
  quoteNumber: string;
}) {
  return (
    <section
      aria-labelledby="share-payment-title"
      data-testid="share-payment"
      className="flex flex-col gap-4 rounded-md border border-border p-4 sm:p-5"
    >
      <h2
        id="share-payment-title"
        className="text-xs tracking-[0.08em] text-[var(--brand-text)] uppercase"
      >
        Datos para pagar
      </h2>
      {payment.due ? (
        <div>
          <p className="text-sm text-fg-muted">{payment.due.label}: monto a pagar</p>
          <p className="text-2xl font-semibold tabular-nums" data-testid="share-payment-due">
            {formatClp(payment.due.amountClp)}
          </p>
        </div>
      ) : (
        <p className="font-medium">Esta cotización ya está pagada. ¡Gracias!</p>
      )}

      {payment.due ? (
        payment.bankLines ? (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            {payment.bankLines.map(({ label, value }) => (
              <div key={label} className="contents">
                <dt className="text-fg-subtle">{label}</dt>
                <dd className="font-medium break-all">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm">{organizationName} te enviará los datos para transferir.</p>
        )
      ) : null}

      {payment.rows.length > 1 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {payment.rows.map((row) => (
            <li key={row.label} className="flex justify-between gap-4">
              <span>{row.label}</span>
              <span className={cn("tabular-nums", row.paid ? "text-success" : "text-fg-muted")}>
                {formatClp(row.amountClp)} · {row.statusLabel}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {payment.due ? (
        <p className="text-sm text-fg-muted">
          En el comentario de la transferencia indica el número {quoteNumber}.
        </p>
      ) : null}
    </section>
  );
}
