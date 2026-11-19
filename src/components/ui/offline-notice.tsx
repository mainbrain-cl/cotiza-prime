"use client";

import { WifiOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

/** El texto que ven quienes intentan enviar sin red: lo que escribieron sigue en pantalla. */
export const OFFLINE_MESSAGE =
  "Sin conexión. Tus datos siguen aquí; vuelve a intentar cuando recuperes internet.";
/** Con un identificador fijo, apretar el botón varias veces no apila avisos iguales. */
const OFFLINE_TOAST_ID = "offline-submit";

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

/**
 * Si el navegador no tiene red, avisa con un aviso breve y devuelve `true` (quien llama NO debe enviar).
 * Sin esto, la petición del formulario falla sin que nadie la atrape y la pantalla se reemplaza por un
 * error: la persona pierde lo que escribió. `navigator.onLine` en falso es confiable (no hay red); en
 * verdadero no garantiza que haya internet, y ese caso lo cubre el límite de errores de la aplicación.
 */
export function blockIfOffline(event?: { preventDefault: () => void }): boolean {
  if (typeof navigator === "undefined" || navigator.onLine) return false;
  event?.preventDefault();
  toast.error(OFFLINE_MESSAGE, { id: OFFLINE_TOAST_ID });
  return true;
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
      {OFFLINE_MESSAGE}
    </div>
  );
}
