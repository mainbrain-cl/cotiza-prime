import { describe, expect, it } from "vitest";
import {
  DEAD_RESULTS,
  INVITATION_COOKIE_MAX_AGE_SECONDS,
  INVITATION_COOKIE_NAME,
  INVITATION_NOTICES,
  INVITATION_NOTICE_MESSAGES,
  INVITATION_RESULTS,
  INVITED_HINT,
  RETRY_RESULTS,
  alreadyMemberSentence,
  MISSING_CODE_MESSAGE,
  RESULT_MESSAGES,
  acceptResponseSchema,
  invitationCodeSchema,
  invitationSentence,
  invitedRole,
  messageForResult,
  noticeMessage,
  previewResponseSchema,
} from "./accept-model";
import { newInvitationToken } from "./invitation-code";

// Aceptar una invitación (H-009), sin base de datos: la cookie, el formato del código, los mensajes y la forma de
// lo que contesta la base.

const TENANT_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0001";

describe("la cookie del código", () => {
  it("dura una hora y tiene un nombre fijo", () => {
    expect(INVITATION_COOKIE_MAX_AGE_SECONDS).toBe(3600);
    expect(INVITATION_COOKIE_NAME).toBe("cp_invitation");
  });
});

describe("el formato del código", () => {
  it("acepta un código recién generado", () => {
    expect(invitationCodeSchema.safeParse(newInvitationToken()).success).toBe(true);
  });

  it.each([
    ["vacío", ""],
    ["demasiado corto", "abc"],
    ["demasiado largo", "a".repeat(44)],
    ["con caracteres no permitidos", `${"a".repeat(42)}/`],
    ["con espacios", `${"a".repeat(42)} `],
    ["con salto de línea", `${"a".repeat(42)}\n`],
    ["con relleno de base64", `${"a".repeat(42)}=`],
    ["que parece una dirección", "../../etc/passwd"],
  ])("rechaza uno %s", (_name, value) => {
    expect(invitationCodeSchema.safeParse(value).success).toBe(false);
  });

  it("rechaza lo que no es texto", () => {
    expect(invitationCodeSchema.safeParse(undefined).success).toBe(false);
    expect(invitationCodeSchema.safeParse(null).success).toBe(false);
    expect(invitationCodeSchema.safeParse(1234).success).toBe(false);
  });
});

describe("los mensajes", () => {
  const failures = INVITATION_RESULTS.filter((r) => r !== "ok" && r !== "accepted");

  it("hay uno para cada resultado que falla", () => {
    for (const result of failures) {
      expect(messageForResult(result).length, result).toBeGreaterThan(10);
    }
  });

  it("los códigos que ya no sirven dicen a quién pedir otra", () => {
    for (const result of ["revoked", "expired", "used"] as const) {
      expect(DEAD_RESULTS.has(result)).toBe(true);
      expect(RESULT_MESSAGES[result], result).toMatch(/quien te invitó/);
    }
  });

  it("el correo que no coincide y el sin verificar no son definitivos: no borran el código", () => {
    expect(DEAD_RESULTS.has("wrong_email")).toBe(false);
    expect(DEAD_RESULTS.has("unverified")).toBe(false);
    expect(DEAD_RESULTS.has("rate_limited")).toBe(false);
  });

  it("jamás dicen «ya tienes cuenta» ni revelan si el correo existe", () => {
    const all = [
      ...Object.values(RESULT_MESSAGES),
      ...Object.values(INVITATION_NOTICE_MESSAGES),
      MISSING_CODE_MESSAGE,
      INVITED_HINT,
    ].join(" | ");
    expect(all).not.toMatch(/ya tienes (una )?cuenta/i);
    expect(all).not.toMatch(/ya existe/i);
    expect(all).not.toMatch(/no tienes (una )?cuenta/i);
    expect(all).not.toMatch(/ya est[aá] registrad/i);
  });

  it("el de otro correo no nombra ninguna organización", () => {
    expect(RESULT_MESSAGES.wrong_email).toBe(
      "Esta invitación es para otro correo. Ingresa con el correo al que llegó la invitación.",
    );
  });

  it("hay un mensaje para cada aviso de la dirección", () => {
    for (const notice of Object.values(INVITATION_NOTICES)) {
      expect(INVITATION_NOTICE_MESSAGES[notice], notice).toBeTruthy();
    }
  });

  it("el aviso de la dirección: solo los conocidos dan un texto; `__proto__`, `constructor` y otros, nada", () => {
    for (const notice of Object.values(INVITATION_NOTICES)) {
      expect(noticeMessage(notice), notice).toBe(INVITATION_NOTICE_MESSAGES[notice]);
    }
    expect(noticeMessage(INVITATION_NOTICES.changed)).toBe(
      "Ahora se muestra otra invitación. Revisa a qué organización te unes.",
    );
    for (const bad of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "",
      "otro",
      undefined,
      ["invitacion-cambio"],
      42,
    ]) {
      expect(noticeMessage(bad), String(bad)).toBeUndefined();
    }
  });

  it("«Ana te invitó a Negocio 1 como Comercial.»", () => {
    expect(
      invitationSentence({
        inviterName: "Ana",
        organizationName: "Negocio 1",
        roleLabel: "Comercial",
      }),
    ).toBe("Ana te invitó a Negocio 1 como Comercial.");
  });

  it("sin nombre de quien invita, igual se entiende", () => {
    expect(
      invitationSentence({
        inviterName: "  ",
        organizationName: "Negocio 1",
        roleLabel: "Observador",
      }),
    ).toBe("Un miembro del equipo te invitó a Negocio 1 como Observador.");
    expect(
      invitationSentence({
        inviterName: null,
        organizationName: "Negocio 1",
        roleLabel: "Observador",
      }),
    ).toBe("Un miembro del equipo te invitó a Negocio 1 como Observador.");
  });
});

