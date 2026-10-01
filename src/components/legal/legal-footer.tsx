import { cn } from "@/lib/utils";
import { LegalLinks } from "./legal-page";

/** Pie común con los enlaces legales (H-110). Va al final de cada página pública y de la aplicación. */
export function LegalFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("flex shrink-0 justify-center px-4 py-3", className)}>
      <LegalLinks />
    </footer>
  );
}
