import { describe, expect, it } from "vitest";
import { FALLBACK_INVITER_NAME, FALLBACK_ORGANIZATION_NAME } from "./invitation-names";
import { buildInvitationEmail, type InvitationEmailInput } from "./invitation";

const TOKEN = "A".repeat(43);
const base: InvitationEmailInput = {
  recipientAddress: "nuevo@ejemplo.test",
  fromAddress: "cotizaciones@ejemplo.test",
  inviterName: "Ana Pérez",
  organizationName: "Negocio Demo 1",
  roleLabel: "Comercial",
  roleDescription: "Arma y envía sus propias cotizaciones.",
  expiresAt: "2026-11-06T15:00:00.000Z",
  inviteUrl: `http://localhost:3000/invitacion/${TOKEN}`,
  idempotencyKey: "mail-1",
};

function build(over: Partial<InvitationEmailInput> = {}) {
  const result = buildInvitationEmail({ ...base, ...over });
  if (!result.ok) throw new Error(`debió armarse (${result.code})`);
  return result.message;
}

describe("correo de invitación (H-008)", () => {
  it("dice quién invita, a qué organización, con qué rol, qué puede hacer y hasta cuándo", () => {
    const message = build();
    expect(message.subject).toBe("Ana Pérez te invitó a Negocio Demo 1 en Cotiza Prime");
    expect(message.to).toBe("nuevo@ejemplo.test");
    expect(message.from).toEqual({ name: "Cotiza Prime", address: "cotizaciones@ejemplo.test" });
    expect(message.idempotencyKey).toBe("mail-1");
    for (const body of [message.text, message.html]) {
      expect(body).toContain("Ana Pérez te invitó a Negocio Demo 1 en Cotiza Prime");
      expect(body).toContain("con el rol de Comercial");
      expect(body).toContain("Arma y envía sus propias cotizaciones.");
      expect(body).toContain("06-11-2026"); // dd-mm-aaaa
    }
  });

  it("el botón lleva a /invitacion/{código} y el texto plano trae el mismo enlace", () => {
    const message = build();
    expect(message.html).toContain(`href="http://localhost:3000/invitacion/${TOKEN}"`);
    expect(message.html).toContain("Aceptar la invitación");
    expect(message.text).toContain(
      `Aceptar la invitación: http://localhost:3000/invitacion/${TOKEN}`,
    );
  });

  it("la fecha de vencimiento es la de Chile, no la del servidor", () => {
    // 02:30 UTC del 7 de noviembre sigue siendo el 6 en Chile (UTC-3).
    expect(build({ expiresAt: "2026-11-07T02:30:00.000Z" }).text).toContain("06-11-2026");
  });

  it("el nombre de la organización es texto: se escapa y no se puede usar para meter HTML", () => {
    const message = build({ organizationName: `<script>alert(1)</script> "Tienda" & Cía` });
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.html).toContain("&amp; Cía");
    expect(message.html).toContain("&quot;Tienda&quot;");
  });

  it("lo mismo con el nombre de quien invita", () => {
    const message = build({ inviterName: `<img src=x onerror=alert(1)>` });
    expect(message.html).not.toContain("<img");
    expect(message.html).toContain("&lt;img");
  });

  it("los saltos de línea y caracteres de control del nombre no llegan al asunto (inyección de cabeceras)", () => {
    const message = build({ organizationName: "Mi\r\nBcc: robo@ejemplo.test\tNegocio‮" });
    expect(message.subject).not.toMatch(/[\r\n\t‮]/);
    expect(message.subject).toContain("Mi Bcc: robo@ejemplo.test Negocio");
  });

  it("un nombre larguísimo no rompe el límite del asunto", () => {
    const message = build({ organizationName: "N".repeat(200), inviterName: "J".repeat(200) });
    expect(message.subject.length).toBeLessThanOrEqual(150);
    expect(message.subject.endsWith("en Cotiza Prime")).toBe(true);
  });

  it("rechaza un destinatario o remitente inválido, una dirección que no es URL y una fecha rota", () => {
    for (const over of [
      { recipientAddress: "no-es-correo" },
      { fromAddress: "" },
      { inviteUrl: "esto no es una url" },
      { expiresAt: "ayer" },
    ] as Partial<InvitationEmailInput>[]) {
      expect(buildInvitationEmail({ ...base, ...over }), JSON.stringify(over)).toEqual({
        ok: false,
        code: "invalid_input",
      });
    }
  });

  it("avisa que se puede ignorar si no se esperaba", () => {
    expect(build().text).toContain("Si no esperabas esta invitación");
  });

  it.each([
    ["espacios", " "],
    ["vacío", ""],
    ["un carácter invisible", "\u200b"],
    ["marcas de dirección", "\u202e\u2066"],
    ["saltos de línea", "\r\n\t"],
  ])(
    "un nombre de quien invita de puro «%s» no impide el correo: usa el texto de respaldo",
    (_label, name) => {
      const message = build({ inviterName: name });
      expect(message.subject).toBe(
        `${FALLBACK_INVITER_NAME} te invitó a Negocio Demo 1 en Cotiza Prime`,
      );
      expect(message.text).toContain(`${FALLBACK_INVITER_NAME} te invitó a Negocio Demo 1`);
    },
  );

  it.each([" ", "", "\u200b", "\u202e"])(
    "una organización sin nombre visible (%j) usa el texto de respaldo",
    (name) => {
      const message = build({ organizationName: name });
      expect(message.subject).toBe(
        `Ana Pérez te invitó a ${FALLBACK_ORGANIZATION_NAME} en Cotiza Prime`,
      );
    },
  );
});
