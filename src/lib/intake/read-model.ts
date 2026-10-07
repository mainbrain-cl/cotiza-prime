import { z } from "zod";
import type { FieldModes, QuantityMode } from "./field-modes";

/**
 * Lo que devuelve la base al leer un formulario público (`intake_form_read`) y lo que de eso viaja al
 * navegador. Son dos cosas distintas a propósito: la base le entrega al servidor identificadores internos
 * (organización, formulario) que NUNCA salen al público (PROYECTO.md §13.10). Lo que llega a la pantalla
 * se arma con una lista blanca de campos en `public-view.ts`.
 */

/** Forma del identificador público de un formulario: 22 caracteres, 128 bits al azar (migración 29). */
export const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export const isWellFormedPublicId = (value: unknown): value is string =>
  typeof value === "string" && PUBLIC_ID_PATTERN.test(value);

const fieldModeSchema = z.enum(["off", "optional", "required"]);

const fieldsSchema = z.object({
  phone: fieldModeSchema,
  company: fieldModeSchema,
  comuna: fieldModeSchema,
  serviceAddress: fieldModeSchema,
  desiredDate: fieldModeSchema,
  message: fieldModeSchema,
});

const orgSchema = z.object({
  name: z.string().min(1).max(200),
  contact_email: z.string().max(254).nullable(),
  contact_phone: z.string().max(60).nullable(),
});

const baseSchema = {
  tenant_id: z.uuid(),
  form_id: z.uuid(),
  title: z.string(),
  org: orgSchema,
  brand: z.object({
    primary_color: z.string().nullable(),
    secondary_color: z.string().nullable(),
  }),
  logo_path: z.string().max(300).nullable(),
  /**
   * Sitios autorizados para incrustar (H-093). Solo lo lee `readFrameAncestors`; nunca llega al navegador.
   * La base lo entrega con el formulario publicado y también en pausa (migración 35), para que el marco muestre
   * el aviso. Opcional aquí a propósito: sin la lista, ningún sitio puede enmarcarlo.
   */
  embed_origins: z.array(z.string()).max(50).optional(),
};

const itemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  unit: z.string(),
  quantity_mode: z.enum(["none", "optional", "required"]),
  min_qty_milli: z.number().int().nullable(),
  max_qty_milli: z.number().int().nullable(),
});

export const intakeFormReadSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_found") }),
  z.object({ state: z.literal("paused"), ...baseSchema }),
  z.object({
    state: z.literal("ok"),
    ...baseSchema,
    revision: z.number().int().min(0),
    intro: z.string(),
    success_message: z.string(),
    fields: fieldsSchema,
    privacy_policy_url: z.string().nullable(),
    items: z.array(itemSchema).max(100),
  }),
]);

export type IntakeOrganizationContact = {
  name: string;
  email: string | null;
  phone: string | null;
};

export type IntakeFormItem = {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  quantityMode: QuantityMode;
  minQtyMilli: number | null;
  maxQtyMilli: number | null;
};

/** Datos internos que el servidor recibe de la base. NO se envían tal cual al navegador. */
export type IntakeFormInternal = {
  tenantId: string;
  formId: string;
  title: string;
  organization: IntakeOrganizationContact;
  primaryColor: string | null;
  secondaryColor: string | null;
  logoPath: string | null;
};

export type IntakeFormReadResult =
  | { state: "not_found" }
  | ({ state: "paused" } & IntakeFormInternal)
  | ({
      state: "ok";
      revision: number;
      intro: string;
      successMessage: string;
      fields: FieldModes;
      privacyPolicyUrl: string | null;
      items: IntakeFormItem[];
    } & IntakeFormInternal);

export type IntakeFormAvailable = Extract<IntakeFormReadResult, { state: "ok" }>;
