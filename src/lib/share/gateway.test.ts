import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const download = vi.fn();
const from = vi.fn(() => ({ download }));
vi.mock("@/lib/supabase/admin-client", () => ({
  createAdminClient: () => ({ rpc, storage: { from } }),
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
  ShareGatewayError,
  expectedPdfPath,
  readFrozenLogoDataUrl,
  readFrozenPdf,
  readNoticeRecipients,
  readShareLink,
  recordShareView,
  registerInternalNotice,
  respondShareLink,
  settleInternalNotice,
} from "./gateway";
import type { ShareAvailable } from "./read-model";
import { hashShareToken, newShareToken } from "./token";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const QUOTE = "33333333-3333-4333-8333-333333333333";
const PACKAGE = "44444444-4444-4444-8444-444444444444";
const LINK = "55555555-5555-4555-8555-555555555555";
const PDF = new Uint8Array([37, 80, 68, 70, 45]);
const PDF_SHA = createHash("sha256").update(PDF).digest("hex");

function available(overrides: Partial<ShareAvailable> = {}): ShareAvailable {
  return {
    state: "ok",
    contact: { name: "Empresa", detailLines: [] },
    tenantId: TENANT,
    quoteId: QUOTE,
    packageId: PACKAGE,
    shareLinkId: LINK,
    quoteStatus: "sent",
    validUntil: null,
    response: null,
    document: {} as ShareAvailable["document"],
    customerSnapshotEnc: null,
    pdfPath: `${TENANT}/${QUOTE}/${PACKAGE}.pdf`,
    pdfSha256: PDF_SHA,
    logoPath: `${TENANT}/${QUOTE}/${PACKAGE}-logo.png`,
    ...overrides,
  };
}

const blobOf = (bytes: Uint8Array) => ({
  size: bytes.length,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
});

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: null, error: null });
  download.mockReset();
  from.mockClear();
});

