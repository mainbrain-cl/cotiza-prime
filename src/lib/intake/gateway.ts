import "server-only";
import { z } from "zod";
import { encryptPii } from "@/lib/crypto/pii";
import { searchHash } from "@/lib/crypto/search-hash";
import { getRequestContext } from "@/lib/http/request-context";
import { normalizeEmail } from "@/lib/normalize/email";
import { createAdminClient } from "@/lib/supabase/admin-client";
import { REQUEST_ID_HEADER } from "@/lib/tenant/constants";
import {
  intakeFormReadSchema,
  isWellFormedPublicId,
  type IntakeFormReadResult,
} from "./read-model";

/**
 * El PORTERO del formulario público (decisión 017, plan del sprint 4 §2). Es el ÚNICO archivo que usa la
 * llave maestra para atender a alguien que no tiene sesión y que, además, ESCRIBE datos de un desconocido.
 * Lo hace de dos maneras muy angostas:
 *
 *  1. Llama SOLO a seis funciones de la base, ejecutables únicamente por el servidor: `intake_form_read`,
 *     `intake_request_submit`, `intake_record_block` y las tres de los avisos al equipo
 *     (`intake_notice_recipients`, `intake_notice_register`, `intake_notice_settle`).
 *  2. Lee del bucket privado `tenant-logos` SOLO el logo de la organización dueña del formulario, y solo
 *     si su ruta empieza por el `tenant_id` que devolvió la base.
 *
 * No toca ninguna tabla (una guardia estática vigila que no aparezca `.from(` sobre tablas, `.auth`, ni
 * otra función). El navegador del visitante nunca habla con la base: todo pasa por aquí.
 *
 * Reglas de este archivo:
 *  - El identificador mal formado se rechaza ANTES de consultar la base.
 *  - La organización sale de la fila del formulario (la devuelve la base), nunca de un argumento.
 *  - Ningún mensaje de error ni registro lleva el identificador del formulario, la IP ni datos del visitante.
 */

const LOGO_BUCKET = "tenant-logos";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mismo tope del bucket de logos (migración 13): 1 MB. */
const LOGO_MAX_BYTES = 1_048_576;
const LOGO_FILE_PATTERN = /^[A-Za-z0-9_-]{1,80}\.(png|jpg|svg)$/;
/** Código de Postgres para «ya existe una fila con esa clave única». */
const UNIQUE_VIOLATION = "23505";

export class IntakeGatewayError extends Error {
  constructor(operation: string, code?: string) {
    super(`intake_gateway_${operation}${code ? `:${code}` : ""}`);
    this.name = "IntakeGatewayError";
  }
}

/** Cabecera con el identificador de la petición, para que la auditoría quede correlacionada. */
async function correlationHeaders(): Promise<Record<string, string> | undefined> {
  try {
    const { requestId } = await getRequestContext();
    return { [REQUEST_ID_HEADER]: requestId };
  } catch {
    // Fuera de una petición (un guion o una prueba): sin correlación.
    return undefined;
  }
}

/**
 * Lee el formulario. SOLO LEE: un GET que llegue aquí nunca cambia nada. Identificador mal formado o
 * inexistente: `not_found` (el primero sin tocar la base).
 */
export async function readIntakeForm(publicId: string): Promise<IntakeFormReadResult> {
  if (!isWellFormedPublicId(publicId)) return { state: "not_found" };
  const { data, error } = await createAdminClient().rpc("intake_form_read", {
    p_public_id: publicId,
  });
  if (error) throw new IntakeGatewayError("read", error.code);
  const parsed = intakeFormReadSchema.safeParse(data);
  if (!parsed.success) throw new IntakeGatewayError("read", "shape");
  const body = parsed.data;
  if (body.state === "not_found") return { state: "not_found" };
  const internal = {
    tenantId: body.tenant_id,
    formId: body.form_id,
    title: body.title,
    organization: {
      name: body.org.name,
      email: body.org.contact_email,
      phone: body.org.contact_phone,
    },
    primaryColor: body.brand.primary_color,
    secondaryColor: body.brand.secondary_color,
    logoPath: body.logo_path,
  };
  if (body.state === "paused") return { state: "paused", ...internal };
  return {
    state: "ok",
    ...internal,
    revision: body.revision,
    intro: body.intro,
    successMessage: body.success_message,
    fields: body.fields,
    privacyPolicyUrl: body.privacy_policy_url,
    items: body.items.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      unit: item.unit,
      quantityMode: item.quantity_mode,
      minQtyMilli: item.min_qty_milli,
      maxQtyMilli: item.max_qty_milli,
    })),
  };
}

