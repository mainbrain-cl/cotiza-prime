import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  verify: vi.fn(),
  consumeIntakeSubmitQuota: vi.fn(),
  readIntakeForm: vi.fn(),
  recordIntakeBlock: vi.fn(),
  submitIntakeRequest: vi.fn(),
  notifyRequestReceived: vi.fn(),
  notifyCapReached: vi.fn(),
  serverLog: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/antibot", () => ({ getAntibotVerifier: () => ({ verify: mocks.verify }) }));
vi.mock("@/lib/http/request-context", () => ({
  getAppOrigin: () => "https://app.ejemplo.test",
  getRequestContext: async () => ({ requestId: "r", clientIp: "203.0.113.9", userAgent: "UA" }),
}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: mocks.serverLog }));
vi.mock("@/lib/security/login-rate-limit", () => ({
  consumeIntakeSubmitQuota: mocks.consumeIntakeSubmitQuota,
}));
vi.mock("@/lib/crypto/pii", () => ({
  encryptPii: (
    plain: string,
    ctx: { table: string; field: string; tenantId: string; rowId: string },
  ) => `cifrado(${plain})|${ctx.table}.${ctx.field}|${ctx.tenantId}|${ctx.rowId}`,
}));
vi.mock("@/lib/crypto/search-hash", () => ({
  searchHash: (field: string, tenantId: string, value: string) =>
    `huella(${field}|${tenantId}|${value})`,
}));
vi.mock("./gateway", () => ({
  IntakeGatewayError: class IntakeGatewayError extends Error {},
  readIntakeForm: mocks.readIntakeForm,
  recordIntakeBlock: mocks.recordIntakeBlock,
  submitIntakeRequest: mocks.submitIntakeRequest,
}));
vi.mock("./notices", () => ({
  notifyRequestReceived: mocks.notifyRequestReceived,
  notifyCapReached: mocks.notifyCapReached,
}));

import { buildConsentNotice } from "./consent-notice";
import { consentFingerprint } from "./consent-fingerprint";
import { MIN_FILL_SECONDS, createRenderToken, verifyRenderToken } from "./render-token";
import { MSG_CAP_REACHED, MSG_EXPIRED, MSG_PAUSED } from "./submit-response";
import { HONEYPOT_FIELD } from "./submit-schema";
import { handleIntakeSubmit } from "./submit-service";

process.env.INTAKE_RENDER_SECRET = "s".repeat(40);

const PUBLIC_ID = "A".repeat(22);
const TENANT = "11111111-1111-4111-8111-111111111111";
const FORM = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const SUBMIT_KEY = "55555555-5555-4555-8555-555555555555";
const OTHER_SUBMIT_KEY = "66666666-6666-4666-8666-666666666666";
const consentFor = (privacyPolicyUrl: string | null = null) => {
  const notice = buildConsentNotice({
    organizationName: "Empresa Ficticia",
    contactEmail: "contacto@ejemplo.test",
    privacyPolicyUrl,
  });
  return consentFingerprint(notice.text, notice.privacyPolicyUrl);
};

const form = (overrides: Record<string, unknown> = {}) => ({
  state: "ok",
  tenantId: TENANT,
  formId: FORM,
  title: "Pide tu cotización",
  organization: { name: "Empresa Ficticia", email: "contacto@ejemplo.test", phone: null },
  primaryColor: null,
  secondaryColor: null,
  logoPath: null,
  revision: 3,
  intro: "",
  successMessage: "¡Gracias por escribirnos!",
  fields: {
    phone: "optional",
    company: "off",
    comuna: "off",
    serviceAddress: "off",
    desiredDate: "off",
    message: "optional",
  },
  privacyPolicyUrl: null,
  items: [
    {
      id: ITEM,
      name: "Flete urbano",
      description: null,
      unit: "service",
      quantityMode: "optional",
      minQtyMilli: null,
      maxQtyMilli: null,
    },
  ],
  ...overrides,
});

