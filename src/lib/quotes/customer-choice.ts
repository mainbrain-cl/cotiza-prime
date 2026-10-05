import { maskEmail, maskRut } from "@/lib/customers/mask";
import type { CustomerListItem } from "@/lib/customers/queries";

/** Un cliente tal como se ofrece al elegirlo en una cotización: datos personales siempre enmascarados. */
export type CustomerChoice = {
  id: string;
  displayName: string;
  kind: string;
  maskedRut: string | null;
  maskedEmail: string | null;
};

export function toCustomerChoices(items: CustomerListItem[]): CustomerChoice[] {
  return items.map((item) =>
    item.ok
      ? {
          id: item.customer.id,
          displayName: item.customer.displayName,
          kind: item.customer.kind,
          maskedRut: item.customer.rut ? maskRut(item.customer.rut) : null,
          maskedEmail: item.customer.email ? maskEmail(item.customer.email) : null,
        }
      : {
          id: item.id,
          displayName: item.displayName,
          kind: "person",
          maskedRut: null,
          maskedEmail: null,
        },
  );
}
