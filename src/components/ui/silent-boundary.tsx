"use client";

import { Component, type ReactNode } from "react";

/**
 * Límite de errores para adornos (fondos animados, efectos): si fallan —por ejemplo, el trozo de código se
 * descarga justo cuando se corta la red—, no se dibuja nada y el resto de la pantalla sigue como estaba.
 * Sin él, un fallo del adorno reemplazaba toda la pantalla por la de error. No se traga el error en silencio: deja un aviso en la
 * consola del navegador (solo el nombre y el mensaje, sin datos de la persona) para poder verlo al depurar.
 */
export class SilentBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.warn(
      "Un adorno de la pantalla no se pudo dibujar y se omitió:",
      error.name,
      error.message,
    );
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
