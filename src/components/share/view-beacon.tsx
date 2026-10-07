"use client";

import { useEffect } from "react";
import { APP_ENV, isTestEnv } from "@/lib/env/app-env";

/** Tokens cuya apertura ya se avisó en esta pestaña (evita el doble aviso del modo estricto de React). */
const announced = new Set<string>();

/** Tiempo que la página tiene que seguir a la vista antes de avisar que se abrió. */
export const VIEW_BEACON_DELAY_MS = 2000;

/**
 * ¿Este navegador puede avisar la apertura? Un navegador automatizado (`navigator.webdriver`: los
 * antivirus y las vistas previas que ejecutan la página suelen serlo) no cuenta como cliente. Solo en
 * el entorno de pruebas se permite igual, porque las pruebas de punta a punta usan Playwright, que
 * activa esa marca. En producción nunca se salta.
 */
export function mayAnnounceView(webdriver: boolean, testEnvironment: boolean): boolean {
  return !webdriver || testEnvironment;
}

/**
 * Avisa al servidor que la página se mostró (H-030). Es lo único que registra una apertura: leer la
 * página (un GET) nunca registra nada, así los antivirus y las vistas previas de los mensajes no
 * cuentan como que el cliente la abrió. El aviso sale solo si la pestaña está visible, tras
 * ~2 segundos a la vista y sin navegador automatizado. No muestra nada y, si falla, no molesta a nadie.
 */
export function ViewBeacon({ viewUrl }: { viewUrl: string }) {
  useEffect(() => {
    if (announced.has(viewUrl)) return;
    if (!mayAnnounceView(navigator.webdriver === true, isTestEnv(APP_ENV))) return;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const announce = () => {
      if (announced.has(viewUrl)) return;
      announced.add(viewUrl);
      document.removeEventListener("visibilitychange", onVisibility);
      fetch(viewUrl, { method: "POST", keepalive: true, credentials: "same-origin" }).catch(
        () => undefined,
      );
    };
    const startTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(announce, VIEW_BEACON_DELAY_MS);
    };
    // Si la pestaña se oculta antes de los 2 segundos, se cancela; al volver a verse, se cuenta de nuevo.
    function onVisibility() {
      if (document.visibilityState === "visible") startTimer();
      else clearTimeout(timer);
    }

    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") startTimer();

    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [viewUrl]);
  return null;
}
