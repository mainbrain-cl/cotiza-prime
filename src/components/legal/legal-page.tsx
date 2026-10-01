import Link from "next/link";
import { SafeMarkdown } from "@/components/legal/safe-markdown";
import type { LegalDocument } from "@/lib/legal/documents";

const LEGAL_LINKS = [
  { href: "/terminos", label: "Términos y condiciones" },
  { href: "/privacidad", label: "Política de privacidad" },
] as const;

const dateFormatter = new Intl.DateTimeFormat("es-CL", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(isoDate: string): string {
  return dateFormatter.format(new Date(`${isoDate}T00:00:00Z`)).replaceAll("/", "-");
}

/** Enlaces a los textos legales. Pensado para el pie de cualquier página (H-110). */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Información legal" className={className}>
      <ul className="flex flex-wrap gap-x-6 text-sm">
        {LEGAL_LINKS.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="inline-flex min-h-11 items-center text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function LegalPage({ document }: { document: LegalDocument }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto w-full max-w-[65ch] px-4 py-10 sm:py-16">
        <Link
          href="/"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Volver al inicio
        </Link>
        <p className="mt-6 mb-4 text-sm text-muted-foreground" data-testid="legal-version">
          Versión <span className="font-mono">{document.version}</span> · Publicada el{" "}
          <time dateTime={document.publishedOn}>{formatDate(document.publishedOn)}</time>
        </p>
        <SafeMarkdown source={document.content} />
        <footer className="mt-12 border-t border-border pt-6">
          <LegalLinks />
        </footer>
      </main>
    </div>
  );
}
