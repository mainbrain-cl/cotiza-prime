import { describe, expect, it } from "vitest";
import { quotePdfFileName } from "./file-name";

describe("quotePdfFileName", () => {
  it("usa el número de la cotización", () => {
    expect(quotePdfFileName("COT-2026-0001", 1)).toBe("COT-2026-0001.pdf");
  });
  it("agrega la versión desde la 2", () => {
    expect(quotePdfFileName("COT-2026-0001", 2)).toBe("COT-2026-0001-v2.pdf");
  });
  it("nunca deja caracteres que rompan la cabecera", () => {
    expect(quotePdfFileName('COT "2026"/..\r\n', 1)).toBe("COT--2026------.pdf");
  });
});
