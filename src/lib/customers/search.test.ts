import { describe, expect, it } from "vitest";
import { detectCustomerSearch, escapeLikePattern } from "./search";

describe("detectCustomerSearch", () => {
  it("no busca nada si está vacío", () => {
    expect(detectCustomerSearch("")).toEqual({ kind: "none" });
    expect(detectCustomerSearch("   ")).toEqual({ kind: "none" });
    expect(detectCustomerSearch(undefined)).toEqual({ kind: "none" });
  });

  it("reconoce un RUT completo con o sin puntos y guion", () => {
    for (const typed of ["12.345.678-5", "12345678-5", "123456785", " 12.345.678-5 "]) {
      expect(detectCustomerSearch(typed)).toEqual({ kind: "rut", rut: "12345678-5" });
    }
  });

  it("acepta la K del dígito verificador en minúscula", () => {
    expect(detectCustomerSearch("6.000.000-k")).toMatchObject({ kind: "rut" });
  });

  it("un RUT con dígito incorrecto, o incompleto, se busca como texto", () => {
    expect(detectCustomerSearch("12.345.678-4")).toEqual({ kind: "text", text: "12.345.678-4" });
    expect(detectCustomerSearch("12.345")).toEqual({ kind: "text", text: "12.345" });
  });

  it("reconoce un correo completo y lo normaliza a minúsculas", () => {
    expect(detectCustomerSearch(" ANA.Cliente@Ejemplo.TEST ")).toEqual({
      kind: "email",
      email: "ana.cliente@ejemplo.test",
    });
  });

  it("un correo a medias se busca como texto", () => {
    expect(detectCustomerSearch("ana@")).toEqual({ kind: "text", text: "ana@" });
  });

  it("un nombre, o parte de él, es texto con los espacios ordenados", () => {
    expect(detectCustomerSearch("  Transportes   Ficti ")).toEqual({
      kind: "text",
      text: "Transportes Ficti",
    });
    expect(detectCustomerSearch("Pedro 2")).toMatchObject({ kind: "text" });
  });

  it("corta lo escrito si es demasiado largo", () => {
    const result = detectCustomerSearch("a".repeat(500));
    expect(result.kind === "text" && result.text.length).toBe(100);
  });
});

describe("escapeLikePattern", () => {
  it("escapa los comodines para buscarlos tal cual", () => {
    expect(escapeLikePattern("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
});
