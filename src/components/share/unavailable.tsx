import { CalendarX, FileQuestion, Link2Off, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { ShareContact, ShareUnavailableState } from "@/lib/share/read-model";

/**
 * Lo que ve el cliente cuando el enlace no muestra la cotización (H-030). Vencido, revocado o
 * reemplazado: un mensaje claro con el nombre y el contacto de la organización, SIN la cotización.
 * Enlace inexistente o mal escrito: un mensaje genérico, que no revela nada de nadie.
 */

type Copy = { title: string; body: string; icon: ReactNode };

const ICON = "size-7";

const COPY: Record<ShareUnavailableState, Copy> = {
  expired: {
    title: "Esta cotización ya no está vigente",
    body: "El plazo de esta cotización terminó. Si todavía te interesa, pídele a la empresa que te la actualice.",
    icon: <CalendarX aria-hidden strokeWidth={1.75} className={ICON} />,
  },
  revoked: {
    title: "Este enlace ya no está disponible",
    body: "La empresa dejó sin efecto este enlace. Si necesitas revisar la cotización, pídele uno nuevo.",
    icon: <Link2Off aria-hidden strokeWidth={1.75} className={ICON} />,
  },
  superseded: {
    title: "Hay una versión más nueva de esta cotización",
    body: "La empresa preparó una versión actualizada, así que esta ya no se puede responder. Pídele el enlace de la nueva.",
    icon: <RefreshCw aria-hidden strokeWidth={1.75} className={ICON} />,
  },
};

function Shell({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="customer-light flex min-h-dvh flex-col">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-5 px-4 py-10 text-center">
        <div className="flex size-14 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
          {icon}
        </div>
        <div className="flex flex-col gap-2">
          <h1 data-testid="share-unavailable-title" className="text-xl">
            {title}
          </h1>
          {children}
        </div>
      </main>
    </div>
  );
}

export function ShareUnavailable({
  state,
  contact,
}: {
  state: ShareUnavailableState;
  contact: ShareContact;
}) {
  const copy = COPY[state];
  return (
    <Shell icon={copy.icon} title={copy.title}>
      <p className="text-fg-muted">{copy.body}</p>
      <section
        aria-label="Contacto de la empresa"
        data-testid="share-contact"
        className="mt-3 rounded-md border border-border bg-surface p-4 text-left"
      >
        <p className="text-xs tracking-[0.08em] text-fg-subtle uppercase">Contacta a</p>
        <p className="mt-1 font-semibold break-words">{contact.name}</p>
        {contact.detailLines.map((line) => (
          <p key={line} className="text-sm break-words text-fg-muted">
            {line}
          </p>
        ))}
      </section>
    </Shell>
  );
}

/** Enlace que no existe o está mal escrito: no dice nada más que eso. */
export function ShareNotFound() {
  return (
    <Shell
      icon={<FileQuestion aria-hidden strokeWidth={1.75} className={ICON} />}
      title="No encontramos esta cotización"
    >
      <p className="text-fg-muted" data-testid="share-not-found">
        El enlace no es válido o ya no existe. Revisa que esté completo tal como lo recibiste en el
        correo, o pídele a la empresa que te lo envíe de nuevo.
      </p>
    </Shell>
  );
}

/** Demasiadas solicitudes en poco tiempo. */
export function ShareBusy() {
  return (
    <Shell
      icon={<RefreshCw aria-hidden strokeWidth={1.75} className={ICON} />}
      title="Demasiadas solicitudes"
    >
      <p className="text-fg-muted" data-testid="share-busy">
        Hiciste muchas solicitudes en poco tiempo. Espera un minuto e inténtalo de nuevo.
      </p>
    </Shell>
  );
}
