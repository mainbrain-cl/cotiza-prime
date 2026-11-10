"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { CheckCircle2, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormAlert, Input } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { useResultToast } from "@/components/ui/use-result-toast";
import { saveApprovalRuleAction } from "@/lib/approvals/actions";
import {
  APPROVAL_RULE_HELP,
  APPROVAL_RULE_SCOPE_NOTE,
  describeApprovalRule,
} from "@/lib/approvals/describe";
import { INITIAL_APPROVAL_STATE, type ApprovalSaveState } from "@/lib/approvals/form-state";
import type { ApprovalMode } from "@/lib/approvals/rule";
import { approvalRuleSchema } from "@/lib/approvals/schemas";
import { cn } from "@/lib/utils";

const MODE_OPTIONS: readonly { value: ApprovalMode; title: string; text: string }[] = [
  {
    value: "never",
    title: "Nunca",
    text: "Las cotizaciones se envían directo, sin visto bueno.",
  },
  {
    value: "always",
    title: "Siempre",
    text: "Todas las cotizaciones necesitan aprobación antes de salir.",
  },
  {
    value: "conditional",
    title: "Según el monto o el descuento",
    text: "Solo las que pasan un monto o un descuento que tú eliges.",
  },
];

const OFFLINE_SAVE_MESSAGE =
  "No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo: lo que escribiste sigue aquí.";
const ALWAYS_WARNING =
  "Con «Siempre», ninguna cotización podrá enviarse —tampoco las tuyas— hasta que llegue la solicitud de aprobación.";
const AMOUNT_HINT = "Pide aprobación si el total, con IVA, es mayor. Por ejemplo, 2.000.000.";
const DISCOUNT_HINT =
  "Pide aprobación si el descuento es mayor. Por ejemplo, 10 o 12,5. Con 0, cualquier descuento la pide.";