describe("el rol de la invitación", () => {
  it("solo los roles de la matriz", () => {
    expect(invitedRole("sales")).toBe("sales");
    expect(invitedRole("superadmin")).toBeNull();
    expect(invitedRole(undefined)).toBeNull();
  });
});

describe("lo que contesta la base", () => {
  it("acepta la forma de una vista previa lista", () => {
    const parsed = previewResponseSchema.safeParse({
      result: "ok",
      tenant_id: TENANT_ID,
      tenant_name: "Negocio 1",
      inviter_name: null,
      role: "sales",
      expires_at: "2026-11-10T12:00:00Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("acepta la forma de una aceptación", () => {
    const parsed = acceptResponseSchema.safeParse({
      result: "accepted",
      tenant_id: TENANT_ID,
      role: "sales",
      already_member: false,
      reactivated: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("rechaza un resultado desconocido o un identificador que no es UUID", () => {
    expect(previewResponseSchema.safeParse({ result: "quizas" }).success).toBe(false);
    expect(acceptResponseSchema.safeParse({ result: "accepted", tenant_id: "x" }).success).toBe(
      false,
    );
    expect(acceptResponseSchema.safeParse(null).success).toBe(false);
    expect(acceptResponseSchema.safeParse("accepted").success).toBe(false);
  });
});

describe("quien invitó ya no puede invitar (inviter_inactive)", () => {
  it("es un resultado definitivo y manda a pedirle a OTRA persona de la organización", () => {
    expect(INVITATION_RESULTS).toContain("inviter_inactive");
    expect(DEAD_RESULTS.has("inviter_inactive")).toBe(true);
    expect(RESULT_MESSAGES.inviter_inactive).toContain(
      "Pide a otra persona de la organización que te invite de nuevo.",
    );
    expect(RESULT_MESSAGES.inviter_inactive).not.toMatch(/cancelada/);
    expect(messageForResult("inviter_inactive")).toBe(RESULT_MESSAGES.inviter_inactive);
  });

  it("no nombra a la organización", () => {
    expect(RESULT_MESSAGES.inviter_inactive).not.toMatch(/Negocio|Ltda|SpA/);
  });
});

describe("quien ya es miembro", () => {
  it("la frase dice su rol actual y que la invitación no lo cambia", () => {
    expect(alreadyMemberSentence({ organizationName: "Negocio 1", roleLabel: "Observador" })).toBe(
      "Ya eres parte de Negocio 1 como Observador. Esta invitación no cambia tu rol.",
    );
  });

  it("la vista previa acepta los dos campos nuevos", () => {
    const parsed = previewResponseSchema.safeParse({
      result: "ok",
      already_member: true,
      current_role: "viewer",
      tenant_id: TENANT_ID,
      tenant_name: "Negocio 1",
      role: "admin",
    });
    expect(parsed.success).toBe(true);
    expect(previewResponseSchema.safeParse({ result: "ok", current_role: null }).success).toBe(
      true,
    );
  });
});

describe("resultados que se arreglan reintentando", () => {
  it("el límite de intentos y el correo sin verificar no borran el código", () => {
    expect([...RETRY_RESULTS].sort()).toEqual(["rate_limited", "unverified"]);
    for (const result of RETRY_RESULTS) expect(DEAD_RESULTS.has(result)).toBe(false);
  });
});
