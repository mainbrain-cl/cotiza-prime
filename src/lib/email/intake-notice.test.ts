import { describe, expect, it } from "vitest";
import { buildIntakeNotice } from "./intake-notice";

const base = {
  recipientAddress: "ana@ejemplo.test",
  fromAddress: "no-responder@ejemplo.test",
  formName: "Fletes web",
  appUrl: "http://localhost:3000/o/11111111-1111-4111-8111-111111111111/solicitudes",
};

describe("aviso al equipo del formulario público", () => {
  it("«Llegó una solicitud»: asunto, botón y nada del visitante", () => {
    const result = buildIntakeNotice({ ...base, kind: "request_received" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.subject).toBe("Llegó una solicitud");
    expect(result.message.to).toBe("ana@ejemplo.test");
    expect(result.message.html).toContain("Ver las solicitudes");
    expect(result.message.html).toContain(base.appUrl);
    expect(result.message.text).toContain("Fletes web");
    expect(result.message.html).toContain("No lleva datos de quien llenó el formulario");
  });

  it("«Te asignaron una solicitud»: asunto, botón a la solicitud y nada del visitante", () => {
    const result = buildIntakeNotice({ ...base, kind: "request_assigned" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.subject).toBe("Te asignaron una solicitud");
    expect(result.message.html).toContain("Ver la solicitud");
    expect(result.message.html).toContain(base.appUrl);
    expect(result.message.text).toContain("Fletes web");
    expect(result.message.html).toContain("No lleva datos de quien llenó el formulario");
  });

  it("el tope: asuntos distintos para el del formulario y el de la organización", () => {
    const form = buildIntakeNotice({ ...base, kind: "intake_cap_reached", capKind: "form" });
    const org = buildIntakeNotice({ ...base, kind: "intake_cap_reached", capKind: "org" });
    expect(form.ok && form.message.subject).toBe("Tu formulario llegó al tope de hoy");
    expect(org.ok && org.message.subject).toBe(
      "Tu organización llegó al tope diario de solicitudes",
    );
    if (form.ok) expect(form.message.html).toContain("Ver el formulario");
  });

  it("escapa el nombre del formulario (lo escribe la organización) y limpia saltos de línea", () => {
    const result = buildIntakeNotice({
      ...base,
      formName: "<img src=x onerror=alert(1)>\r\nBcc: otro@malo.test",
      kind: "request_received",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.html).not.toContain("<img");
    expect(result.message.html).toContain("&lt;img");
    expect(result.message.subject).not.toMatch(/[\r\n]/);
  });

  it("rechaza destinatarios, remitentes, direcciones o nombres inválidos", () => {
    expect(
      buildIntakeNotice({ ...base, recipientAddress: "no-es-correo", kind: "request_received" }).ok,
    ).toBe(false);
    expect(
      buildIntakeNotice({ ...base, fromAddress: "no-es-correo", kind: "request_received" }).ok,
    ).toBe(false);
    expect(
      buildIntakeNotice({ ...base, appUrl: "no es una url", kind: "request_received" }).ok,
    ).toBe(false);
    expect(buildIntakeNotice({ ...base, formName: "  \r\n ", kind: "request_received" }).ok).toBe(
      false,
    );
  });
});
