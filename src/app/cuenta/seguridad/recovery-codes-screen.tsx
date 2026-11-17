"use client";

import { Check, Copy, Download, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { acknowledgeRecoveryCodesAction } from "@/lib/auth/recovery-code-actions";

const COPIED_FEEDBACK_MS = 2000;
/** Cuando «Listo» no pudo llegar al servidor: los códigos siguen en pantalla y se puede reintentar. */
const OFFLINE_RETRY_MESSAGE =
  "No pudimos conectarnos. Tus códigos siguen aquí: revisa tu conexión y vuelve a apretar «Listo».";
/** Cuánto se espera antes de soltar el enlace temporal de la descarga (el navegador ya empezó a guardar el archivo). */
const REVOKE_DOWNLOAD_URL_MS = 10_000;
/** Nombre del archivo que se descarga. */
const DOWNLOAD_FILE_NAME = "codigos-de-respaldo-cotiza-prime.txt";
const DOWNLOAD_HEADER = [
  "Códigos de respaldo de Cotiza Prime",
  "Cada código sirve una sola vez. Guárdalos en un lugar seguro.",
];

/** El texto del archivo: la lista numerada, sin el correo ni nada más de la cuenta. */
function buildDownloadText(codes: readonly string[]): string {
  return [...DOWNLOAD_HEADER, "", ...codes.map((code, index) => `${index + 1}. ${code}`), ""].join(
    "\n",
  );
}

/**
 * Arma el archivo en el NAVEGADOR (un `Blob` con un enlace temporal): los códigos no pasan por el servidor para descargarse
 * ni quedan en una dirección.
 */
function downloadCodes(codes: readonly string[]): void {
  const blob = new Blob([buildDownloadText(codes)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = DOWNLOAD_FILE_NAME;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DOWNLOAD_URL_MS);
}

/**
 * «Tus códigos de respaldo» (H-004b, §3.3): se muestran UNA sola vez, justo después de activar la verificación o de generar
 * códigos nuevos. Los recibe ya formateados («7KQM-3XHP-W2RT») desde la respuesta de la acción: este componente no importa
 * nada de `recovery-code.ts` (es solo de servidor). «Listo» no se habilita hasta marcar la casilla y confirma con
 * `acknowledgeRecoveryCodesAction`; al recargar la página los códigos no vuelven a aparecer.
 */
export function RecoveryCodesScreen({
  codes,
  setId,
  onDone,
}: {
  codes: readonly string[];
  setId: string;
  /** Se llama cuando la base confirmó que la persona guardó los códigos. */
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // El servidor respondió que no puede confirmar este juego (p. ej. se generaron códigos nuevos en otra pestaña): reintentar no
  // sirve, así que se ofrece una salida que limpia la pantalla. Un fallo de red NO la ofrece: ahí los códigos siguen valiendo.
  const [canLeave, setCanLeave] = useState(false);
  const [pending, startTransition] = useTransition();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // El foco pasa al título al aparecer la pantalla (lectores de pantalla y teclado).
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      // Sin permiso del navegador: los códigos siguen a la vista para copiarlos a mano o descargarlos.
    }
  }

  function finish() {
    setError(null);
    startTransition(async () => {
      // Si la red falla, los códigos NO se pierden: siguen en pantalla y «Listo» se puede volver a apretar.
      try {
        const result = await acknowledgeRecoveryCodesAction(setId);
        if (result.status === "ok") onDone();
        else {
          setError(result.message);
          setCanLeave(true);
        }
      } catch {
        setError(OFFLINE_RETRY_MESSAGE);
      }
    });
  }

  return (
    <div className="flex flex-col gap-5" data-testid="recovery-codes-screen">
      <OfflineNotice />
      <h2 ref={headingRef} tabIndex={-1} className="text-md outline-none">
        Tus códigos de respaldo
      </h2>
      <p className="text-fg-muted">
        Solo los verás esta vez. Cada código sirve una sola vez. Si pierdes tu teléfono, entra con
        uno.
      </p>
      <ol
        role="list"
        aria-label="Códigos de respaldo"
        className="grid grid-cols-1 gap-2 rounded-sm border border-border bg-surface-2 p-3 sm:grid-cols-2"
      >
        {codes.map((code, index) => (
          <li key={code} className="flex items-baseline gap-2 py-0.5">
            <span
              aria-hidden
              className="w-6 shrink-0 text-right text-sm text-fg-subtle tabular-nums"
            >
              {index + 1}.
            </span>
            <code data-testid="recovery-code" className="font-mono text-base tracking-wider">
              {code}
            </code>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={copyAll}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copiados" : "Copiar todos"}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => downloadCodes(codes)}>
          <Download aria-hidden />
          Descargar (.txt)
        </Button>
        {/* El cambio de «Copiar todos» a «Copiados» se anuncia a lectores de pantalla sin mover el foco. */}
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? "Códigos copiados." : ""}
        </span>
      </div>
      {error ? <FormAlert>{error}</FormAlert> : null}
      <label className="flex min-h-11 items-start gap-3 text-sm text-fg">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
          className="mt-0.5 size-5 shrink-0 accent-accent"
        />
        <span>Guardé estos códigos en un lugar seguro</span>
      </label>
      <Button
        size="lg"
        onClick={finish}
        disabled={!saved || pending}
        aria-disabled={!saved || pending}
      >
        {pending ? (
          <>
            <Loader2 aria-hidden className="animate-spin" />
            Guardando…
          </>
        ) : (
          "Listo"
        )}
      </Button>
      {canLeave ? (
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
          Cerrar esta pantalla
        </Button>
      ) : null}
    </div>
  );
}
