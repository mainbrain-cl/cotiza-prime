import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONSENT_TEMPLATE_V1,
  CONSENT_TEMPLATE_VERSION,
  ConsentNoticeError,
  buildConsentNotice,
  consentTextSha256,
} from "./consent-notice";

const INPUT = { organizationName: "Fletes Andes SpA", contactEmail: "contacto@fletesandes.cl" };

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("texto de consentimiento v1", () => {
  it("la versión es v1", () => {
    expect(CONSENT_TEMPLATE_VERSION).toBe("v1");
  });

  it("el texto con huecos de la v1 no cambia sin subir la versión", () => {
    // Si esta prueba falla: no edites la constante. Crea v2 (texto y versión nuevos) y conserva v1.
    expect(sha(CONSENT_TEMPLATE_V1)).toBe(
      "a430a07ad98959ce029a50a48ebb0e4786c585af362d4214986dea4cd3db3d57",
    );
  });

  it("el texto armado de v1 está amarrado a su huella", () => {
    const notice = buildConsentNotice(INPUT);
    expect(notice.templateVersion).toBe("v1");
    expect(notice.text).toBe(
      "Tus datos los recibirá Fletes Andes SpA (contacto@fletesandes.cl) para responder tu solicitud de cotización. " +
        "Se guardan hasta 12 meses si no se concreta. " +
        "Puedes pedir acceso o supresión en contacto@fletesandes.cl. " +
        "Cotiza Prime los procesa por encargo de Fletes Andes SpA.",
    );
    expect(consentTextSha256(notice)).toBe(
      "430947556b4f811800d902ffe4d84a6d031606229a05d587db15ec6cc94b7a96",
    );
  });
});

describe("buildConsentNotice", () => {
  it("normaliza espacios y NFC del nombre", () => {
    const notice = buildConsentNotice({
      organizationName: `  Mu${String.fromCodePoint(0x006e, 0x0303)}oz   y  Cía  `,
      contactEmail: " a@b.cl ",
    });
    expect(notice.text).toContain("recibirá Muñoz y Cía (a@b.cl)");
  });

  it("incluye el enlace a la política solo si es https", () => {
    const notice = buildConsentNotice({
      ...INPUT,
      privacyPolicyUrl: "https://fletesandes.cl/privacidad",
    });
    expect(notice.privacyPolicyUrl).toBe("https://fletesandes.cl/privacidad");
    expect(buildConsentNotice({ ...INPUT, privacyPolicyUrl: null }).privacyPolicyUrl).toBeNull();
    expect(buildConsentNotice({ ...INPUT, privacyPolicyUrl: "  " }).privacyPolicyUrl).toBeNull();
  });

  it.each([
    "http://fletesandes.cl/privacidad",
    "javascript:alert(1)",
    "data:text/html,x",
    "ftp://x.cl",
    "no es una url",
    "https://usuario:clave@x.cl/p",
    "https://x.cl/p\nSet-Cookie: a=b",
  ])("rechaza la política %j", (url) => {
    expect(() => buildConsentNotice({ ...INPUT, privacyPolicyUrl: url })).toThrow(
      ConsentNoticeError,
    );
  });

  it.each([
    ["organizationName", ""],
    ["organizationName", "   "],
    ["organizationName", "a".repeat(121)],
    ["organizationName", `Banco${String.fromCodePoint(0x202e)}`],
    ["contactEmail", ""],
    ["contactEmail", "a@b.cl\nBcc: x@y.cl"],
    ["contactEmail", "a".repeat(255)],
  ])("rechaza %s = %j", (field, value) => {
    expect(() => buildConsentNotice({ ...INPUT, [field]: value })).toThrow(ConsentNoticeError);
  });

  it("lo que escribe la organización no se interpreta como hueco ni como patrón", () => {
    const notice = buildConsentNotice({
      organizationName: "{contact} $& $1",
      contactEmail: "a@b.cl",
    });
    expect(notice.text).toContain("recibirá {contact} $& $1 (a@b.cl)");
    expect(notice.text.match(/\$&/g)).toHaveLength(2);
  });
});

describe("consentTextSha256", () => {
  it("cambia si cambia el texto, el contacto o el enlace", () => {
    const base = consentTextSha256(buildConsentNotice(INPUT));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(consentTextSha256(buildConsentNotice({ ...INPUT, organizationName: "Otra" }))).not.toBe(
      base,
    );
    expect(consentTextSha256(buildConsentNotice({ ...INPUT, contactEmail: "x@y.cl" }))).not.toBe(
      base,
    );
    expect(
      consentTextSha256(buildConsentNotice({ ...INPUT, privacyPolicyUrl: "https://x.cl/p" })),
    ).not.toBe(base);
  });

  it("es determinista", () => {
    expect(consentTextSha256(buildConsentNotice(INPUT))).toBe(
      consentTextSha256(buildConsentNotice(INPUT)),
    );
  });
});
