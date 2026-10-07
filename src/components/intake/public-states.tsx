import { FileQuestion, PauseCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { PublicOrganization } from "@/lib/intake/public-view";

/**
 * Lo que ve quien abre un formulario público que no puede llenar: pausado (con el contacto de la
 * organización), inexistente o mal escrito (mensaje genérico, que no revela nada de nadie) o con demasiadas
 * lecturas desde su IP. Sin datos internos.
 */

const ICON = "size-7";

function Shell({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="customer-light flex min-h-dvh flex-col">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-5 px-4 py-10 text-center">
        <div className="flex size-14 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
          {icon}
        </div>
        <div className="flex w-full flex-col gap-2">
          <h1 data-testid="intake-state-title" className="text-xl">
            {title}
          </h1>
          {children}
        </div>
      </main>
    </div>
  );
}

/** Formulario en pausa (o sin aviso de privacidad armable): con el contacto de la organización. */
export function IntakeUnavailable({ organization }: { organization: PublicOrganization }) {
  const lines = [organization.contactEmail, organization.contactPhone].filter(
    (line): line is string => Boolean(line),
  );
  return (
    <Shell
      icon={<PauseCircle aria-hidden strokeWidth={1.75} className={ICON} />}
      title="Este formulario no está recibiendo solicitudes"
    >
      <p className="text-fg-muted" data-testid="intake-unavailable">
        {organization.name} lo pausó por ahora. Si necesitas una cotización, escríbele directo.
      </p>
      {lines.length > 0 ? (
        <section
          aria-label="Contacto de la organización"
          data-testid="intake-contact"
          className="mt-3 rounded-md border border-border bg-surface p-4 text-left"
        >
          <p className="text-xs tracking-[0.08em] text-fg-subtle uppercase">Contacta a</p>
          <p className="mt-1 font-semibold break-words">{organization.name}</p>
          {lines.map((line) => (
            <p key={line} className="text-sm break-words text-fg-muted">
              {line}
            </p>
          ))}
        </section>
      ) : null}
    </Shell>
  );
}

/** Identificador inexistente, mal escrito o de un formulario que no se publica: mismo mensaje siempre. */
export function IntakeNotFound() {
  return (
    <Shell
      icon={<FileQuestion aria-hidden strokeWidth={1.75} className={ICON} />}
      title="No encontramos este formulario"
    >
      <p className="text-fg-muted" data-testid="intake-not-found">
        El enlace no es válido o el formulario ya no existe. Revisa que esté completo o pídele a la
        empresa que te lo envíe de nuevo.
      </p>
    </Shell>
  );
}

/** Demasiadas lecturas en poco tiempo desde la misma IP. */
export function IntakeBusy() {
  return (
    <Shell
      icon={<RefreshCw aria-hidden strokeWidth={1.75} className={ICON} />}
      title="Demasiadas solicitudes"
    >
      <p className="text-fg-muted" data-testid="intake-busy">
        Hiciste muchas solicitudes en poco tiempo. Espera un minuto e inténtalo de nuevo.
      </p>
    </Shell>
  );
}
