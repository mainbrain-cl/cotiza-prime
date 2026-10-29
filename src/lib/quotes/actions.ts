"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/lib/auth/form-state";
import { fieldErrorsOf } from "@/lib/auth/schemas";
import { listCustomers, type DuplicateMatch } from "@/lib/customers/queries";
import { customerSchema } from "@/lib/customers/schemas";
import { createCustomer } from "@/lib/customers/service";
import { serverLog } from "@/lib/log/server-log";
import { NO_PERMISSION_MESSAGE } from "@/lib/permissions/matrix";
import { requirePermission } from "@/lib/permissions/require";
import { requireActiveTenant, type ActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid, tenantPath } from "@/lib/tenant/constants";
import { calculateQuote } from "./calc";
import {
  listQuotableCatalogItems,
  QUOTABLE_SEARCH_MAX_LENGTH,
  type QuotableCatalogItem,
} from "./catalog-source";
import { toCustomerChoices, type CustomerChoice } from "./customer-choice";
import { calcIssueFieldErrors, toCalcInput, toSaveRpcArgs } from "./payload";
import { payloadFieldErrors, saveQuotePayloadSchema } from "./schemas";

const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";
const SQLSTATE_NOT_FOUND = "CP404";
const SQLSTATE_REVISION_CONFLICT = "CP409";
const SQLSTATE_INVALID = "CP422";
const SQLSTATE_NOT_EDITABLE = "CP423";
const SQLSTATE_CALC_MISMATCH = "CP500";

const NO_PERMISSION_CREATE = NO_PERMISSION_MESSAGE;
const CREATE_FAILED = "No pudimos crear la cotización. Intenta de nuevo en unos minutos.";
const CONFLICT_MESSAGE =
  "Esta cotización cambió en otra pestaña. Recarga para ver la última versión.";

// ---------------------------------------------------------------------------------------------
// Guardar el borrador (H-026)
// ---------------------------------------------------------------------------------------------

export type SaveQuoteResult =
  | { status: "saved"; revision: number }
  | { status: "conflict"; message: string }
  | { status: "not_editable"; message: string }
  | { status: "forbidden"; message: string }
  | { status: "not_found"; message: string }
  | { status: "invalid"; message: string; fieldErrors: Record<string, string> }
  | { status: "error"; message: string };

const SAVE_FAILED = "No pudimos guardar los cambios. Intenta de nuevo en unos minutos.";

function invalidMessage(rpcMessage: string): string {
  if (rpcMessage.startsWith("catalog_item_unavailable")) {
    return "Un servicio de la cotización ya no está disponible en el catálogo. Quítalo o usa una línea libre.";
  }
  if (rpcMessage.startsWith("catalog_item_changed")) {
    return "El servicio cambió en el catálogo; vuelve a agregarlo.";
  }
  if (rpcMessage.startsWith("validity_in_past")) {
    return "La fecha de vigencia no puede estar en el pasado.";
  }
  if (rpcMessage.startsWith("customer_not_found") || rpcMessage.startsWith("invalid_customer")) {
    return "El cliente ya no está disponible. Elige otro.";
  }
  return "Revisa los datos de la cotización e intenta de nuevo.";
}

async function mapSaveError(error: { code?: string; message?: string }): Promise<SaveQuoteResult> {
  switch (error.code) {
    case SQLSTATE_REVISION_CONFLICT:
      return { status: "conflict", message: CONFLICT_MESSAGE };
    case SQLSTATE_NOT_EDITABLE:
      return { status: "not_editable", message: "Esta cotización ya no se puede editar." };
    case SQLSTATE_INSUFFICIENT_PRIVILEGE:
      return { status: "forbidden", message: "Solo quien creó este borrador puede editarlo." };
    case SQLSTATE_NOT_FOUND:
      return { status: "not_found", message: "No encontramos esta cotización." };
    case SQLSTATE_INVALID: {
      const message = error.message ?? "";
      return {
        status: "invalid",
        message: invalidMessage(message),
        fieldErrors: message.startsWith("validity_in_past")
          ? { validity: "La fecha de vigencia no puede estar en el pasado." }
          : {},
      };
    }
    case SQLSTATE_CALC_MISMATCH:
      // El cálculo de la aplicación y el de la base no coinciden: error grave, sin datos personales.
      await serverLog("error", "quote_calc_mismatch", { code: error.code });
      return {
        status: "error",
        message:
          "No pudimos confirmar los totales de esta cotización, así que no se guardó nada. Ya avisamos al equipo.",
      };
    default:
      await serverLog("error", "quote_save_failed", { code: error.code });
      return { status: "error", message: SAVE_FAILED };
  }
}

