"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";
import { formatRut } from "@/lib/chile/rut";
import {
  createCustomerAction,
  updateCustomerAction,
  type CustomerFormState,
} from "@/lib/customers/actions";
import {
  CUSTOMER_ADDRESS_MAX_LENGTH,
  CUSTOMER_EMAIL_MAX_LENGTH,
  CUSTOMER_KINDS,
  CUSTOMER_NAME_MAX_LENGTH,
  CUSTOMER_PHONE_MAX_LENGTH,
  RUT_ERROR,
} from "@/lib/customers/schemas";
import { tenantPath } from "@/lib/tenant/constants";

const INITIAL: CustomerFormState = INITIAL_FORM_STATE;

const MATCH_LABEL = { rut: "el mismo RUT", email: "el mismo correo" } as const;

/** Datos con que se abre el formulario al editar (el RUT ya con formato). */
export type CustomerFormInitial = {
  kind: string;
  displayName: string;
  rut: string;
  email: string;
  phone: string;
  address: string;
};

/** Sin `customerId` registra un cliente nuevo; con `customerId` edita ese cliente. */
export function CustomerForm({
  tenantId,
  customerId,
  initial,
}: {
  tenantId: string;
  customerId?: string;
  initial?: CustomerFormInitial;
}) {
  const editing = customerId !== undefined;
  const [state, formAction] = useActionState(
    editing
      ? updateCustomerAction.bind(null, tenantId, customerId)
      : createCustomerAction.bind(null, tenantId),
    INITIAL,
  );
  const value = (name: keyof CustomerFormInitial) => state.values?.[name] ?? initial?.[name];
  const [rut, setRut] = useState(value("rut") ?? "");
  const [rutError, setRutError] = useState<string | undefined>();
  const [kind, setKind] = useState(value("kind") ?? "person");
  // El aviso de duplicados corresponde a lo que se envió. Si se edita el RUT o el correo, deja de
  // valer: se esconde y el siguiente guardado vuelve a revisar. Un resultado nuevo lo reemplaza.
  const [staleState, setStaleState] = useState<CustomerFormState | null>(null);
  const errors = state.fieldErrors ?? {};
  const duplicates = staleState === state ? [] : (state.duplicates ?? []);
  const dismissDuplicates = () => setStaleState(state);

  // Aviso inmediato en el navegador; el servidor vuelve a validar y es quien manda.
  function checkRut(value: string) {
    if (value.trim() === "") return setRutError(undefined);
    const pretty = formatRut(value);
    if (pretty) {
      setRut(pretty);
      setRutError(undefined);
    } else {
      setRutError(RUT_ERROR);
    }
  }

  const isCompany = kind === "company";

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <OfflineNotice />
      {state.message ? <FormAlert>{state.message}</FormAlert> : null}

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
                <Link
                  href={tenantPath(tenantId, `clientes/${duplicate.id}`)}
                  className="inline-flex min-h-11 items-center font-semibold text-accent underline underline-offset-4"
                >
                  Abrir {duplicate.displayName}
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-fg-muted">
            Puedes abrir el cliente que ya existe o guardar este de todos modos.
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
        {errors.kind ? (
          <p role="alert" className="text-sm text-danger">
            {errors.kind}
          </p>
        ) : null}
      </fieldset>

      <Field label={isCompany ? "Razón social" : "Nombre"} error={errors.displayName} required>
        {(control) => (
          <Input
            {...control}
            name="displayName"
            autoComplete="off"
            defaultValue={value("displayName")}
            maxLength={CUSTOMER_NAME_MAX_LENGTH}
            required
          />
        )}
      </Field>

      <Field
        label="RUT (opcional)"
        error={rutError ?? errors.rut}
        hint={isCompany ? "Por ejemplo, 76.123.456-0" : "Por ejemplo, 12.345.678-5"}
      >
        {(control) => (
          <Input
            {...control}
            name="rut"
            inputMode="text"
            autoComplete="off"
            value={rut}
            onChange={(event) => {
              setRut(event.target.value);
              setRutError(undefined);
              dismissDuplicates();
            }}
            onBlur={(event) => checkRut(event.target.value)}
          />
        )}
      </Field>

      <Field label="Correo (opcional)" error={errors.email}>
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="off"
            defaultValue={value("email")}
            onChange={dismissDuplicates}
            maxLength={CUSTOMER_EMAIL_MAX_LENGTH}
          />
        )}
      </Field>

      <Field label="Teléfono (opcional)" error={errors.phone}>
        {(control) => (
          <Input
            {...control}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            defaultValue={value("phone")}
            maxLength={CUSTOMER_PHONE_MAX_LENGTH}
          />
        )}
      </Field>

      <Field label="Dirección (opcional)" error={errors.address}>
        {(control) => (
          <Input
            {...control}
            name="address"
            autoComplete="off"
            defaultValue={value("address")}
            maxLength={CUSTOMER_ADDRESS_MAX_LENGTH}
          />
        )}
      </Field>

      <div className="flex flex-col-reverse gap-3 md:flex-row md:justify-end">
        <Link
          href={tenantPath(tenantId, editing ? `clientes/${customerId}` : "clientes")}
          className={buttonVariants({ variant: "secondary", size: "lg" })}
        >
          Cancelar
        </Link>
        {duplicates.length > 0 ? (
          <SubmitButton name="confirmDuplicate" value="1" pendingLabel="Guardando…">
            Guardar de todos modos
          </SubmitButton>
        ) : (
          <SubmitButton pendingLabel="Guardando…">
            {editing ? "Guardar cambios" : "Guardar cliente"}
          </SubmitButton>
        )}
      </div>
    </form>
  );
}
