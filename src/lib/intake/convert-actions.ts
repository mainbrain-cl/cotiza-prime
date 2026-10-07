"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fieldErrorsOf } from "@/lib/auth/schemas";
import { buildCustomerInsertRow } from "@/lib/customers/record";
import { findDuplicates, type DuplicateMatch } from "@/lib/customers/queries";
import { CUSTOMER_NO_PERMISSION, CUSTOMER_SAVE_FAILED } from "@/lib/customers/service";
import { serverLog } from "@/lib/log/server-log";
import { requireActiveTenant, type ActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid, tenantPath } from "@/lib/tenant/constants";
import { deriveConvertCustomerId } from "./convert-ids";
import { saveRequestLines } from "./convert-lines";
import {
  CONVERT_ANONYMIZED,
  CONVERT_DISCARDED,
  CONVERT_FORBIDDEN,
  CONVERT_GENERIC_FAILURE,
  CONVERT_NOT_FOUND,
  convertInputSchema,
  customerSchema,
  mapConvertError,
  parseRequestedServices,
  type ConvertErrorKind,
} from "./convert-model";
import { requestPermissions, type RequestStatus } from "./requests-model";

/**
 * Convertir una solicitud en cotización con un clic (H-090). Orden: organización activa → rol → la
 * solicitud (con la sesión, así que una de otra organización «no existe») → el cliente (nuevo, cifrado
 * con el sello de `customers`, o uno existente) → `convert_intake_request` → las líneas del catálogo.
 * El permiso real lo decide la base (`42501`); aquí se revisa antes solo para no dejar un cliente
 * creado de balde. El mensaje del visitante NO se copia a la cotización: queda en la solicitud.
 */

export type ConvertResult = {
  status: "error";
  kind: ConvertErrorKind | "invalid" | "duplicates" | "state";
  message: string;
  fieldErrors?: Record<string, string>;
  duplicates?: DuplicateMatch[];
};

const WRITER_ROLES: readonly string[] = ["owner", "admin", "sales"];
const UNIQUE_VIOLATION = "23505";

function fail(
  kind: ConvertResult["kind"],
  message: string,
  extra: Partial<ConvertResult> = {},
): ConvertResult {
  return { status: "error", kind, message, ...extra };
}

function quotePath(active: ActiveTenant, quoteId: string): string {
  return tenantPath(active.tenantId, `cotizaciones/${quoteId}`);
}

function refresh(active: ActiveTenant) {
  revalidatePath(tenantPath(active.tenantId, "solicitudes"), "layout");
  revalidatePath(tenantPath(active.tenantId), "layout");
}

type RequestRow = {
  status: RequestStatus;
  assigned_to: string | null;
  anonymized_at: string | null;
  quote_id: string | null;
  items: unknown;
};

/**
 * Crea el cliente nuevo con el identificador que generó la pantalla. Si ya existe (doble clic, otra
 * pestaña, un reintento tras un fallo) se reutiliza: nunca se crean dos clientes por una solicitud.
 */
async function ensureNewCustomer(
  active: ActiveTenant,
  customerId: string,
  customer: ReturnType<typeof customerSchema.parse>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data: existing, error: readError } = await active.supabase
    .from("customers")
    .select("id")
    .eq("tenant_id", active.tenantId)
    .eq("id", customerId)
    .maybeSingle();
  if (readError) {
    await serverLog("error", "intake_convert_customer_read_failed", { code: readError.code });
    return { ok: false, message: CUSTOMER_SAVE_FAILED };
  }
  if (existing) return { ok: true };
  const row = buildCustomerInsertRow(customer, active.tenantId, customerId);
  const { error } = await active.supabase.from("customers").insert(row);
  if (!error || error.code === UNIQUE_VIOLATION) return { ok: true };
  await serverLog("error", "customer_insert_failed", { code: error.code });
  return {
    ok: false,
    message: error.code === "42501" ? CUSTOMER_NO_PERMISSION : CUSTOMER_SAVE_FAILED,
  };
}

