import { describe, expect, it } from "vitest";
import {
  CONFLICT_MESSAGE,
  GENERIC_FAILURE,
  NO_PERMISSION,
  mapBuilderError,
} from "./builder-errors";

describe("mapBuilderError", () => {
  it("un choque de revisión pide recargar sin perder lo escrito", () => {
    const mapped = mapBuilderError({ code: "CP409", message: "revision_conflict" });
    expect(mapped.kind).toBe("conflict");
    expect(mapped.message).toBe(CONFLICT_MESSAGE);
    expect(mapped.message).toContain("Recarga");
  });

  it("sin permiso", () => {
    expect(mapBuilderError({ code: "42501", message: "forbidden" })).toEqual({
      kind: "forbidden",
      message: NO_PERMISSION,
    });
  });

  it("publicar sin servicios explica qué falta", () => {
    const mapped = mapBuilderError({ code: "CP422", message: "needs_item" });
    expect(mapped.message).toContain("al menos un servicio");
  });

  it("publicar sin correo de contacto dice cómo corregirlo y a dónde ir", () => {
    const mapped = mapBuilderError({ code: "CP422", message: "needs_contact_email" });
    expect(mapped.message).toContain("correo de contacto");
    expect(mapped.fixPath).toBe("configuracion/empresa");
    expect(mapped.fixLabel).toBeTruthy();
  });

  it("el tope de formularios muestra el máximo", () => {
    expect(mapBuilderError({ code: "CP422", message: "too_many_forms" }).message).toContain("20");
  });

  it("nunca muestra el texto técnico de la base", () => {
    for (const error of [
      { code: "XX000", message: "relation public.intake_forms does not exist" },
      { code: "CP422", message: "invalid_fields" },
      { code: "CP404", message: "form_not_found" },
      { code: null, message: null },
    ]) {
      const text = mapBuilderError(error).message;
      expect(text).not.toMatch(/relation|invalid_|form_not_found|public\./);
    }
    expect(mapBuilderError({ code: "XX000", message: "boom" }).message).toBe(GENERIC_FAILURE);
  });
});
