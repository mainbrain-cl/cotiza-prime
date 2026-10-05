"use client";

import { CheckCircle2 } from "lucide-react";
import { useActionState, useState } from "react";
import { Field, FormAlert, Input, Select, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";
import { formatRut, isValidRut } from "@/lib/rut";
import { updateCompanyAction } from "@/lib/tenant/actions";
import { CONTACT_PHONE_MAX_LENGTH, INDUSTRIES, TENANT_NAME_MAX_LENGTH } from "@/lib/tenant/schemas";

const RUT_ERROR = "El RUT no es válido. Revisa el número y el dígito verificador.";

export type CompanyValues = {
  name: string;
  rut: string;
  industry: string;
  contactEmail: string;
  contactPhone: string;
};

export function CompanyForm({
  tenantId,
  initial,
  canEdit,
}: {
  tenantId: string;
  initial: CompanyValues;
  canEdit: boolean;
}) {
  const [state, formAction] = useActionState(
    updateCompanyAction.bind(null, tenantId),
    INITIAL_FORM_STATE,
  );
  const [values, setValues] = useState<CompanyValues>(initial);
  const [rutError, setRutError] = useState<string | undefined>();
  const errors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  const set = (field: keyof CompanyValues) => (value: string) =>
    setValues((previous) => ({ ...previous, [field]: value }));

  // Aviso inmediato en el navegador; el servidor vuelve a validar y es quien manda.
  function checkRut(value: string) {
    if (value.trim() === "") return setRutError(undefined);
    if (isValidRut(value)) {
      set("rut")(formatRut(value));
      setRutError(undefined);
    } else {
      setRutError(RUT_ERROR);
    }
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <OfflineNotice />
      {state.status === "error" && state.message ? <FormAlert>{state.message}</FormAlert> : null}
      {state.status === "saved" ? (
        <FormAlert tone="success">
          <span className="inline-flex items-center gap-2" data-testid="company-saved">
            <CheckCircle2 aria-hidden className="size-4" />
            Guardamos los datos de tu empresa.
          </span>
        </FormAlert>
      ) : null}

      <Field label="Nombre de la empresa" error={errors.name} required>
        {(control) => (
          <Input
            {...control}
            name="name"
            autoComplete="organization"
            value={values.name}
            onChange={(event) => set("name")(event.target.value)}
            maxLength={TENANT_NAME_MAX_LENGTH}
            disabled={!canEdit}
            required
          />
        )}
      </Field>

      <Field
        label="RUT de la empresa"
        error={rutError ?? errors.rut}
        hint="Por ejemplo, 76.123.456-0"
        required
      >
        {(control) => (
          <Input
            {...control}
            name="rut"
            inputMode="text"
            autoComplete="off"
            value={values.rut}
            onChange={(event) => {
              set("rut")(event.target.value);
              setRutError(undefined);
            }}
            onBlur={(event) => checkRut(event.target.value)}
            disabled={!canEdit}
            required
          />
        )}
      </Field>

      <Field label="Rubro" error={errors.industry} required>
        {(control) => (
          <Select
            {...control}
            name="industry"
            value={values.industry}
            onChange={(event) => set("industry")(event.target.value)}
            disabled={!canEdit}
            required
          >
            <option value="" disabled>
              Elige un rubro
            </option>
            {INDUSTRIES.map((industry) => (
              <option key={industry.value} value={industry.value}>
                {industry.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label="Correo de contacto (opcional)" error={errors.contactEmail}>
        {(control) => (
          <Input
            {...control}
            name="contactEmail"
            type="email"
            inputMode="email"
            autoComplete="off"
            value={values.contactEmail}
            onChange={(event) => set("contactEmail")(event.target.value)}
            disabled={!canEdit}
          />
        )}
      </Field>

      <Field label="Teléfono de contacto (opcional)" error={errors.contactPhone}>
        {(control) => (
          <Input
            {...control}
            name="contactPhone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={values.contactPhone}
            onChange={(event) => set("contactPhone")(event.target.value)}
            maxLength={CONTACT_PHONE_MAX_LENGTH}
            disabled={!canEdit}
          />
        )}
      </Field>

      {canEdit ? (
        <div>
          <SubmitButton pendingLabel="Guardando…">Guardar datos</SubmitButton>
        </div>
      ) : (
        <FormAlert tone="warning">
          Solo el Dueño o un Administrador puede cambiar los datos de la empresa.
        </FormAlert>
      )}
    </form>
  );
}
