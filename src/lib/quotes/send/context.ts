import "server-only";
import { loadBrand } from "@/lib/brand/service";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";

export type SendContext = {
  organizationName: string;
  brandPrimary: string | null;
  brandSecondary: string | null;
  /** Contacto de la organización: a este correo llegan las respuestas del cliente. */
  contactEmail: string | null;
};

/** Nombre, colores y contacto de la organización activa, para armar el correo al cliente. */
export async function loadSendContext(active: ActiveTenant): Promise<SendContext | null> {
  const [brand, tenantRow] = await Promise.all([
    loadBrand(active),
    active.supabase
      .from("tenants")
      .select("contact_email")
      .eq("tenant_id", active.tenantId)
      .maybeSingle(),
  ]);
  if (brand === null || tenantRow.error || !tenantRow.data) return null;
  return {
    organizationName: brand.name,
    brandPrimary: brand.primaryColor,
    brandSecondary: brand.secondaryColor,
    contactEmail: (tenantRow.data as { contact_email: string | null }).contact_email,
  };
}
