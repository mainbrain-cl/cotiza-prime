import { getOptionalUser } from "@/lib/auth/session";
import { LOGO_CONTENT_SECURITY_POLICY } from "@/lib/brand/headers";
import { getAppOrigin } from "@/lib/http/request-context";
import { isFormId } from "@/lib/intake/builder-schema";
import { publicFormUrl } from "@/lib/intake/builder-model";
import { buildQrPng, buildQrSvg, QrError } from "@/lib/intake/qr";
import { parseQrFormat, qrFileName } from "@/lib/intake/qr-download";
import { requirePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";

export const runtime = "nodejs";

const QR_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  // Mismo criterio que el logo: aunque alguien abra el SVG directo, no puede ejecutar nada.
  "Content-Security-Policy": LOGO_CONTENT_SECURITY_POLICY,
  "Cache-Control": "private, no-store",
};

const notFound = () => new Response(null, { status: 404 });

/**
 * Código QR de un formulario público (H-091), como descarga. Solo quien maneja los formularios
 * (matriz: `intake.forms.manage`): un miembro sin ese permiso recibe 403; quien no es miembro de la
 * organización, o un formulario que no existe en la organización activa, o uno archivado o en
 * borrador, recibe 404. El contenido es siempre `${origen de la aplicación}/f/${publicId}`: el origen
 * sale de la configuración, nunca de las cabeceras de la petición.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/v1/tenants/[tenantId]/intake-forms/[formId]/qr">,
) {
  const { tenantId, formId } = await context.params;

  if (!(await getOptionalUser())) return new Response(null, { status: 401 });

  const active = await requireActiveTenant(tenantId);
  if (requirePermission(active, "intake.forms.manage")) return new Response(null, { status: 403 });

  const format = parseQrFormat(new URL(request.url).searchParams.get("format"));
  if (!format) return new Response(null, { status: 400 });

  if (!isFormId(formId)) return notFound();
  const { data, error } = await active.supabase
    .from("intake_forms")
    .select("name, public_id, status")
    .eq("tenant_id", active.tenantId)
    .eq("id", formId)
    .maybeSingle();
  const row = data as { name: string; public_id: string; status: string } | null;
  if (error || !row || (row.status !== "published" && row.status !== "paused")) return notFound();

  const content = publicFormUrl(getAppOrigin(), row.public_id);
  let body: Uint8Array;
  try {
    body =
      format === "png"
        ? new Uint8Array(await buildQrPng(content))
        : new TextEncoder().encode(buildQrSvg(content));
  } catch (cause) {
    if (cause instanceof QrError) return new Response(null, { status: 500 });
    throw cause;
  }

  return new Response(body as BodyInit, {
    headers: {
      ...QR_HEADERS,
      "Content-Type": format === "png" ? "image/png" : "image/svg+xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${qrFileName(row.name, format)}"`,
    },
  });
}
