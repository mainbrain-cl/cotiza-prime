import { describe, expect, it } from "vitest";
import { describeQuoteEvent, UNKNOWN_EVENT_TEXT } from "./timeline-text";

describe("texto de la línea de tiempo", () => {
  it("cada evento del envío tiene su texto", () => {
    for (const type of ["created", "sent", "send_failed", "resent"]) {
      expect(describeQuoteEvent(type)).not.toBe(UNKNOWN_EVENT_TEXT);
    }
  });

  it("el rechazo del cliente muestra el motivo, sin datos personales (H-031)", () => {
    expect(describeQuoteEvent("accepted")).toBe("El cliente aceptó la cotización");
    expect(describeQuoteEvent("rejected_by_customer", { reason_code: "price_too_high" })).toBe(
      "El cliente rechazó la cotización: el precio es demasiado alto",
    );
    expect(describeQuoteEvent("rejected_by_customer", { reason_code: "inventado" })).toBe(
      "El cliente rechazó la cotización",
    );
    expect(describeQuoteEvent("rejected_by_customer")).toBe("El cliente rechazó la cotización");
  });

  it("una cotización que nació de una solicitud lo dice (H-090)", () => {
    expect(describeQuoteEvent("created_from_request", { request_id: "x" })).toBe(
      "Creada desde una solicitud",
    );
  });

  it("un precio bloqueado que alguien con permiso cambió dice la línea y de cuánto a cuánto (H-041)", () => {
    expect(
      describeQuoteEvent("locked_price_overridden", {
        count: 1,
        lines: [{ position: 2, catalog_item_id: "x", old_price_clp: 10_000, new_price_clp: 8_000 }],
      }),
    ).toBe("Se cambió un precio bloqueado (línea 2: $10.000 → $8.000)");
    expect(describeQuoteEvent("locked_price_overridden")).toBe("Se cambió un precio bloqueado");
    expect(describeQuoteEvent("locked_price_overridden")).not.toBe(UNKNOWN_EVENT_TEXT);
  });

  it("un evento desconocido no rompe la pantalla", () => {
    expect(describeQuoteEvent("algo_nuevo")).toBe(UNKNOWN_EVENT_TEXT);
  });
});
