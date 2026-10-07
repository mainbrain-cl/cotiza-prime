import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const download = vi.fn();
const from = vi.fn(() => ({ download }));
const createAdminClient = vi.fn((headers?: Record<string, string>) => {
  void headers;
  return { rpc, storage: { from } };
});
vi.mock("@/lib/supabase/admin-client", () => ({
  createAdminClient: (headers?: Record<string, string>) => createAdminClient(headers),
}));
vi.mock("@/lib/http/request-context", () => ({
  getRequestContext: async () => ({
    requestId: "req-123",
    clientIp: "203.0.113.9",
    userAgent: "UA",
  }),
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

import {
  IntakeGatewayError,
  readIntakeForm,
  readIntakeNoticeRecipients,
  readOrganizationLogoFile,
  recordIntakeBlock,
  registerIntakeNotice,
  settleIntakeNotice,
  submitIntakeRequest,
  type IntakeSubmitInput,
} from "./gateway";

const PUBLIC_ID = "A".repeat(22);
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const FORM = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

const baseRead = {
  tenant_id: TENANT,
  form_id: FORM,
  title: "Pide tu cotización",
  org: { name: "Empresa", contact_email: "c@ejemplo.test", contact_phone: null },
  brand: { primary_color: "#2B54E0", secondary_color: null },
  logo_path: null,
};

const submitInput: IntakeSubmitInput = {
  publicId: PUBLIC_ID,
  requestId: REQUEST,
  submitKey: "66666666-6666-4666-8666-666666666666",
  formRevision: 3,
  contactNameEnc: "n",
  contactEmailEnc: "e",
  contactPhoneEnc: null,
  companyEnc: null,
  comunaEnc: null,
  serviceAddressEnc: null,
  messageEnc: null,
  contactEmailHash: "h".repeat(64),
  desiredDate: null,
  items: [{ formItemId: ITEM, quantityMilli: 1500 }],
  consentTemplateVersion: "intake-v1",
  consentText: "texto",
  consentIpEnc: null,
};

const blobOf = (bytes: Uint8Array) => ({
  size: bytes.length,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
});

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: null, error: null });
  download.mockReset();
  from.mockClear();
  createAdminClient.mockClear();
});

describe("el portero: leer el formulario", () => {
  it("un identificador mal formado se rechaza SIN consultar la base", async () => {
    for (const id of ["", "corto", "A".repeat(23), "A".repeat(21) + "!", " " + "A".repeat(21)]) {
      expect(await readIntakeForm(id)).toEqual({ state: "not_found" });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("llama solo a intake_form_read con el identificador", async () => {
    rpc.mockResolvedValue({ data: { state: "not_found" }, error: null });
    expect(await readIntakeForm(PUBLIC_ID)).toEqual({ state: "not_found" });
    expect(rpc).toHaveBeenCalledWith("intake_form_read", { p_public_id: PUBLIC_ID });
  });

  it("entrega un formulario publicado con sus servicios y sin precios", async () => {
    rpc.mockResolvedValue({
      data: {
        ...baseRead,
        state: "ok",
        revision: 2,
        intro: "Hola",
        success_message: "Gracias",
        fields: {
          phone: "optional",
          company: "off",
          comuna: "off",
          serviceAddress: "off",
          desiredDate: "off",
          message: "required",
        },
        privacy_policy_url: null,
        // si la base algún día agregara precios, el portero no los deja pasar
        items: [
          {
            id: ITEM,
            name: "Flete",
            description: null,
            unit: "service",
            quantity_mode: "optional",
            min_qty_milli: null,
            max_qty_milli: null,
            unit_price_clp: 45000,
          },
        ],
      },
      error: null,
    });
    const form = await readIntakeForm(PUBLIC_ID);
    expect(form.state).toBe("ok");
    expect(JSON.stringify(form)).not.toContain("45000");
    if (form.state === "ok") {
      expect(form.revision).toBe(2);
      expect(form.items[0]).toEqual({
        id: ITEM,
        name: "Flete",
        description: null,
        unit: "service",
        quantityMode: "optional",
        minQtyMilli: null,
        maxQtyMilli: null,
      });
    }
  });

  it("un formulario en pausa trae solo marca y contacto", async () => {
    rpc.mockResolvedValue({ data: { ...baseRead, state: "paused" }, error: null });
    const form = await readIntakeForm(PUBLIC_ID);
    expect(form.state).toBe("paused");
    expect(form).not.toHaveProperty("items");
  });

  it("si la base falla o responde algo raro, lanza un error con solo un código", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "detalle interno" } });
    await expect(readIntakeForm(PUBLIC_ID)).rejects.toThrow("intake_gateway_read:XX000");
    rpc.mockResolvedValue({ data: { state: "ok" }, error: null });
    await expect(readIntakeForm(PUBLIC_ID)).rejects.toBeInstanceOf(IntakeGatewayError);
  });
});

