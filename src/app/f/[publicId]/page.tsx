import type { Metadata } from "next";
import { PublicIntakeScreen } from "@/components/intake/public-intake-screen";

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
  return <PublicIntakeScreen publicId={publicId} embedded={false} />;
}
