"use client";

import { WifiOff } from "lucide-react";
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

const getOnline = () => navigator.onLine;
// En el servidor no se sabe: se asume con conexión para que el HTML inicial no muestre el aviso.
const getServerOnline = () => true;

/** Estado de conexión del navegador. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, getOnline, getServerOnline);
}

/** Aviso de "sin conexión" para los formularios: solo aparece cuando el navegador no tiene red. */
export function OfflineNotice() {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      data-testid="offline-notice"
      className="flex items-center gap-2 rounded-sm bg-warning-soft px-3 py-2.5 text-sm font-medium text-warning"
    >
      <WifiOff aria-hidden className="size-4 shrink-0" />
      Sin conexión. Tus datos siguen aquí; vuelve a intentar cuando recuperes internet.
    </div>
  );
}
