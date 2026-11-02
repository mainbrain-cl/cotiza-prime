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

  it("un nombre con emojis nunca se corta a media unidad en el asunto y el correo sale igual", () => {
    for (const count of [40, 60]) {
      const emojis = "😀".repeat(count);
      const message = build({ inviterName: emojis, organizationName: emojis });
      // Un emoji partido por la mitad deja una unidad suelta: codificarlo fallaría.
      expect(() => encodeURIComponent(message.subject)).not.toThrow();
      expect(message.subject.length).toBeLessThanOrEqual(150);
      expect(message.subject.endsWith("como Administrador")).toBe(true);
      expect(message.subject).toContain("😀");
    }
  });

  describe("invitación ya aceptada antes de que saliera el aviso", () => {
    const accepted = () =>
      build({ invitationAccepted: true, teamUrl: "http://localhost:3000/o/aaaa" });

    it("dice que la persona ya aceptó y NO promete cancelar ni «ver la invitación»", () => {
      const message = accepted();
      for (const body of [message.text, message.html]) {
        expect(body).toContain(
          "La persona ya aceptó y es Administrador de tu organización. Revisa tu equipo.",
        );
        expect(body).not.toMatch(/cancel/i);
        expect(body).not.toContain("Puedes ver la invitación");
        expect(body).not.toContain("Ver tu equipo");
      }
    });

    it("el botón no promete lo que «Tu equipo» no tiene: lleva al inicio de la organización", () => {
      const message = accepted();
      expect(message.html).toContain("Abrir Cotiza Prime");
      expect(message.html).toContain('href="http://localhost:3000/o/aaaa"');
      expect(message.text).toContain("Abrir Cotiza Prime: http://localhost:3000/o/aaaa");
    });

    it("sigue diciendo quién invitó, a qué organización, el rol y la fecha, y sin el correo del invitado", () => {
      const message = accepted();
      expect(message.subject).toBe(
        "Mixta Doble invitó a una persona a Negocio Demo 1 como Administrador",
      );
      expect(message.text).toContain("con el rol de Administrador, el 30-10-2026");
      expect((message.text.match(/@/g) ?? []).length).toBe(0);
    });

    it("las pendientes y vencidas conservan el texto de cancelar y el botón a «Tu equipo»", () => {
      const message = build();
      expect(message.text).toContain("cancelarla, si no corresponde, en «Tu equipo»");
      expect(message.html).toContain("Ver tu equipo");
    });
  });

  it("una familia de emojis (unida por caracteres invisibles, que se limpian) tampoco rompe el asunto", () => {
    const family = "👨‍👩‍👧‍👦";
    const message = build({ inviterName: family.repeat(60), organizationName: family.repeat(60) });
    expect(message.subject.length).toBeLessThanOrEqual(150);
    expect(() => encodeURIComponent(message.subject)).not.toThrow();
  });

  it("un emoji compuesto (bandera, tono de piel) no queda cortado a la vista en el asunto", () => {
    for (const unit of ["🇨🇱", "👍🏽"]) {
      const message = build({ inviterName: unit.repeat(60), organizationName: unit.repeat(60) });
      expect(message.subject.length).toBeLessThanOrEqual(150);
      // Cada unidad que queda está entera: quitando las unidades completas no sobra nada raro.
      const body = message.subject.replaceAll(unit, "");
      expect(body.replaceAll("…", "")).toBe(" invitó a una persona a  como Administrador");
    }
  });
});
