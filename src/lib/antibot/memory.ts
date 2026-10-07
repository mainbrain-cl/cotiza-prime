import type { AntibotVerifier, AntibotVerifyInput, AntibotVerifyResult } from "./types";

/** Tokens del adaptador de pruebas. La aplicación no arranca con él en producción. */
export const MEMORY_PASS_TOKEN = "test-pass";
export const MEMORY_FAIL_TOKEN = "test-fail";

export function createMemoryAntibot(): AntibotVerifier {
  return {
    provider: "memory",
    async verify({ token }: AntibotVerifyInput): Promise<AntibotVerifyResult> {
      if (!token) return { ok: false, reason: "missing_token" };
      if (token === MEMORY_PASS_TOKEN) return { ok: true };
      return { ok: false, reason: "invalid_token" };
    },
  };
}
