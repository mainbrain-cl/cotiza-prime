import "server-only";
import { createHash } from "node:crypto";
import { encryptPii } from "@/lib/crypto/pii";
import { createAdminClient } from "@/lib/supabase/admin-client";
import { hashShareToken, isWellFormedShareToken } from "./token";
import {
  shareReadSchema,
  type ShareAvailable,
  type ShareContact,
  type ShareReadResult,
} from "./read-model";

/**
 * El PORTERO del enlace del cliente (decisión 017). Es el ÚNICO archivo que usa la llave maestra
 * para atender a alguien que no tiene sesión, y lo hace de dos maneras muy angostas:
 *
 *  1. Llama SOLO a tres funciones de la base, ejecutables únicamente por el servidor:
 *     `share_link_read`, `share_link_record_view` y `share_link_respond` (esta última la usa H-031).
 *  2. Lee del bucket privado `quote-documents` SOLO el PDF y el logo congelados de ese enlace.
 *
 * No toca ninguna tabla (una prueba estática vigila que no aparezca `.from(` sobre tablas ni otra
 * función). El navegador del cliente nunca habla con la base: todo pasa por aquí, con el token ya
 * validado en forma y los límites de tasa ya aplicados por quien llama.
 *
 * Reglas de este archivo:
 *  - El token mal formado se rechaza ANTES de consultar la base de datos.
 *  - La organización sale de la fila del enlace (la devuelve la base), nunca de un argumento.
 *  - Las rutas de los archivos congelados se arman con ese `tenant_id` y se comparan con las que
 *    guardó el paquete: una ruta de otra organización se descarta.
 *  - Ningún mensaje de error ni registro lleva el token, la IP ni datos del cliente.
 */

