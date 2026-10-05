import "server-only";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";

/** Bucket privado de Storage donde viven los logos (migración 13). */
export const LOGO_BUCKET = "tenant-logos";

export type TenantBrand = {
  name: string;
  primaryColor: string | null;
  secondaryColor: string | null;
  logoPath: string | null;
};

/** Lee la marca de la organización activa (la RLS ya limita la lectura a sus miembros). */
export async function loadBrand(active: ActiveTenant): Promise<TenantBrand | null> {
  const { data, error } = await active.supabase
    .from("tenants")
    .select("name, brand_primary_color, brand_secondary_color, logo_path")
    .eq("tenant_id", active.tenantId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    name: data.name as string,
    primaryColor: (data.brand_primary_color as string | null) ?? null,
    secondaryColor: (data.brand_secondary_color as string | null) ?? null,
    logoPath: (data.logo_path as string | null) ?? null,
  };
}
