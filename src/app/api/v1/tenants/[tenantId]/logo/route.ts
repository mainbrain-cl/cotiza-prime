import { LOGO_CONTENT_SECURITY_POLICY } from "@/lib/brand/headers";
import { mimeForLogoPath } from "@/lib/brand/logo";
import { loadBrand, LOGO_BUCKET } from "@/lib/brand/service";
import { getOptionalUser } from "@/lib/auth/session";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";

/** Cabeceras que impiden que un archivo servido desde aquí haga algo más que mostrarse como imagen. */
const LOGO_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": LOGO_CONTENT_SECURITY_POLICY,
  // Privado: depende de quién lo pide. La dirección lleva la versión (`?v=`), así que un logo
  // nuevo se pide de nuevo; el plazo corto limita cuánto tarda en notarse un cambio de miembros.
  "Cache-Control": "private, max-age=300",
};

const notFound = () => new Response(null, { status: 404 });

/**
 * Entrega el logo de una organización a sus miembros. Siempre pasa por el servidor: se verifica que
 * la persona sea miembro (`requireActiveTenant`) y el archivo se lee con las políticas de Storage
 * de esa organización. Quien no es miembro, o no hay logo, recibe 404: no se revela nada.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/v1/tenants/[tenantId]/logo">,
) {
  const { tenantId } = await context.params;

  // Sin sesión no se redirige (es una imagen, no una pantalla): 401 y nada más.
  if (!(await getOptionalUser())) return new Response(null, { status: 401 });

  const active = await requireActiveTenant(tenantId);
  const brand = await loadBrand(active);
  const mime = brand?.logoPath ? mimeForLogoPath(brand.logoPath) : null;
  if (!brand?.logoPath || !mime) return notFound();

  const { data, error } = await active.supabase.storage.from(LOGO_BUCKET).download(brand.logoPath);
  if (error || !data) return notFound();

  return new Response(await data.arrayBuffer(), {
    headers: { "Content-Type": mime, ...LOGO_HEADERS },
  });
}
