import "server-only";
import { after } from "next/server";
import { getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { consumeShareRespondQuota } from "@/lib/security/login-rate-limit";
import { onQuoteResponded } from "./after-response";
import { PUBLIC_RESPONSE_HEADERS, TOO_MANY_REQUESTS_MESSAGE } from "./public-request";
import {
  MSG_INVALID_REQUEST,
  RESPOND_BODY_MAX_BYTES,
  acceptInputSchema,
  fieldErrorsOf,
  rejectInputSchema,
  type RespondOutcome,
} from "./respond";
import { respondToShare } from "./respond-service";

/**
 * Cuerpo común de las dos rutas de respuesta del cliente (H-031). Las rutas ya comprobaron el origen
 * y el token, y aplicaron el límite de lectura; aquí se lee el cuerpo, se valida ANTES de cifrar o de
 * tocar la base, se cuenta el límite de respuestas por IP y se llama al servicio.
 */

const RETRY_AFTER_SECONDS = 3_600;
const HTTP_STATUS: Record<RespondOutcome["status"], number> = {
  ok: 200,
  already_responded: 200,
  unavailable: 409,
  invalid: 422,
  error: 500,
};

function json(outcome: RespondOutcome): Response {
  const status =
    outcome.status === "unavailable" && outcome.reason === "not_found"
      ? 404
      : HTTP_STATUS[outcome.status];
  return Response.json(outcome, { status, headers: PUBLIC_RESPONSE_HEADERS });
}

const invalidRequest = () =>
  json({ status: "invalid", fieldErrors: { form: MSG_INVALID_REQUEST } });

async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > RESPOND_BODY_MAX_BYTES) return undefined;
  const text = await request.text();
  if (text.length > RESPOND_BODY_MAX_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function respondFromRequest(
  request: Request,
  token: string,
  decision: "accepted" | "rejected",
): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === undefined || body === null || typeof body !== "object") return invalidRequest();

  const parsed =
    decision === "accepted" ? acceptInputSchema.safeParse(body) : rejectInputSchema.safeParse(body);
  if (!parsed.success) return json({ status: "invalid", fieldErrors: fieldErrorsOf(parsed.error) });

  const { clientIp } = await getRequestContext();
  if (!(await consumeShareRespondQuota(clientIp))) {
    await serverLog("warn", "share_respond_rate_limited");
    return Response.json(
      { status: "rate_limited", message: TOO_MANY_REQUESTS_MESSAGE },
      {
        status: 429,
        headers: { ...PUBLIC_RESPONSE_HEADERS, "Retry-After": String(RETRY_AFTER_SECONDS) },
      },
    );
  }

  try {
    const result = await respondToShare(
      token,
      decision === "accepted"
        ? { decision, input: acceptInputSchema.parse(body) }
        : { decision, input: rejectInputSchema.parse(body) },
    );
    const { notify } = result;
    // El aviso al autor sale DESPUÉS de responderle al cliente, y si falla no le afecta.
    if (notify) after(() => onQuoteResponded(notify));
    return json(result.outcome);
  } catch {
    await serverLog("error", "share_respond_failed");
    return json({ status: "error" });
  }
}
