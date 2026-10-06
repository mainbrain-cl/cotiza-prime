import { createHash } from "node:crypto";
import type { CustomerView } from "@/lib/customers/record";
import type { QuoteDocumentData } from "@/lib/pdf/types";

/**
 * Lo que se congela en la base de datos al enviar (H-029).
 *
 * - `buildDocumentSnapshot`: el modelo del documento SIN el logo (va como archivo aparte) y SIN los
 *   datos del cliente (son personales: van cifrados en `customer_snapshot_enc`). Es lo que más
 *   adelante dibuja la pantalla del cliente, con las mismas cifras que el PDF.
 * - `buildCustomerSnapshot`: nombre, RUT, correo, teléfono y dirección del cliente al enviar.
 * - `contentSha256`: sello del contenido completo del paquete (para saber que lo aprobado y lo
 *   enviado son lo mismo).
 */

export type DocumentSnapshot = Omit<QuoteDocumentData, "customer" | "organization"> & {
  organization: { name: string; detailLines: string[] };
};

export function buildDocumentSnapshot(data: QuoteDocumentData): DocumentSnapshot {
  return {
    paper: data.paper,
    brand: data.brand,
    organization: { name: data.organization.name, detailLines: data.organization.detailLines },
    quote: data.quote,
    preparedBy: data.preparedBy,
    lines: data.lines,
    totals: data.totals,
    observations: data.observations,
    conditions: data.conditions,
    paymentTerms: data.paymentTerms,
  };
}

export function buildCustomerSnapshot(customer: CustomerView): {
  kind: string;
  name: string;
  rut: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
} {
  return {
    kind: customer.kind,
    name: customer.displayName,
    rut: customer.rut,
    email: customer.email,
    phone: customer.phone,
    address: customer.address,
  };
}

export function contentSha256(content: {
  subject: string;
  body: string;
  issueDate: string;
  validUntil: string;
  pdfSha256: string;
  snapshot: DocumentSnapshot;
}): string {
  return createHash("sha256").update(JSON.stringify(content), "utf8").digest("hex");
}
