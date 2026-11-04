import "server-only";
import { getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { createClient } from "@/lib/supabase/server";
import { CLIENT_IP_HEADER, REQUEST_ID_HEADER } from "@/lib/tenant/constants";
import {
  INVITATION_GENERIC_FAILURE,
  acceptResponseSchema,
  previewResponseSchema,
  type InvitationResult,
} from "./accept-model";
import { hashInvitationToken } from "./invitation-code";

/**
 * El corazón de H-009: la vista previa y la aceptación de una invitación. Las dos corren con el PASE de la
 * persona (nunca con la llave maestra) y las decide la base de datos: sesión, correo verificado, estado de la
 * invitación y, sobre todo, que el correo de la cuenta sea el mismo al que se envió. Aquí solo se manda la huella
 * del código (jamás el código ni un rol, ni una organización) y se entiende la respuesta.
 *
 * No hay organización activa todavía —la persona aún no es miembro—, así que el cliente va SIN la cabecera de
 * organización; solo lleva el origen y la correlación para la auditoría. Nada de lo que pasa por aquí (código,
 * correo, nombres) se escribe en un log: solo códigos.
 */

export type PreviewOutcome =
  | {
      status: "ready";
      tenantId: string;
      organizationName: string;
      inviterName: string | null;
      role: string;
      expiresAt: string | null;
      /** Ya es miembro activa: aceptar no le cambia el rol; este es el que tiene hoy. */
      alreadyMember: boolean;
      currentRole: string | null;
    }
  | { status: "already_member"; tenantId: string }
  | { status: "unavailable"; result: Exclude<InvitationResult, "ok" | "accepted"> }
  | { status: "no_session" }
  | { status: "failed"; message: string };

export type AcceptOutcome =
  | { status: "joined"; tenantId: string; alreadyMember: boolean }
  | { status: "unavailable"; result: Exclude<InvitationResult, "ok" | "accepted"> }
  | { status: "no_session" }
  | { status: "failed"; message: string };

const NO_SESSION_CODE = "42501";

async function personClient() {
  const context = await getRequestContext();
  return createClient({
    [REQUEST_ID_HEADER]: context.requestId,
    ...(context.clientIp ? { [CLIENT_IP_HEADER]: context.clientIp } : {}),
  });
}

/** Qué se ve en la pantalla «Unirme»: la organización, quién invitó y el rol, solo si la invitación es para esta cuenta. */
export async function previewInvitation(code: string): Promise<PreviewOutcome> {
  const supabase = await personClient();
  const { data, error } = await supabase.rpc("invitation_preview", {
    p_token_sha256: hashInvitationToken(code),
  });
  if (error) {
    if (error.code === NO_SESSION_CODE) return { status: "no_session" };
    void serverLog("error", "invitation_preview_failed", { code: error.code ?? "unknown" });
    return { status: "failed", message: INVITATION_GENERIC_FAILURE };
  }
  const parsed = previewResponseSchema.safeParse(data);
  if (!parsed.success) {
    void serverLog("error", "invitation_preview_failed", { code: "shape" });
    return { status: "failed", message: INVITATION_GENERIC_FAILURE };
  }
  const body = parsed.data;
  if (body.result === "accepted" && body.tenant_id) {
    return { status: "already_member", tenantId: body.tenant_id };
  }
  if (body.result === "ok") {
    if (!body.tenant_id || !body.tenant_name || !body.role) {
      void serverLog("error", "invitation_preview_failed", { code: "shape" });
      return { status: "failed", message: INVITATION_GENERIC_FAILURE };
    }
    return {
      status: "ready",
      tenantId: body.tenant_id,
      organizationName: body.tenant_name,
      inviterName: body.inviter_name ?? null,
      role: body.role,
      expiresAt: body.expires_at ?? null,
      alreadyMember: body.already_member === true,
      currentRole: body.current_role ?? null,
    };
  }
  if (body.result === "accepted") {
    void serverLog("error", "invitation_preview_failed", { code: "shape" });
    return { status: "failed", message: INVITATION_GENERIC_FAILURE };
  }
  return { status: "unavailable", result: body.result };
}

/** Acepta la invitación. El rol y la organización los decide la base a partir de la invitación. */
export async function acceptInvitation(code: string): Promise<AcceptOutcome> {
  const supabase = await personClient();
  const { data, error } = await supabase.rpc("accept_invitation", {
    p_token_sha256: hashInvitationToken(code),
  });
  if (error) {
    if (error.code === NO_SESSION_CODE) return { status: "no_session" };
    void serverLog("error", "invitation_accept_failed", { code: error.code ?? "unknown" });
    return { status: "failed", message: INVITATION_GENERIC_FAILURE };
  }
  const parsed = acceptResponseSchema.safeParse(data);
  if (!parsed.success) {
    void serverLog("error", "invitation_accept_failed", { code: "shape" });
    return { status: "failed", message: INVITATION_GENERIC_FAILURE };
  }
  const body = parsed.data;
  if (body.result === "accepted") {
    if (!body.tenant_id) {
      void serverLog("error", "invitation_accept_failed", { code: "shape" });
      return { status: "failed", message: INVITATION_GENERIC_FAILURE };
    }
    return {
      status: "joined",
      tenantId: body.tenant_id,
      alreadyMember: body.already_member === true,
    };
  }
  if (body.result === "ok") {
    void serverLog("error", "invitation_accept_failed", { code: "shape" });
    return { status: "failed", message: INVITATION_GENERIC_FAILURE };
  }
  return { status: "unavailable", result: body.result };
}
