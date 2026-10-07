import { describe, expect, it } from "vitest";
import { responseHeadline, responseReason, type QuoteResponseView } from "./response-text";

const base: QuoteResponseView = {
  decision: "accepted",
  respondedAt: "2026-10-05T15:00:00Z",
  acceptorName: "Ana Pérez",
  reasonCode: null,
  reasonText: null,
  unreadable: false,
};

describe("respuesta del cliente en el detalle de la cotización (H-031)", () => {
  it("aceptada: «Aceptada por <nombre> el dd-mm-aaaa»", () => {
    expect(responseHeadline(base, "05-10-2026")).toBe("Aceptada por Ana Pérez el 05-10-2026");
    expect(responseReason(base)).toBeNull();
  });

  it("aceptada con el nombre ilegible: no inventa uno", () => {
    expect(responseHeadline({ ...base, acceptorName: null, unreadable: true }, "05-10-2026")).toBe(
      "Aceptada por el cliente el 05-10-2026",
    );
  });

  it("rechazada: el motivo sale con el texto de la lista", () => {
    const rejected: QuoteResponseView = {
      ...base,
      decision: "rejected",
      acceptorName: null,
      reasonCode: "price_too_high",
    };
    expect(responseHeadline(rejected, "05-10-2026")).toBe("Rechazada por el cliente el 05-10-2026");
    expect(responseReason(rejected)).toBe("El precio es demasiado alto");
  });
});