describe("el portero: leer el enlace", () => {
  it("un token mal formado se rechaza SIN consultar la base de datos", async () => {
    for (const token of [
      "",
      "corto",
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}!`,
      "../".repeat(15),
    ]) {
      expect(await readShareLink(token)).toEqual({ state: "not_found" });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("consulta con el sello del token, nunca con el token", async () => {
    rpc.mockResolvedValue({ data: { state: "not_found" }, error: null });
    const token = newShareToken();
    expect(await readShareLink(token)).toEqual({ state: "not_found" });
    expect(rpc).toHaveBeenCalledWith("share_link_read", { p_token_sha256: hashShareToken(token) });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(token);
  });

  it("vencido, revocado o reemplazado devuelve solo el contacto", async () => {
    rpc.mockResolvedValue({
      data: { state: "expired", org_contact: { name: "Empresa", detail_lines: ["a@b.test"] } },
      error: null,
    });
    expect(await readShareLink(newShareToken())).toEqual({
      state: "expired",
      contact: { name: "Empresa", detailLines: ["a@b.test"] },
    });
  });

  it("una respuesta con forma inesperada falla en vez de dibujarse a medias", async () => {
    rpc.mockResolvedValue({ data: { state: "ok" }, error: null });
    await expect(readShareLink(newShareToken())).rejects.toThrow("share_gateway_read:shape");
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    await expect(readShareLink(newShareToken())).rejects.toThrow("share_gateway_read:XX000");
  });
});

describe("el portero: registrar la apertura", () => {
  it("cifra la IP sellada con la organización y el enlace, y no manda nada más", async () => {
    rpc.mockResolvedValue({ data: { recorded: true, first: true }, error: null });
    const token = newShareToken();
    const result = await recordShareView(
      token,
      { tenantId: TENANT, shareLinkId: LINK },
      {
        ip: "203.0.113.7",
        userAgent: "Mozilla/5.0",
      },
    );
    expect(result).toEqual({ recorded: true, first: true });
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("share_link_record_view");
    expect(args).toEqual({
      p_token_sha256: hashShareToken(token),
      p_ip_enc: `cifrado(203.0.113.7)|share_link_views.ip|${TENANT}|${LINK}`,
      p_user_agent: "Mozilla/5.0",
    });
  });

  it("sin IP conocida no inventa una", async () => {
    await recordShareView(
      newShareToken(),
      { tenantId: TENANT, shareLinkId: LINK },
      {
        ip: null,
        userAgent: null,
      },
    );
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_ip_enc: null, p_user_agent: null });
  });

  it("un token mal formado no llega a la base", async () => {
    const result = await recordShareView(
      "malo",
      { tenantId: TENANT, shareLinkId: LINK },
      {
        ip: null,
        userAgent: null,
      },
    );
    expect(result).toEqual({ recorded: false, first: false });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("el portero: la respuesta del cliente (la usa H-031)", () => {
  it("llama a share_link_respond con el sello y devuelve el resultado de la base", async () => {
    rpc.mockResolvedValue({
      data: { result: "already_responded", decision: "accepted" },
      error: null,
    });
    const token = newShareToken();
    const result = await respondShareLink({
      token,
      responseId: LINK,
      responseKey: QUOTE,
      decision: "accepted",
      acceptorNameEnc: "enc",
      reasonCode: null,
      reasonTextEnc: null,
      ipEnc: "enc",
      originIp: "203.0.113.7",
      userAgent: "x",
      acceptanceTextVersion: "v1",
    });
    expect(result.result).toBe("already_responded");
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("share_link_respond");
    expect(args.p_token_sha256).toBe(hashShareToken(token));
  });
});

describe("el portero: archivos congelados", () => {
  it("el PDF solo se lee de la carpeta de la organización del enlace, con su sello", async () => {
    download.mockResolvedValue({ data: blobOf(PDF), error: null });
    expect(await readFrozenPdf(available())).toEqual(PDF);
    expect(from).toHaveBeenCalledWith("quote-documents");
    expect(download).toHaveBeenCalledWith(expectedPdfPath(available()));
  });

  it("una ruta de otra organización, o fuera del patrón, se descarta sin tocar Storage", async () => {
    for (const pdfPath of [
      `${OTHER_TENANT}/${QUOTE}/${PACKAGE}.pdf`,
      `${TENANT}/${QUOTE}/${PACKAGE}.pdf/../x.pdf`,
      `${TENANT}/${QUOTE}/otro.pdf`,
      `../${TENANT}/${QUOTE}/${PACKAGE}.pdf`,
      "",
    ]) {
      expect(await readFrozenPdf(available({ pdfPath })), pdfPath).toBeNull();
    }
    expect(await readFrozenPdf(available({ tenantId: "no-uuid" }))).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it("si el sello del archivo no coincide con el guardado, no se entrega", async () => {
    download.mockResolvedValue({ data: blobOf(new Uint8Array([1, 2, 3])), error: null });
    expect(await readFrozenPdf(available())).toBeNull();
  });

  it("si Storage falla, no se entrega", async () => {
    download.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await readFrozenPdf(available())).toBeNull();
  });

  it("el logo congelado sale como imagen en base64 y solo con la ruta de este paquete", async () => {
    download.mockResolvedValue({ data: blobOf(new Uint8Array([137, 80, 78, 71])), error: null });
    const url = await readFrozenLogoDataUrl(available());
    expect(url).toBe(`data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString("base64")}`);
    download.mockClear();
    expect(
      await readFrozenLogoDataUrl(
        available({ logoPath: `${OTHER_TENANT}/${QUOTE}/${PACKAGE}-logo.png` }),
      ),
    ).toBeNull();
    expect(
      await readFrozenLogoDataUrl(
        available({ logoPath: `${TENANT}/${QUOTE}/${PACKAGE}-logo.svg` }),
      ),
    ).toBeNull();
    expect(await readFrozenLogoDataUrl(available({ logoPath: null }))).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });
});

describe("aviso interno de H-031 por el portero", () => {
  const RESPONSE = "66666666-6666-4666-8666-666666666666";
  const USER = "77777777-7777-4777-8777-777777777777";
  const EMAIL = "88888888-8888-4888-8888-888888888888";

  it("los destinatarios salen ya filtrados de la base y no se usa la API de cuentas", async () => {
    rpc.mockResolvedValue({
      data: {
        package_id: PACKAGE,
        audience: "managers",
        recipients: [{ user_id: USER, email: "dueno@ejemplo.test" }],
      },
      error: null,
    });
    const result = await readNoticeRecipients({
      tenantId: TENANT,
      quoteId: QUOTE,
      responseId: RESPONSE,
    });
    expect(rpc).toHaveBeenCalledWith("share_notice_recipients", {
      p_quote_id: QUOTE,
      p_response_id: RESPONSE,
    });
    expect(result).toEqual({
      packageId: PACKAGE,
      audience: "managers",
      recipients: [{ userId: USER, email: "dueno@ejemplo.test" }],
    });
  });

  it("una respuesta de la base con otra forma es un error, no una lista vacía", async () => {
    rpc.mockResolvedValue({ data: { recipients: "x" }, error: null });
    await expect(
      readNoticeRecipients({ tenantId: TENANT, quoteId: QUOTE, responseId: RESPONSE }),
    ).rejects.toThrow(ShareGatewayError);
    rpc.mockResolvedValue({ data: null, error: { code: "CP404" } });
    await expect(
      readNoticeRecipients({ tenantId: TENANT, quoteId: QUOTE, responseId: RESPONSE }),
    ).rejects.toThrow("share_gateway_notice_recipients:CP404");
  });

  it("registrar: el correo va normalizado, cifrado con el sello de la fila y con su huella", async () => {
    await registerInternalNotice({
      emailId: EMAIL,
      tenantId: TENANT,
      quoteId: QUOTE,
      responseId: RESPONSE,
      recipient: { userId: USER, email: " Dueno@Ejemplo.TEST " },
    });
    expect(rpc).toHaveBeenCalledWith("internal_notice_register", {
      p_email_id: EMAIL,
      p_quote_id: QUOTE,
      p_response_id: RESPONSE,
      p_to_user_id: USER,
      p_to_email_enc: `cifrado(dueno@ejemplo.test)|email_messages.to_email|${TENANT}|${EMAIL}`,
      p_to_email_hash: `huella(email|${TENANT}|dueno@ejemplo.test)`,
    });
  });

  it("cerrar: enviado lleva lo que informó el proveedor; fallido, solo un código", async () => {
    await settleInternalNotice({
      emailId: EMAIL,
      tenantId: TENANT,
      sent: { provider: "mailpit", providerMessageId: "m-1" },
    });
    expect(rpc).toHaveBeenLastCalledWith("internal_notice_settle", {
      p_email_id: EMAIL,
      p_provider: "mailpit",
      p_provider_message_id: "m-1",
      p_error_code: null,
    });
    await settleInternalNotice({ emailId: EMAIL, tenantId: TENANT, errorCode: "timeout" });
    expect(rpc).toHaveBeenLastCalledWith("internal_notice_settle", {
      p_email_id: EMAIL,
      p_provider: null,
      p_provider_message_id: null,
      p_error_code: "timeout",
    });
  });
});
