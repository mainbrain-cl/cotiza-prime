import { describe, expect, it } from "vitest";
import {
  ACCOUNT_LINK_BUTTON_LABEL,
  ACCOUNT_LINK_FOOTER,
  ACCOUNT_LINK_SUBJECT,
  buildAccountLinkEmail,
  type AccountLinkEmailInput,
} from "./account-link";

const base: AccountLinkEmailInput = {
  recipientAddress: "nueva@ejemplo.test",
  fromAddress: "cotizaciones@ejemplo.test",
  confirmUrl: "http://localhost:3000/confirmar-correo?token_hash=abc123_-XYZ&type=invite",
  idempotencyKey: "mail-1",
};

function build(over: Partial<AccountLinkEmailInput> = {}) {
  const result = buildAccountLinkEmail({ ...base, ...over });
  if (!result.ok) throw new Error(`debió armarse (${result.code})`);
  return result.message;
}

describe("correo del registro en dos pasos (H-116)", () => {
  it("usa los textos del diseño: asunto, botón y pie", () => {
    const message = build();
    expect(message.subject).toBe("Confirma tu correo para crear tu cuenta en Cotiza Prime");
    expect(message.subject).toBe(ACCOUNT_LINK_SUBJECT);
    expect(message.from).toEqual({ name: "Cotiza Prime", address: "cotizaciones@ejemplo.test" });
    expect(message.to).toBe("nueva@ejemplo.test");
    expect(message.idempotencyKey).toBe("mail-1");
    for (const body of [message.html, message.text]) {
      expect(body).toContain("Confirmar mi correo");
      expect(body).toContain(
        "Si no lo pediste tú, ignora este mensaje: sin tu clic la cuenta no se activa.",
      );
      // Dice cuánto vale y qué viene después, sin prometer nada que no exista.
      expect(body).toContain("1 hora");
      expect(body).toContain("Después elegirás tu nombre y tu contraseña");
    }
    expect(ACCOUNT_LINK_BUTTON_LABEL).toBe("Confirmar mi correo");
    expect(ACCOUNT_LINK_FOOTER).toContain("sin tu clic la cuenta no se activa");
  });

  it("el botón y la versión de texto llevan el MISMO enlace, el de nuestra aplicación", () => {
    const message = build();
    // En el HTML el «&» de la dirección va escapado (`&amp;`): es lo correcto y el navegador lo lee igual.
    expect(message.html).toContain(`href="${base.confirmUrl.replace("&", "&amp;")}"`);
    expect(message.text).toContain(`Confirmar mi correo: ${base.confirmUrl}`);
    // El enlace escrito a la vista (por si el botón no funciona) también está.
    expect(message.html.match(/confirmar-correo\?token_hash=/g)?.length).toBe(2);
  });

  it("el texto de la dirección se escapa en el HTML (nada se interpreta como código)", () => {
    const message = build({
      confirmUrl:
        'http://localhost:3000/confirmar-correo?token_hash=a"><script>x</script>&type=invite',
    });
    expect(message.html).not.toContain("<script>");
  });

  it("no sale sin un código en el enlace, con un enlace que no es web ni con correos mal escritos", () => {
    expect(
      buildAccountLinkEmail({ ...base, confirmUrl: "http://localhost:3000/confirmar-correo" }),
    ).toEqual({ ok: false, code: "invalid_input" });
    expect(buildAccountLinkEmail({ ...base, confirmUrl: "javascript:alert(1)" })).toEqual({
      ok: false,
      code: "invalid_input",
    });
    expect(buildAccountLinkEmail({ ...base, confirmUrl: "no es un enlace" }).ok).toBe(false);
    expect(buildAccountLinkEmail({ ...base, recipientAddress: "no-es-correo" }).ok).toBe(false);
    expect(buildAccountLinkEmail({ ...base, fromAddress: "tampoco" }).ok).toBe(false);
  });
});