export function ApprovalRuleForm({
  tenantId,
  version,
  initial,
  onlyApproverIsYou,
}: {
  tenantId: string;
  /** La versión de la regla que se está editando: la base rechaza guardar si otra persona ya la cambió. */
  version: number;
  initial: { mode: ApprovalMode; amount: string; discount: string };
  onlyApproverIsYou: boolean;
}) {
  const [state, setState] = useState<ApprovalSaveState>(INITIAL_APPROVAL_STATE);
  const [pending, startTransition] = useTransition();
  useResultToast(state, { successMessage: state.message });
  const [mode, setMode] = useState<ApprovalMode>(initial.mode);
  const [amount, setAmount] = useState(initial.amount);
  const [discount, setDiscount] = useState(initial.discount);
  const conditionId = useId();
  // «Siempre» frena todos los envíos hasta que llegue la solicitud de aprobación: se pide confirmarlo antes de guardar.
  const [savedMode, setSavedMode] = useState<ApprovalMode>(initial.mode);
  const [confirming, setConfirming] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmTitleId = useId();
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  // Tras guardar, la versión siguiente; antes, la que trajo la pantalla.
  const expectedVersion = state.status === "saved" && state.version ? state.version : version;

  // La frase sale de la misma lectura que usará el servidor al guardar.
  const preview = useMemo(() => {
    const parsed = approvalRuleSchema.safeParse({
      mode,
      amount,
      discount,
      expectedVersion: String(expectedVersion),
    });
    return parsed.success ? describeApprovalRule(parsed.data) : null;
  }, [mode, amount, discount, expectedVersion]);

  // Se guarda con una acción llamada a mano (no con `action` del formulario): si no hay conexión la llamada falla, y eso se
  // cuenta aquí con lo escrito intacto, en vez de caer en la pantalla de error de la organización.
  function save(form: HTMLFormElement) {
    const data = new FormData(form);
    setConfirming(false);
    startTransition(async () => {
      try {
        const result = await saveApprovalRuleAction(tenantId, INITIAL_APPROVAL_STATE, data);
        if (result.status === "saved" && result.values)
          setSavedMode(result.values.mode as ApprovalMode);
        setState(result);
      } catch {
        setState({ status: "error", message: OFFLINE_SAVE_MESSAGE });
      }
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (mode === "always" && savedMode !== "always") {
      setConfirming(true);
      return;
    }
    save(event.currentTarget);
  }

  function cancelConfirm() {
    setConfirming(false);
    saveRef.current?.focus();
  }

  function onConfirmKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      cancelConfirm();
    }
  }

  const errors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  // «Guardada» se muestra mientras lo que está en pantalla sea lo que se guardó. Los montos solo cuentan en «según el monto o el
  // descuento»: en las otras dos opciones los campos ni se ven ni se envían.
  const showSaved =
    state.status === "saved" &&
    state.values?.mode === mode &&
    (mode !== "conditional" ||
      (state.values?.amount === amount && state.values?.discount === discount));

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <OfflineNotice />
      <input type="hidden" name="expectedVersion" value={expectedVersion} />
      {state.status === "error" && state.message ? (
        <div className="flex flex-col gap-3">
          <FormAlert>{state.message}</FormAlert>
          {state.conflict ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                data-testid="approval-reload"
                onClick={() => window.location.reload()}
              >
                Ver la regla vigente
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {showSaved ? (
        <FormAlert tone="success" silent>
          <span className="inline-flex items-center gap-2" data-testid="approval-saved">
            <CheckCircle2 aria-hidden className="size-4" />
            {state.message}
          </span>
        </FormAlert>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-semibold text-fg">
          ¿Cuándo se pide aprobación?
        </legend>
        <div className="grid gap-3">
          {MODE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={cn(
                "relative flex min-h-11 cursor-pointer flex-col gap-0.5 rounded-md border bg-surface px-4 py-3 shadow-1 transition-[border-color,box-shadow] duration-(--dur-fast) ease-ios has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30",
                mode === option.value
                  ? "border-accent bg-accent-soft"
                  : "border-border-strong hover:border-accent",
              )}
            >
              <input
                type="radio"
                name="mode"
                value={option.value}
                checked={mode === option.value}
                onChange={() => {
                  setMode(option.value);
                  setConfirming(false);
                }}
                aria-controls={
                  option.value === "conditional" && mode === "conditional" ? conditionId : undefined
                }
                data-testid={`approval-mode-${option.value}`}
                className="peer absolute inset-0 size-full cursor-[inherit] appearance-none rounded-md outline-none"
              />
              {mode === option.value ? (
                <CheckCircle2 aria-hidden className="absolute top-3 right-3 size-5 text-accent" />
              ) : null}
              <span className="pr-8 text-sm font-semibold text-fg">{option.title}</span>
              <span className="text-sm text-fg-muted">{option.text}</span>
            </label>
          ))}
        </div>
        {errors.mode ? (
          <p role="alert" className="text-sm text-danger">
            {errors.mode}
          </p>
        ) : null}
      </fieldset>

      {mode === "conditional" ? (
        <div
          id={conditionId}
          className="flex flex-col gap-4 rounded-lg border border-border bg-surface px-4 py-4"
        >
          <p className="text-sm text-fg-muted">
            Escribe una condición o las dos: basta con que se cumpla una.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Si el total supera" error={errors.amount} hint={AMOUNT_HINT}>
              {(control) => (
                <div className="relative">
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-fg-muted"
                  >
                    $
                  </span>
                  <Input
                    {...control}
                    name="amount"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="2.000.000"
                    className="pl-7 tabular-nums"
                    data-testid="approval-amount"
                  />
                </div>
              )}
            </Field>
            <Field label="Si el descuento supera" error={errors.discount} hint={DISCOUNT_HINT}>
              {(control) => (
                <div className="relative">
                  <Input
                    {...control}
                    name="discount"
                    value={discount}
                    onChange={(event) => setDiscount(event.target.value)}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="10"
                    className="pr-8 tabular-nums"
                    data-testid="approval-discount"
                  />
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-fg-muted"
                  >
                    %
                  </span>
                </div>
              )}
            </Field>
          </div>
          {errors.condition ? (
            <p role="alert" className="text-sm text-danger">
              {errors.condition}
            </p>
          ) : null}
          <p className="text-sm text-fg-subtle">{APPROVAL_RULE_HELP}</p>
        </div>
      ) : null}

      <section
        aria-labelledby="approval-preview-title"
        className="flex flex-col gap-1 rounded-lg border border-border bg-surface-2 px-4 py-4"
      >
        <h2 id="approval-preview-title" className="text-sm font-semibold text-fg-muted">
          Así quedará
        </h2>
        <p aria-live="polite" data-testid="approval-preview" className="min-h-6 text-md text-fg">
          {preview ?? (
            <span className="text-fg-muted">
              Completa los datos para ver cómo quedará la regla.
            </span>
          )}
        </p>
        <p className="text-sm text-fg-muted">{APPROVAL_RULE_SCOPE_NOTE}</p>
      </section>

      {mode !== "never" ? (
        <div className="flex flex-col gap-3" data-testid="approval-heads-up">
          <FormAlert tone="warning">
            <span className="inline-flex items-start gap-2">
              <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span data-testid={mode === "always" ? "approval-always-warning" : undefined}>
                {mode === "always"
                  ? ALWAYS_WARNING
                  : "Por ahora, una cotización que cumpla la regla no se puede enviar: la solicitud de aprobación llega pronto. Quien la armó puede ajustarla (por ejemplo, bajar el descuento) para que salga."}
              </span>
            </span>
          </FormAlert>
          {onlyApproverIsYou ? (
            <FormAlert tone="warning">
              <span data-testid="approval-only-you">
                Hoy solo tú puedes aprobar. Cuando llegue la solicitud de aprobación, tus
                cotizaciones que cumplan la regla no podrán salir hasta que invites a otra persona.
              </span>
            </FormAlert>
          ) : null}
        </div>
      ) : null}

      {confirming ? (
        <div
          role="alertdialog"
          aria-labelledby={confirmTitleId}
          data-testid="approval-confirm"
          onKeyDown={onConfirmKeyDown}
          className="flex flex-col gap-3 rounded-lg border border-warning bg-warning-soft px-4 py-4"
        >
          <p id={confirmTitleId} className="text-sm font-semibold text-warning">
            ¿Guardar «Siempre»?
          </p>
          <p className="text-sm text-fg">{ALWAYS_WARNING}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={cancelRef}
              type="button"
              variant="secondary"
              size="lg"
              data-testid="approval-confirm-cancel"
              onClick={cancelConfirm}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              size="lg"
              disabled={pending}
              data-testid="approval-confirm-always"
              onClick={() => formRef.current && save(formRef.current)}
            >
              Sí, guardar «Siempre»
            </Button>
          </div>
        </div>
      ) : null}

      <div>
        <Button
          ref={saveRef}
          type="submit"
          size="lg"
          disabled={pending}
          aria-disabled={pending}
          data-testid="approval-save"
        >
          {pending ? (
            <>
              <Loader2 aria-hidden className="animate-spin" />
              Guardando…
            </>
          ) : (
            "Guardar regla"
          )}
        </Button>
      </div>
    </form>
  );
}
