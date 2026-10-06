import { describe, expect, it } from "vitest";
import { describeQuoteEvent, UNKNOWN_EVENT_TEXT } from "./timeline-text";

describe("texto de la línea de tiempo", () => {
  it("cada evento del envío tiene su texto", () => {
    for (const type of ["created", "sent", "send_failed", "resent"]) {
      expect(describeQuoteEvent(type)).not.toBe(UNKNOWN_EVENT_TEXT);
    }
  });

  it("un evento desconocido no rompe la pantalla", () => {
    expect(describeQuoteEvent("algo_nuevo")).toBe(UNKNOWN_EVENT_TEXT);
  });
});
