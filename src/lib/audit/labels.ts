/**
 * Cómo se ve el registro de actividad: nombres en español para cada acción y recurso (H-014).
 * Puro, sin base de datos. Las acciones nuevas que aún no tengan nombre se muestran con su código.
 */

/** Acciones que el registro de la organización sabe nombrar, en el orden del selector. */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  "session.login": "Ingresó a la plataforma",
  "member.created": "Se sumó un miembro",
  "member.updated": "Cambió un miembro",
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
  "share_link.revoked": "Se revocó el enlace de una cotización",
};

const RESOURCE_LABELS: Readonly<Record<string, string>> = {
  session: "Sesión",
  member: "Miembro",
  tenant: "Organización",
  numbering: "Numeración",
  catalog_item: "Catálogo",
  customer: "Cliente",
  quote: "Cotización",
};

const ROLE_LABELS: Readonly<Record<string, string>> = {
  owner: "Dueño",
  admin: "Administrador",
  approver: "Aprobador",
  sales: "Comercial",
  viewer: "Observador",
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
};

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

/**
 * Una frase corta de qué cambió, sin mostrar valores personales: solo el cambio de rol (con los
 * dos roles) y los nombres de los campos modificados. `null` si no hay nada que agregar.
 */
export function describeAuditDetails(details: unknown): string | null {
  if (!isRecord(details)) return null;

  const oldValues = isRecord(details.old) ? details.old : null;
  const newValues = isRecord(details.new) ? details.new : null;
  if (oldValues && newValues && "role" in newValues) {
    const before = ROLE_LABELS[String(oldValues.role)] ?? String(oldValues.role);
    const after = ROLE_LABELS[String(newValues.role)] ?? String(newValues.role);
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
