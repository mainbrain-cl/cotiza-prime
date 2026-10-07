import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { BrandHeader } from "@/components/intake/brand-header";
import { IntakeBusy, IntakeNotFound, IntakeUnavailable } from "@/components/intake/public-states";
import { PublicIntakeForm } from "@/components/intake/public-intake-form";
import { loadAntibotConfig } from "@/lib/antibot";
import { getRequestContext } from "@/lib/http/request-context";
import { buildConsentNotice, ConsentNoticeError } from "@/lib/intake/consent-notice";
import { readIntakeForm, readOrganizationLogoFile } from "@/lib/intake/gateway";
import { shrinkLogoToDataUrl } from "@/lib/intake/logo-thumbnail";
import { buildPublicView, buildUnavailableView } from "@/lib/intake/public-view";
import { isWellFormedPublicId } from "@/lib/intake/read-model";
import { createRenderToken } from "@/lib/intake/render-token";
import { consumeIntakeReadQuota } from "@/lib/security/login-rate-limit";

/**
 * Pantalla pública del formulario (H-087): la abre cualquiera con el enlace o el QR, sin cuenta. La puerta
 * es el identificador de la dirección (22 caracteres al azar). Leer la página es un GET y NUNCA escribe.
 *
 * Lo que llega al navegador se arma con una LISTA BLANCA de campos (`public-view.ts`): nunca la
 * organización, el formulario, el nombre interno ni el servicio del catálogo, y ningún monto. Manda la marca
 * de la organización, no el diseño de Cotiza Prime.
 *
 * Códigos de estado (igual que el enlace del cliente, `/c/[token]`): esta pantalla responde 200 también para
 * un formulario inexistente, mal escrito o con el límite excedido, porque `loading.tsx` ya envió el esqueleto
 * antes de que la página decida. El mensaje es el mismo para cualquier causa y la página no se indexa. La
 * API (`/api/v1/public/forms/...`) sí responde 404 y 429.
 *
 * Metadatos genéricos: ni el nombre de la organización ni del formulario salen en el título.
 */
export const metadata: Metadata = {
  title: "Pide una cotización",
  description: "Cuéntanos qué necesitas y te enviaremos una cotización.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function PublicIntakePage({ params }: PageProps<"/f/[publicId]">) {
  const { publicId } = await params;
  // Identificador mal formado: no se toca la base ni se gasta el límite.
  if (!isWellFormedPublicId(publicId)) return <IntakeNotFound />;

  const { clientIp } = await getRequestContext();
  if (!(await consumeIntakeReadQuota(clientIp))) return <IntakeBusy />;

  // Si la base falla, `error.tsx` muestra un mensaje de reintento (nunca un detalle técnico).
  const form = await readIntakeForm(publicId);
  if (form.state === "not_found") return <IntakeNotFound />;
  if (form.state === "paused") {
    return <IntakeUnavailable organization={buildUnavailableView(form).organization} />;
  }

  // Sin un contacto válido de la organización no se puede armar el aviso de privacidad: no se recibe nada.
  let consent;
  try {
    consent = buildConsentNotice({
      organizationName: form.organization.name,
      contactEmail: form.organization.email ?? "",
      privacyPolicyUrl: form.privacyPolicyUrl,
    });
  } catch (cause) {
    if (cause instanceof ConsentNoticeError) {
      return <IntakeUnavailable organization={buildUnavailableView(form).organization} />;
    }
    throw cause;
  }

  // El logo se reduce aquí (256 px como máximo) y la cabecera de la marca se dibuja en el servidor: el
  // formulario del navegador recibe el encabezado ya armado, no la imagen como dato.
  const logoFile = await readOrganizationLogoFile(form.tenantId, form.logoPath);
  const logoSrc = logoFile ? await shrinkLogoToDataUrl(logoFile.bytes, logoFile.kind) : null;
  const antibot = loadAntibotConfig();
  // La clave de envío la crea el servidor y el sello de tiempo queda atado a ella.
  const submitKey = randomUUID();

  return (
    <div className="customer-light min-h-dvh">
      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <PublicIntakeForm
          publicId={publicId}
          view={buildPublicView(form, consent)}
          renderToken={createRenderToken(publicId, submitKey)}
          submitKey={submitKey}
          header={<BrandHeader organizationName={form.organization.name} logoSrc={logoSrc} />}
          antibot={{
            provider: antibot.provider,
            siteKey: antibot.provider === "turnstile" ? antibot.turnstileSiteKey : null,
          }}
        />
      </main>
    </div>
  );
}
