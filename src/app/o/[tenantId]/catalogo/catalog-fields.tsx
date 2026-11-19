import { Lock } from "lucide-react";
import { useId } from "react";
import { Field, Input, Select } from "@/components/ui/form-controls";
import {
  CATALOG_DESCRIPTION_MAX_LENGTH,
  CATALOG_NAME_MAX_LENGTH,
  CATALOG_UNITS,
  TAX_TREATMENTS,
} from "@/lib/catalog/schemas";
import { priceLockHelp } from "@/lib/quotes/discount-cap";

const TEXTAREA_CLASS =
  "min-h-20 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-fg shadow-1 outline-none transition-[border-color,box-shadow] duration-(--dur-fast) ease-ios placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-danger";

/** Los campos de un servicio, iguales al agregar y al editar. */
export function CatalogFields({
  errors,
  values,
  maxDiscountBp,
}: {
  errors: Record<string, string>;
  values?: Record<string, string | null | undefined>;
  /** El descuento máximo de los Comerciales hoy (`null` = sin tope); `undefined` si no se pudo leer: la ayuda no afirma el valor. */
  maxDiscountBp?: number | null;
}) {
  const helpId = useId();
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
        <div className="rounded-md border border-border-strong bg-surface p-3 transition-[border-color,background-color] duration-(--dur-fast) ease-ios has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30">
          <label className="flex min-h-11 cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              name="priceLocked"
              value="1"
              defaultChecked={values?.priceLocked === "1"}
              aria-describedby={helpId}
              aria-invalid={Boolean(errors.priceLocked)}
              data-testid="price-locked"
              className="size-5 shrink-0 accent-(--accent)"
            />
            <span className="flex items-center gap-1.5 font-semibold text-fg">
              <Lock aria-hidden className="size-4" />
              Bloquear el precio
            </span>
          </label>
          <p id={helpId} data-testid="price-locked-help" className="pl-8 text-sm text-fg-muted">
            {priceLockHelp(maxDiscountBp)}
          </p>
        </div>
        {errors.priceLocked ? (
          <p role="alert" className="text-sm text-danger">
            {errors.priceLocked}
          </p>
        ) : null}
      </div>
    </>
  );
}
