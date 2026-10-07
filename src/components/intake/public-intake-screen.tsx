import { randomUUID } from "node:crypto";
import type { ReactNode } from "react";
import { BrandHeader } from "@/components/intake/brand-header";
import { EmbedResizer } from "@/components/intake/embed-resizer";
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
 * La pantalla pública del formulario, compartida por la página normal (`/f/[publicId]`, H-087) y por la
 * incrustable (`/f/[publicId]/incrustar`, H-093): MISMOS límites, MISMAS protecciones (límite de lecturas por
 * IP, sello de tiempo ligado a la clave de envío, anti-robot, consentimiento) y el mismo formulario; solo
 * cambia el marco de afuera. Es un componente de SERVIDOR: leer es un GET y NUNCA escribe.
 *
 * Lo que llega al navegador se arma con una LISTA BLANCA de campos (`public-view.ts`): nunca la organización,
 * el formulario, el nombre interno ni el servicio del catálogo, y ningún monto. Manda la marca de la
 * organización, no el diseño de Cotiza Prime.
 *
 * Dentro del sitio de otra empresa (`embedded`): fondo transparente, sin alto de pantalla completa, sin pie ni
 * enlaces a Cotiza Prime, y un avisador que solo informa la altura (`EmbedResizer`).
 */
export async function PublicIntakeScreen({
  publicId,
  embedded,
}: {
  publicId: string;
  embedded: boolean;
}) {
  // Identificador mal formado: no se toca la base ni se gasta el límite.
  if (!isWellFormedPublicId(publicId)) {
    return wrap(<IntakeNotFound embedded={embedded} />, embedded);
  }

  const { clientIp } = await getRequestContext();
  if (!(await consumeIntakeReadQuota(clientIp))) {
    return wrap(<IntakeBusy embedded={embedded} />, embedded);
  }

  // Si la base falla, `error.tsx` muestra un mensaje de reintento (nunca un detalle técnico).
  const form = await readIntakeForm(publicId);
  if (form.state === "not_found") return wrap(<IntakeNotFound embedded={embedded} />, embedded);
  if (form.state === "paused") {
    return wrap(
      <IntakeUnavailable
        organization={buildUnavailableView(form).organization}
        embedded={embedded}
      />,
      embedded,
    );
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
      return wrap(
        <IntakeUnavailable
          organization={buildUnavailableView(form).organization}
          embedded={embedded}
        />,
        embedded,
      );
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

  const formElement = (
    <PublicIntakeForm
      publicId={publicId}
      view={buildPublicView(form, consent)}
      renderToken={createRenderToken(publicId, submitKey)}
      submitKey={submitKey}
      embedded={embedded}
      header={<BrandHeader organizationName={form.organization.name} logoSrc={logoSrc} />}
      antibot={{
        provider: antibot.provider,
        siteKey: antibot.provider === "turnstile" ? antibot.turnstileSiteKey : null,
      }}
    />
  );

  if (embedded) {
    return (
      <EmbedFrame>
        <main className="customer-light mx-auto w-full max-w-5xl py-2">{formElement}</main>
      </EmbedFrame>
    );
  }
  return (
    <div className="customer-light min-h-dvh">
      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">{formElement}</main>
    </div>
  );
}

/** Marco de los avisos (pausado, inexistente, ocupado): completo en la página, sin alto fijo en el incrustado. */
function wrap(content: ReactNode, embedded: boolean) {
  return embedded ? <EmbedFrame>{content}</EmbedFrame> : content;
}

/** Lo común del incrustado: fondo transparente, altura según el contenido y el avisador de altura. */
function EmbedFrame({ children }: { children: ReactNode }) {
  return (
    <>
      {/* El fondo del sitio de afuera se ve a través del marco: sin fondo propio y sin alto de pantalla. */}
      <style>{`html,body{background:transparent!important;height:auto!important;min-height:0!important;color-scheme:light}`}</style>
      <div data-testid="intake-embed">{children}</div>
      <EmbedResizer />
    </>
  );
}
