"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Send, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormAlert, Input, Textarea } from "@/components/ui/form-controls";
import { formatClp, parseClp } from "@/lib/money/clp";
import {
  recordPaymentAction,
  requestSecondPaymentAction,
  reversePaymentAction,
  type PaymentActionResult,
} from "@/lib/payments/actions";
import {
  MILESTONE_LABELS,
  MILESTONE_STATUS_LABELS,
  outstandingClp,
  type MilestoneKind,
  type MilestoneStatus,
} from "@/lib/payments/model";
import { cn } from "@/lib/utils";

export type PaymentRow = {
  id: string;
  seq: number;
  kind: MilestoneKind;
  amountClp: number;
  status: MilestoneStatus;
  paidOn: string | null;
  paidAmountClp: number | null;
  paidNote: string | null;
};

type Mode =
  | { kind: "idle" }
  | { kind: "record"; id: string }
  | { kind: "reverse"; id: string }
  | { kind: "request"; id: string };

const OFFLINE = "No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.";

function todayInChile(): string {
  // `sv-SE` escribe la fecha como aaaa-mm-dd (lo que espera el campo de fecha).
  return new Date().toLocaleDateString("sv-SE", { timeZone: "America/Santiago" });
}

function displayDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

/**
 * Los pagos de una cotización aceptada (H-054 a H-057): lo esperado, lo recibido y lo que falta. Marcar y deshacer solo los ve
 * quien puede confirmar pagos (Dueño y Administrador); «Solicitar segundo pago», quien puede pedirlo. El servidor y la base lo
 * vuelven a exigir.
 */