describe("el portero: bloqueos", () => {
  it("cuenta captcha, rate e invalid; con un identificador mal formado no toca la base", async () => {
    rpc.mockResolvedValue({ data: { recorded: true }, error: null });
    expect(await recordIntakeBlock(PUBLIC_ID, "captcha")).toEqual({ recorded: true });
    expect(rpc).toHaveBeenCalledWith("intake_record_block", {
      p_public_id: PUBLIC_ID,
      p_reason: "captcha",
    });
    rpc.mockClear();
    expect(await recordIntakeBlock("mal", "rate")).toEqual({ recorded: false });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("el portero: guardar la solicitud", () => {
  it("manda lo cifrado y el texto de consentimiento, con la correlación de la petición, y nunca el tenant", async () => {
    rpc.mockResolvedValue({
      data: {
        result: "ok",
        replayed: false,
        request_id: REQUEST,
        tenant_id: TENANT,
        form_id: FORM,
      },
      error: null,
    });
    expect(await submitIntakeRequest(submitInput)).toEqual({
      result: "ok",
      replayed: false,
      requestId: REQUEST,
      tenantId: TENANT,
      formId: FORM,
    });
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("intake_request_submit");
    expect(args).toMatchObject({
      p_public_id: PUBLIC_ID,
      p_request_id: REQUEST,
      p_form_revision: 3,
      p_consent_template_version: "intake-v1",
      p_consent_text: "texto",
      p_items: [{ form_item_id: ITEM, quantity_milli: 1500 }],
    });
    expect(Object.keys(args)).not.toContain("p_tenant_id");
    // la huella del consentimiento la calcula la base: no se manda
    expect(Object.keys(args).join(",")).not.toMatch(/sha|hash_consent/);
    expect(createAdminClient).toHaveBeenCalledWith({ "x-cp-request-id": "req-123" });
  });

  it("traduce los resultados de la base, incluido el tope con su tipo", async () => {
    rpc.mockResolvedValue({
      data: {
        result: "cap_reached",
        cap_kind: "org",
        notify_cap: true,
        tenant_id: TENANT,
        form_id: FORM,
      },
      error: null,
    });
    expect(await submitIntakeRequest(submitInput)).toEqual({
      result: "cap_reached",
      capKind: "org",
      notifyCap: true,
      tenantId: TENANT,
      formId: FORM,
    });
    for (const result of ["paused", "not_found", "form_changed", "invalid_items", "invalid_data"]) {
      rpc.mockResolvedValue({ data: { result }, error: null });
      expect(await submitIntakeRequest(submitInput)).toEqual({ result });
    }
  });

  it("un choque 23505 es un resultado, no un error crudo; otros errores lanzan con solo el código", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate key value" } });
    expect(await submitIntakeRequest(submitInput)).toEqual({ result: "conflict" });
    rpc.mockResolvedValue({ data: null, error: { code: "CP422", message: "invalid_hash" } });
    await expect(submitIntakeRequest(submitInput)).rejects.toThrow("intake_gateway_submit:CP422");
  });

  it("un identificador mal formado devuelve not_found sin tocar la base", async () => {
    expect(await submitIntakeRequest({ ...submitInput, publicId: "mal" })).toEqual({
      result: "not_found",
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("el portero: avisos al equipo", () => {
  it("lee los destinatarios ya filtrados por la base", async () => {
    rpc.mockResolvedValue({
      data: {
        audience: "managers",
        limited: false,
        recipients: [{ user_id: USER, email: "ana@ejemplo.test" }],
        tenant_id: TENANT,
        tenant_name: "Empresa",
        form_id: FORM,
        form_name: "Fletes web",
      },
      error: null,
    });
    expect(
      await readIntakeNoticeRecipients({ kind: "request_received", requestId: REQUEST }),
    ).toEqual({
      tenantId: TENANT,
      formId: FORM,
      formName: "Fletes web",
      limited: false,
      recipients: [{ userId: USER, email: "ana@ejemplo.test" }],
    });
    expect(rpc).toHaveBeenCalledWith("intake_notice_recipients", {
      p_request_id: REQUEST,
      p_kind: "request_received",
      p_form_id: null,
    });
    await readIntakeNoticeRecipients({ kind: "intake_cap_reached", formId: FORM });
    expect(rpc).toHaveBeenLastCalledWith("intake_notice_recipients", {
      p_request_id: null,
      p_kind: "intake_cap_reached",
      p_form_id: FORM,
    });
  });

  it("registra el aviso con el correo cifrado y su huella, y respeta registered:false", async () => {
    const emailId = "77777777-7777-4777-8777-777777777777";
    rpc.mockResolvedValue({ data: { registered: true }, error: null });
    expect(
      await registerIntakeNotice({
        emailId,
        tenantId: TENANT,
        kind: "request_received",
        requestId: REQUEST,
        formId: FORM,
        recipient: { userId: USER, email: "Ana@Ejemplo.test" },
      }),
    ).toEqual({ registered: true });
    expect(rpc.mock.calls[0][1]).toEqual({
      p_email_id: emailId,
      p_request_id: REQUEST,
      p_kind: "request_received",
      p_to_user_id: USER,
      p_to_email_enc: `cifrado(ana@ejemplo.test)|email_messages.to_email|${TENANT}|${emailId}`,
      p_to_email_hash: `huella(email|${TENANT}|ana@ejemplo.test)`,
      p_form_id: null,
    });
    rpc.mockResolvedValue({ data: { registered: false, reason: "daily_limit" }, error: null });
    expect(
      await registerIntakeNotice({
        emailId,
        tenantId: TENANT,
        kind: "intake_cap_reached",
        formId: FORM,
        recipient: { userId: USER, email: "ana@ejemplo.test" },
      }),
    ).toEqual({ registered: false, reason: "daily_limit" });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_request_id: null, p_form_id: FORM });
  });

  it("cierra el aviso: enviado o fallido", async () => {
    await settleIntakeNotice({
      emailId: "e",
      sent: { provider: "mailpit", providerMessageId: "m1" },
    });
    expect(rpc).toHaveBeenLastCalledWith("intake_notice_settle", {
      p_email_id: "e",
      p_provider: "mailpit",
      p_provider_message_id: "m1",
      p_error_code: null,
    });
    await settleIntakeNotice({ emailId: "e", errorCode: "timeout" });
    expect(rpc).toHaveBeenLastCalledWith("intake_notice_settle", {
      p_email_id: "e",
      p_provider: null,
      p_provider_message_id: null,
      p_error_code: "timeout",
    });
  });
});

describe("el portero: el logo de la organización", () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  it("entrega el archivo si la ruta empieza por el tenant_id que devolvió la base", async () => {
    download.mockResolvedValue({ data: blobOf(PNG), error: null });
    const file = await readOrganizationLogoFile(TENANT, `${TENANT}/logo-ab12cd34ef56.png`);
    expect(file?.kind).toBe("png");
    expect(file?.bytes.equals(Buffer.from(PNG))).toBe(true);
    expect(from).toHaveBeenCalledWith("tenant-logos");
  });

  it("una ruta de OTRA organización, con subcarpetas, sin extensión válida o sin tenant se descarta sin descargar", async () => {
    const bad = [
      `${OTHER_TENANT}/logo-ab12cd34ef56.png`,
      `${TENANT}/../${OTHER_TENANT}/logo.png`,
      `${TENANT}/sub/logo.png`,
      `${TENANT}/logo.exe`,
      `${TENANT}/logo`,
      `logo-ab12cd34ef56.png`,
    ];
    for (const path of bad) expect(await readOrganizationLogoFile(TENANT, path)).toBeNull();
    expect(await readOrganizationLogoFile(TENANT, null)).toBeNull();
    expect(await readOrganizationLogoFile("no-es-uuid", "no-es-uuid/logo.png")).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it("un logo demasiado grande o una falla de Storage dan null", async () => {
    download.mockResolvedValue({ data: { size: 2 * 1024 * 1024 }, error: null });
    expect(await readOrganizationLogoFile(TENANT, `${TENANT}/logo-a.png`)).toBeNull();
    download.mockResolvedValue({ data: null, error: { message: "no existe" } });
    expect(await readOrganizationLogoFile(TENANT, `${TENANT}/logo-a.png`)).toBeNull();
  });
});
