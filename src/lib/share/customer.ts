import "server-only";
import { decryptPii } from "@/lib/crypto/pii";
import { serverLog } from "@/lib/log/server-log";
import { formatRut } from "@/lib/rut";
import { customerSnapshotSchema, type ShareAvailable } from "./read-model";

export type ShareCustomerView = { name: string; detailLines: string[] };

const compact = (parts: (string | null | undefined | false)[]): string[] =>
  parts.filter((part): part is string => typeof part === "string" && part.trim() !== "");

/**
 * Los datos del cliente congelados al enviar, descifrados en el servidor. Se arman igual que en el
 * PDF (RUT, dirección, correo, teléfono). Si no se pueden descifrar, la pantalla sigue sin ese
 * bloque y se avisa en el registro (sin datos personales).
 */
export async function readShareCustomer(link: ShareAvailable): Promise<ShareCustomerView | null> {
  if (!link.customerSnapshotEnc) return null;
  try {
    const plain = decryptPii(link.customerSnapshotEnc, {
      table: "quote_packages",
      field: "customer_snapshot",
      tenantId: link.tenantId,
      rowId: link.packageId,
    });
    const customer = customerSnapshotSchema.parse(JSON.parse(plain));
    return {
      name: customer.name,
      detailLines: compact([
        customer.rut && `RUT ${formatRut(customer.rut)}`,
        customer.address,
        customer.email,
        customer.phone,
      ]),
    };
  } catch {
    await serverLog("error", "share_customer_unreadable");
    return null;
  }
}
