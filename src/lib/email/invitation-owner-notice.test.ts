import { describe, expect, it } from "vitest";
import { FALLBACK_INVITER_NAME, FALLBACK_ORGANIZATION_NAME } from "./invitation-names";
import {
  buildInvitationOwnerNotice,
  type InvitationOwnerNoticeInput,
} from "./invitation-owner-notice";

const base: InvitationOwnerNoticeInput = {
  recipientAddress: "duena@ejemplo.test",
  fromAddress: "cotizaciones@ejemplo.test",
  inviterName: "Mixta Doble",
  organizationName: "Negocio Demo 1",
  roleLabel: "Administrador",
  invitedAt: "2026-10-30T15:00:00.000Z",
  teamUrl: "http://localhost:3000/o/aaaa/equipo",
  idempotencyKey: "mail-1",
};

function build(over: Partial<InvitationOwnerNoticeInput> = {}) {
  const result = buildInvitationOwnerNotice({ ...base, ...over });
  if (!result.ok) throw new Error(`debió armarse (${result.code})`);
  return result.message;
}

describe("aviso al Dueño por una invitación (H-008)", () => {
  it("dice quién invitó, a qué organización, con qué rol y cuándo, y lleva el botón a «Tu equipo»", () => {
    const message = build();
    expect(message.to).toBe("duena@ejemplo.test");
    expect(message.subject).toBe(
      "Mixta Doble invitó a una persona a Negocio Demo 1 como Administrador",
    );
    for (const body of [message.text, message.html]) {
      expect(body).toContain("Mixta Doble invitó a una persona a Negocio Demo 1");
      expect(body).toContain("con el rol de Administrador");
      expect(body).toContain("30-10-2026");
    }
    expect(message.html).toContain('href="http://localhost:3000/o/aaaa/equipo"');
    expect(message.text).toContain("Ver tu equipo: http://localhost:3000/o/aaaa/equipo");
    expect(message.idempotencyKey).toBe("mail-1");
  });

  it("no hay ningún campo para el correo del invitado: no puede aparecer en el aviso", () => {
    // El tipo de entrada no lo admite; además, el texto no habla de «correo» de nadie ni lleva una arroba extra.
    const message = build();
    const atSigns = (message.text.match(/@/g) ?? []).length;
    expect(atSigns).toBe(0);
    expect(message.html).not.toContain("mailto:");
  });

  it("los nombres son texto: se escapan y no inyectan cabeceras", () => {
    const message = build({
      organizationName: `<script>alert(1)</script> Tienda`,
      inviterName: "Ana\r\nBcc: robo@ejemplo.test",
    });
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.subject).not.toMatch(/[\r\n]/);
  });

  it("rechaza datos inválidos", () => {
    for (const over of [
      { recipientAddress: "no-es-correo" },
      { fromAddress: "" },
      { teamUrl: "no es url" },
      { invitedAt: "ayer" },
    ] as Partial<InvitationOwnerNoticeInput>[]) {
      expect(buildInvitationOwnerNotice({ ...base, ...over }), JSON.stringify(over)).toEqual({
        ok: false,
        code: "invalid_input",
      });
    }
  });

  it.each([
    ["espacios", " "],
    ["vacío", ""],
    ["un carácter invisible", "\u200b"],
    ["marcas de dirección", "\u202e\u2066"],
  ])(
    "un nombre de quien invita de puro «%s» NO silencia el aviso: usa el texto de respaldo",
    (_label, name) => {
      const message = build({ inviterName: name });
      expect(message.subject).toBe(
        `${FALLBACK_INVITER_NAME} invitó a una persona a Negocio Demo 1 como Administrador`,
      );
      expect(message.text).toContain(
        `${FALLBACK_INVITER_NAME} invitó a una persona a Negocio Demo 1`,
      );
    },
  );

  it.each([" ", "", "\u200b"])(
    "una organización sin nombre visible (%j) tampoco silencia el aviso",
    (name) => {
      const message = build({ organizationName: name });
      expect(message.subject).toBe(
        `Mixta Doble invitó a una persona a ${FALLBACK_ORGANIZATION_NAME} como Administrador`,
      );
    },
  );
});
