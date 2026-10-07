import { describe, expect, it } from "vitest";
import { DEFAULT_FIELD_MODES, freeItem, type EditorForm, type EditorItem } from "./builder-model";
import { isFormId, isValidPolicyUrl, validateEditorForm } from "./builder-schema";

const ID = "11111111-1111-4111-8111-111111111111";
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

function item(overrides: Partial<EditorItem> = {}): EditorItem {
  return { ...freeItem(ID), publicName: "Flete", ...overrides };
}

function form(overrides: Partial<EditorForm> = {}): EditorForm {
  return {
    name: "Fletes",
    title: "Pide tu cotización",
    intro: "",
    successMessage: "",
    fields: DEFAULT_FIELD_MODES,
    privacyPolicyUrl: "",
    items: [item()],
    ...overrides,
  };
}

describe("validateEditorForm", () => {
  it("acepta un formulario correcto y lo devuelve limpio", () => {
    const result = validateEditorForm(form({ name: "  Fletes  ", intro: " Hola\r\nmundo " }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("Fletes");
      expect(result.data.intro).toBe("Hola\nmundo");
    }
  });

  it("pide nombre y título", () => {
    const result = validateEditorForm(form({ name: "  ", title: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.name).toBeTruthy();
      expect(result.errors.title).toBeTruthy();
    }
  });

  it("rechaza textos demasiado largos", () => {
    const result = validateEditorForm(
      form({ title: "x".repeat(121), intro: "x".repeat(1001), successMessage: "x".repeat(501) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors)).toEqual(
        expect.arrayContaining(["title", "intro", "successMessage"]),
      );
    }
  });

  it("rechaza caracteres invisibles y de dirección invertida", () => {
    for (const bad of [cp(0x202e), cp(0x200b), cp(0x0007)]) {
      expect(validateEditorForm(form({ title: `Hola${bad}` })).ok).toBe(false);
    }
    // un salto de línea sí vale en la introducción, no en el título
    expect(validateEditorForm(form({ intro: "uno\ndos" })).ok).toBe(true);
    expect(validateEditorForm(form({ title: "uno\ndos" })).ok).toBe(false);
  });

  it("marca el servicio con problemas, con su posición", () => {
    const result = validateEditorForm(
      form({ items: [item(), item({ id: "otro", publicName: "" })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(Object.keys(result.errors).some((k) => k.startsWith("items.1"))).toBe(true);
  });

  it("no acepta modos ni claves fuera de la lista cerrada (ni RUT ni precio)", () => {
    const withRut = { ...form(), fields: { ...DEFAULT_FIELD_MODES, rut: "required" } };
    expect(validateEditorForm(withRut as unknown as EditorForm).ok).toBe(false);
    const withPrice = { ...form(), items: [{ ...item(), unitPriceClp: 45000 }] };
    expect(validateEditorForm(withPrice as unknown as EditorForm).ok).toBe(false);
    const badMode = form({ fields: { ...DEFAULT_FIELD_MODES, phone: "siempre" as never } });
    expect(validateEditorForm(badMode).ok).toBe(false);
  });

  it("acepta como máximo 50 servicios", () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      item({ id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}` }),
    );
    expect(validateEditorForm(form({ items: many })).ok).toBe(false);
  });
});

describe("política de privacidad", () => {
  it("solo https, con dominio y sin caracteres peligrosos", () => {
    expect(isValidPolicyUrl("https://tuempresa.cl/privacidad")).toBe(true);
    expect(isValidPolicyUrl("https://tuempresa.cl:8443/p?x=1#a")).toBe(true);
    for (const bad of [
      "http://tuempresa.cl/p",
      "javascript:alert(1)",
      "https://usuario:clave@tuempresa.cl",
      "https://localhost/p",
      'https://tuempresa.cl/"onload=1',
      "https://tuempresa.cl/<script>",
      "https://tuempresa.cl/a b",
      "//tuempresa.cl",
      "tuempresa.cl",
    ]) {
      expect(isValidPolicyUrl(bad), bad).toBe(false);
    }
  });

  it("vacía vale (sin política propia)", () => {
    expect(validateEditorForm(form({ privacyPolicyUrl: "" })).ok).toBe(true);
    expect(validateEditorForm(form({ privacyPolicyUrl: "http://x.cl" })).ok).toBe(false);
  });
});

describe("isFormId", () => {
  it("reconoce solo UUID", () => {
    expect(isFormId(ID)).toBe(true);
    expect(isFormId("hola")).toBe(false);
    expect(isFormId(undefined)).toBe(false);
    expect(isFormId(`${ID}x`)).toBe(false);
  });
});
