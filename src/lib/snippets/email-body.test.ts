import { describe, expect, it } from "vitest";
import { MAX_BODY_LENGTH } from "@/lib/email/basic-format";
import {
  emailSnippetOptions,
  emailVariableValues,
  initialEmailBody,
  isEmailBodyEdited,
} from "./email-body";

const values = emailVariableValues({
  customerName: "Distribuidora Maule Ltda.",
  quoteNumber: "COT-2026-0043 v2",
  senderName: "Juan Pérez",
  organizationName: "Transportes Andes SpA",
});
const row = (name: string, body: string, isDefault = false, kind = "email_body" as const) => ({
  id: `id-${name}`,
  kind,
  name,
  body,
  isDefault,
});

describe("emailSnippetOptions (los textos de correo con los datos de esta cotización, H-048b)", () => {
  it("completa las cuatro variables con los datos de la cotización", () => {
    const [option] = emailSnippetOptions(
      [
        row(
          "Saludo",
          "Estimado/a {{cliente}}: adjuntamos la {{numero}}.\n\n{{remitente}}\n{{organizacion}}",
        ),
      ],
      values,
    );
    expect(option.text).toBe(
      "Estimado/a Distribuidora Maule Ltda.: adjuntamos la COT-2026-0043 v2.\n\nJuan Pérez\nTransportes Andes SpA",
    );
    expect(option.text).not.toContain("{{");
  });

  it("solo ofrece los textos de correo (no condiciones, exclusiones ni notas)", () => {
    const options = emailSnippetOptions(
      [
        row("Correo", "Hola"),
        row("Cond", "Valores sin IVA", false, "conditions" as never),
        row("Excl", "No incluye", false, "exclusions" as never),
      ],
      values,
    );
    expect(options.map((o) => o.name)).toEqual(["Correo"]);
  });

  it("un cliente llamado {{numero}} no se vuelve a completar: queda escrito tal cual, con las llaves separadas", () => {
    const hostile = emailVariableValues({
      customerName: "{{numero}}",
      quoteNumber: "COT-1",
      senderName: "Ana",
      organizationName: "Org",
    });
    const [option] = emailSnippetOptions([row("Saludo", "Hola {{cliente}}, {{numero}}")], hostile);
    expect(option.text).toBe("Hola { { numero } }, COT-1");
    expect(option.text).not.toContain("{{");
  });

  it("un nombre con enlace o negrita no se vuelve enlace ni negrita", () => {
    const sneaky = emailVariableValues({
      customerName: "[Paga aquí](https://malo.ejemplo)",
      quoteNumber: "COT-1",
      senderName: "**Ana**",
      organizationName: "Org",
    });
    const [option] = emailSnippetOptions([row("Saludo", "{{cliente}} {{remitente}}")], sneaky);
    expect(option.text).not.toContain("](");
    expect(option.text).not.toContain("**");
  });

  it("un texto viejo con una variable dentro de la dirección de un enlace no se ofrece (revisión de Aarón al PR #67)", () => {
    const hostile = emailVariableValues({
      customerName: "https://malo.ejemplo/pago",
      quoteNumber: "COT-1",
      senderName: "Ana",
      organizationName: "Org",
    });
    const options = emailSnippetOptions(
      [
        row("Peligroso", "[Mira]({{cliente}})"),
        row("Peligroso 2", "[Mira](https://{{organizacion}}/x)"),
        row("Peligroso 3", "Pago: [aquí]({{cliente}})"),
        row("Bien", "Hola {{cliente}}, cotización {{numero}}."),
      ],
      hostile,
    );
    expect(options.map((option) => option.name)).toEqual(["Bien"]);
  });

  it("si completado ya no cabe en el correo, no se ofrece", () => {
    const big = "x".repeat(MAX_BODY_LENGTH - 5);
    expect(emailSnippetOptions([row("Largo", `${big} {{cliente}}`)], values)).toEqual([]);
    expect(emailSnippetOptions([row("Cabe", big)], values)).toHaveLength(1);
  });

  it("si el formato básico lo rechazaría, no se ofrece (un enlace que muestra otra dirección)", () => {
    const bad = "[https://uno.ejemplo](https://otro.ejemplo)";
    expect(emailSnippetOptions([row("Engañoso", bad), row("Bien", "Hola")], values)).toEqual([
      expect.objectContaining({ name: "Bien" }),
    ]);
  });
});

describe("initialEmailBody e isEmailBodyEdited", () => {
  const options = emailSnippetOptions(
    [row("Uno", "Texto uno"), row("Inicial", "Texto inicial de {{organizacion}}", true)],
    values,
  );
  it("parte con el texto inicial de la organización; sin él, con el de siempre", () => {
    expect(initialEmailBody(options, "El de siempre")).toBe(
      "Texto inicial de Transportes Andes SpA",
    );
    expect(
      initialEmailBody(
        options.filter((o) => !o.isDefault),
        "El de siempre",
      ),
    ).toBe("El de siempre");
    expect(initialEmailBody([], "El de siempre")).toBe("El de siempre");
  });
  it("detecta si se editó lo que estaba puesto", () => {
    expect(isEmailBodyEdited("igual", "igual")).toBe(false);
    expect(isEmailBodyEdited("igual.", "igual")).toBe(true);
  });
});
