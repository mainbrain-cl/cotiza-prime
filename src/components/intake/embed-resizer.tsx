"use client";

import { useEffect } from "react";
import { buildResizeMessage, buildScrollMessage } from "@/lib/intake/embed";

/**
 * Avisa al sitio que contiene el formulario (H-093) cuánto mide, para que su marco se ajuste. Lo ÚNICO que
 * emite es `{source, type: "resize", height}` (y, tras enviar, `{source, type: "scroll"}`): nunca datos del formulario ni del visitante ni el identificador. No
 * escucha ningún mensaje de afuera. No dibuja nada.
 *
 * El destino es `*` a propósito: la página no sabe en qué sitio está (lo autoriza `frame-ancestors`) y el
 * mensaje no lleva nada que valga la pena interceptar. Quien lo recibe (el código para pegar) comprueba de
 * dónde viene.
 */
/**
 * Tras enviar con éxito dentro de un marco: pide al sitio de afuera que lleve el marco a la vista (aquí
 * `scrollTo` solo mueve el interior del marco). Segundo y último mensaje permitido; sin ningún dato.
 */
export function requestParentScroll(): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage(buildScrollMessage(), "*");
}

export function EmbedResizer() {
  useEffect(() => {
    if (window.parent === window) return;
    let last = -1;
    const report = () => {
      const message = buildResizeMessage(document.body.getBoundingClientRect().height);
      if (!message || message.height === last) return;
      last = message.height;
      window.parent.postMessage(message, "*");
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);
  return null;
}
