"use client";

import { CircleAlert, Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyLinkButton } from "@/components/intake/copy-link-button";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form-controls";
import { saveEmbedOriginsAction } from "@/lib/intake/builder-actions";
import { MAX_EMBED_ORIGINS, embedOriginProblem } from "@/lib/intake/embed";

const SAVED_TOAST_ID = "intake-embed-saved";
const OFFLINE_MESSAGE =
  "No pudimos comunicarnos con el servidor. Revisa tu conexión; lo que escribiste sigue aquí.";

/**
 * «Poner el formulario en tu sitio web» (H-093). Solo lo ven el Dueño y los Administradores, con el formulario
 * publicado o en pausa. Dos cosas: la lista de sitios donde se puede mostrar (la regla real vive en
 * `isValidEmbedOrigin`; aquí solo se avisa a tiempo, y el servidor y la base la repiten) y el código para
 * pegar. Nada de esto toca el resto del formulario ni pide guardarlo.
 */
export function EmbedPanel({
  tenantId,
  formId,
  initialOrigins,
  snippet,
  paused,
  editable,
}: {
  tenantId: string;
  formId: string;
  initialOrigins: string[];
  /** El código para pegar; `null` si no se pudo armar. Cambia si se crea un enlace nuevo. */
  snippet: string | null;
  paused: boolean;
  editable: boolean;
}) {
  const [saved, setSaved] = useState<string[]>(initialOrigins);
  const [origins, setOrigins] = useState<string[]>(initialOrigins);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = JSON.stringify([...origins].sort()) !== JSON.stringify([...saved].sort());
  const full = origins.length >= MAX_EMBED_ORIGINS;

  function add() {
    const value = draft.trim();
    const found = embedOriginProblem(value);
    if (found) {
      setProblem(found);
      return;
    }
    if (origins.includes(value)) {
      setProblem("Ese sitio ya está en la lista.");
      return;
    }
    if (full) {
      setProblem(`Puedes autorizar hasta ${MAX_EMBED_ORIGINS} sitios.`);
      return;
    }
    setOrigins((current) => [...current, value]);
    setDraft("");
    setProblem(null);
  }

  async function save() {
    if (saving || !editable) return;
    setBanner(null);
    setSaving(true);
    try {
      const result = await saveEmbedOriginsAction(tenantId, formId, origins);
      if (result.status === "error") {
        setBanner(result.message);
        return;
      }
      const stored = result.embedOrigins ?? origins;
      setSaved(stored);
      setOrigins(stored);
      toast.success(result.message, { id: SAVED_TOAST_ID });
    } catch {
      setBanner(OFFLINE_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      data-testid="embed-panel"
      aria-labelledby="embed-title"
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id="embed-title" className="text-lg">
          Ponerlo en tu sitio web
        </h2>
        <p className="text-sm text-fg-muted">
          Pega el código en tu página y tus clientes piden cotización sin salir de tu sitio. Lo que
          escriban llega igual que por el enlace.
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-sm font-semibold text-fg">Sitios autorizados</p>
        <p className="text-sm text-fg-muted">
          Solo los sitios de esta lista pueden mostrar tu formulario: así nadie más lo copia en su
          página. Escribe cada dirección completa, con https:// y sin la barra final ni comodines,
          por ejemplo https://www.tuempresa.cl.
        </p>
        {origins.length === 0 ? (
          <p
            role="status"
            data-testid="embed-empty-warning"
            className="flex items-start gap-2 rounded-sm bg-warning-soft px-3 py-2 text-sm font-medium text-warning"
          >
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            Sin sitios autorizados, el formulario incrustado no carga en ninguna web.
          </p>
        ) : (
          <ul data-testid="embed-origins" className="flex flex-col gap-1.5">
            {origins.map((origin) => (
              <li
                key={origin}
                className="flex min-w-0 items-center justify-between gap-2 rounded-sm bg-surface-2 px-3 py-1.5"
              >
                <span className="min-w-0 font-mono text-sm break-all text-fg">{origin}</span>
                {editable ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Quitar ${origin}`}
                    onClick={() => setOrigins((current) => current.filter((o) => o !== origin))}
                  >
                    <X aria-hidden />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {editable ? (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label="Agregar un sitio"
                error={problem ?? undefined}
                className="min-w-0 flex-1"
              >
                {(control) => (
                  <Input
                    {...control}
                    value={draft}
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://www.tuempresa.cl"
                    maxLength={255}
                    data-testid="embed-origin-input"
                    onChange={(event) => {
                      setDraft(event.target.value);
                      setProblem(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        add();
                      }
                    }}
                  />
                )}
              </Field>
              <Button
                type="button"
                variant="secondary"
                onClick={add}
                data-testid="embed-origin-add"
              >
                <Plus aria-hidden />
                Agregar
              </Button>
            </div>
            <p className="text-xs text-fg-subtle">
              {origins.length} de {MAX_EMBED_ORIGINS} sitios.
            </p>
            {banner ? (
              <p
                role="alert"
                data-testid="embed-banner"
                className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm font-medium text-danger"
              >
                {banner}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                onClick={() => void save()}
                disabled={saving || !dirty}
                aria-disabled={saving || !dirty}
                data-testid="embed-save"
              >
                {saving ? "Guardando…" : "Guardar sitios"}
              </Button>
              {dirty ? (
                <p className="text-sm text-fg-muted" aria-live="polite">
                  Tienes sitios sin guardar.
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-sm font-semibold text-fg">Código para pegar</p>
        {snippet ? (
          <>
            <textarea
              readOnly
              aria-label="Código para pegar en tu sitio web"
              data-testid="embed-snippet"
              rows={8}
              value={snippet}
              spellCheck={false}
              className="w-full resize-y rounded-sm border border-border-strong bg-surface-2 p-3 font-mono text-xs text-fg"
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="flex flex-wrap gap-2">
              <CopyLinkButton
                url={snippet}
                label="Copiar código"
                successMessage="Copiamos el código."
                failMessage="No pudimos copiar solo. Selecciona el código y cópialo a mano."
                testId="embed-copy"
              />
            </div>
          </>
        ) : (
          <p className="text-sm text-fg-muted">
            No pudimos armar el código ahora. Recarga la página en unos minutos.
          </p>
        )}
        <p className="text-sm text-fg-muted">
          Si creas un enlace nuevo, el código que ya pegaste deja de funcionar: tendrás que pegar el
          nuevo.
        </p>
        {paused ? (
          <p className="text-sm text-fg-muted">
            El formulario está en pausa y no recibe solicitudes.
          </p>
        ) : null}
      </div>
    </section>
  );
}
