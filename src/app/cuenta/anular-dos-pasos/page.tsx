import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { AnnulForm } from "./annul-form";

export const metadata: Metadata = {
  title: "Anular la activación · Cotiza Prime",
  // La dirección lleva el código tras el «#» (el navegador no lo manda al servidor), pero igual no se indexa ni se manda a otros sitios.
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/**
 * Tiempo máximo (segundos) de las acciones de servidor de esta pantalla. Una de ellas puede enviar hasta 3 avisos de la
 * activación del segundo paso de 15 segundos cada uno (H-118): 45 s más un margen. Next exige un LITERAL aquí (no una
 * constante importada); una guardia estática (14i) vigila que valga al menos 60. El plazo del hosting debe respetarlo.
 */
export const maxDuration = 60;

/**
 * Anular la activación del segundo paso desde el enlace del correo de aviso (H-118b). Es una pantalla pública, sin sesión.
 * Al ABRIRLA no pasa nada: no lee ningún código, no consulta la base ni pide sesión. Solo explica qué va a pasar. Lo único que
 * ejecuta algo es apretar el botón (una acción de servidor), así un escáner de enlaces o una vista previa del correo no
 * pueden anular nada.
 */
export default function AnnulSecondStepPage() {
  return (
    <AuthCard
      title="¿No fuiste tú?"
      description="Alguien activó la verificación en dos pasos en tu cuenta de Cotiza Prime."
    >
      <AnnulForm />
    </AuthCard>
  );
}
