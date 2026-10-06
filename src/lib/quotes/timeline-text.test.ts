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

  it("un evento desconocido no rompe la pantalla", () => {
    expect(describeQuoteEvent("algo_nuevo")).toBe(UNKNOWN_EVENT_TEXT);
  });
});
