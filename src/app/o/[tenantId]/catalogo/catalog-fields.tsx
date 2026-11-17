import { Lock } from "lucide-react";
import { Field, Input, Select } from "@/components/ui/form-controls";
import {
  CATALOG_DESCRIPTION_MAX_LENGTH,
  CATALOG_NAME_MAX_LENGTH,
  CATALOG_UNITS,
  TAX_TREATMENTS,
} from "@/lib/catalog/schemas";

const TEXTAREA_CLASS =
  "min-h-20 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-fg shadow-1 outline-none transition-[border-color,box-shadow] duration-(--dur-fast) ease-ios placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-danger";

export const PRICE_LOCK_HELP =
  "Al cotizar, los Comerciales no podrán cambiar este precio. El Dueño y los Administradores sí, y queda registrado.";

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

      <div className="flex flex-col gap-1.5">
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border-strong bg-surface p-3 transition-[border-color,background-color] duration-(--dur-fast) ease-ios hover:bg-surface-2 has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30">
          <input
            type="checkbox"
            name="priceLocked"
            value="1"
            defaultChecked={values?.priceLocked === "1"}
            aria-describedby="price-locked-help"
            aria-invalid={Boolean(errors.priceLocked)}
            data-testid="price-locked"
            className="mt-0.5 size-5 shrink-0 accent-(--accent)"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 font-semibold text-fg">
              <Lock aria-hidden className="size-4" />
              Bloquear el precio
            </span>
            <span id="price-locked-help" className="text-sm text-fg-muted">
              {PRICE_LOCK_HELP}
            </span>
          </span>
        </label>
        {errors.priceLocked ? (
          <p role="alert" className="text-sm text-danger">
            {errors.priceLocked}
          </p>
        ) : null}
      </div>
    </>
  );
}
