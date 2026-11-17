"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FormAlert, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { useResultToast } from "@/components/ui/use-result-toast";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/auth/form-state";
import { setCatalogItemActiveAction, updateCatalogItemAction } from "@/lib/catalog/actions";
import { CatalogFields } from "../catalog-fields";

export type EditableItem = {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  unitPriceClp: string;
  taxTreatment: string;
  /** `"1"` si el precio está bloqueado; vacío si no (como lo manda la casilla). */
  priceLocked: string;
};

export function EditCatalogItemForm({ tenantId, item }: { tenantId: string; item: EditableItem }) {
  const [state, formAction] = useActionState(
    (previous: FormState, formData: FormData) =>
      updateCatalogItemAction(tenantId, item.id, previous, formData),
    INITIAL_FORM_STATE,
  );
  useResultToast(state);
  const errors = state.fieldErrors ?? {};
  // Si hubo error se conserva lo que la persona escribió; si no, se parte de lo guardado.
  const values = state.status === "error" && state.values ? state.values : item;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <OfflineNotice />
      {state.status === "error" && state.message ? <FormAlert>{state.message}</FormAlert> : null}

      <CatalogFields errors={errors} values={values} />

      <SubmitButton pendingLabel="Guardando…">Guardar cambios</SubmitButton>
    </form>
  );
}

export function ToggleActiveForm({
  tenantId,
  itemId,
  isActive,
}: {
  tenantId: string;
  itemId: string;
  isActive: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    () => setCatalogItemActiveAction(tenantId, itemId, !isActive),
    INITIAL_FORM_STATE,
  );
  useResultToast(state, { errors: true });

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Button
        type="submit"
        size="lg"
        variant={isActive ? "danger" : "secondary"}
        disabled={pending}
        aria-disabled={pending}
      >
        {isActive ? "Desactivar servicio" : "Reactivar servicio"}
      </Button>
    </form>
  );
}
