"use client";

import { useEffect } from "react";

/** Tokens cuya apertura ya se avisó en esta pestaña (evita el doble aviso del modo estricto de React). */
const announced = new Set<string>();

/**
 * Avisa al servidor que la página se mostró (H-030). Es lo único que registra una apertura: leer la
 * página (un GET) nunca cambia nada, así los antivirus y las vistas previas de los mensajes no
 * cuentan como que el cliente la abrió. No muestra nada y, si falla, no molesta a nadie.
 */
export function ViewBeacon({ viewUrl }: { viewUrl: string }) {
  useEffect(() => {
    if (announced.has(viewUrl)) return;
    announced.add(viewUrl);
    fetch(viewUrl, { method: "POST", keepalive: true, credentials: "same-origin" }).catch(
      () => undefined,
    );
  }, [viewUrl]);
  return null;
}
