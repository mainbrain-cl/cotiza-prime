import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { getLegalDocument } from "@/lib/legal/documents";

export const metadata: Metadata = {
  title: "Política de privacidad | Cotiza Prime",
  description:
    "Qué datos trata Cotiza Prime, para qué, por cuánto tiempo y cómo ejercer tus derechos. Versión preliminar pendiente de revisión legal.",
};

export default function PrivacyPage() {
  return <LegalPage document={getLegalDocument("privacy")} />;
}