const QUOTE_DOCUMENTS_BUCKET = "quote-documents";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID}$`, "i");
/** El logo congelado es una imagen chica (la marca limita el original a 1 MB). */
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg" };

export class ShareGatewayError extends Error {
  constructor(operation: string, code?: string) {
    super(`share_gateway_${operation}${code ? `:${code}` : ""}`);
    this.name = "ShareGatewayError";
  }
}

const toContact = (contact: { name: string; detail_lines: string[] }): ShareContact => ({
  name: contact.name,
  detailLines: contact.detail_lines,
});

/**
 * Lee el enlace. SOLO LEE: un GET que llegue aquí nunca cambia nada (salvo que la fecha de vigencia
 * ya pasó: entonces la base marca la cotización como vencida, que es lo que corresponde).
 * Token mal formado o inexistente: `not_found`, sin tocar la base en el primer caso.
 */
export async function readShareLink(token: string): Promise<ShareReadResult> {
  if (!isWellFormedShareToken(token)) return { state: "not_found" };
  const { data, error } = await createAdminClient().rpc("share_link_read", {
    p_token_sha256: hashShareToken(token),
  });
  if (error) throw new ShareGatewayError("read", error.code);
  const parsed = shareReadSchema.safeParse(data);
  if (!parsed.success) throw new ShareGatewayError("read", "shape");
  const body = parsed.data;
  if (body.state === "not_found") return { state: "not_found" };
  if (body.state === "expired" || body.state === "revoked" || body.state === "superseded") {
    return { state: body.state, contact: toContact(body.org_contact) };
  }
  return {
    state: body.state,
    contact: toContact(body.org_contact),
    tenantId: body.tenant_id,
    quoteId: body.quote_id,
    packageId: body.package_id,
    shareLinkId: body.share_link_id,
    quoteStatus: body.quote_status,
    validUntil: body.valid_until,
    response: body.response
      ? { decision: body.response.decision, respondedAt: body.response.responded_at }
      : null,
    document: body.document_snapshot,
    customerSnapshotEnc: body.customer_snapshot_enc,
    pdfPath: body.pdf_path,
    pdfSha256: body.pdf_sha256,
    logoPath: body.logo_path,
  };
}

/**
 * Registra una apertura. Quien llama ya leyó el enlace (de ahí salen la organización y el id del
 * enlace con que se sella la IP) y ya comprobó que quien abre no es miembro de la organización.
 * La IP y el navegador salen del servidor, nunca de un parámetro del cliente. La IP va cifrada; el
 * navegador lo recorta la base. Devuelve si la apertura quedó registrada y si fue la primera.
 */
export async function recordShareView(
  token: string,
  link: Pick<ShareAvailable, "tenantId" | "shareLinkId">,
  origin: { ip: string | null; userAgent: string | null },
): Promise<{ recorded: boolean; first: boolean }> {
  if (!isWellFormedShareToken(token)) return { recorded: false, first: false };
  const ipEnc = origin.ip
    ? encryptPii(origin.ip, {
        table: "share_link_views",
        field: "ip",
        tenantId: link.tenantId,
        rowId: link.shareLinkId,
      })
    : null;
  const { data, error } = await createAdminClient().rpc("share_link_record_view", {
    p_token_sha256: hashShareToken(token),
    p_ip_enc: ipEnc,
    p_user_agent: origin.userAgent,
  });
  if (error) throw new ShareGatewayError("record_view", error.code);
  const result = (data ?? {}) as { recorded?: boolean; first?: boolean };
  return { recorded: result.recorded === true, first: result.first === true };
}

export type ShareRespondInput = {
  token: string;
  responseId: string;
  responseKey: string;
  decision: "accepted" | "rejected";
  acceptorNameEnc: string | null;
  reasonCode: string | null;
  reasonTextEnc: string | null;
  ipEnc: string | null;
  /** IP real de quien responde, del servidor: la base la guarda en la auditoría. */
  originIp: string | null;
  userAgent: string | null;
  acceptanceTextVersion: string | null;
};

/**
 * Deja preparada la respuesta del cliente (aceptar o rechazar). La usa H-031; en H-030 no hay
 * pantalla que la llame. Devuelve el resultado tal cual lo entrega la base (`result`: ok,
 * already_responded, revoked, superseded, expired, not_allowed, not_found).
 */
export async function respondShareLink(
  input: ShareRespondInput,
): Promise<{ result: string; [key: string]: unknown }> {
  if (!isWellFormedShareToken(input.token)) return { result: "not_found" };
  const { data, error } = await createAdminClient().rpc("share_link_respond", {
    p_token_sha256: hashShareToken(input.token),
    p_response_id: input.responseId,
    p_response_key: input.responseKey,
    p_decision: input.decision,
    p_acceptor_name_enc: input.acceptorNameEnc,
    p_reason_code: input.reasonCode,
    p_reason_text_enc: input.reasonTextEnc,
    p_ip_enc: input.ipEnc,
    p_origin_ip: input.originIp,
    p_user_agent: input.userAgent,
    p_acceptance_text_version: input.acceptanceTextVersion,
  });
  if (error) throw new ShareGatewayError("respond", error.code);
  const result = data as { result?: unknown } | null;
  if (!result || typeof result.result !== "string") throw new ShareGatewayError("respond", "shape");
  return result as { result: string; [key: string]: unknown };
}

/**
 * Correo de quien creó la cotización, para el aviso interno de H-031. El id sale de la respuesta de
 * `share_link_respond` (la base), nunca de la petición. Usa la API de cuentas del servidor (no toca
 * ninguna tabla). Si no se encuentra, devuelve `null`.
 */
export async function readAuthorEmail(authorId: string | null | undefined): Promise<string | null> {
  if (!authorId || !UUID_PATTERN.test(authorId)) return null;
  const { data, error } = await createAdminClient().auth.admin.getUserById(authorId);
  if (error || !data.user?.email) return null;
  return data.user.email;
}

/** Ruta que le corresponde al PDF congelado de este enlace: `{tenant}/{quote}/{package}.pdf`. */
export function expectedPdfPath(link: Pick<ShareAvailable, "tenantId" | "quoteId" | "packageId">) {
  return `${link.tenantId}/${link.quoteId}/${link.packageId}.pdf`;
}

function idsAreUuids(link: Pick<ShareAvailable, "tenantId" | "quoteId" | "packageId">): boolean {
  return [link.tenantId, link.quoteId, link.packageId].every((id) => UUID_PATTERN.test(id));
}

/**
 * El PDF congelado del paquete, solo si su ruta es la de ESTA organización y su sello coincide con
 * el que se guardó al enviar. Cualquier otra cosa devuelve `null`.
 */
export async function readFrozenPdf(link: ShareAvailable): Promise<Uint8Array | null> {
  if (!link.pdfPath || !link.pdfSha256 || !idsAreUuids(link)) return null;
  if (link.pdfPath !== expectedPdfPath(link)) return null;
  const { data, error } = await createAdminClient()
    .storage.from(QUOTE_DOCUMENTS_BUCKET)
    .download(link.pdfPath);
  if (error || !data) return null;
  const bytes = new Uint8Array(await data.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return sha256 === link.pdfSha256 ? bytes : null;
}

/** El logo congelado como dirección `data:` (la pantalla del cliente no habla con Storage). */
export async function readFrozenLogoDataUrl(link: ShareAvailable): Promise<string | null> {
  if (!link.logoPath || !idsAreUuids(link)) return null;
  const match = new RegExp(
    `^${link.tenantId}/${link.quoteId}/${link.packageId}-logo\\.(png|jpg)$`,
  ).exec(link.logoPath);
  if (!match) return null;
  const { data, error } = await createAdminClient()
    .storage.from(QUOTE_DOCUMENTS_BUCKET)
    .download(link.logoPath);
  if (error || !data || data.size > LOGO_MAX_BYTES) return null;
  const bytes = Buffer.from(await data.arrayBuffer());
  return `data:${LOGO_CONTENT_TYPES[match[1]]};base64,${bytes.toString("base64")}`;
}
