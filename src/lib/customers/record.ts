import "server-only";
import { decryptPii, encryptPii, type PiiContext } from "@/lib/crypto/pii";
import { searchHash } from "@/lib/crypto/search-hash";
import type { CustomerInput, CustomerKind } from "./schemas";

// Armado y lectura del registro de un cliente. Los datos personales se cifran aquí, en el servidor;
// la base solo guarda texto cifrado y huellas (modelo-datos.md §3.5 y §5).

const TABLE = "customers";

/** Fila tal como se inserta en `customers`. */
export type CustomerInsertRow = {
  id: string;
  tenant_id: string;
  kind: CustomerKind;
  display_name: string;
  email_enc: string | null;
  email_hash: string | null;
  phone_enc: string | null;
  rut_enc: string | null;
  rut_hash: string | null;
  address_enc: string | null;
};

/** Columnas de una fila leída (los datos personales siguen cifrados). */
export type CustomerStoredRow = {
  id: string;
  kind: CustomerKind;
  display_name: string;
  email_enc: string | null;
  phone_enc: string | null;
  rut_enc: string | null;
  address_enc: string | null;
  created_at: string;
};

export type CustomerView = {
  id: string;
  kind: CustomerKind;
  displayName: string;
  email: string | null;
  phone: string | null;
  rut: string | null;
  address: string | null;
  createdAt: string;
};

function context(field: string, tenantId: string, rowId: string): PiiContext {
  return { table: TABLE, field, tenantId, rowId };
}

/** Las huellas de RUT y correo de un cliente (o `null` si no tiene). Nunca salen del servidor. */
export function customerHashes(
  tenantId: string,
  input: Pick<CustomerInput, "rut" | "email">,
): { rutHash: string | null; emailHash: string | null } {
  return {
    rutHash: input.rut ? searchHash("rut", tenantId, input.rut) : null,
    emailHash: input.email ? searchHash("email", tenantId, input.email) : null,
  };
}

/** `input` ya viene validado y normalizado (RUT canónico, correo en minúsculas). */
export function buildCustomerInsertRow(
  input: CustomerInput,
  tenantId: string,
  customerId: string,
): CustomerInsertRow {
  const seal = (field: string, value: string | null) =>
    value === null ? null : encryptPii(value, context(field, tenantId, customerId));
  const { rutHash, emailHash } = customerHashes(tenantId, input);
  return {
    id: customerId,
    tenant_id: tenantId,
    kind: input.kind,
    display_name: input.displayName,
    email_enc: seal("email", input.email),
    email_hash: emailHash,
    phone_enc: seal("phone", input.phone),
    rut_enc: seal("rut", input.rut),
    rut_hash: rutHash,
    address_enc: seal("address", input.address),
  };
}

/** Descifra una fila. Si algún dato no se puede descifrar, lanza `PiiCryptoError` (sin el dato en el mensaje). */
export function decodeCustomer(row: CustomerStoredRow, tenantId: string): CustomerView {
  const open = (field: string, token: string | null) =>
    token === null ? null : decryptPii(token, context(field, tenantId, row.id));
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    email: open("email", row.email_enc),
    phone: open("phone", row.phone_enc),
    rut: open("rut", row.rut_enc),
    address: open("address", row.address_enc),
    createdAt: row.created_at,
  };
}
