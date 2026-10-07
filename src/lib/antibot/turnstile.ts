import { z } from "zod";
import type {
  AntibotFailReason,
  AntibotVerifier,
  AntibotVerifyInput,
  AntibotVerifyResult,
} from "./types";

/** Única dirección a la que este adaptador le habla (lista blanca de una sola entrada). */
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_TIMEOUT_MS = 5_000;
/** Cloudflare documenta 2.048 caracteres como máximo para el token. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;
const MAX_RESPONSE_CHARS = 10_000;
const MAX_REMOTE_IP_LENGTH = 45;

const responseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
});

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type TurnstileOptions = {
  secretKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

function fail(reason: AntibotFailReason): AntibotVerifyResult {
  return { ok: false, reason };
}

/**
 * Verifica el token con Cloudflare. Falla cerrado: si Cloudflare no responde, tarda más de 5 s,
 * redirige o contesta algo que no se entiende, el envío se bloquea.
 */
export function createTurnstileVerifier(options: TurnstileOptions): AntibotVerifier {
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? TURNSTILE_TIMEOUT_MS;

  return {
    provider: "turnstile",
    async verify(input: AntibotVerifyInput): Promise<AntibotVerifyResult> {
      const token = input.token;
      if (!token) return fail("missing_token");
      if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) return fail("invalid_token");

      const body = new URLSearchParams({ secret: options.secretKey, response: token });
      if (input.remoteIp && input.remoteIp.length <= MAX_REMOTE_IP_LENGTH) {
        body.set("remoteip", input.remoteIp);
      }

      let text: string;
      try {
        const response = await doFetch(TURNSTILE_VERIFY_URL, {
          method: "POST",
          body,
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.redirected || !response.ok) return fail("unreachable");
        text = await response.text();
      } catch {
        return fail("unreachable");
      }
      if (text.length > MAX_RESPONSE_CHARS) return fail("bad_response");

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return fail("bad_response");
      }
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) return fail("bad_response");
      if (!parsed.data.success) return fail("invalid_token");
      if (parsed.data.hostname !== input.expectedHostname) return fail("hostname_mismatch");
      if (parsed.data.action !== input.expectedAction) return fail("action_mismatch");
      return { ok: true };
    },
  };
}
