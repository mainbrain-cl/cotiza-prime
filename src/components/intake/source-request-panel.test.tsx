// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SourceRequestPanel } from "@/lib/intake/convert-queries";
import { SourceRequestPanelView } from "./source-request-panel";

// «Solicitud original» (H-090/H-042): el aviso de los servicios que no se cargaron dice la verdad de por qué y, a quien tiene una lista de
// servicios, no le sugiere saltársela con una línea libre.
const panel = (count: number): SourceRequestPanel => ({
  requestId: "r",
  anonymized: false,
  createdAt: "2026-11-20T15:00:00Z",
  services: [],
  message: null,
  serviceAddress: null,
  comuna: null,
  desiredDate: null,
  notLoaded: Array.from({ length: count }, (_, i) => ({
    name: `Servicio ${i + 1}`,
    unit: "service",
    quantityMilli: 1_000,
    catalogItemId: null,
  })) as never,
  seedLines: [],
  unreadable: false,
});
const html = (count: number, catalogLimited?: boolean) =>
  renderToStaticMarkup(
    createElement(SourceRequestPanelView, { tenantId: "t", panel: panel(count), catalogLimited }),
  ).replace(/<!-- -->/g, "");

describe("el aviso de servicios que no se cargaron", () => {
  it("dice que ya no están activos o no están entre los que puede cotizar, y sugiere la línea libre", () => {
    const text = html(2);
    expect(text).toContain(
      "estos servicios porque ya no están activos en tu catálogo o no están entre los servicios que puedes cotizar",
    );
    expect(text).toContain("Servicio 1, Servicio 2");
    expect(text).toContain("Agrégalo como línea libre si todavía lo vas a cotizar.");
  });
  it("en singular", () => {
    expect(html(1)).toContain(
      "este servicio porque ya no está activo en tu catálogo o no está entre los servicios que puedes cotizar",
    );
  });
  it("a quien tiene una lista de servicios no le sugiere la línea libre", () => {
    const text = html(1, true);
    expect(text).toContain("Servicio 1");
    expect(text).not.toContain("línea libre");
  });
  it("sin servicios sin cargar no hay aviso", () => {
    expect(html(0)).not.toContain("No cargamos");
  });
});
