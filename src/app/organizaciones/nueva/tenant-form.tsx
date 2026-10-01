"use client";

import { useActionState, useState } from "react";
import { Field, FormAlert, Input, Select, SubmitButton } from "@/components/ui/form-controls";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";
import { formatRut, isValidRut } from "@/lib/rut";
import { createTenantAction } from "@/lib/tenant/actions";
import { CONTACT_PHONE_MAX_LENGTH, INDUSTRIES, TENANT_NAME_MAX_LENGTH } from "@/lib/tenant/schemas";

const RUT_ERROR = "El RUT no es válido. Revisa el número y el dígito verificador.";

export function TenantForm() {
  const [state, formAction] = useActionState(createTenantAction, INITIAL_FORM_STATE);
  const [rut, setRut] = useState(state.values?.rut ?? "");
  const [rutError, setRutError] = useState<string | undefined>();
  const errors = state.fieldErrors ?? {};

  // Aviso inmediato en el navegador; el servidor vuelve a validar y es quien manda.
  function checkRut(value: string) {
    if (value.trim() === "") return setRutError(undefined);
    if (isValidRut(value)) {
      setRut(formatRut(value));
      setRutError(undefined);
    } else {
      setRutError(RUT_ERROR);
    }
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.message ? <FormAlert>{state.message}</FormAlert> : null}

      <Field label="Nombre de la empresa" error={errors.name} required>
        {(control) => (
          <Input
            {...control}
            name="name"
            autoComplete="organization"
            defaultValue={state.values?.name}
            maxLength={TENANT_NAME_MAX_LENGTH}
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
            value={rut}
            onChange={(event) => {
              setRut(event.target.value);
              setRutError(undefined);
            }}
            onBlur={(event) => checkRut(event.target.value)}
            required
          />
        )}
      </Field>

      <Field label="Rubro" error={errors.industry} required>
        {(control) => (
          <Select {...control} name="industry" defaultValue={state.values?.industry ?? ""} required>
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
            defaultValue={state.values?.contactEmail}
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
            defaultValue={state.values?.contactPhone}
            maxLength={CONTACT_PHONE_MAX_LENGTH}
          />
        )}
      </Field>

      <SubmitButton pendingLabel="Creando tu organización…">Crear organización</SubmitButton>
    </form>
  );
}
