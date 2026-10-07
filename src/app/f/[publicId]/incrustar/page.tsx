import type { Metadata } from "next";
import { PublicIntakeScreen } from "@/components/intake/public-intake-screen";

/**
 * El formulario público para pegar en el sitio web de la organización (H-093): la MISMA pantalla que
 * `/f/[publicId]` (mismo componente, mismos límites y protecciones), sin el marco de afuera, con fondo
 * transparente y sin enlaces a Cotiza Prime. Solo se puede mostrar dentro de los sitios que la organización
 * autorizó: la cabecera `frame-ancestors` de esta ruta la arma `src/proxy.ts` (con `none` si no hay ninguno).
 * Esta página no incluye datos del formulario en ninguna cabecera ni mensaje: solo avisa su altura.
 */
export const metadata: Metadata = {
  title: "Pide una cotización",
  description: "Cuéntanos qué necesitas y te enviaremos una cotización.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function EmbeddedIntakePage({ params }: PageProps<"/f/[publicId]/incrustar">) {
  const { publicId } = await params;
  return <PublicIntakeScreen publicId={publicId} embedded />;
}
