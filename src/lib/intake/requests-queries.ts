import "server-only";
import { decryptPii } from "@/lib/crypto/pii";
import type { ActiveTenant, MemberRole } from "@/lib/tenant/active-tenant";
import { isUuid } from "@/lib/tenant/constants";
import {
  ASSIGNABLE_ROLES,
  REQUEST_LIST_LIMIT,
  isStale,
  parseRequestItems,
  summarizeRequestItems,
  type RequestFilter,
  type RequestItemCopy,
  type RequestStatus,
} from "./requests-model";

/**
 * Lecturas de las solicitudes para la pantalla del equipo (H-089). Todo pasa por el cliente con sesión:
 * la base decide qué filas se ven (RLS) y nunca entrega `consent_ip_enc`. Los datos del visitante se
 * descifran aquí, en el servidor, con el sello `intake_requests.<campo>|tenant|id`.
 */

export const FORMER_MEMBER_LABEL = "Alguien que ya no está en el equipo";

const LIST_COLUMNS =
  "id, form_id, status, assigned_to, created_at, contact_name_enc, items, anonymized_at";
const DETAIL_COLUMNS =
  "id, form_id, status, assigned_to, assigned_at, assigned_by, created_at, discard_reason, discard_note, discarded_at, quote_id, converted_at, contact_name_enc, contact_email_enc, contact_phone_enc, company_enc, comuna_enc, service_address_enc, message_enc, desired_date, items, consent_template_version, consent_text, consent_text_unavailable, consented_at, anonymized_at";

type PlainField = { value: string | null; unreadable: boolean };

function readSealed(
  active: ActiveTenant,
  requestId: string,
  field: string,
  token: string | null,
): PlainField {
  if (token === null) return { value: null, unreadable: false };
  try {
    return {
      value: decryptPii(token, {
        table: "intake_requests",
        field,
        tenantId: active.tenantId,
        rowId: requestId,
      }),
      unreadable: false,
    };
  } catch {
    // Sin detalle: ni el dato ni el motivo técnico salen de aquí.
    return { value: null, unreadable: true };
  }
}

/** Nombres de las personas del equipo (los de quienes ya no están no se pueden leer). */
async function profileNames(
  active: ActiveTenant,
  userIds: readonly string[],
): Promise<Map<string, string> | null> {
  const names = new Map<string, string>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return names;
  const { data, error } = await active.supabase
    .from("profiles")
    .select("user_id, full_name")
    .in("user_id", ids);
  if (error) return null;
  for (const row of (data ?? []) as { user_id: string; full_name: string }[]) {
    names.set(row.user_id, row.full_name);
  }
  return names;
}

async function formNames(
  active: ActiveTenant,
  formIds: readonly string[],
): Promise<Map<string, string> | null> {
  const names = new Map<string, string>();
  const ids = [...new Set(formIds)];
  if (ids.length === 0) return names;
  const { data, error } = await active.supabase
    .from("intake_forms")
    .select("id, name")
    .in("id", ids);
  if (error) return null;
  for (const row of (data ?? []) as { id: string; name: string }[]) names.set(row.id, row.name);
  return names;
}

export type RequestListRow = {
  id: string;
  status: RequestStatus;
  createdAt: string;
  anonymized: boolean;
  /** `null` si se anonimizó o no se pudo leer (ver `unreadable`). */
  contactName: string | null;
  unreadable: boolean;
  itemsSummary: string;
  formName: string;
  assignedToId: string | null;
  /** `null` si no tiene responsable. */
  assignedToName: string | null;
  stale: boolean;
};

export type RequestListResult =
  { ok: true; rows: RequestListRow[]; truncated: boolean } | { ok: false };

export async function loadRequestList(
  active: ActiveTenant,
  filter: RequestFilter,
): Promise<RequestListResult> {
  let query = active.supabase.from("intake_requests").select(LIST_COLUMNS);
  if (filter === "sin-asignar") query = query.eq("status", "new");
  else if (filter === "mias")
    query = query.eq("assigned_to", active.userId).eq("status", "assigned");
  else if (filter === "convertidas") query = query.eq("status", "converted");
  else if (filter === "descartadas") query = query.eq("status", "discarded");
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(REQUEST_LIST_LIMIT + 1);
  if (error || !data) return { ok: false };

  const rows = (data as Record<string, unknown>[]).slice(0, REQUEST_LIST_LIMIT);
  const assigneeIds = rows.map((r) => r.assigned_to).filter((v): v is string => v !== null);
  const [forms, people] = await Promise.all([
    formNames(
      active,
      rows.map((r) => r.form_id as string),
    ),
    profileNames(active, assigneeIds),
  ]);
  if (!forms || !people) return { ok: false };

  const now = new Date();
  return {
    ok: true,
    truncated: data.length > REQUEST_LIST_LIMIT,
    rows: rows.map((row) => {
      const id = row.id as string;
      const status = row.status as RequestStatus;
      const anonymized = row.anonymized_at !== null;
      const name = readSealed(active, id, "contact_name", row.contact_name_enc as string | null);
      const assignedTo = row.assigned_to as string | null;
      return {
        id,
        status,
        createdAt: row.created_at as string,
        anonymized,
        contactName: name.value,
        unreadable: name.unreadable,
        itemsSummary: summarizeRequestItems(parseRequestItems(row.items)),
        formName: forms.get(row.form_id as string) ?? "Formulario",
        assignedToId: assignedTo,
        assignedToName: assignedTo ? (people.get(assignedTo) ?? FORMER_MEMBER_LABEL) : null,
        stale: isStale(status, row.created_at as string, now),
      } satisfies RequestListRow;
    }),
  };
}

