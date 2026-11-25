/**
 * Cómo se ve el registro de actividad: nombres en español para cada acción y recurso (H-014).
 * Puro, sin base de datos. Las acciones nuevas que aún no tengan nombre se muestran con su código.
 */

import { describeApprovalRule } from "@/lib/approvals/describe";
import { isApprovalMode, type ApprovalRule } from "@/lib/approvals/rule";
import { roleLabel } from "@/lib/permissions/matrix";
import { formatPercentBp } from "@/lib/quotes/format";
import { describeLockedPriceChanges } from "@/lib/quotes/locked-price-text";

/** Acciones que el registro de la organización sabe nombrar, en el orden del selector. */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  "session.login": "Ingresó a la plataforma",
  "session.mfa_enrolled": "Activó la verificación en dos pasos",
  "session.mfa_enroll_reverted":
    "Se revirtió la activación de la verificación en dos pasos (no salió el aviso por correo)",
  "session.mfa_annulled":
    "Se anuló la activación de la verificación en dos pasos desde el correo de aviso",
  "session.mfa_annul_warning":
    "Se anuló la activación, pero no se pudo comprobar el cierre de sesiones en la base",
  "session.mfa_annul_failed":
    "No se pudo terminar de anular la activación de la verificación en dos pasos",
  "session.mfa_notice_sent": "Se envió el aviso de la activación de la verificación en dos pasos",
  "session.reauth_failed":
    "No se confirmó la contraseña al pedir una acción de seguridad de la cuenta",
  "session.mfa_recovery_codes_created": "Creó códigos de respaldo de la verificación en dos pasos",
  "session.mfa_recovery_used":
    "Entró con un código de respaldo (se desactivó la verificación en dos pasos)",
  "session.mfa_disabled": "Desactivó la verificación en dos pasos",
  "member.created": "Se sumó un miembro",
  "member.updated": "Cambió un miembro",
  "member.role_changed": "Se cambió el rol de un miembro",
  "member.removed": "Se quitó a un miembro del equipo",
  "member.catalog_scope_changed": "Se cambiaron los servicios que puede cotizar un miembro",
  "tenant.created": "Se creó la organización",
  "tenant.updated": "Cambió la configuración de la organización",
  "numbering.created": "Se configuró la numeración",
  "numbering.updated": "Cambió la numeración",
  "catalog_item.created": "Se agregó un servicio al catálogo",
  "catalog_item.updated": "Cambió un servicio del catálogo",
  "catalog_item.price_changed": "Cambió el precio de un servicio",
  "customer.created": "Se registró un cliente",
  "customer.updated": "Cambió un cliente",
  "quote.sent": "Se envió una cotización al cliente",
  "quote.resent": "Se reenvió una cotización al cliente",
  "quote.send_failed": "No se pudo enviar una cotización",
  "quote.accepted": "El cliente aceptó una cotización",
  "quote.rejected": "El cliente rechazó una cotización",
  "quote.locked_price_overridden": "Se cambió un precio bloqueado en una cotización",
  "share_link.revoked": "Se revocó el enlace de una cotización",
  "invitation.created": "Se invitó a una persona al equipo",
  "invitation.updated": "Cambió una invitación",
  "invitation.resent": "Se reenvió una invitación",
  "invitation.revoked": "Se canceló una invitación",
  "approval_rule.updated": "Cambió la regla de aprobación",
  "text_snippet.created": "Se creó un texto guardado",
  "text_snippet.updated": "Se cambió un texto guardado",
  "text_snippet.deleted": "Se eliminó un texto guardado",
  "invitation.accepted": "Una persona aceptó la invitación al equipo",
  "invitation.accept_denied": "Se intentó aceptar una invitación dirigida a otra persona",
};

