import type { Metadata } from "next";
import { ResponsePanel } from "@/components/share/response-panel";
import { QuoteView } from "@/components/share/quote-view";
import { ShareBusy, ShareNotFound, ShareUnavailable } from "@/components/share/unavailable";
import { ViewBeacon } from "@/components/share/view-beacon";
import { readShareCustomer } from "@/lib/share/customer";
import { readFrozenLogoDataUrl, readShareLink } from "@/lib/share/gateway";
import { passTokenGate } from "@/lib/share/public-request";
import { isAvailable } from "@/lib/share/read-model";

/**
 * Pantalla pública de la cotización (H-030): la abre el cliente final desde el botón del correo, sin
 * cuenta. La puerta es el token de la dirección. Leer la página es un GET y nunca registra una
 * apertura ni una respuesta: la apertura la registra aparte el aviso `ViewBeacon` desde el navegador
 * (los antivirus que abren los enlaces solos no ejecutan la página). Lo único que un GET sí puede
 * hacer es dejar vencida la cotización si ya pasó su vigencia (`share_link_read` la vence al leer),
 * porque eso no depende de quién la mire.
 *
 * Códigos de estado (desviación declarada, 2026-10-07): esta pantalla responde 200 también para un
 * token inexistente o mal formado y para el límite excedido. `loading.tsx` envía el esqueleto antes
 * de que la página decida, así que `notFound()` ya no puede cambiar el código (se probó: seguía en
 * 200) y una página no puede fijar un 429. La API pública (`/api/v1/public/quote-links/...`) sí
 * responde 404 y 429. El mensaje es el mismo para cualquier causa y la página no se indexa.
 *
 * Metadatos genéricos: ni montos ni el nombre del cliente salen en el título ni en la descripción.
 */
export const metadata: Metadata = {
  title: "Tu cotización",
  description: "Revisa la cotización que recibiste.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

const API_PREFIX = "/api/v1/public/quote-links";
const DECISION_TEXT = { accepted: "aceptada", rejected: "rechazada" } as const;

/** Estados de la cotización en los que el cliente todavía puede responder. */
const RESPONDABLE_STATUSES: ReadonlySet<string> = new Set(["sent", "viewed"]);

function responseDate(respondedAt: string): string | null {
  const date = new Date(respondedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("es-CL", {
    timeZone: "America/Santiago",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function responseNotice(
  response: { decision: "accepted" | "rejected"; respondedAt: string } | null,
): string | null {
  if (!response) return null;
  const date = responseDate(response.respondedAt);
  return `Esta cotización ya fue ${DECISION_TEXT[response.decision]}${date ? ` el ${date}` : ""}.`;
}

export default async function SharedQuotePage({ params }: PageProps<"/c/[token]">) {
  const { token } = await params;

  const gate = await passTokenGate(token);
  if (!gate.ok) return gate.reason === "rate_limited" ? <ShareBusy /> : <ShareNotFound />;

  // Si la base falla, `error.tsx` muestra un mensaje de reintento (nunca un detalle técnico).
  const link = await readShareLink(token);
  if (link.state === "not_found") return <ShareNotFound />;
  if (!isAvailable(link)) {
    return <ShareUnavailable state={link.state} contact={link.contact} />;
  }

  const [customer, logoDataUrl] = await Promise.all([
    readShareCustomer(link),
    readFrozenLogoDataUrl(link),
  ]);

  return (
    <>
      <QuoteView
        document={link.document}
        customer={customer}
        logoDataUrl={logoDataUrl}
        pdfHref={`${API_PREFIX}/${token}/pdf`}
        responseNotice={responseNotice(link.response)}
        responseSlot={
          <ResponsePanel
            apiBase={`${API_PREFIX}/${token}`}
            organizationName={link.document.organization.name}
            contactLines={link.contact.detailLines}
            initialResponse={
              link.response
                ? {
                    decision: link.response.decision,
                    dateText: responseDate(link.response.respondedAt),
                  }
                : null
            }
            canRespond={link.state === "ok" && RESPONDABLE_STATUSES.has(link.quoteStatus)}
          />
        }
      />
      <ViewBeacon viewUrl={`${API_PREFIX}/${token}/view`} />
    </>
  );
}