export async function convertIntakeRequestAction(
  tenantId: string,
  requestId: string,
  rawInput: unknown,
): Promise<ConvertResult> {
  const active = await requireActiveTenant(tenantId);
  if (!WRITER_ROLES.includes(active.role)) return fail("forbidden", CONVERT_FORBIDDEN);
  if (!isUuid(requestId)) return fail("not_found", CONVERT_NOT_FOUND);
  const input = convertInputSchema.safeParse(rawInput);
  if (!input.success) {
    return fail("invalid", "Revisa los datos del cliente e intenta de nuevo.");
  }

  // La solicitud, con la sesión: una de otra organización no se ve (RLS) y se responde como inexistente.
  const { data, error: readError } = await active.supabase
    .from("intake_requests")
    .select("status, assigned_to, anonymized_at, quote_id, items")
    .eq("id", requestId)
    .maybeSingle();
  if (readError) {
    await serverLog("error", "intake_convert_read_failed", { code: readError.code });
    return fail("other", CONVERT_GENERIC_FAILURE);
  }
  if (!data) return fail("not_found", CONVERT_NOT_FOUND);
  const request = data as RequestRow;
  // Ya convertida (otro clic, otra pestaña): se lleva a la misma cotización, sin crear nada.
  if (request.status === "converted" && request.quote_id) {
    redirect(quotePath(active, request.quote_id));
  }
  if (request.status === "discarded") return fail("discarded", CONVERT_DISCARDED);
  if (request.anonymized_at !== null) return fail("state", CONVERT_ANONYMIZED);
  const permissions = requestPermissions(active.role, active.userId, {
    status: request.status,
    assignedTo: request.assigned_to,
    anonymized: false,
  });
  if (!permissions.canConvert) return fail("forbidden", CONVERT_FORBIDDEN);

  // El cliente.
  // Cliente nuevo: su identificador sale de la organización y la solicitud (no del navegador), así dos
  // clics o dos pestañas llegan al mismo cliente y el cliente creado en un intento anterior se reutiliza.
  const customerId =
    input.data.mode === "existing"
      ? input.data.customerId
      : deriveConvertCustomerId(active.tenantId, requestId);
  if (input.data.mode === "new") {
    const parsed = customerSchema.safeParse(input.data.customer);
    if (!parsed.success) {
      return fail("invalid", "Revisa los datos marcados.", {
        fieldErrors: fieldErrorsOf(parsed.error),
      });
    }
    if (!input.data.confirmDuplicate) {
      // El cliente de un intento anterior de esta misma solicitud no cuenta como «parecido».
      const duplicates = await findDuplicates(active, parsed.data, customerId);
      if (duplicates.length > 0) {
        return fail("duplicates", "Ya tienes un cliente parecido.", { duplicates });
      }
    }
    const created = await ensureNewCustomer(active, customerId, parsed.data);
    if (!created.ok) return fail("other", created.message);
  }

  // La cotización y la marca de «convertida».
  const { data: converted, error } = await active.supabase.rpc("convert_intake_request", {
    p_request_id: requestId,
    p_customer_id: customerId,
    p_creation_key: input.data.creationKey,
  });
  if (error) {
    const mapped = mapConvertError(error);
    if (mapped.kind === "other") {
      await serverLog("error", "intake_convert_failed", { code: error.code ?? "unknown" });
    }
    return fail(mapped.kind, mapped.message);
  }
  const result = converted as { quote_id?: string; converted?: boolean } | null;
  if (!result?.quote_id || !isUuid(result.quote_id)) {
    await serverLog("error", "intake_convert_bad_response");
    return fail("other", CONVERT_GENERIC_FAILURE);
  }
  refresh(active);

  // Las líneas: solo si esta llamada fue la que convirtió. Si falla, queda un borrador vacío y el
  // editor ofrece «Cargar los servicios de la solicitud».
  if (result.converted === true) {
    try {
      await saveRequestLines(
        active,
        active.tenantId,
        result.quote_id,
        parseRequestedServices(request.items),
      );
    } catch {
      // Un fallo inesperado del guardado de líneas no frena la conversión: sin detalle en el registro.
      await serverLog("error", "intake_convert_lines_threw");
    }
  }
  redirect(quotePath(active, result.quote_id));
}
