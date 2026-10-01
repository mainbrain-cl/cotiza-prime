import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { getLegalDocument } from "@/lib/legal/documents";

export const metadata: Metadata = {
  title: "Términos y condiciones | Cotiza Prime",
  description: "Las reglas de uso de Cotiza Prime, versión preliminar pendiente de revisión legal.",
};

export default function TermsPage() {
  return <LegalPage document={getLegalDocument("terms")} />;
}