const oldToken = (id = PUBLIC_ID, submitKey = SUBMIT_KEY) =>
  createRenderToken(id, submitKey, {
    nowSeconds: Math.floor(Date.now() / 1000) - (MIN_FILL_SECONDS + 10),
  });

const validBody = (overrides: Record<string, unknown> = {}) => ({
  name: "Ana Prueba",
  email: "Ana@Cliente.test",
  phone: "+56 9 1234 5678",
  message: "Necesito un flete\ncon <script>alert(1)</script>",
  items: [{ formItemId: ITEM, quantity: "2" }],
  consent: true,
  submitKey: SUBMIT_KEY,
  consentFingerprint: consentFor(),
  formRevision: 3,
  [HONEYPOT_FIELD]: "",
  renderToken: oldToken(),
  antibotToken: "test-pass",
  ...overrides,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://app.ejemplo.test/api/v1/public/forms/x/requests", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function run(body: unknown, publicId = PUBLIC_ID, headers: Record<string, string> = {}) {
  const response = await handleIntakeSubmit(post(body, headers), publicId);
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: JSON.parse(text) as Record<string, unknown>,
    response,
  };
}

const blocksRecorded = () => mocks.recordIntakeBlock.mock.calls.map(([, reason]) => reason);

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.consumeIntakeSubmitQuota.mockResolvedValue("allowed");
  mocks.verify.mockResolvedValue({ ok: true });
  mocks.readIntakeForm.mockResolvedValue(form());
  mocks.recordIntakeBlock.mockResolvedValue({ recorded: true });
  mocks.submitIntakeRequest.mockResolvedValue({
    result: "ok",
    replayed: false,
    requestId: REQUEST,
    tenantId: TENANT,
    formId: FORM,
  });
});

