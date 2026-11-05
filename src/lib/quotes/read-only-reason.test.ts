import { describe, expect, it } from "vitest";
import { AUTHOR_GONE_MESSAGE, AUTHOR_UNKNOWN_MESSAGE, readOnlyReason } from "./read-only-reason";

const base = {
  editable: false,
  statusAllowsEdit: true,
  roleCanEdit: true,
  authorName: "María Pérez",
  authorIsActive: true,
};

describe("por qué una cotización queda solo para leer", () => {
  it("si se puede editar, no hay motivo", () => {
    expect(readOnlyReason({ ...base, editable: true })).toBeNull();
  });

  it("el borrador de alguien que sigue en el equipo: solo esa persona lo edita", () => {
    expect(readOnlyReason(base)).toBe(
      "Solo María Pérez puede editar este borrador. Tú puedes verlo.",
    );
  });

  it("el borrador de alguien que ya no está: lo dice, sin prometer que esa persona lo edite", () => {
    const text = readOnlyReason({ ...base, authorIsActive: false });
    expect(text).toBe(AUTHOR_GONE_MESSAGE);
    expect(text).toBe("Quien armó este borrador ya no está en el equipo; queda solo para leer.");
    expect(text).not.toContain("María Pérez");
  });

  it("si no se pudo saber si el autor sigue (la consulta falló), no dice que se fue ni nombra a nadie", () => {
    const text = readOnlyReason({ ...base, authorIsActive: null });
    expect(text).toBe(AUTHOR_UNKNOWN_MESSAGE);
    expect(text).toBe("Solo quien armó este borrador puede editarlo. Tú puedes verlo.");
    expect(text).not.toBe(AUTHOR_GONE_MESSAGE);
    expect(text).not.toContain("María Pérez");
  });

  it("los otros motivos mandan sobre el autor", () => {
    expect(readOnlyReason({ ...base, statusAllowsEdit: false, authorIsActive: false })).toBe(
      "Esta cotización ya no se puede editar.",
    );
    expect(readOnlyReason({ ...base, roleCanEdit: false, authorIsActive: false })).toBe(
      "Tu rol solo permite ver las cotizaciones.",
    );
  });
});
