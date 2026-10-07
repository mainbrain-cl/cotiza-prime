"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";

/**
 * Verificación anti-robot del formulario público (decisión 019). Según el proveedor configurado:
 *  - `turnstile`: el widget de Cloudflare, cargado recién al mostrarse (carga diferida) y solo desde
 *    https://challenges.cloudflare.com. Cada prueba sirve una sola vez: quien lo usa lo vuelve a montar
 *    (con otra `key`) después de cada envío.
 *  - `memory`: un botón de prueba que NUNCA existe en producción (la aplicación no arranca con ese
 *    proveedor allá). Sirve para las pruebas automáticas.
 */

export const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** Valores del adaptador de pruebas (`src/lib/antibot/memory.ts`). */
const MEMORY_PASS_TOKEN = "test-pass";
const MEMORY_FAIL_TOKEN = "test-fail";

type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export type AntibotWidgetProps = {
  provider: "turnstile" | "memory";
  /** Clave pública del widget (solo turnstile). */
  siteKey: string | null;
  /** Acción con que se verifica en el servidor. */
  action: string;
  onToken: (token: string | null) => void;
};

function loadTurnstile(): Promise<TurnstileApi> {
  return new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_SRC}"]`,
    );
    const script = existing ?? document.createElement("script");
    const done = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile"));
    script.addEventListener("load", done, { once: true });
    script.addEventListener("error", () => reject(new Error("turnstile")), { once: true });
    if (!existing) {
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
}

function TurnstileWidget({
  siteKey,
  action,
  onToken,
}: {
  siteKey: string;
  action: string;
  onToken: (token: string | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !container.current) return;
        widgetId = api.render(container.current, {
          sitekey: siteKey,
          action,
          callback: (token: string) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [siteKey, action, onToken]);

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="antibot-turnstile">
      <div ref={container} />
      {failed ? (
        <p role="alert" className="text-sm text-danger">
          No pudimos cargar la verificación. Revisa tu conexión y recarga la página.
        </p>
      ) : null}
    </div>
  );
}

function MemoryWidget({ onToken }: { onToken: (token: string | null) => void }) {
  const [state, setState] = useState<"idle" | "passed" | "failed">("idle");
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-md border border-dashed border-border-strong p-3"
      data-testid="antibot-memory"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-fg">
        <ShieldCheck aria-hidden strokeWidth={1.75} className="size-5 shrink-0" />
        Verificación de prueba (no existe en producción)
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="antibot-memory-pass"
          className="h-11 rounded-sm border border-border-strong bg-surface px-3 text-sm font-semibold text-fg"
          onClick={() => {
            setState("passed");
            onToken(MEMORY_PASS_TOKEN);
          }}
        >
          Confirmar que soy una persona
        </button>
        <button
          type="button"
          data-testid="antibot-memory-fail"
          className="h-11 rounded-sm border border-border-strong bg-surface px-3 text-sm text-fg-muted"
          onClick={() => {
            setState("failed");
            onToken(MEMORY_FAIL_TOKEN);
          }}
        >
          Simular una verificación fallida
        </button>
      </div>
      <p className="text-sm text-fg-muted" role="status" data-testid="antibot-memory-state">
        {state === "passed"
          ? "Verificación lista."
          : state === "failed"
            ? "Verificación fallida a propósito."
            : "Sin verificar."}
      </p>
    </div>
  );
}

export function AntibotWidget({ provider, siteKey, action, onToken }: AntibotWidgetProps) {
  if (provider === "turnstile" && siteKey) {
    return <TurnstileWidget siteKey={siteKey} action={action} onToken={onToken} />;
  }
  if (provider === "memory") return <MemoryWidget onToken={onToken} />;
  return null;
}
