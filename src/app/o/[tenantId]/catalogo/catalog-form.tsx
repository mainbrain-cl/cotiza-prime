"use client";

import { useActionState } from "react";
import { Field, FormAlert, Input, Select, SubmitButton } from "@/components/ui/form-controls";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/auth/form-state";
import { createCatalogItemAction } from "@/lib/catalog/actions";
import {
  CATALOG_DESCRIPTION_MAX_LENGTH,
  CATALOG_NAME_MAX_LENGTH,
  CATALOG_UNITS,
  TAX_TREATMENTS,
} from "@/lib/catalog/schemas";

const TEXTAREA_CLASS =
  "min-h-20 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-fg shadow-1 outline-none transition-[border-color,box-shadow] duration-(--dur-fast) ease-ios placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-danger";

export function CatalogForm({ tenantId }: { tenantId: string }) {
  const [state, formAction] = useActionState(
    (previous: FormState, formData: FormData) =>
      createCatalogItemAction(tenantId, previous, formData),
    INITIAL_FORM_STATE,
  );
  const errors = state.fieldErrors ?? {};
  const values = state.status === "error" ? state.values : undefined;
  // Tras guardar con éxito el formulario se vuelve a montar vacío, listo para el siguiente servicio.
  const formKey = state.status === "sent" ? `sent-${state.values?.nonce}` : "editing";

  return (
    <form key={formKey} action={formAction} className="flex flex-col gap-4" noValidate>
      {state.status === "sent" && state.message ? (
        <FormAlert tone="success">{state.message}</FormAlert>
      ) : null}
      {state.status === "error" && state.message ? <FormAlert>{state.message}</FormAlert> : null}

      <Field label="Nombre" error={errors.name} required>
        {(control) => (
          <Input
            {...control}
            name="name"
            autoComplete="off"
            defaultValue={values?.name}
            maxLength={CATALOG_NAME_MAX_LENGTH}
            required
          />
        )}
      </Field>

      <Field label="Descripción (opcional)" error={errors.description}>
        {(control) => (
          <textarea
            {...control}
            name="description"
            className={TEXTAREA_CLASS}
            defaultValue={values?.description}
            maxLength={CATALOG_DESCRIPTION_MAX_LENGTH}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <Field label="Unidad" error={errors.unit} required>
          {(control) => (
            <Select {...control} name="unit" defaultValue={values?.unit ?? "service"} required>
              {CATALOG_UNITS.map((unit) => (
                <option key={unit.value} value={unit.value}>
                  {unit.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="Precio neto (en pesos)"
          error={errors.unitPriceClp}
          hint="Sin IVA y sin decimales. Por ejemplo, 15.000."
          required
        >
          {(control) => (
            <Input
              {...control}
              name="unitPriceClp"
              inputMode="numeric"
              autoComplete="off"
              defaultValue={values?.unitPriceClp}
              required
            />
          )}
        </Field>
      </div>

      <Field label="IVA" error={errors.taxTreatment} required>
        {(control) => (
          <Select
            {...control}
            name="taxTreatment"
            defaultValue={values?.taxTreatment ?? "taxable"}
            required
          >
            {TAX_TREATMENTS.map((tax) => (
              <option key={tax.value} value={tax.value}>
                {tax.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <SubmitButton pendingLabel="Guardando…">Agregar al catálogo</SubmitButton>
    </form>
  );
}