const RESOURCE_LABELS: Readonly<Record<string, string>> = {
  session: "Sesión",
  member: "Miembro",
  tenant: "Organización",
  numbering: "Numeración",
  catalog_item: "Catálogo",
  customer: "Cliente",
  quote: "Cotización",
  invitation: "Invitación",
  text_snippet: "Texto guardado",
  approval_rule: "Regla de aprobación",
};

const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: "nombre",
  rut: "RUT",
  industry: "rubro",
  contact_email: "correo de contacto",
  contact_phone: "teléfono de contacto",
  logo_path: "logo",
  brand_primary_color: "color de la marca",
  prefix: "prefijo",
  mode: "formato",
  role: "rol",
  status: "estado",
  removed_at: "salida del equipo",
  removed_by: "salida del equipo",
  unit_price_clp: "precio",
  unit: "unidad",
  is_active: "activo",
  tax_treatment: "IVA",
  description: "descripción",
  display_name: "nombre",
  kind: "tipo",
  email_enc: "correo",
  phone_enc: "teléfono",
  rut_enc: "RUT",
  address_enc: "dirección",
  expires_at: "vencimiento",
  send_count: "envíos",
  last_sent_at: "último envío",
  revoke_reason: "motivo de la cancelación",
  resent_by: "quién la reenvió",
  body: "texto",
  is_default: "predeterminado",
  price_locked: "precio bloqueado",
  max_discount_bp: "descuento máximo",
};

/** Quién hizo algo cuando la fila no lo identifica: una persona con cuenta que no es ni fue de esta organización. */
export const OUTSIDE_ACTOR_TEXT = "Una persona de fuera de tu organización";

/** Quién hizo algo, para la columna «Quién» del registro de actividad. */
export function auditActorText(entry: {
  actorName: string | null;
  actorOutside?: boolean;
  actorType: "user" | "service" | "system" | "public";
}): string {
  if (entry.actorName) return entry.actorName;
  if (entry.actorOutside) return OUTSIDE_ACTOR_TEXT;
  if (entry.actorType === "system") return "El sistema";
  if (entry.actorType === "public") return "Una visita sin cuenta";
  if (entry.actorType === "service") return "Un servicio automático";
  return "Alguien que ya no está en el equipo";
}

export function actionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export function resourceLabel(resourceType: string | null): string {
  if (!resourceType) return "—";
  return RESOURCE_LABELS[resourceType] ?? resourceType;
}

