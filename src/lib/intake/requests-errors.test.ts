import { describe, expect, it } from "vitest";
import { REQUEST_GENERIC_FAILURE, REQUEST_NOT_FOUND, mapRequestError } from "./requests-errors";

describe("mapRequestError", () => {
  it("sin permiso (42501) dice quién sí puede, según la acción", () => {
    expect(mapRequestError({ code: "42501" }, "assign")).toEqual({
      kind: "forbidden",
      message: "Solo el Dueño y los Administradores pueden asignar solicitudes.",
    });
    expect(mapRequestError({ code: "42501" }, "discard").message).toMatch(/a cargo/);
    expect(mapRequestError({ code: "42501" }, "restore").message).toMatch(/a cargo/);
    expect(mapRequestError({ code: "42501" }, "anonymize").message).toMatch(/eliminar los datos/);
  });

  it("no existe en esta organización (CP404): mismo mensaje que si nunca existió", () => {
    expect(mapRequestError({ code: "CP404", message: "request_not_found" }, "assign")).toEqual({
      kind: "not_found",
      message: REQUEST_NOT_FOUND,
    });
  });

  it("estado que no admite el cambio (CP423) pide recargar", () => {
    const mapped = mapRequestError({ code: "CP423", message: "not_assignable" }, "assign");
    expect(mapped.kind).toBe("state");
    expect(mapped.message).toMatch(/Recarga/);
  });

  it("explica a quién no se puede asignar y la nota inválida", () => {
    expect(
      mapRequestError({ code: "CP422", message: "assignee_not_eligible" }, "assign").message,
    ).toMatch(/Elige a otra/);
    expect(mapRequestError({ code: "CP422", message: "invalid_note" }, "discard").message).toMatch(
      /nota/,
    );
  });

  it("nunca deja pasar el texto técnico de la base", () => {
    const mapped = mapRequestError(
      { code: "XX000", message: "duplicate key value violates unique constraint" },
      "assign",
    );
    expect(mapped).toEqual({ kind: "other", message: REQUEST_GENERIC_FAILURE });
    for (const code of ["42501", "CP404", "CP422", "CP423", "", undefined]) {
      const text = mapRequestError(
        { code, message: "select * from intake_requests" },
        "assign",
      ).message;
      expect(text).not.toMatch(/select|intake_requests|constraint/i);
    }
  });
});