/**
 * H-026: guarda el borrador. Orden: organización activa → rol → zod (forma y rangos) → cálculo en el
 * servidor → función de la base, que recalcula, compara y guarda en un solo paso. La pantalla puede
 * mostrar totales al escribir, pero lo guardado lo calcula el servidor y lo comprueba la base.
 */
export async function saveQuoteDraftAction(
  tenantId: string,
  quoteId: string,
  payload: unknown,
): Promise<SaveQuoteResult> {
  const active = await requireActiveTenant(tenantId);
  if (!isUuid(quoteId)) {
    return { status: "not_found", message: "No encontramos esta cotización." };
  }
  // Revisión gruesa (¿puede editar cotizaciones?); que sea SU borrador lo exige la base de datos.
  const denied = requirePermission(active, "quote.edit");
  if (denied) return { status: "forbidden", message: denied };

  const parsed = saveQuotePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      status: "invalid",
      message: "Revisa los datos marcados.",
      fieldErrors: payloadFieldErrors(parsed.error),
    };
  }

  // La tasa de IVA queda congelada en la cotización al crearla: se lee de ahí, no del navegador.
  const { data: quote, error: readError } = await active.supabase
    .from("quotes")
    .select("tax_rate_bp")
    .eq("tenant_id", active.tenantId)
    .eq("id", quoteId)
    .maybeSingle();
  if (readError) {
    await serverLog("error", "quote_read_failed", { code: readError.code });
    return { status: "error", message: SAVE_FAILED };
  }
  if (!quote) return { status: "not_found", message: "No encontramos esta cotización." };

  const calc = calculateQuote(
    toCalcInput(parsed.data, (quote as { tax_rate_bp: number }).tax_rate_bp),
  );
  if (!calc.ok) {
    return {
      status: "invalid",
      message: "Revisa los datos marcados.",
      fieldErrors: calcIssueFieldErrors(calc.issues),
    };
  }

  const { data, error } = await active.supabase.rpc(
    "save_quote_draft",
    toSaveRpcArgs(quoteId, parsed.data, calc.totals),
  );
  if (error) return mapSaveError(error);
  const revision = (data as { revision?: number } | null)?.revision;
  if (typeof revision !== "number") {
    await serverLog("error", "quote_save_bad_response");
    return { status: "error", message: SAVE_FAILED };
  }
  return { status: "saved", revision };
}

// ---------------------------------------------------------------------------------------------
// Crear la cotización (H-025)
// ---------------------------------------------------------------------------------------------

export type CreateQuoteResult = { status: "error"; message: string };

type CreateOutcome = { ok: true; quoteId: string } | { ok: false; message: string };

async function callCreateQuote(
  active: ActiveTenant,
  customerId: string,
  creationKey: string,
): Promise<CreateOutcome> {
  if (!isUuid(customerId) || !isUuid(creationKey)) {
    return { ok: false, message: CREATE_FAILED };
  }
  const { data, error } = await active.supabase.rpc("create_quote", {
    p_customer_id: customerId,
    p_creation_key: creationKey,
  });
  if (error) {
    if (error.code === SQLSTATE_NOT_FOUND) {
      return { ok: false, message: "Ese cliente ya no está disponible. Elige otro." };
    }
    if (error.code === SQLSTATE_INVALID) {
      // La misma clave de creación con otro cliente: la pantalla genera una clave nueva y reintenta.
      return { ok: false, message: "No pudimos crear la cotización. Intenta de nuevo." };
    }
    if (error.code === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
      return { ok: false, message: NO_PERMISSION_CREATE };
    }
    await serverLog("error", "quote_create_failed", { code: error.code });
    return { ok: false, message: CREATE_FAILED };
  }
  const row = (data as { quote_id: string }[] | null)?.[0];
  if (!row) {
    await serverLog("error", "quote_create_bad_response");
    return { ok: false, message: CREATE_FAILED };
  }
  return { ok: true, quoteId: row.quote_id };
}

