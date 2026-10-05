"use client";

import { useActionState } from "react";
import { FormAlert, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { useResultToast } from "@/components/ui/use-result-toast";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/auth/form-state";
import { createCatalogItemAction } from "@/lib/catalog/actions";
import { CatalogFields } from "./catalog-fields";

export function CatalogForm({ tenantId }: { tenantId: string }) {
  const [state, formAction] = useActionState(
    (previous: FormState, formData: FormData) =>
      createCatalogItemAction(tenantId, previous, formData),
    INITIAL_FORM_STATE,
  );
  useResultToast(state);
  const errors = state.fieldErrors ?? {};
  const values = state.status === "error" ? state.values : undefined;
  // Tras guardar con éxito el formulario se vuelve a montar vacío, listo para el siguiente servicio.
  const formKey = state.status === "sent" ? `sent-${state.values?.nonce}` : "editing";

  return (
    <form key={formKey} action={formAction} className="flex flex-col gap-4" noValidate>
      <OfflineNotice />
      {state.status === "error" && state.message ? <FormAlert>{state.message}</FormAlert> : null}

      <CatalogFields errors={errors} values={values} />

      <SubmitButton pendingLabel="Guardando…">Agregar al catálogo</SubmitButton>
    </form>
  );
}