export function QuotePayments({
  tenantId,
  quoteId,
  rows,
  canConfirm,
  canRequestSecond,
}: {
  tenantId: string;
  quoteId: string;
  rows: PaymentRow[];
  canConfirm: boolean;
  canRequestSecond: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [paidOn, setPaidOn] = useState(todayInChile());
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [confirmMismatch, setConfirmMismatch] = useState(false);

  const outstanding = outstandingClp(rows);
  const deposit = rows.find((row) => row.seq === 1);

  function open(next: Mode, row?: PaymentRow) {
    setError(null);
    setConfirmMismatch(false);
    if (next.kind === "record" && row) {
      setAmount(String(row.amountClp));
      setPaidOn(todayInChile());
      setNote("");
    }
    if (next.kind === "reverse") setReason("");
    setMode(next);
  }

  function run(task: () => Promise<PaymentActionResult>) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await task();
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        if (result.message) toast.success(result.message);
        setMode({ kind: "idle" });
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  function submitRecord(event: FormEvent<HTMLFormElement>, row: PaymentRow) {
    event.preventDefault();
    const parsed = parseClp(amount);
    if (!parsed.ok) {
      setError("Escribe el monto recibido en pesos, sin decimales.");
      return;
    }
    // H-054: si el monto no coincide con el esperado, se advierte antes de confirmar.
    if (parsed.value !== row.amountClp && !confirmMismatch) {
      setConfirmMismatch(true);
      return;
    }
    run(() => recordPaymentAction(tenantId, quoteId, row.id, { paidOn, amount, note }));
  }

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6"
      aria-labelledby="payments-title"
      data-testid="quote-payments"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="payments-title" className="text-lg">
          Pagos
        </h2>
        <p className="text-sm text-fg-muted" data-testid="payments-outstanding">
          {outstanding > 0 ? (
            <>
              Falta por cobrar{" "}
              <strong className="text-fg tabular-nums">{formatClp(outstanding)}</strong>
            </>
          ) : (
            "Todo pagado"
          )}
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const canRecord =
            canConfirm && row.status !== "paid" && (row.seq === 1 || deposit?.status === "paid");
          const canReverse =
            canConfirm &&
            row.status === "paid" &&
            (row.seq === 2 || !rows.some((other) => other.seq === 2 && other.status === "paid"));
          const canRequest =
            canRequestSecond &&
            row.kind === "balance" &&
            deposit?.status === "paid" &&
            row.status !== "paid";
          return (
            <li
              key={row.id}
              className="flex flex-col gap-3 rounded-md border border-border p-3"
              data-testid={`payment-${row.kind}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-col">
                  <span className="font-semibold">{MILESTONE_LABELS[row.kind]}</span>
                  <span className="text-sm text-fg-muted tabular-nums">
                    {formatClp(row.amountClp)}
                  </span>
                </div>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold",
                    row.status === "paid"
                      ? "bg-success-soft text-success"
                      : "bg-warning-soft text-warning",
                  )}
                  data-testid={`payment-status-${row.kind}`}
                >
                  {MILESTONE_STATUS_LABELS[row.status]}
                </span>
              </div>
              {row.status === "paid" && row.paidOn ? (
                <p className="text-sm text-fg-muted">
                  Recibido el {displayDate(row.paidOn)} por{" "}
                  <span className="tabular-nums">{formatClp(row.paidAmountClp ?? 0)}</span>
                  {row.paidNote ? ` · ${row.paidNote}` : ""}
                </p>
              ) : null}

              {mode.kind === "idle" && (canRecord || canReverse || canRequest) ? (
                <div className="flex flex-wrap gap-2">
                  {canRecord ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => open({ kind: "record", id: row.id }, row)}
                      data-testid={`payment-record-${row.kind}`}
                    >
                      <CheckCircle2 aria-hidden />
                      Marcar como recibido
                    </Button>
                  ) : null}
                  {canRequest ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => open({ kind: "request", id: row.id })}
                      data-testid="payment-request-balance"
                    >
                      <Send aria-hidden />
                      {row.status === "requested"
                        ? "Reenviar el pedido del saldo"
                        : "Solicitar segundo pago"}
                    </Button>
                  ) : null}
                  {canReverse ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => open({ kind: "reverse", id: row.id })}
                      data-testid={`payment-reverse-${row.kind}`}
                    >
                      <Undo2 aria-hidden />
                      Deshacer
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {mode.kind === "record" && mode.id === row.id ? (
                <form
                  className="flex flex-col gap-3 rounded-md bg-surface-2 p-3"
                  onSubmit={(event) => submitRecord(event, row)}
                  noValidate
                >
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Fecha en que llegó" required>
                      {(control) => (
                        <Input
                          {...control}
                          type="date"
                          value={paidOn}
                          max={todayInChile()}
                          onChange={(event) => setPaidOn(event.target.value)}
                          required
                        />
                      )}
                    </Field>
                    <Field label="Monto recibido" required>
                      {(control) => (
                        <Input
                          {...control}
                          inputMode="numeric"
                          value={amount}
                          onChange={(event) => {
                            setAmount(event.target.value);
                            setConfirmMismatch(false);
                          }}
                          required
                          data-testid="payment-amount"
                        />
                      )}
                    </Field>
                  </div>
                  <Field label="Nota (opcional)" hint="Por ejemplo, el número de la transferencia.">
                    {(control) => (
                      <Textarea
                        {...control}
                        rows={2}
                        maxLength={500}
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                      />
                    )}
                  </Field>
                  {confirmMismatch ? (
                    <FormAlert tone="warning">
                      El monto no coincide con el esperado ({formatClp(row.amountClp)}). Si es
                      correcto, presiona «Confirmar de todas formas».
                    </FormAlert>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={pending} data-testid="payment-record-confirm">
                      {confirmMismatch ? "Confirmar de todas formas" : "Confirmar pago recibido"}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setMode({ kind: "idle" })}>
                      Cancelar
                    </Button>
                  </div>
                </form>
              ) : null}

              {mode.kind === "reverse" && mode.id === row.id ? (
                <form
                  className="flex flex-col gap-3 rounded-md bg-surface-2 p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    run(() => reversePaymentAction(tenantId, quoteId, row.id, reason));
                  }}
                  noValidate
                >
                  <Field
                    label="¿Por qué lo deshaces?"
                    hint={
                      row.seq === 1 &&
                      rows.some((other) => other.seq === 2 && other.status === "requested")
                        ? "Queda en el historial junto al pago original. El pedido del saldo se anula: vuelve a «Por pagar»."
                        : "Queda en el historial junto al pago original."
                    }
                    required
                  >
                    {(control) => (
                      <Input
                        {...control}
                        value={reason}
                        maxLength={200}
                        onChange={(event) => setReason(event.target.value)}
                        required
                      />
                    )}
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" variant="danger" disabled={pending}>
                      Deshacer el pago
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setMode({ kind: "idle" })}>
                      Cancelar
                    </Button>
                  </div>
                </form>
              ) : null}

              {mode.kind === "request" && mode.id === row.id ? (
                <div className="flex flex-col gap-3 rounded-md bg-surface-2 p-3">
                  <p className="text-sm">
                    Le enviaremos al cliente un correo con el saldo de{" "}
                    <strong className="tabular-nums">{formatClp(row.amountClp)}</strong> y los datos
                    de transferencia con que aceptó la cotización.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={pending}
                      onClick={() =>
                        run(() => requestSecondPaymentAction(tenantId, quoteId, row.id))
                      }
                      data-testid="payment-request-confirm"
                    >
                      {pending ? "Enviando…" : "Enviar el correo"}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setMode({ kind: "idle" })}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? <FormAlert>{error}</FormAlert> : null}
    </section>
  );
}