describe("el orden del envío público", () => {
  it("un identificador mal formado da 404 sin límites ni base de datos", async () => {
    const { status } = await run(validBody(), "corto");
    expect(status).toBe(404);
    expect(mocks.consumeIntakeSubmitQuota).not.toHaveBeenCalled();
    expect(mocks.readIntakeForm).not.toHaveBeenCalled();
    expect(mocks.recordIntakeBlock).not.toHaveBeenCalled();
  });

  it("el límite por IP corta primero: 429, cuenta el bloqueo nuevo y no lee nada más", async () => {
    mocks.consumeIntakeSubmitQuota.mockResolvedValue("blocked_now");
    const { status, response } = await run(validBody());
    expect(status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(blocksRecorded()).toEqual(["rate"]);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.readIntakeForm).not.toHaveBeenCalled();
    expect(mocks.consumeIntakeSubmitQuota).toHaveBeenCalledWith("203.0.113.9");
  });

  it("una IP que ya estaba bloqueada recibe 429 pero NO suma otro bloqueo al formulario", async () => {
    mocks.consumeIntakeSubmitQuota.mockResolvedValue("blocked_repeat");
    const { status, response } = await run(validBody());
    expect(status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(blocksRecorded()).toEqual([]);
    expect(mocks.readIntakeForm).not.toHaveBeenCalled();
  });

  it("solo acepta application/json", async () => {
    const { status } = await run(validBody(), PUBLIC_ID, { "content-type": "text/plain" });
    expect(status).toBe(415);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("un envío clásico del navegador (formulario urlencoded o multipart) da 415 sin leer ni guardar el cuerpo", async () => {
    for (const type of [
      "application/x-www-form-urlencoded",
      "application/x-www-form-urlencoded; charset=UTF-8",
      "multipart/form-data; boundary=----x",
    ]) {
      let pulled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled = true;
            controller.enqueue(
              new TextEncoder().encode("pf-name=Ana+Prueba&pf-email=ana%40cliente.test"),
            );
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const request = new Request("https://app.ejemplo.test/api/v1/public/forms/x/requests", {
        method: "POST",
        headers: { "content-type": type },
        body,
        // @ts-expect-error `duplex` es obligatorio al enviar un flujo y todavía falta en los tipos de DOM
        duplex: "half",
      });
      const response = await handleIntakeSubmit(request, PUBLIC_ID);
      expect(response.status, type).toBe(415);
      expect(pulled, `${type}: el cuerpo no se lee`).toBe(false);
      expect(mocks.verify).not.toHaveBeenCalled();
      expect(mocks.readIntakeForm).not.toHaveBeenCalled();
      expect(mocks.submitIntakeRequest).not.toHaveBeenCalled();
      expect(blocksRecorded()).toEqual([]);
      const logged = JSON.stringify(mocks.serverLog.mock.calls);
      expect(logged).not.toContain("Ana");
      expect(logged).not.toContain("cliente.test");
    }
  });

  it("un cuerpo de más de 16 kB da 413 y se cuenta como inválido", async () => {
    const { status } = await run({ ...validBody(), message: "x".repeat(17_000) });
    expect(status).toBe(413);
    expect(blocksRecorded()).toEqual(["invalid"]);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("un JSON roto o que no es un objeto es inválido sin tocar el anti-robot", async () => {
    expect((await run("{no es json")).status).toBe(422);
    expect((await run([1, 2, 3])).status).toBe(422);
    expect((await run({ ...validBody(), antibotToken: 5 })).status).toBe(422);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.readIntakeForm).not.toHaveBeenCalled();
  });

  it("el campo trampa lleno bloquea antes del anti-robot y de la base, y cuenta como robot", async () => {
    const { status, json } = await run(validBody({ [HONEYPOT_FIELD]: "http://spam.test" }));
    expect(status).toBe(403);
    expect(json.status).toBe("blocked");
    expect(blocksRecorded()).toEqual(["captcha"]);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.readIntakeForm).not.toHaveBeenCalled();
  });

  it("un sello de tiempo muy rápido, falsificado, de otro formulario o vencido bloquea", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      createRenderToken(PUBLIC_ID, SUBMIT_KEY, { nowSeconds: now }),
      "v1.123.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      oldToken("B".repeat(22)),
      // atado a OTRA clave de envío: un solo sello no sirve para muchos envíos distintos
      oldToken(PUBLIC_ID, OTHER_SUBMIT_KEY),
      "no-es-un-sello",
    ];
    for (const renderToken of cases) {
      mocks.recordIntakeBlock.mockClear();
      const { status } = await run(validBody({ renderToken }));
      expect(status, renderToken).toBe(403);
      expect(blocksRecorded()).toEqual(["captcha"]);
    }
    const expired = createRenderToken(PUBLIC_ID, SUBMIT_KEY, { nowSeconds: now - 25 * 3600 });
    const result = await run(validBody({ renderToken: expired }));
    expect(result.status).toBe(403);
    expect(result.json.message).toBe(MSG_EXPIRED);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.readIntakeForm).not.toHaveBeenCalled();
  });

  it("el anti-robot se consulta con el hostname y la acción; si falla o no responde, bloquea", async () => {
    mocks.verify.mockResolvedValue({ ok: false, reason: "unreachable" });
    const { status, json } = await run(validBody());
    expect(status).toBe(403);
    expect(json.status).toBe("blocked");
    expect(blocksRecorded()).toEqual(["captcha"]);
    expect(mocks.verify).toHaveBeenCalledWith({
      token: "test-pass",
      remoteIp: "203.0.113.9",
      expectedHostname: "app.ejemplo.test",
      expectedAction: "intake_submit",
    });
    expect(mocks.readIntakeForm).not.toHaveBeenCalled();
    expect(mocks.submitIntakeRequest).not.toHaveBeenCalled();
  });

  it("formulario inexistente: 404; en pausa: 409 sin contar bloqueos de pausa", async () => {
    mocks.readIntakeForm.mockResolvedValue({ state: "not_found" });
    expect((await run(validBody())).status).toBe(404);
    mocks.readIntakeForm.mockResolvedValue({ ...form(), state: "paused" });
    const paused = await run(validBody());
    expect(paused.status).toBe(409);
    expect(paused.json).toEqual({ status: "paused", message: MSG_PAUSED });
    expect(blocksRecorded()).toEqual([]);
    expect(mocks.submitIntakeRequest).not.toHaveBeenCalled();
  });

  it("un organización sin contacto válido para el aviso de privacidad no recibe nada", async () => {
    mocks.readIntakeForm.mockResolvedValue(
      form({ organization: { name: "Empresa", email: null, phone: null } }),
    );
    const { status, json } = await run(validBody());
    expect(status).toBe(409);
    expect(json.status).toBe("paused");
    expect(mocks.submitIntakeRequest).not.toHaveBeenCalled();
  });

  it("datos inválidos: 422 con errores por campo, sin repetir lo escrito, y cuenta como inválido", async () => {
    const { status, json, text } = await run(
      validBody({ name: "A", email: "no-es-correo", consent: false, items: [] }),
    );
    expect(status).toBe(422);
    const errors = json.fieldErrors as Record<string, string>;
    expect(Object.keys(errors).sort()).toEqual(["consent", "email", "items", "name"]);
    expect(text).not.toContain("no-es-correo");
    expect(blocksRecorded()).toEqual(["invalid"]);
    expect(mocks.submitIntakeRequest).not.toHaveBeenCalled();
  });

  it("un servicio que no es de ESTE formulario es inválido y no llega a la base", async () => {
    const { status, json } = await run(
      validBody({ items: [{ formItemId: randomUUID(), quantity: null }] }),
    );
    expect(status).toBe(422);
    expect(JSON.stringify(json)).toContain("ya no está disponible");
    expect(mocks.submitIntakeRequest).not.toHaveBeenCalled();
  });

  it("sin requestId: ya no es un dato del envío, y sin huella del aviso de privacidad no se acepta", async () => {
    const withRequestId = await run(validBody({ requestId: randomUUID() }));
    expect(withRequestId.status).toBe(422);
    const { consentFingerprint: _omitted, ...rest } = validBody();
    void _omitted;
    const without = await run(rest);
    expect(without.status).toBe(422);
    expect(Object.keys(without.json.fieldErrors as object)).toContain("consentFingerprint");
    expect(mocks.submitIntakeRequest).not.toHaveBeenCalled();
  });

  it("si el aviso de privacidad cambió (otra huella), entrega el nuevo y NO guarda el consentimiento", async () => {
    mocks.readIntakeForm.mockResolvedValue(
      form({ privacyPolicyUrl: "https://ejemplo.test/privacidad" }),
    );
    // la persona vio el aviso SIN enlace a la política; ahora la organización la agregó (misma revisión)
    const { status, json } = await run(validBody({ consentFingerprint: consentFor(null) }));
    expect(status).toBe(409);
    expect(json.status).toBe("form_changed");
    expect((json.content as { privacyPolicyUrl: string }).privacyPolicyUrl).toBe(
      "https://ejemplo.test/privacidad",
    );
    expect(mocks.submitIntakeRequest).not.toHaveBeenCalled();
    expect(blocksRecorded()).toEqual([]);
    // el sello nuevo queda atado a la MISMA clave de envío, para poder reintentar con ella
    const stamp = verifyRenderToken(json.renderToken, PUBLIC_ID, SUBMIT_KEY, {
      nowSeconds: Math.floor(Date.now() / 1000) + MIN_FILL_SECONDS + 1,
    });
    expect(stamp.ok).toBe(true);
  });

  it("con la huella correcta del aviso (también con enlace a la política) sí se guarda", async () => {
    mocks.readIntakeForm.mockResolvedValue(
      form({ privacyPolicyUrl: "https://ejemplo.test/privacidad" }),
    );
    const { status } = await run(
      validBody({ consentFingerprint: consentFor("https://ejemplo.test/privacidad") }),
    );
    expect(status).toBe(200);
  });

  it("una revisión distinta entrega el formulario vigente y un sello nuevo, sin guardar nada", async () => {
    mocks.readIntakeForm.mockResolvedValue(form({ revision: 4, title: "Título nuevo" }));
    const { status, json } = await run(validBody({ formRevision: 3 }));
    expect(status).toBe(409);
    expect(json.status).toBe("form_changed");
    expect((json.content as { revision: number; title: string }).revision).toBe(4);
    expect((json.content as { title: string }).title).toBe("Título nuevo");
    expect(String(json.renderToken)).toMatch(/^v1\.\d+\./);
    expect(mocks.submitIntakeRequest).not.toHaveBeenCalled();
    expect(blocksRecorded()).toEqual([]);
  });
});

