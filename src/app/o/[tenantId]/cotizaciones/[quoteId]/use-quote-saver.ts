"use client";

import { useCallback, useRef, useState } from "react";
import type { SaveQuoteResult } from "@/lib/quotes/actions";
import { contentKey, type DraftContent } from "@/lib/quotes/editor-model";
import type { SaveQuotePayload } from "@/lib/quotes/schemas";

export type SaverState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "offline"; message: string }
  | Exclude<SaveQuoteResult, { status: "saved" }>;

const OFFLINE_MESSAGE =
  "No pudimos conectarnos. Tus cambios siguen aquí; vuelve a guardar cuando tengas internet.";

/**
 * Guardado de la cotización (cotizaciones-y-calculo.md §6): un guardado a la vez, y lo que se envía
 * es siempre el último estado. Un reintento por mala conexión usa la MISMA clave de guardado, así la
 * base no lo aplica dos veces. La revisión sube con cada guardado; si otra pestaña guardó antes, la
 * base avisa (conflicto) y nunca se sobrescribe en silencio.
 * H-072 (guardado automático) solo agrega un temporizador y el aviso de conexión encima de este hook.
 */
export function useQuoteSaver({
  initialRevision,
  initialSavedKey,
  save,
}: {
  initialRevision: number;
  /** Clave (`contentKey`) del contenido tal como está guardado ahora. */
  initialSavedKey: string;
  save: (payload: SaveQuotePayload) => Promise<SaveQuoteResult>;
}) {
  const [state, setState] = useState<SaverState>({ status: "idle" });
  const [savedKey, setSavedKey] = useState(initialSavedKey);
  // La clave del contenido que el servidor rechazó: sus errores por campo valen solo mientras no se cambie nada (H-041).
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const revision = useRef(initialRevision);
  const inFlight = useRef(false);
  const queued = useRef<DraftContent | null>(null);
  const lastAttempt = useRef<{ key: string; saveId: string } | null>(null);

  const run = useCallback(
    async (content: DraftContent) => {
      if (inFlight.current) {
        queued.current = content;
        return;
      }
      inFlight.current = true;
      setState({ status: "saving" });
      let current: DraftContent | null = content;
      try {
        while (current) {
          const key = contentKey(current);
          const saveId =
            lastAttempt.current?.key === key ? lastAttempt.current.saveId : crypto.randomUUID();
          lastAttempt.current = { key, saveId };
          let result: SaveQuoteResult;
          try {
            result = await save({ ...current, saveId, expectedRevision: revision.current });
          } catch {
            setState({ status: "offline", message: OFFLINE_MESSAGE });
            queued.current = null;
            return;
          }
          // TODO(H-072): si la respuesta se pierde (la base guardó pero el navegador no se enteró) y se
          // reintenta con otra clave de guardado, la base ve una revisión vieja y hoy se muestra el
          // falso aviso de "cambió en otra pestaña". Al recibir un conflicto, comparar el contenido
          // guardado con el propio antes de avisar.
          if (result.status !== "saved") {
            setFailedKey(key);
            setState(result);
            queued.current = null;
            return;
          }
          revision.current = result.revision;
          lastAttempt.current = null;
          setSavedKey(key);
          setFailedKey(null);
          setState({ status: "saved" });
          current = queued.current;
          queued.current = null;
        }
      } finally {
        inFlight.current = false;
      }
    },
    [save],
  );

  return { state, savedKey, failedKey, saving: state.status === "saving", run };
}
