import "server-only";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { getAntibotVerifier } from "@/lib/antibot";
import { encryptPii } from "@/lib/crypto/pii";
import { searchHash } from "@/lib/crypto/search-hash";
import { getAppOrigin, getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { consumeIntakeSubmitQuota } from "@/lib/security/login-rate-limit";
import { PUBLIC_RESPONSE_HEADERS } from "@/lib/share/public-request";
import { buildConsentNotice, ConsentNoticeError, type ConsentNotice } from "./consent-notice";
import { consentFingerprint } from "./consent-fingerprint";
import {
  IntakeGatewayError,
  readIntakeForm,
  recordIntakeBlock,
  submitIntakeRequest,
  type IntakeBlockReason,
} from "./gateway";
import { notifyCapReached, notifyRequestReceived } from "./notices";
import { buildPublicContent } from "./public-view";
import { isWellFormedPublicId, type IntakeFormAvailable } from "./read-model";
import { createRenderToken, RenderTokenConfigError, verifyRenderToken } from "./render-token";
import { readLimitedJsonBody } from "./request-body";
import {
  MSG_ANTIBOT,
  MSG_BLOCKED,
  MSG_CAP_REACHED,
  MSG_CONFLICT,
  MSG_ERROR,
  MSG_EXPIRED,
  MSG_FORM_CHANGED,
  MSG_NOT_FOUND,
  MSG_PAUSED,
  MSG_RATE_LIMITED,
  MSG_RECEIVED_DEFAULT,
  MSG_TOO_LARGE,
  MSG_UNREADABLE,
  type SubmitResponse,
} from "./submit-response";
import { buildSubmitSchema, fieldErrors, HONEYPOT_FIELD, type SubmitData } from "./submit-schema";

/**
 * Atiende `POST /api/v1/public/forms/[publicId]/requests`: alguien SIN CUENTA entrega datos personales. Es la
 * primera superficie pública que ESCRIBE, así que nunca existe sin todas sus protecciones. El orden es fijo
 * y lo que no pasa un paso se corta ahí (plan del sprint 4, §2). La ruta ya comprobó el `Origin` (paso 1).
 *
 *  2. forma del identificador (404 sin tocar la base)
 *  3. límite por IP (5 cada 10 minutos y 20 al día)
 *  4. cuerpo: solo `application/json`, hasta 16 kB. Un envío clásico del navegador (formulario
 *     `application/x-www-form-urlencoded` o `multipart/form-data`, p. ej. sin JavaScript) se rechaza con 415 SIN
 *     leer el cuerpo y sin registrar nada de él
 *  5. forma mínima: clave de envío, sello de tiempo, token anti-robot y campo trampa
 *  6. campo trampa y sello de tiempo (≥ 3 s, ≤ 24 h, de este formulario y de esta clave de envío)
 *  7. anti-robot (si el proveedor no responde, se bloquea)
 *  8. lectura del formulario y validación estricta con sus reglas (errores por campo)
 *  9. cifrado de los datos personales y envío a la base (que aplica el tope diario)
 * 10. aviso al equipo, en segundo plano
 *
 * Reglas: nada del visitante (nombre, correo, teléfono, mensaje, IP) ni el identificador del formulario ni el
 * token anti-robot llegan a un log; el mensaje del visitante es siempre texto.
 */

const ANTIBOT_ACTION = "intake_submit";
const STATUS = {
  ok: 200,
  not_found: 404,
  payload_too_large: 413,
  unsupported_type: 415,
  invalid: 422,
  blocked: 403,
  conflict: 409,
  rate_limited: 429,
  error: 500,
} as const;
const RETRY_AFTER_SECONDS = 600;

function respond(body: SubmitResponse, status: number, extraHeaders?: Record<string, string>) {
  return Response.json(body, { status, headers: { ...PUBLIC_RESPONSE_HEADERS, ...extraHeaders } });
}

/** Cuenta un bloqueo sin que una falla de la base afecte la respuesta. */
async function countBlock(publicId: string, reason: IntakeBlockReason): Promise<void> {
  try {
    await recordIntakeBlock(publicId, reason);
  } catch (cause) {
    await serverLog("warn", "intake_block_record_failed", {
      code: cause instanceof IntakeGatewayError ? cause.message : "unexpected",
    });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function appHostname(): string {
  return new URL(getAppOrigin()).hostname;
}

function consentFor(form: IntakeFormAvailable): ConsentNotice | null {
  try {
    return buildConsentNotice({
      organizationName: form.organization.name,
      contactEmail: form.organization.email ?? "",
      privacyPolicyUrl: form.privacyPolicyUrl,
    });
  } catch (cause) {
    if (cause instanceof ConsentNoticeError) return null;
    throw cause;
  }
}

/** El texto que se guarda como consentimiento: lo que se mostró y, si lo había, el enlace a la política. */
export function consentTextToStore(notice: ConsentNotice): string {
  return notice.privacyPolicyUrl ? `${notice.text}\n${notice.privacyPolicyUrl}` : notice.text;
}

export const CONSENT_VERSION_PREFIX = "intake-";

function encryptFields(data: SubmitData, ip: string | null, tenantId: string, requestId: string) {
  const seal = (field: string) => ({ table: "intake_requests", field, tenantId, rowId: requestId });
  const enc = (field: string, value: string | null) =>
    value === null ? null : encryptPii(value, seal(field));
  return {
    contactNameEnc: encryptPii(data.name, seal("contact_name")),
    contactEmailEnc: encryptPii(data.email, seal("contact_email")),
    contactPhoneEnc: enc("contact_phone", data.phone),
    companyEnc: enc("company", data.company),
    comunaEnc: enc("comuna", data.comuna),
    serviceAddressEnc: enc("service_address", data.serviceAddress),
    messageEnc: enc("message", data.message),
    contactEmailHash: searchHash("email", tenantId, data.email),
    consentIpEnc: enc("consent_ip", ip),
  };
}

export async function handleIntakeSubmit(request: Request, publicId: string): Promise<Response> {
  // 2. Forma del identificador: si no calza, 404 sin consultar la base.
  if (!isWellFormedPublicId(publicId)) {
    return respond({ status: "not_found", message: MSG_NOT_FOUND }, STATUS.not_found);
  }

  try {
    const { clientIp } = await getRequestContext();

    // 3. Límite por IP (cada intento cuenta, también los que fallan). Solo el bloqueo NUEVO se anota como
    // bloqueo del formulario: quien insiste con la IP ya bloqueada no infla los contadores. (Para un
    // identificador que no existe, la base no cuenta nada: `intake_record_block` responde `recorded: false`.)
    const quota = await consumeIntakeSubmitQuota(clientIp);
    if (quota !== "allowed") {
      await serverLog("warn", "intake_submit_rate_limited");
      if (quota === "blocked_now") await countBlock(publicId, "rate");
      return respond({ status: "rate_limited", message: MSG_RATE_LIMITED }, STATUS.rate_limited, {
        "Retry-After": String(RETRY_AFTER_SECONDS),
      });
    }

    // 4. Cuerpo acotado y solo JSON.
    const body = await readLimitedJsonBody(request);
    if (!body.ok) {
      if (body.reason === "unsupported_type") {
        return respond(
          { status: "invalid", fieldErrors: { form: MSG_UNREADABLE } },
          STATUS.unsupported_type,
        );
      }
      await countBlock(publicId, "invalid");
      return body.reason === "too_large"
        ? respond(
            { status: "invalid", fieldErrors: { form: MSG_TOO_LARGE } },
            STATUS.payload_too_large,
          )
        : respond({ status: "invalid", fieldErrors: { form: MSG_UNREADABLE } }, STATUS.invalid);
    }

    // 5. Forma mínima para poder aplicar las trampas.
    const raw = body.value;
    if (
      !isRecord(raw) ||
      typeof raw.submitKey !== "string" ||
      typeof raw.renderToken !== "string" ||
      typeof raw.antibotToken !== "string"
    ) {
      await countBlock(publicId, "invalid");
      return respond({ status: "invalid", fieldErrors: { form: MSG_UNREADABLE } }, STATUS.invalid);
    }

    // 6. Campo trampa y sello de tiempo. Los robots caen aquí; se cuentan como bloqueo de robot.
    const honeypot = raw[HONEYPOT_FIELD];
    if (typeof honeypot === "string" && honeypot !== "") {
      await serverLog("warn", "intake_submit_blocked", { reason: "honeypot" });
      await countBlock(publicId, "captcha");
      return respond({ status: "blocked", message: MSG_BLOCKED }, STATUS.blocked);
    }
    const stamp = verifyRenderToken(raw.renderToken, publicId, raw.submitKey);
    if (!stamp.ok) {
      await serverLog("warn", "intake_submit_blocked", { reason: `render_${stamp.reason}` });
      await countBlock(publicId, "captcha");
      return respond(
        { status: "blocked", message: stamp.reason === "expired" ? MSG_EXPIRED : MSG_BLOCKED },
        STATUS.blocked,
      );
    }

    // 7. Anti-robot. Si el proveedor no responde, se bloquea (falla cerrado).
    const verdict = await getAntibotVerifier().verify({
      token: raw.antibotToken,
      remoteIp: clientIp,
      expectedHostname: appHostname(),
      expectedAction: ANTIBOT_ACTION,
    });
    if (!verdict.ok) {
      await serverLog("warn", "intake_submit_blocked", { reason: `antibot_${verdict.reason}` });
      await countBlock(publicId, "captcha");
      return respond({ status: "blocked", message: MSG_ANTIBOT }, STATUS.blocked);
    }

    // 8. Lectura del formulario (la organización sale de él) y validación estricta con sus reglas.
    const form = await readIntakeForm(publicId);
    if (form.state === "not_found") {
      return respond({ status: "not_found", message: MSG_NOT_FOUND }, STATUS.not_found);
    }
    if (form.state === "paused") {
      return respond({ status: "paused", message: MSG_PAUSED }, STATUS.conflict);
    }
    const consent = consentFor(form);
    if (!consent) {
      // La organización no tiene un contacto válido para el aviso de privacidad: no se puede aceptar.
      await serverLog("warn", "intake_submit_consent_unavailable");
      return respond({ status: "paused", message: MSG_PAUSED }, STATUS.conflict);
    }

    // El formulario o el aviso de privacidad cambiaron desde que la persona los vio: se le entrega lo nuevo
    // para que revise y vuelva a aceptar. Lo que se guarda como consentimiento es siempre lo que leyó.
    const consentChanged =
      typeof raw.consentFingerprint === "string" &&
      raw.consentFingerprint !== consentFingerprint(consent.text, consent.privacyPolicyUrl);
    if (
      consentChanged ||
      (typeof raw.formRevision === "number" && raw.formRevision !== form.revision)
    ) {
      return respond(formChanged(form, consent, publicId, raw.submitKey), STATUS.conflict);
    }

    const parsed = buildSubmitSchema({
      fields: form.fields,
      items: form.items.map((item) => ({
        id: item.id,
        quantityMode: item.quantityMode,
        minQtyMilli: item.minQtyMilli,
        maxQtyMilli: item.maxQtyMilli,
      })),
    }).safeParse(raw);
    if (!parsed.success) {
      await countBlock(publicId, "invalid");
      return respond({ status: "invalid", fieldErrors: fieldErrors(parsed.error) }, STATUS.invalid);
    }
    const data = parsed.data;

    // 9. Cifrado y envío a la base. El id de la solicitud lo genera la aplicación (parte del sello).
    const requestId = randomUUID();
    const result = await submitIntakeRequest({
      publicId,
      requestId,
      submitKey: data.submitKey,
      formRevision: data.formRevision,
      ...encryptFields(data, clientIp, form.tenantId, requestId),
      desiredDate: data.desiredDate,
      items: data.items,
      consentTemplateVersion: `${CONSENT_VERSION_PREFIX}${consent.templateVersion}`,
      consentText: consentTextToStore(consent),
    });

    switch (result.result) {
      case "ok":
        // El mismo envío repetido (reintento por mala conexión): ya se avisó la primera vez.
        if (!result.replayed) after(() => notifyRequestReceived(result.requestId));
        return respond(
          { status: "ok", message: form.successMessage || MSG_RECEIVED_DEFAULT },
          STATUS.ok,
        );
      case "cap_reached":
        if (result.notifyCap) after(() => notifyCapReached(result.formId, result.capKind));
        return respond({ status: "cap_reached", message: MSG_CAP_REACHED }, STATUS.conflict);
      case "paused":
        return respond({ status: "paused", message: MSG_PAUSED }, STATUS.conflict);
      case "not_found":
        return respond({ status: "not_found", message: MSG_NOT_FOUND }, STATUS.not_found);
      case "form_changed":
      case "invalid_items": {
        // Carrera con una edición del formulario: se vuelve a leer y se entrega el vigente.
        const fresh = await readIntakeForm(publicId);
        const freshConsent = fresh.state === "ok" ? consentFor(fresh) : null;
        if (fresh.state !== "ok" || !freshConsent) {
          return respond({ status: "paused", message: MSG_PAUSED }, STATUS.conflict);
        }
        return respond(formChanged(fresh, freshConsent, publicId, data.submitKey), STATUS.conflict);
      }
      case "invalid_data":
        return respond(
          { status: "invalid", fieldErrors: { form: MSG_UNREADABLE } },
          STATUS.invalid,
        );
      case "conflict":
        return respond({ status: "conflict", message: MSG_CONFLICT }, STATUS.conflict);
    }
  } catch (cause) {
    // Solo un código: nunca el mensaje completo, el identificador ni datos del visitante.
    const code =
      cause instanceof IntakeGatewayError
        ? cause.message
        : cause instanceof RenderTokenConfigError
          ? "render_secret_config"
          : "unexpected";
    await serverLog("error", "intake_submit_failed", { code });
    return respond({ status: "error", message: MSG_ERROR }, STATUS.error);
  }
}

function formChanged(
  form: IntakeFormAvailable,
  consent: ConsentNotice,
  publicId: string,
  submitKey: string,
): SubmitResponse {
  return {
    status: "form_changed",
    message: MSG_FORM_CHANGED,
    content: buildPublicContent(form, consent),
    renderToken: createRenderToken(publicId, submitKey),
  };
}
