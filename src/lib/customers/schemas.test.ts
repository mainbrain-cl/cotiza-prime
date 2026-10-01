import { describe, expect, it } from "vitest";
import { customerSchema } from "./schemas";

const valid = {
  kind: "company",
  displayName: "  Transportes Ficticios SpA ",
  rut: "76.086.428-5",
  email: "  Contacto@Ejemplo.TEST ",
  phone: "+56 9 1234 5678",
  address: " Calle Ficticia 123, Santiago ",
};

describe("customerSchema", () => {
  it("acepta un cliente completo y normaliza RUT, correo y espacios", () => {
    const result = customerSchema.parse(valid);
    expect(result).toEqual({
      kind: "company",
      displayName: "Transportes Ficticios SpA",
      rut: "76086428-5",
      email: "contacto@ejemplo.test",
      phone: "+56 9 1234 5678",
      address: "Calle Ficticia 123, Santiago",
    });
  });

  it("solo exige el nombre: lo demás vacío queda en null", () => {
    const result = customerSchema.parse({
      kind: "person",
      displayName: "Ana",
      rut: "",
      email: "",
      phone: "",
      address: "",
    });
    expect(result).toMatchObject({ rut: null, email: null, phone: null, address: null });
  });

  it("rechaza un RUT con dígito verificador incorrecto", () => {
    const result = customerSchema.safeParse({ ...valid, rut: "76.086.428-4" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toMatch(/RUT no es válido/);
  });

  it("rechaza un correo mal escrito, un teléfono raro y un nombre vacío", () => {
    expect(customerSchema.safeParse({ ...valid, email: "sin-arroba" }).success).toBe(false);
    expect(customerSchema.safeParse({ ...valid, phone: "abc" }).success).toBe(false);
    expect(customerSchema.safeParse({ ...valid, displayName: "   " }).success).toBe(false);
  });

  it("rechaza un tipo que no es persona ni empresa", () => {
    expect(customerSchema.safeParse({ ...valid, kind: "otro" }).success).toBe(false);
  });
});
