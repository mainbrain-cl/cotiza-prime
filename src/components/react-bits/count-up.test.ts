import { describe, expect, it } from "vitest";
import { formatCount } from "./count-up";

describe("formatCount", () => {
  it("usa punto como separador de miles", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1250)).toBe("1.250");
    expect(formatCount(1250000)).toBe("1.250.000");
  });

  it("redondea los valores intermedios de la animación", () => {
    expect(formatCount(41.6)).toBe("42");
  });
});
