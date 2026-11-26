"use client";

import { useActionState, useState } from "react";
import { Field, FormAlert, Input, Select, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { useResultToast } from "@/components/ui/use-result-toast";
import { saveBankAccountAction, type BankAccountFormState } from "@/lib/payments/actions";
import { ACCOUNT_TYPES, BANKS, type BankDetails } from "@/lib/payments/bank";
import { formatRut, isValidRut } from "@/lib/rut";

const INITIAL_STATE: BankAccountFormState = { status: "idle" };
const RUT_ERROR = "El RUT no es válido. Revisa el número y el dígito verificador.";

type Values = Record<keyof BankDetails, string>;

const EMPTY: Values = {
  bank: "",
  accountType: "",
  accountNumber: "",
  holderName: "",
  holderRut: "",
  email: "",
};

export function BankAccountForm({
  tenantId,
  bankAccountId,
  revision,
  initial,
}: {
  tenantId: string;
  bankAccountId: string | null;
  revision: number;
  initial: BankDetails | null;
}) {
  const [state, formAction] = useActionState(
    saveBankAccountAction.bind(null, tenantId),
    INITIAL_STATE,
  );
  useResultToast(state);
  const [values, setValues] = useState<Values>(
    initial ? { ...initial, holderRut: formatRut(initial.holderRut) } : EMPTY,
  );
  const [rutError, setRutError] = useState<string | undefined>();
  const errors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  const set = (field: keyof Values) => (value: string) =>
    setValues((previous) => ({ ...previous, [field]: value }));
  // Tras guardar, la revisión nueva; antes, la que trajo la pantalla.
  const expectedRevision = state.status === "saved" && state.revision ? state.revision : revision;
  const currentId =
    state.status === "saved" && state.bankAccountId ? state.bankAccountId : bankAccountId;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <OfflineNotice />
      <input type="hidden" name="expectedRevision" value={expectedRevision} />
      <input type="hidden" name="bankAccountId" value={currentId ?? ""} />
      {state.status === "error" && state.message ? <FormAlert>{state.message}</FormAlert> : null}

      <Field label="Banco" error={errors.bank} required>
        {(control) => (
          <Select
            {...control}
            name="bank"
            value={values.bank}
            onChange={(event) => set("bank")(event.target.value)}
            required
          >
            <option value="" disabled>
              Elige el banco
            </option>
            {BANKS.map((bank) => (
              <option key={bank} value={bank}>
                {bank}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label="Tipo de cuenta" error={errors.accountType} required>
        {(control) => (
          <Select
            {...control}
            name="accountType"
            value={values.accountType}
            onChange={(event) => set("accountType")(event.target.value)}
            required
          >
            <option value="" disabled>
              Elige el tipo de cuenta
            </option>
            {Object.entries(ACCOUNT_TYPES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label="Número de cuenta" error={errors.accountNumber} required>
        {(control) => (
          <Input
            {...control}
            name="accountNumber"
            inputMode="numeric"
            autoComplete="off"
            className="font-mono"
            value={values.accountNumber}
            onChange={(event) => set("accountNumber")(event.target.value)}
            maxLength={26}
            required
          />
        )}
      </Field>

      <Field label="Titular de la cuenta" error={errors.holderName} required>
        {(control) => (
          <Input
            {...control}
            name="holderName"
            autoComplete="off"
            value={values.holderName}
            onChange={(event) => set("holderName")(event.target.value)}
            maxLength={100}
            required
          />
        )}
      </Field>

      <Field
        label="RUT del titular"
        error={rutError ?? errors.holderRut}
        hint="Por ejemplo, 76.123.456-0"
        required
      >
        {(control) => (
          <Input
            {...control}
            name="holderRut"
            autoComplete="off"
            className="font-mono"
            value={values.holderRut}
            onChange={(event) => {
              set("holderRut")(event.target.value);
              setRutError(undefined);
            }}
            onBlur={(event) => {
              const value = event.target.value;
              if (value.trim() === "") return;
              if (isValidRut(value)) set("holderRut")(formatRut(value));
              else setRutError(RUT_ERROR);
            }}
            required
          />
        )}
      </Field>

      <Field
        label="Correo para avisar la transferencia"
        error={errors.email}
        hint="Tus clientes lo verán junto a los datos, para enviarte el comprobante."
        required
      >
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="off"
            value={values.email}
            onChange={(event) => set("email")(event.target.value)}
            maxLength={254}
            required
          />
        )}
      </Field>

      <SubmitButton pendingLabel="Guardando…" className="w-full md:w-fit" data-testid="bank-save">
        Guardar datos de transferencia
      </SubmitButton>
    </form>
  );
}
