import { describe, expect, it } from "vitest";
import { maskEmail, maskPhone, maskRut } from "./mask";

describe("máscaras de la lista", () => {
  it("el correo deja la primera letra y el dominio", () => {
    expect(maskEmail("contacto@ejemplo.test")).toBe("c••••@ejemplo.test");
  });
  it("el teléfono deja los últimos tres dígitos", () => {
    expect(maskPhone("+56 9 1234 5678")).toBe("•••• 678");
  });
  it("el RUT deja los últimos tres dígitos y el verificador", () => {
    expect(maskRut("76086428-5")).toBe("••.•••.428-5");
  });
  it("no revienta con datos raros", () => {
    expect(maskEmail("raro")).toBe("•••••");
    expect(maskPhone("12")).toBe("••••");
    expect(maskRut("no-es-rut")).toBe("••••••••");
  });
});