/** Motivos que el servidor puede contar como bloqueo. El tope y la pausa los cuenta el propio envío. */
export type IntakeBlockReason = "captcha" | "rate" | "invalid";

/**
 * Suma un envío bloqueado al contador del día. Si el identificador no existe la base no hace nada. NUNCA
 * se llama con `paused` ni con `cap`: la base ya los cuenta dentro del envío.
 */
export async function recordIntakeBlock(
  publicId: string,
  reason: IntakeBlockReason,
): Promise<{ recorded: boolean }> {
  if (!isWellFormedPublicId(publicId)) return { recorded: false };
  const { data, error } = await createAdminClient().rpc("intake_record_block", {
    p_public_id: publicId,
    p_reason: reason,
  });
  if (error) throw new IntakeGatewayError("record_block", error.code);
  return { recorded: (data as { recorded?: boolean } | null)?.recorded === true };
}

export type IntakeSubmitInput = {
  publicId: string;
  /** Lo genera la aplicación antes de cifrar: es parte del sello de cada dato. */
  requestId: string;
  submitKey: string;
  formRevision: number;
  contactNameEnc: string;
  contactEmailEnc: string;
  contactPhoneEnc: string | null;
  companyEnc: string | null;
  comunaEnc: string | null;
  serviceAddressEnc: string | null;
  messageEnc: string | null;
  contactEmailHash: string;
  /** `YYYY-MM-DD` o `null`. */
  desiredDate: string | null;
  items: { formItemId: string; quantityMilli: number | null }[];
  /** `intake-v<n>`. */
  consentTemplateVersion: string;
  /** El texto que vio quien aceptó, armado en el servidor con datos de la organización. */
  consentText: string;
  consentIpEnc: string | null;
};

const submitResultSchema = z.object({
  result: z.enum([
    "ok",
    "paused",
    "not_found",
    "form_changed",
    "invalid_items",
    "invalid_data",
    "cap_reached",
  ]),
  replayed: z.boolean().optional(),
  request_id: z.uuid().optional(),
  tenant_id: z.uuid().optional(),
  form_id: z.uuid().optional(),
  form_name: z.string().optional(),
  cap_kind: z.enum(["form", "org"]).optional(),
  notify_cap: z.boolean().optional(),
});

export type IntakeSubmitResult =
  | {
      result: "ok";
      replayed: boolean;
      requestId: string;
      tenantId: string;
      formId: string;
    }
  | {
      result: "cap_reached";
      capKind: "form" | "org";
      notifyCap: boolean;
      tenantId: string;
      formId: string;
    }
  | { result: "paused" | "not_found" | "form_changed" | "invalid_items" | "invalid_data" }
  /** Un choque de clave única (por ejemplo, la misma clave de envío con otro contenido). */
  | { result: "conflict" };

/**
 * Guarda una solicitud nueva. La base hace todo en una transacción (formulario bloqueado, misma clave de
 * envío = misma solicitud, topes del día, servicios revalidados contra ESTE formulario). La organización
 * sale del formulario, nunca de un argumento.
 */