/**
 * H-025: crea el borrador para un cliente ya elegido y abre el editor. La clave de creación la genera
 * la pantalla una vez: un doble clic o un reintento devuelve la misma cotización, sin gastar otro número.
 */
export async function createQuoteAction(
  tenantId: string,
  customerId: string,
  creationKey: string,
): Promise<CreateQuoteResult> {
  const active = await requireActiveTenant(tenantId);
  const denied = requirePermission(active, "quote.create");
  if (denied) return { status: "error", message: denied };
  const outcome = await callCreateQuote(active, customerId, creationKey);
  if (!outcome.ok) return { status: "error", message: outcome.message };
  redirect(tenantPath(active.tenantId, `cotizaciones/${outcome.quoteId}`));
}

export type QuoteCustomerFormState = FormState & {
  duplicates?: DuplicateMatch[];
  /** El cliente se creó pero la cotización no: el reintento solo crea la cotización. */
  createdCustomerId?: string;
};

const CUSTOMER_FIELDS = ["kind", "displayName", "rut", "email", "phone", "address"] as const;

function readText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * H-025: crea el cliente desde el diálogo (sin salir de la cotización) y, enseguida, el borrador.
 * Comparte con la pantalla de clientes el mismo núcleo (cifrado y aviso de duplicados).
 */
export async function createCustomerAndQuoteAction(
  tenantId: string,
  creationKey: string,
  _previous: QuoteCustomerFormState,
  formData: FormData,
): Promise<QuoteCustomerFormState> {
  const active = await requireActiveTenant(tenantId);
  const raw = Object.fromEntries(CUSTOMER_FIELDS.map((name) => [name, readText(formData, name)]));
  const denied = requirePermission(active, "quote.create");
  if (denied) return { status: "error", message: denied, values: raw };
  // Reintento: el cliente ya se había creado y solo falló la cotización. No se crea otro cliente
  // (ni se avisa de un "duplicado" de sí mismo): solo se vuelve a pedir la cotización.
  const alreadyCreated = readText(formData, "createdCustomerId");
  if (isUuid(alreadyCreated)) {
    const retry = await callCreateQuote(active, alreadyCreated, creationKey);
    if (!retry.ok) {
      return {
        status: "error",
        message: retry.message,
        values: raw,
        createdCustomerId: alreadyCreated,
      };
    }
    redirect(tenantPath(active.tenantId, `cotizaciones/${retry.quoteId}`));
  }

  const parsed = customerSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  }
  const created = await createCustomer(
    active,
    parsed.data,
    readText(formData, "confirmDuplicate") === "1",
  );
  if (!created.ok) {
    if (created.reason === "duplicates") {
      return { status: "error", duplicates: created.duplicates, values: raw };
    }
    return { status: "error", message: created.message, values: raw };
  }
  const outcome = await callCreateQuote(active, created.id, creationKey);
  if (!outcome.ok) {
    return {
      status: "error",
      message: `Guardamos al cliente, pero no pudimos crear la cotización. ${outcome.message}`,
      values: raw,
      createdCustomerId: created.id,
    };
  }
  redirect(tenantPath(active.tenantId, `cotizaciones/${outcome.quoteId}`));
}

/** Busca clientes para elegirlos en una cotización (nombre por partes; RUT y correo, completos). */
export async function searchQuoteCustomersAction(
  tenantId: string,
  term: string,
): Promise<CustomerChoice[]> {
  const active = await requireActiveTenant(tenantId);
  if (requirePermission(active, "quote.create")) return [];
  const page = await listCustomers(active, {
    search: typeof term === "string" ? term.slice(0, QUOTABLE_SEARCH_MAX_LENGTH) : "",
    page: 1,
  });
  if (!page) return [];
  return toCustomerChoices(page.items);
}

/** Busca servicios del catálogo para agregarlos como línea (solo activos, hasta 20). */
export async function searchQuoteCatalogAction(
  tenantId: string,
  term: string,
): Promise<QuotableCatalogItem[]> {
  const active = await requireActiveTenant(tenantId);
  if (requirePermission(active, "quote.edit")) return [];
  return listQuotableCatalogItems(active, typeof term === "string" ? term : "");
}