/** Acciones que se pueden elegir en el filtro. */
export function isKnownAuditAction(value: string): boolean {
  return Object.hasOwn(AUDIT_ACTION_LABELS, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cancelledNote(details: Record<string, unknown>): string | null {
  const cancelled = details.cancelled_invitations;
  if (typeof cancelled !== "number" || cancelled <= 0) return null;
  return cancelled === 1
    ? "se canceló 1 invitación que había enviado o reenviado"
    : `se cancelaron ${cancelled} invitaciones que había enviado o reenviado`;
}

function describeMemberChange(details: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if (typeof details.old_role === "string" && typeof details.new_role === "string") {
    parts.push(`Rol: ${roleLabel(details.old_role)} → ${roleLabel(details.new_role)}`);
  } else if (
    typeof details.role === "string" &&
    typeof details.cancelled_invitations === "number"
  ) {
    parts.push(`Rol: ${roleLabel(details.role)}`);
  }
  const note = cancelledNote(details);
  if (parts.length > 0 && note) parts.push(note);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Qué cambió en los servicios que puede cotizar un miembro (H-042), con las cantidades que guarda el registro (nunca nombres de servicio:
 * solo ids). `null` si el detalle no trae lo esperado (se cae a la frase general).
 */
function describeCatalogScopeChange(who: string, details: Record<string, unknown>): string | null {
  const {
    old_mode: oldMode,
    new_mode: newMode,
    old_count: oldCount,
    new_count: newCount,
  } = details;
  if (
    (oldMode !== "all" && oldMode !== "list") ||
    (newMode !== "all" && newMode !== "list") ||
    typeof oldCount !== "number" ||
    typeof newCount !== "number"
  ) {
    return null;
  }
  const services = (n: number) => (n === 1 ? "1 servicio" : `${n} servicios`);
  if (newMode === "all") return `Dejó a ${who} cotizar todos los servicios`;
  if (oldMode === "all") return `Limitó a ${who} a ${services(newCount)}`;
  // De una lista a otra: cuántos se agregaron y cuántos se quitaron (si el registro los truncó, no se dice un número que no es).
  const added = Array.isArray(details.added) ? details.added.length : null;
  const removed = Array.isArray(details.removed) ? details.removed.length : null;
  const changes =
    details.truncated === true || added === null || removed === null
      ? []
      : [added > 0 ? `agregó ${added}` : null, removed > 0 ? `quitó ${removed}` : null].filter(
          Boolean,
        );
  // Sin cambios que contar (un registro deformado), no se deja un paréntesis vacío.
  const moved = changes.length > 0 ? ` (${changes.join(", ")})` : "";
  return `Cambió los servicios de ${who}: de ${services(oldCount)} a ${services(newCount)}${moved}`;
}

/** Cómo se llama a la persona afectada cuando su nombre no se puede leer. */
export const UNKNOWN_SUBJECT = "una persona del equipo";

/**
 * Una frase corta de qué cambió, sin mostrar valores personales: solo el cambio de rol (con los
 * dos roles) y los nombres de los campos modificados. `null` si no hay nada que agregar.
 */
export function describeAuditDetails(details: unknown): string | null {
  if (!isRecord(details)) return null;

  // Cambiar el rol o quitar a un miembro (H-010): los roles no son datos personales; nunca viaja un correo.
  const memberNote = describeMemberChange(details);
  if (memberNote) return memberNote;

  const oldValues = isRecord(details.old) ? details.old : null;
  const newValues = isRecord(details.new) ? details.new : null;
  if (oldValues && newValues && "role" in newValues) {
    const before = roleLabel(String(oldValues.role));
    const after = roleLabel(String(newValues.role));
    return `Rol: ${before} → ${after}`;
  }

  const fields: string[] = Array.isArray(details.changed)
    ? details.changed.map(String)
    : newValues
      ? Object.keys(newValues)
      : [];
  if (fields.length === 0) return null;
  const names = [...new Set(fields.map((field) => FIELD_LABELS[field] ?? "otros datos"))];
  return `Cambió: ${names.join(", ")}`;
}

/** La regla de aprobación guardada en un registro (`old` o `new`); `null` si la forma no es la esperada. */
function approvalRuleOf(value: unknown): ApprovalRule | null {
  if (!isRecord(value) || !isApprovalMode(value.mode)) return null;
  const amount = value.amount_threshold_clp;
  const discount = value.discount_threshold_bp;
  if (amount !== null && typeof amount !== "number") return null;
  if (discount !== null && typeof discount !== "number") return null;
  return { mode: value.mode, amountThresholdClp: amount, discountThresholdBp: discount };
}

/** El descuento máximo como se dice en el registro: «Sin tope» o «10 %»; `null` si el valor no es de este tipo. */
function maxDiscountValueText(value: unknown): string | null {
  if (value === null) return "Sin tope";
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return `${formatPercentBp(value)} %`;
}

/**
 * Los cambios del descuento máximo (organización) y del candado de un precio (servicio del catálogo) dicho como en H-040
 * («Descuento máximo: Sin tope → 10 %», «Bloqueó el precio»), más «Cambió: …» con lo demás que haya cambiado en el mismo registro.
 * `null` si el registro no toca ninguno de los dos campos o no se puede leer.
 */
function describePriceRuleChange(details: unknown): string | null {
  if (!isRecord(details) || !isRecord(details.new)) return null;
  const oldValues = isRecord(details.old) ? details.old : {};
  const parts: string[] = [];
  if ("max_discount_bp" in details.new) {
    const before = maxDiscountValueText(oldValues.max_discount_bp ?? null);
    const after = maxDiscountValueText(details.new.max_discount_bp);
    if (before === null || after === null) return null;
    parts.push(`Descuento máximo: ${before} → ${after}`);
  }
  if ("price_locked" in details.new) {
    if (typeof details.new.price_locked !== "boolean") return null;
    parts.push(details.new.price_locked ? "Bloqueó el precio" : "Quitó el bloqueo del precio");
  }
  if (parts.length === 0) return null;
  const rest = Object.keys(details.new).filter(
    (key) => key !== "max_discount_bp" && key !== "price_locked",
  );
  if (rest.length > 0) {
    const other = describeAuditDetails({ changed: rest });
    if (other) parts.push(other);
  }
  return parts.join(" · ");
}

/**
 * La frase del detalle de un registro. Para cambiar el rol de un miembro o quitarlo dice **a quién** afectó
 * («Quitó a María Pérez del equipo»): con la decisión de no mandar correos, el registro es lo único que se lo
 * cuenta al Dueño. El nombre se lee al mostrar (nunca se guarda en la auditoría); sin nombre, «una persona del
 * equipo». Nunca lleva un correo. Para las demás acciones es `describeAuditDetails`.
 */
export function describeAuditEntry(entry: {
  action: string;
  details: unknown;
  subjectName?: string | null;
}): string | null {
  const details = isRecord(entry.details) ? entry.details : {};
  const who = entry.subjectName?.trim() || UNKNOWN_SUBJECT;
  if (
    entry.action === "member.role_changed" &&
    typeof details.old_role === "string" &&
    typeof details.new_role === "string"
  ) {
    const sentence = `Cambió el rol de ${who} de ${roleLabel(details.old_role)} a ${roleLabel(details.new_role)}`;
    return [sentence, cancelledNote(details)].filter(Boolean).join(" · ");
  }
  if (entry.action === "member.removed") {
    const named = entry.subjectName?.trim();
    // Sin nombre: «Quitó a una persona del equipo» (sin repetir «del equipo»).
    const sentence = named ? `Quitó a ${named} del equipo` : `Quitó a ${UNKNOWN_SUBJECT}`;
    return [sentence, cancelledNote(details)].filter(Boolean).join(" · ");
  }
  if (entry.action === "member.catalog_scope_changed") {
    const sentence = describeCatalogScopeChange(who, details);
    if (sentence) return sentence;
  }
  if (entry.action === "approval_rule.updated") {
    // Montos y porcentajes, nunca datos personales: se cuenta la regla de antes y la de ahora con la misma frase de la pantalla.
    const before = approvalRuleOf(details.old);
    const after = approvalRuleOf(details.new);
    if (before && after) {
      return `Antes: ${describeApprovalRule(before)} Ahora: ${describeApprovalRule(after)}`;
    }
  }
  if (
    entry.action === "tenant.updated" ||
    entry.action === "catalog_item.updated" ||
    entry.action === "catalog_item.price_changed"
  ) {
    const change = describePriceRuleChange(entry.details);
    if (change) return change;
  }
  if (entry.action === "quote.locked_price_overridden") {
    // Qué líneas y de cuánto a cuánto; nunca nombres de línea (el registro no los guarda).
    const changes = describeLockedPriceChanges(entry.details);
    if (changes) return `Cambió: ${changes}`;
  }
  return describeAuditDetails(entry.details);
}

/** «Sobre qué» de un registro: el tipo de recurso y, si es un miembro, a quién. */
export function describeAuditSubject(entry: {
  resourceType: string | null;
  subjectName?: string | null;
}): string {
  const label = resourceLabel(entry.resourceType);
  if (entry.resourceType !== "member") return label;
  return `${label}: ${entry.subjectName?.trim() || UNKNOWN_SUBJECT}`;
}