export async function submitIntakeRequest(input: IntakeSubmitInput): Promise<IntakeSubmitResult> {
  if (!isWellFormedPublicId(input.publicId)) return { result: "not_found" };
  const { data, error } = await createAdminClient(await correlationHeaders()).rpc(
    "intake_request_submit",
    {
      p_public_id: input.publicId,
      p_request_id: input.requestId,
      p_submit_key: input.submitKey,
      p_form_revision: input.formRevision,
      p_contact_name_enc: input.contactNameEnc,
      p_contact_email_enc: input.contactEmailEnc,
      p_contact_phone_enc: input.contactPhoneEnc,
      p_company_enc: input.companyEnc,
      p_comuna_enc: input.comunaEnc,
      p_service_address_enc: input.serviceAddressEnc,
      p_message_enc: input.messageEnc,
      p_contact_email_hash: input.contactEmailHash,
      p_desired_date: input.desiredDate,
      p_items: input.items.map((item) => ({
        form_item_id: item.formItemId,
        quantity_milli: item.quantityMilli,
      })),
      p_consent_template_version: input.consentTemplateVersion,
      p_consent_text: input.consentText,
      p_consent_ip_enc: input.consentIpEnc,
    },
  );
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { result: "conflict" };
    throw new IntakeGatewayError("submit", error.code);
  }
  const parsed = submitResultSchema.safeParse(data);
  if (!parsed.success) throw new IntakeGatewayError("submit", "shape");
  const body = parsed.data;
  if (body.result === "ok") {
    if (!body.request_id || !body.tenant_id || !body.form_id) {
      throw new IntakeGatewayError("submit", "shape");
    }
    return {
      result: "ok",
      replayed: body.replayed === true,
      requestId: body.request_id,
      tenantId: body.tenant_id,
      formId: body.form_id,
    };
  }
  if (body.result === "cap_reached") {
    if (!body.tenant_id || !body.form_id || !body.cap_kind) {
      throw new IntakeGatewayError("submit", "shape");
    }
    return {
      result: "cap_reached",
      capKind: body.cap_kind,
      notifyCap: body.notify_cap === true,
      tenantId: body.tenant_id,
      formId: body.form_id,
    };
  }
  return { result: body.result };
}

export type IntakeNoticeKind = "request_assigned" | "request_received" | "intake_cap_reached";
export type IntakeNoticeRecipient = { userId: string; email: string };

const noticeRecipientsSchema = z.object({
  audience: z.enum(["assignee", "managers"]),
  limited: z.boolean(),
  recipients: z.array(z.object({ user_id: z.uuid(), email: z.string().min(3).max(254) })).max(50),
  tenant_id: z.uuid(),
  tenant_name: z.string(),
  form_id: z.uuid(),
  form_name: z.string(),
});

/**
 * Destinatarios del aviso al equipo, YA FILTRADOS por la base: el Dueño y los Administradores activos (y,
 * en «Llegó una solicitud», solo hasta el tope de 20 solicitudes avisadas por día y organización). `limited`
 * dice que ese tope ya se alcanzó: no hay a quién avisar.
 */
export async function readIntakeNoticeRecipients(
  ref:
    | { kind: "request_assigned" | "request_received"; requestId: string }
    | { kind: "intake_cap_reached"; formId: string },
): Promise<{
  tenantId: string;
  formId: string;
  formName: string;
  limited: boolean;
  recipients: IntakeNoticeRecipient[];
}> {
  const { data, error } = await createAdminClient().rpc("intake_notice_recipients", {
    p_request_id: ref.kind !== "intake_cap_reached" ? ref.requestId : null,
    p_kind: ref.kind,
    p_form_id: ref.kind === "intake_cap_reached" ? ref.formId : null,
  });
  if (error) throw new IntakeGatewayError("notice_recipients", error.code);
  const parsed = noticeRecipientsSchema.safeParse(data);
  if (!parsed.success) throw new IntakeGatewayError("notice_recipients", "shape");
  return {
    tenantId: parsed.data.tenant_id,
    formId: parsed.data.form_id,
    formName: parsed.data.form_name,
    limited: parsed.data.limited,
    recipients: parsed.data.recipients.map((r) => ({ userId: r.user_id, email: r.email })),
  };
}

