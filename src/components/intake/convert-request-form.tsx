"use client";

import { FilePlus2, Loader2 } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FormAlert, Input } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import {
  CUSTOMER_ADDRESS_MAX_LENGTH,
  CUSTOMER_KINDS,
  CUSTOMER_NAME_MAX_LENGTH,
  type CustomerKind,
} from "@/lib/customers/schemas";
import { convertIntakeRequestAction } from "@/lib/intake/convert-actions";
import { cn } from "@/lib/utils";

type Duplicate = { id: string; displayName: string; matchedOn: ("rut" | "email")[] };

const MATCH_LABEL = { rut: "el mismo RUT", email: "el mismo correo" } as const;

type Initial = { name: string; email: string; phone: string; company: string; address: string };

/**
 * Convertir una solicitud en cotización (H-090): el formulario de cliente con los datos de la solicitud
 * ya cargados. Si ya hay un cliente con ese correo se ofrece usarlo. El identificador del cliente nuevo y
 * la clave de creación se generan una sola vez al abrir la pantalla: un doble clic o un reintento no crea
 * otro cliente ni otra cotización. Al terminar, la acción abre la cotización.
 */
export function ConvertRequestForm({
  tenantId,
  requestId,
  requestPath,
  initial,
  duplicates: initialDuplicates,
}: {
  tenantId: string;
  requestId: string;
  requestPath: string;
  initial: Initial;
  duplicates: Duplicate[];
}) {
  const [creationKey, setCreationKey] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<CustomerKind>("person");
  const [displayName, setDisplayName] = useState(initial.name);
  const [rut, setRut] = useState("");
  const [email, setEmail] = useState(initial.email);
  const [phone, setPhone] = useState(initial.phone);
  const [address, setAddress] = useState(initial.address);
  const [duplicates, setDuplicates] = useState<Duplicate[]>(initialDuplicates);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  function run(input: Parameters<typeof convertIntakeRequestAction>[2]) {
    setMessage(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await convertIntakeRequestAction(tenantId, requestId, input);
      // Si salió bien, la acción abre la cotización y no llega aquí.
      if (result?.status !== "error") return;
      setMessage(result.message);
      setFieldErrors(result.fieldErrors ?? {});
      if (result.kind === "duplicates") setDuplicates(result.duplicates ?? []);
      // Un error de la base es definitivo: el próximo intento usa una clave nueva.
      if (result.kind === "key_reused" || result.kind === "other") {
        setCreationKey(crypto.randomUUID());
      }
    });
  }

  function createWithNewCustomer() {
    run({
      mode: "new",
      creationKey,
      confirmDuplicate: duplicates.length > 0,
      customer: { kind, displayName, rut, email, phone, address },
    });
  }

  function chooseExisting(existingId: string) {
    run({ mode: "existing", customerId: existingId, creationKey });
  }

  return (
    <div className="flex flex-col gap-4">
      <OfflineNotice />
      {message ? <FormAlert>{message}</FormAlert> : null}

      {duplicates.length > 0 ? (
        <div
          role="alert"
          data-testid="duplicate-warning"
          className="flex flex-col gap-3 rounded-lg bg-warning-soft p-4 text-sm text-fg"
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
                  data-testid="use-existing-customer"
                  disabled={pending}
                  onClick={() => chooseExisting(duplicate.id)}
                  className="inline-flex min-h-11 items-center font-semibold text-accent underline underline-offset-4 disabled:opacity-50"
                >
                  Usar a {duplicate.displayName}
                </button>
              </li>
            ))}
          </ul>
          <p className="text-fg-muted">
            Puedes usar el cliente que ya existe o guardar uno nuevo de todos modos.
          </p>
        </div>
      ) : null}

      <form
        data-testid="convert-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) createWithNewCustomer();
        }}
        className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6"
      >
        <h2 className="text-lg">Cliente</h2>

        <fieldset className="flex flex-col gap-2" disabled={pending}>
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
          {initial.company !== "" && initial.company !== displayName ? (
            <button
              type="button"
              data-testid="use-company-name"
              onClick={() => {
                setKind("company");
                setDisplayName(initial.company);
              }}
              className="inline-flex min-h-11 w-fit items-center text-left text-sm font-semibold text-accent underline underline-offset-4"
            >
              Cotizar a la empresa «{initial.company}»
            </button>
          ) : null}
        </fieldset>

        <Field
          label={kind === "company" ? "Razón social" : "Nombre"}
          error={fieldErrors.displayName}
          required
        >
          {(control) => (
            <Input
              {...control}
              name="displayName"
              autoComplete="off"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={CUSTOMER_NAME_MAX_LENGTH}
              disabled={pending}
              required
            />
          )}
        </Field>
        <Field label="RUT (opcional)" error={fieldErrors.rut}>
          {(control) => (
            <Input
              {...control}
              name="rut"
              autoComplete="off"
              value={rut}
              onChange={(event) => setRut(event.target.value)}
              disabled={pending}
            />
          )}
        </Field>
        <Field label="Correo (opcional)" error={fieldErrors.email}>
          {(control) => (
            <Input
              {...control}
              name="email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={pending}
            />
          )}
        </Field>
        <Field label="Teléfono (opcional)" error={fieldErrors.phone}>
          {(control) => (
            <Input
              {...control}
              name="phone"
              type="tel"
              autoComplete="off"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              disabled={pending}
            />
          )}
        </Field>
        <Field label="Dirección (opcional)" error={fieldErrors.address}>
          {(control) => (
            <Input
              {...control}
              name="address"
              autoComplete="off"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              maxLength={CUSTOMER_ADDRESS_MAX_LENGTH}
              disabled={pending}
            />
          )}
        </Field>

        <div className="flex flex-col-reverse gap-3 md:flex-row md:justify-end">
          <Link
            href={requestPath}
            className={cn(buttonVariants({ variant: "secondary", size: "lg" }))}
          >
            Cancelar
          </Link>
          <Button type="submit" size="lg" data-testid="convert-submit" disabled={pending}>
            {pending ? <Loader2 aria-hidden className="animate-spin" /> : <FilePlus2 aria-hidden />}
            {pending
              ? "Creando…"
              : duplicates.length > 0
                ? "Guardar cliente nuevo y crear cotización"
                : "Crear cotización"}
          </Button>
        </div>
      </form>
    </div>
  );
}