export type RequestDetail = {
  id: string;
  status: RequestStatus;
  createdAt: string;
  anonymized: boolean;
  formId: string;
  formName: string;
  assignedToId: string | null;
  assignedToName: string | null;
  assignedAt: string | null;
  discardReason: string | null;
  discardNote: string | null;
  discardedAt: string | null;
  quoteId: string | null;
  convertedAt: string | null;
  /** Alguno de los datos de contacto no se pudo descifrar: se avisa, no se inventa. */
  unreadable: boolean;
  contact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    comuna: string | null;
    serviceAddress: string | null;
    message: string | null;
  };
  desiredDate: string | null;
  items: RequestItemCopy[];
  consent: {
    templateVersion: string;
    text: string | null;
    textUnavailable: boolean;
    consentedAt: string;
  };
};

export type RequestDetailResult =
  { ok: true; detail: RequestDetail } | { ok: false; reason: "not_found" | "error" };

export async function loadRequest(
  active: ActiveTenant,
  requestId: string,
): Promise<RequestDetailResult> {
  if (!isUuid(requestId)) return { ok: false, reason: "not_found" };
  const { data, error } = await active.supabase
    .from("intake_requests")
    .select(DETAIL_COLUMNS)
    .eq("id", requestId)
    .maybeSingle();
  if (error) return { ok: false, reason: "error" };
  if (!data) return { ok: false, reason: "not_found" };
  const row = data as Record<string, unknown>;

  const assignedTo = row.assigned_to as string | null;
  const [forms, people] = await Promise.all([
    formNames(active, [row.form_id as string]),
    profileNames(active, assignedTo ? [assignedTo] : []),
  ]);
  if (!forms || !people) return { ok: false, reason: "error" };

  const read = (field: string, column: string) =>
    readSealed(active, requestId, field, row[column] as string | null);
  const name = read("contact_name", "contact_name_enc");
  const email = read("contact_email", "contact_email_enc");
  const phone = read("contact_phone", "contact_phone_enc");
  const company = read("company", "company_enc");
  const comuna = read("comuna", "comuna_enc");
  const address = read("service_address", "service_address_enc");
  const message = read("message", "message_enc");

  return {
    ok: true,
    detail: {
      id: requestId,
      status: row.status as RequestStatus,
      createdAt: row.created_at as string,
      anonymized: row.anonymized_at !== null,
      formId: row.form_id as string,
      formName: forms.get(row.form_id as string) ?? "Formulario",
      assignedToId: assignedTo,
      assignedToName: assignedTo ? (people.get(assignedTo) ?? FORMER_MEMBER_LABEL) : null,
      assignedAt: row.assigned_at as string | null,
      discardReason: row.discard_reason as string | null,
      discardNote: row.discard_note as string | null,
      discardedAt: row.discarded_at as string | null,
      quoteId: row.quote_id as string | null,
      convertedAt: row.converted_at as string | null,
      unreadable: [name, email, phone, company, comuna, address, message].some((f) => f.unreadable),
      contact: {
        name: name.value,
        email: email.value,
        phone: phone.value,
        company: company.value,
        comuna: comuna.value,
        serviceAddress: address.value,
        message: message.value,
      },
      desiredDate: row.desired_date as string | null,
      items: parseRequestItems(row.items),
      consent: {
        templateVersion: row.consent_template_version as string,
        text: (row.consent_text as string | null) ?? null,
        textUnavailable: row.consent_text_unavailable === true,
        consentedAt: row.consented_at as string,
      },
    },
  };
}

export type AssignableMember = { userId: string; name: string; role: MemberRole };

/** Miembros activos a quienes se puede asignar (Dueño, Administradores y Comerciales). */
export async function loadAssignableMembers(
  active: ActiveTenant,
): Promise<AssignableMember[] | null> {
  const { data, error } = await active.supabase
    .from("members")
    .select("user_id, role")
    .eq("status", "active")
    .in("role", [...ASSIGNABLE_ROLES]);
  if (error || !data) return null;
  const members = data as { user_id: string; role: MemberRole }[];
  const names = await profileNames(
    active,
    members.map((m) => m.user_id),
  );
  if (!names) return null;
  return members
    .map((m) => ({ userId: m.user_id, name: names.get(m.user_id) ?? "Sin nombre", role: m.role }))
    .sort((a, b) => a.name.localeCompare(b.name, "es-CL"));
}

/**
 * Cuántas solicitudes esperan a esta persona, para la insignia del menú. Una consulta ligera, sin
 * tabla de notificaciones: el Dueño y los Administradores ven las nuevas sin asignar; el Comercial, las
 * asignadas a él. Los demás roles no ven insignia (`null`). Si la consulta falla, tampoco se muestra.
 */
export async function loadRequestBadge(active: ActiveTenant): Promise<number | null> {
  let query = active.supabase.from("intake_requests").select("id", { count: "exact", head: true });
  if (active.role === "owner" || active.role === "admin") {
    query = query.eq("status", "new");
  } else if (active.role === "sales") {
    query = query.eq("status", "assigned").eq("assigned_to", active.userId);
  } else {
    return null;
  }
  const { count, error } = await query;
  if (error || count === null) return null;
  return count;
}
