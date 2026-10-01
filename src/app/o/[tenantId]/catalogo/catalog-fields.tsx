import { Field, Input, Select } from "@/components/ui/form-controls";
import {
  CATALOG_DESCRIPTION_MAX_LENGTH,
  CATALOG_NAME_MAX_LENGTH,
  CATALOG_UNITS,
  TAX_TREATMENTS,
} from "@/lib/catalog/schemas";

const TEXTAREA_CLASS =
  "min-h-20 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-fg shadow-1 outline-none transition-[border-color,box-shadow] duration-(--dur-fast) ease-ios placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-danger";

/** Los campos de un servicio, iguales al agregar y al editar. */
export function CatalogFields({
  errors,
  values,
}: {
  errors: Record<string, string>;
  values?: Record<string, string | null | undefined>;
}) {
  return (
    <>
      <Field label="Nombre" error={errors.name} required>
        {(control) => (
          <Input
            {...control}
            name="name"
            autoComplete="off"
            defaultValue={values?.name ?? undefined}
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
            defaultValue={values?.description ?? undefined}
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
              defaultValue={values?.unitPriceClp ?? undefined}
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
    </>
  );
}
