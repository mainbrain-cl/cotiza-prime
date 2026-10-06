import "server-only";
import { randomUUID } from "node:crypto";
import { encryptPii } from "@/lib/crypto/pii";
import { getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import type { QuoteRespondedInput } from "./after-response";
import { readShareLink, respondShareLink } from "./gateway";
import { isAvailable } from "./read-model";
import {
  ACCEPTANCE_TEXT_VERSION,
  type AcceptInput,
  type RejectInput,
  type RespondOutcome,
} from "./respond";

/**
 * Registra la respuesta del cliente (H-031). Lo usan las dos rutas (`accept` y `reject`) DESPUÉS de
 * comprobar el origen, el token, los límites y la forma de lo enviado.
 *
 * Reglas:
 *  - Quien decide si se puede responder es la base de datos (`share_link_respond`): vencida,
 *    revocada, reemplazada, ya respondida. Aquí solo se traduce su resultado.
 *  - El nombre y el texto del motivo se cifran aquí, con el sello de la fila (tabla, organización e
 *    id de la respuesta, que genera la aplicación). La IP sale del servidor, nunca del cliente.
 *  - Nunca se registra el token, el nombre, el motivo ni la IP.
 */

export type RespondDecision =
  { decision: "accepted"; input: AcceptInput } | { decision: "rejected"; input: RejectInput };

type UnavailableReason = Extract<RespondOutcome, { status: "unavailable" }>["reason"];
const UNAVAILABLE_RESULTS: ReadonlySet<string> = new Set([
  "expired",
  "revoked",
  "superseded",
  "not_found",
  "not_allowed",
]);

export type RespondServiceResult = {
  outcome: RespondOutcome;
  /** Solo cuando ESTA petición registró la respuesta: lo que hay que avisar después. */
  notify: QuoteRespondedInput | null;
};

const seal = (field: string, tenantId: string, responseId: string) => ({
  table: "quote_responses",
  field,
  tenantId,
  rowId: responseId,
});

const asDecision = (value: unknown): "accepted" | "rejected" | null =>
  value === "accepted" || value === "rejected" ? value : null;

export async function respondToShare(
  token: string,
  request: RespondDecision,
): Promise<RespondServiceResult> {
  const link = await readShareLink(token);
  if (link.state === "not_found") {
    return { outcome: { status: "unavailable", reason: "not_found" }, notify: null };
  }
  if (!isAvailable(link)) {
    return { outcome: { status: "unavailable", reason: link.state }, notify: null };
  }

  const { clientIp, userAgent } = await getRequestContext();
  const responseId = randomUUID();
  const accepted = request.decision === "accepted";
  const reasonText = !accepted && request.input.reasonText ? request.input.reasonText : null;

  const result = await respondShareLink({
    token,
    responseId,
    responseKey: request.input.responseKey,
    decision: request.decision,
    acceptorNameEnc: accepted
      ? encryptPii(request.input.name, seal("acceptor_name", link.tenantId, responseId))
      : null,
    reasonCode: accepted ? null : request.input.reasonCode,
    reasonTextEnc: reasonText
      ? encryptPii(reasonText, seal("reason_text", link.tenantId, responseId))
      : null,
    ipEnc: clientIp ? encryptPii(clientIp, seal("ip", link.tenantId, responseId)) : null,
    originIp: clientIp,
    userAgent,
    acceptanceTextVersion: accepted ? ACCEPTANCE_TEXT_VERSION : null,
  });

  const decision = asDecision(result.decision);
  if (result.result === "ok" && decision) {
    // `replayed`: el mismo envío repetido (doble clic). Ya se avisó la primera vez.
    if (result.replayed === true) return { outcome: { status: "ok", decision }, notify: null };
    const authorId = typeof result.author_id === "string" ? result.author_id : null;
    const numberDisplay = typeof result.number_display === "string" ? result.number_display : "";
    return {
      outcome: { status: "ok", decision },
      notify: {
        tenantId: link.tenantId,
        quoteId: link.quoteId,
        authorId,
        numberDisplay,
        responseId,
        decision,
        acceptorName: accepted ? request.input.name : null,
        reasonCode: accepted ? null : request.input.reasonCode,
        reasonText,
      },
    };
  }
  if (result.result === "already_responded" && decision) {
    return { outcome: { status: "already_responded", decision }, notify: null };
  }
  if (UNAVAILABLE_RESULTS.has(result.result)) {
    return {
      outcome: { status: "unavailable", reason: result.result as UnavailableReason },
      notify: null,
    };
  }
  await serverLog("error", "share_respond_unexpected_result", { code: result.result });
  return { outcome: { status: "error" }, notify: null };
}
