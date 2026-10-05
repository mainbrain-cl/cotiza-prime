"use client";

import { Search, UserPlus, X } from "lucide-react";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";
import { CUSTOMER_KINDS, CUSTOMER_NAME_MAX_LENGTH } from "@/lib/customers/schemas";
import {
  createCustomerAndQuoteAction,
  createQuoteAction,
  searchQuoteCustomersAction,
  type QuoteCustomerFormState,
} from "@/lib/quotes/actions";
import type { CustomerChoice } from "@/lib/quotes/customer-choice";

const SEARCH_DELAY_MS = 250;
const KIND_LABEL: Record<string, string> = Object.fromEntries(
  CUSTOMER_KINDS.map((kind) => [kind.value, kind.label]),
);
const INITIAL: QuoteCustomerFormState = INITIAL_FORM_STATE;
const MATCH_LABEL = { rut: "el mismo RUT", email: "el mismo correo" } as const;

/**
 * Elegir a quién se cotiza: buscar entre los clientes o crear uno nuevo en un diálogo, sin salir.
 * Al elegir, se crea el borrador (con su número) y se abre el editor. La clave de creación se genera
 * una sola vez por visita: un doble clic o un reintento devuelve la misma cotización.
 */
export function CustomerPicker({
  tenantId,
  initial,
}: {
  tenantId: string;
  initial: CustomerChoice[];
}) {
  const [creationKey, setCreationKey] = useState(() => crypto.randomUUID());
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<CustomerChoice[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const timer = useRef<number | undefined>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function onSearch(value: string) {
    setTerm(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        setResults(await searchQuoteCustomersAction(tenantId, value));
      } catch {
        // Sin conexión: se queda la lista anterior.
      }
    }, SEARCH_DELAY_MS);
  }

  function choose(customerId: string) {
    setError(null);
    startTransition(async () => {
      const result = await createQuoteAction(tenantId, customerId, creationKey);
      // Si salió bien, la acción redirige al editor y no llega aquí.
      if (result?.status === "error") {
        setError(result.message);
        // Una respuesta de error es definitiva: el próximo intento usa una clave nueva, para no
        // chocar con la clave de un intento anterior (que podría ser de otro cliente).
        setCreationKey(crypto.randomUUID());
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <OfflineNotice />
      {error ? <FormAlert>{error}</FormAlert> : null}

      <section
        aria-label="Elegir cliente"
        className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6"
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="quote-customer-search" className="text-sm font-semibold text-fg">
            Buscar un cliente
          </label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle"
            />
            <Input
              id="quote-customer-search"
              type="search"
              value={term}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Nombre, RUT o correo"
              autoComplete="off"
              maxLength={100}
              className="pl-9"
            />
          </div>
          <p className="text-sm text-fg-muted">
            El nombre se busca por partes. El RUT y el correo, completos.
          </p>
        </div>

        {results.length === 0 ? (
          <p role="status" data-testid="no-customers" className="text-fg-muted">
            {term.trim() === ""
              ? "Aún no tienes clientes. Crea el primero para empezar."
              : "No encontramos clientes con lo que escribiste."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="customer-choices">
            {results.map((customer) => (
              <li key={customer.id}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => choose(customer.id)}
                  className="flex min-h-14 w-full flex-col items-start gap-0.5 rounded-sm border border-border p-3 text-left transition-colors duration-(--dur-fast) hover:bg-surface-2 focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none disabled:opacity-50"
                >
                  <span className="font-semibold text-fg">{customer.displayName}</span>
                  <span className="text-sm text-fg-muted">
                    {KIND_LABEL[customer.kind] ?? customer.kind}
                    {customer.maskedRut ? ` · ${customer.maskedRut}` : ""}
                    {customer.maskedEmail ? ` · ${customer.maskedEmail}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-border pt-4">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            disabled={pending}
            onClick={() => dialog.current?.showModal()}
          >
            <UserPlus aria-hidden />
            Crear un cliente nuevo
          </Button>
        </div>
      </section>

      <dialog
        ref={dialog}
        aria-labelledby="new-customer-title"
        className="backdrop:bg-black/40 m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-0 text-fg shadow-3"
      >
        <NewCustomerForm
          tenantId={tenantId}
          creationKey={creationKey}
          onClose={() => dialog.current?.close()}
          onChooseExisting={(id) => {
            dialog.current?.close();
            choose(id);
          }}
        />
      </dialog>
    </div>
  );
}

function NewCustomerForm({
  tenantId,
  creationKey,
  onClose,
  onChooseExisting,
}: {
  tenantId: string;
  creationKey: string;
  onClose: () => void;
  onChooseExisting: (customerId: string) => void;
}) {
  const [state, formAction] = useActionState(
    createCustomerAndQuoteAction.bind(null, tenantId, creationKey),
    INITIAL,
  );
  const [kind, setKind] = useState("person");
  const errors = state.fieldErrors ?? {};
  const duplicates = state.duplicates ?? [];

  return (
    <form action={formAction} className="flex flex-col gap-4 p-4 md:p-6" noValidate>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="new-customer-title" className="text-lg">
            Nuevo cliente
          </h2>
          <p className="text-sm text-fg-muted">
            Solo el nombre es obligatorio. Al guardarlo se crea la cotización.
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Cerrar" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>

      {state.message ? <FormAlert>{state.message}</FormAlert> : null}
      {state.createdCustomerId ? (
        <input type="hidden" name="createdCustomerId" value={state.createdCustomerId} />
      ) : null}

      {duplicates.length > 0 ? (
        <div
          role="alert"
          data-testid="duplicate-warning"
          className="flex flex-col gap-3 rounded-sm bg-warning-soft p-3 text-sm text-fg"
        >
          <p className="font-semibold text-warning">Ya tienes un cliente parecido.</p>
          <ul className="flex flex-col gap-2">
            {duplicates.map((duplicate) => (
              <li key={duplicate.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  <strong>{duplicate.displayName}</strong> tiene{" "}
                  {duplicate.matchedOn.map((field) => MATCH_LABEL[field]).join(" y ")}.
                </span>
                <button
                  type="button"
                  onClick={() => onChooseExisting(duplicate.id)}
                  className="inline-flex min-h-11 items-center font-semibold text-accent underline underline-offset-4"
                >
                  Usar a {duplicate.displayName}
                </button>
              </li>
            ))}
          </ul>
          <p className="text-fg-muted">
            Puedes usar el cliente que ya existe o guardar este de todos modos.
          </p>
        </div>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold text-fg">¿Es una persona o una empresa?</legend>
        <div className="flex gap-2">
          {CUSTOMER_KINDS.map((option) => (
            <label
              key={option.value}
              className="flex h-11 flex-1 cursor-pointer items-center justify-center rounded-sm border border-border-strong bg-surface px-3 text-sm font-semibold text-fg has-checked:border-accent has-checked:bg-accent-soft has-checked:text-accent has-focus-visible:ring-3 has-focus-visible:ring-ring/30 md:h-10"
            >
              <input
                type="radio"
                name="kind"
                value={option.value}
                checked={kind === option.value}
                onChange={() => setKind(option.value)}
                className="sr-only"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      <Field
        label={kind === "company" ? "Razón social" : "Nombre"}
        error={errors.displayName}
        required
      >
        {(control) => (
          <Input
            {...control}
            name="displayName"
            autoComplete="off"
            defaultValue={state.values?.displayName}
            maxLength={CUSTOMER_NAME_MAX_LENGTH}
            required
          />
        )}
      </Field>
      <Field label="RUT (opcional)" error={errors.rut}>
        {(control) => (
          <Input {...control} name="rut" autoComplete="off" defaultValue={state.values?.rut} />
        )}
      </Field>
      <Field label="Correo (opcional)" error={errors.email}>
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            autoComplete="off"
            defaultValue={state.values?.email}
          />
        )}
      </Field>
      <Field label="Teléfono (opcional)" error={errors.phone}>
        {(control) => (
          <Input
            {...control}
            name="phone"
            type="tel"
            autoComplete="off"
            defaultValue={state.values?.phone}
          />
        )}
      </Field>

      <div className="flex flex-col-reverse gap-3 md:flex-row md:justify-end">
        <Button type="button" variant="secondary" size="lg" onClick={onClose}>
          Cancelar
        </Button>
        {duplicates.length > 0 ? (
          <SubmitButton name="confirmDuplicate" value="1" pendingLabel="Guardando…">
            Guardar de todos modos
          </SubmitButton>
        ) : (
          <SubmitButton pendingLabel="Guardando…">Guardar y cotizar</SubmitButton>
        )}
      </div>
    </form>
  );
}
