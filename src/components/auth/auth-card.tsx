import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { LegalFooter } from "@/components/legal/legal-footer";
import { AnimatedBackdrop } from "@/components/ui/animated-backdrop";

/** Pantalla de ingreso, registro y onboarding: fondo animado y una tarjeta sólida al centro. */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <>
      <main className="relative flex flex-1 items-center justify-center overflow-hidden px-4 py-10 md:py-16">
        <AnimatedBackdrop />
        <div className="relative flex w-full max-w-md animate-enter flex-col gap-6">
          <BrandMark className="justify-center" />
          <section
            aria-labelledby="auth-title"
            className="flex flex-col gap-6 rounded-lg border border-border bg-surface p-6 shadow-3 md:p-8"
          >
            <header className="flex flex-col gap-1.5">
              <h1 id="auth-title" className="text-xl">
                {title}
              </h1>
              {description ? <p className="text-fg-muted">{description}</p> : null}
            </header>
            {children}
          </section>
          {footer ? <div className="text-center text-sm text-fg-muted">{footer}</div> : null}
        </div>
      </main>
      <LegalFooter />
    </>
  );
}
