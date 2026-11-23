import { z } from "zod";
import { PDF_PAPER_SIZES } from "@/lib/pdf/types";

/**
 * Forma de lo que el portero (`gateway.ts`) recibe de `share_link_read` (H-030). Se valida entera:
 * la copia congelada del paquete viene de la base, pero la pantalla del cliente nunca dibuja nada
 * que no calce con esta forma. Los textos ya vienen formateados (son los mismos que dibuja el PDF).
 */

const text = z.string().max(5_000);
const nullableText = text.nullable();

const brandSchema = z.object({
  primary: z.string(),
  secondary: z.string(),
  primaryText: z.string(),
  onPrimary: z.string(),
  primaryTint: z.string(),
});

const lineSchema = z.object({
  name: text,
  description: nullableText,
  exempt: z.boolean(),
  quantity: text,
  unit: text,
  unitPrice: text,
  discount: text,
  total: text,
});

const totalsSchema = z.object({
  subtotal: text,
  globalDiscount: nullableText,
  netTaxable: text,
  exempt: nullableText,
  taxLabel: text,
  tax: text,
  total: text,
});

/** La copia congelada del documento: sin logo y sin datos del cliente (van aparte). */
export const documentSnapshotSchema = z.object({
  paper: z.enum(PDF_PAPER_SIZES),
  brand: brandSchema,
  organization: z.object({ name: text, detailLines: z.array(text).max(20) }),
  quote: z.object({
    number: text,
    versionLabel: nullableText,
    issueDate: text,
    validUntil: nullableText,
    validityNote: nullableText,
  }),
  preparedBy: z.object({ name: text, detailLines: z.array(text).max(20) }),
  lines: z.array(lineSchema).max(1_000),
  totals: totalsSchema,
  observations: nullableText,
  conditions: nullableText,
  // H-048b: opcionales. Una cotización enviada ANTES de H-048b no trae estas claves y tiene que seguir abriendo para su cliente
  // (si fueran obligatorias, toda copia antigua dejaría de pasar la validación). Faltan = vacíos.
  exclusions: nullableText.optional().default(null),
  footerNote: nullableText.optional().default(null),
  paymentTerms: nullableText,
});

export type ShareDocument = z.infer<typeof documentSnapshotSchema>;

export const contactSchema = z.object({
  name: z.string().max(200),
  detail_lines: z.array(z.string().max(500)).max(20),
});

export type ShareContact = { name: string; detailLines: string[] };

/** Datos del cliente tal como se congelaron al enviar (descifrados solo en el servidor). */
export const customerSnapshotSchema = z.object({
  kind: z.string().optional(),
  name: z.string(),
  rut: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
});

export type ShareCustomer = z.infer<typeof customerSnapshotSchema>;

const responseSchema = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
    responded_at: z.string(),
    reason_code: z.string().nullable().optional(),
  })
  .nullable();

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** Estados en que el enlace ya no muestra la cotización: solo el contacto de la organización. */
export const SHARE_UNAVAILABLE_STATES = ["expired", "revoked", "superseded"] as const;
export type ShareUnavailableState = (typeof SHARE_UNAVAILABLE_STATES)[number];

export const shareReadSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_found") }),
  z.object({ state: z.literal("expired"), org_contact: contactSchema }),
  z.object({ state: z.literal("revoked"), org_contact: contactSchema }),
  z.object({ state: z.literal("superseded"), org_contact: contactSchema }),
  z.object({
    state: z.enum(["ok", "responded"]),
    org_contact: contactSchema,
    tenant_id: uuid,
    quote_id: uuid,
    package_id: uuid,
    share_link_id: uuid,
    quote_status: z.string(),
    valid_until: z.string().nullable(),
    response: responseSchema,
    document_snapshot: documentSnapshotSchema,
    customer_snapshot_enc: z.string().nullable(),
    pdf_path: z.string().nullable(),
    pdf_sha256: z.string().nullable(),
    logo_path: z.string().nullable(),
  }),
]);

/** Lo que el enlace deja ver cuando la cotización está disponible. */
export type ShareAvailable = {
  state: "ok" | "responded";
  contact: ShareContact;
  tenantId: string;
  quoteId: string;
  packageId: string;
  shareLinkId: string;
  quoteStatus: string;
  validUntil: string | null;
  response: { decision: "accepted" | "rejected"; respondedAt: string } | null;
  document: ShareDocument;
  customerSnapshotEnc: string | null;
  pdfPath: string | null;
  pdfSha256: string | null;
  logoPath: string | null;
};

export type ShareReadResult =
  { state: "not_found" } | { state: ShareUnavailableState; contact: ShareContact } | ShareAvailable;

/** ¿El enlace muestra la cotización? (`ok`, o `responded` cuando el cliente ya contestó). */
export function isAvailable(link: ShareReadResult): link is ShareAvailable {
  return link.state === "ok" || link.state === "responded";
}