export type IntakeNoticeRegistration =
  | { registered: true }
  | { registered: false; reason: "daily_limit" | "tenant_inactive" | "id_in_use" };

const REGISTRATION_REASONS: ReadonlySet<string> = new Set([
  "daily_limit",
  "tenant_inactive",
  "id_in_use",
]);

/**
 * Deja anotado el aviso (antes de enviarlo) en el registro de correos. El correo del destinatario va
 * cifrado con el sello de la fila y con su huella. Si la base responde `registered: false`, el correo NO
 * se envía.
 */
export async function registerIntakeNotice(input: {
  emailId: string;
  tenantId: string;
  kind: IntakeNoticeKind;
  requestId?: string;
  formId?: string;
  recipient: IntakeNoticeRecipient;
}): Promise<IntakeNoticeRegistration> {
  const email = normalizeEmail(input.recipient.email);
  const { data, error } = await createAdminClient().rpc("intake_notice_register", {
    p_email_id: input.emailId,
    p_request_id: input.kind !== "intake_cap_reached" ? (input.requestId ?? null) : null,
    p_kind: input.kind,
    p_to_user_id: input.recipient.userId,
    p_to_email_enc: encryptPii(email, {
      table: "email_messages",
      field: "to_email",
      tenantId: input.tenantId,
      rowId: input.emailId,
    }),
    p_to_email_hash: searchHash("email", input.tenantId, email),
    p_form_id: input.kind === "intake_cap_reached" ? (input.formId ?? null) : null,
  });
  if (error) throw new IntakeGatewayError("notice_register", error.code);
  const body = (data ?? {}) as { registered?: boolean; reason?: string };
  if (body.registered === true) return { registered: true };
  const reason = body.reason && REGISTRATION_REASONS.has(body.reason) ? body.reason : "id_in_use";
  return { registered: false, reason: reason as "daily_limit" | "tenant_inactive" | "id_in_use" };
}

/** Cierra el aviso: enviado (con lo que informó el proveedor) o fallido (solo un código). */
export async function settleIntakeNotice(input: {
  emailId: string;
  sent?: { provider: string; providerMessageId: string };
  errorCode?: string;
}): Promise<void> {
  const { error } = await createAdminClient().rpc("intake_notice_settle", {
    p_email_id: input.emailId,
    p_provider: input.sent?.provider ?? null,
    p_provider_message_id: input.sent?.providerMessageId ?? null,
    p_error_code: input.sent ? null : (input.errorCode ?? "unknown"),
  });
  if (error) throw new IntakeGatewayError("notice_settle", error.code);
}

/**
 * El archivo del logo de la organización (la página pública no habla con Storage y no puede exponer la
 * dirección con el identificador de la organización). Solo si la ruta empieza por el `tenant_id` que
 * devolvió la base; cualquier otra cosa devuelve `null`. Quien lo usa lo reduce (`logo-thumbnail.ts`)
 * antes de mostrarlo.
 */
export async function readOrganizationLogoFile(
  tenantId: string,
  logoPath: string | null,
): Promise<{ bytes: Buffer; kind: "png" | "jpg" | "svg" } | null> {
  if (!logoPath || !UUID_PATTERN.test(tenantId)) return null;
  const prefix = `${tenantId}/`;
  if (!logoPath.startsWith(prefix)) return null;
  const file = logoPath.slice(prefix.length);
  const match = LOGO_FILE_PATTERN.exec(file);
  if (!match) return null;
  const { data, error } = await createAdminClient().storage.from(LOGO_BUCKET).download(logoPath);
  if (error || !data || data.size > LOGO_MAX_BYTES) return null;
  return { bytes: Buffer.from(await data.arrayBuffer()), kind: match[1] as "png" | "jpg" | "svg" };
}