describe("el envío correcto", () => {
  it("cifra con el sello de la fila, calcula la huella del correo y manda el texto de consentimiento", async () => {
    const { status, json } = await run(validBody());
    expect(status).toBe(200);
    expect(json).toEqual({ status: "ok", message: "¡Gracias por escribirnos!" });
    expect(mocks.submitIntakeRequest).toHaveBeenCalledOnce();
    const input = mocks.submitIntakeRequest.mock.calls[0][0];
    // el id de la solicitud lo genera la aplicación y es parte del sello de cada dato
    expect(input.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const seal = (field: string) => `|intake_requests.${field}|${TENANT}|${input.requestId}`;
    expect(input.contactNameEnc).toBe(`cifrado(Ana Prueba)${seal("contact_name")}`);
    // el correo llega normalizado
    expect(input.contactEmailEnc).toBe(`cifrado(ana@cliente.test)${seal("contact_email")}`);
    expect(input.contactEmailHash).toBe(`huella(email|${TENANT}|ana@cliente.test)`);
    expect(input.contactPhoneEnc).toContain(seal("contact_phone"));
    expect(input.messageEnc).toContain("<script>alert(1)</script>");
    expect(input.companyEnc).toBeNull();
    expect(input.consentIpEnc).toBe(`cifrado(203.0.113.9)${seal("consent_ip")}`);
    expect(input.items).toEqual([{ formItemId: ITEM, quantityMilli: 2000 }]);
    expect(input.consentTemplateVersion).toBe("intake-v1");
    expect(input.consentText).toContain("Tus datos los recibirá Empresa Ficticia");
    expect(input.consentText).toContain("contacto@ejemplo.test");
    // nunca llega el nombre ni el correo en claro como columnas cifradas
    expect(input.contactNameEnc).not.toBe("Ana Prueba");
    // el tenant no se manda: sale de la fila del formulario
    expect(JSON.stringify(input)).not.toContain(`"tenantId"`);
  });

  it("la respuesta nunca trae identificadores internos", async () => {
    const { text } = await run(validBody());
    for (const secret of [TENANT, FORM, REQUEST, PUBLIC_ID]) expect(text).not.toContain(secret);
  });

  it("avisa al equipo en segundo plano solo la primera vez (un reintento no repite el aviso)", async () => {
    await run(validBody());
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.notifyRequestReceived).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.notifyRequestReceived).toHaveBeenCalledWith(REQUEST);

    mocks.after.mockClear();
    mocks.submitIntakeRequest.mockResolvedValue({
      result: "ok",
      replayed: true,
      requestId: REQUEST,
      tenantId: TENANT,
      formId: FORM,
    });
    const replay = await run(validBody());
    expect(replay.status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("sin mensaje de éxito propio usa uno por defecto", async () => {
    mocks.readIntakeForm.mockResolvedValue(form({ successMessage: "" }));
    const { json } = await run(validBody());
    expect(String(json.message)).toContain("Recibimos tu solicitud");
  });

  it("incluye el enlace a la política de privacidad dentro del texto que se guarda", async () => {
    mocks.readIntakeForm.mockResolvedValue(
      form({ privacyPolicyUrl: "https://ejemplo.test/privacidad" }),
    );
    await run(validBody({ consentFingerprint: consentFor("https://ejemplo.test/privacidad") }));
    const input = mocks.submitIntakeRequest.mock.calls[0][0];
    expect(input.consentText.endsWith("\nhttps://ejemplo.test/privacidad")).toBe(true);
  });
});

describe("lo que responde la base", () => {
  it("tope diario: mensaje claro, un solo aviso (solo si la base lo pide) y sin contar un bloqueo propio", async () => {
    mocks.submitIntakeRequest.mockResolvedValue({
      result: "cap_reached",
      capKind: "form",
      notifyCap: true,
      tenantId: TENANT,
      formId: FORM,
    });
    const first = await run(validBody());
    expect(first.status).toBe(409);
    expect(first.json).toEqual({ status: "cap_reached", message: MSG_CAP_REACHED });
    expect(mocks.after).toHaveBeenCalledOnce();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.notifyCapReached).toHaveBeenCalledWith(FORM, "form");
    // el tope y la pausa los cuenta la base dentro del envío: el servidor NUNCA llama record_block con ellos
    expect(blocksRecorded()).toEqual([]);

    mocks.after.mockClear();
    mocks.submitIntakeRequest.mockResolvedValue({
      result: "cap_reached",
      capKind: "org",
      notifyCap: false,
      tenantId: TENANT,
      formId: FORM,
    });
    await run(validBody());
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("pausa a mitad del envío: 409 y no se cuenta como bloqueo", async () => {
    mocks.submitIntakeRequest.mockResolvedValue({ result: "paused" });
    const { status, json } = await run(validBody());
    expect(status).toBe(409);
    expect(json.status).toBe("paused");
    expect(blocksRecorded()).toEqual([]);
  });

  it("form_changed e invalid_items: se vuelve a leer y se entrega el formulario vigente", async () => {
    for (const result of ["form_changed", "invalid_items"] as const) {
      mocks.submitIntakeRequest.mockResolvedValue({ result });
      mocks.readIntakeForm.mockClear();
      const { status, json } = await run(validBody());
      expect(status).toBe(409);
      expect(json.status).toBe("form_changed");
      expect(mocks.readIntakeForm).toHaveBeenCalledTimes(2);
    }
  });

  it("invalid_data: 422 sin detalles técnicos", async () => {
    mocks.submitIntakeRequest.mockResolvedValue({ result: "invalid_data" });
    const { status, json } = await run(validBody());
    expect(status).toBe(422);
    expect(json.status).toBe("invalid");
  });

  it("un choque de clave única se traduce a un mensaje claro", async () => {
    mocks.submitIntakeRequest.mockResolvedValue({ result: "conflict" });
    const { status, json } = await run(validBody());
    expect(status).toBe(409);
    expect(json.status).toBe("conflict");
    expect(String(json.message)).not.toMatch(/23505|duplicate|unique/i);
  });

  it("si la base falla: 500 genérico y el log lleva solo un código, nunca datos del visitante", async () => {
    mocks.submitIntakeRequest.mockRejectedValue(new Error("intake_gateway_submit:XX000"));
    const { status, json, text } = await run(validBody());
    expect(status).toBe(500);
    expect(json.status).toBe("error");
    expect(text).not.toContain("XX000");
    const logged = JSON.stringify(mocks.serverLog.mock.calls);
    for (const secret of ["Ana Prueba", "cliente.test", "203.0.113.9", PUBLIC_ID, "test-pass"]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("los rechazos no escriben datos del visitante ni el identificador en el log", async () => {
    await run(validBody({ [HONEYPOT_FIELD]: "spam" }));
    mocks.verify.mockResolvedValue({ ok: false, reason: "invalid_token" });
    await run(validBody());
    mocks.consumeIntakeSubmitQuota.mockResolvedValue("blocked_now");
    await run(validBody());
    expect(mocks.serverLog).toHaveBeenCalled();
    const logged = JSON.stringify(mocks.serverLog.mock.calls);
    for (const secret of ["Ana Prueba", "cliente.test", "203.0.113.9", PUBLIC_ID, "test-pass"]) {
      expect(logged).not.toContain(secret);
    }
  });
});
