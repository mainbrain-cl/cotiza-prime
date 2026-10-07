import { z } from "zod";
import { PRODUCTION_ENV, resolveAppEnv } from "@/lib/env/app-env";
import { createMemoryAntibot } from "./memory";
import { createTurnstileVerifier } from "./turnstile";
import { ANTIBOT_PROVIDERS, type AntibotProviderName, type AntibotVerifier } from "./types";

export const DEFAULT_TEST_ANTIBOT_PROVIDER: AntibotProviderName = "memory";
const FORBIDDEN_IN_PRODUCTION: readonly AntibotProviderName[] = ["memory"];
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 200;

export class AntibotConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AntibotConfigError";
  }
}

export type AntibotConfig = {
  provider: AntibotProviderName;
  turnstileSecretKey: string | null;
  /** Clave pública del widget: la única que llega al navegador. */
  turnstileSiteKey: string | null;
};

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const keySchema = z.preprocess(
  emptyToUndefined,
  z.string().trim().min(MIN_KEY_LENGTH).max(MAX_KEY_LENGTH).optional(),
);

const rawSchema = z.object({
  ANTIBOT_PROVIDER: z.preprocess(emptyToUndefined, z.enum(ANTIBOT_PROVIDERS).optional()),
  TURNSTILE_SECRET_KEY: keySchema,
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: keySchema,
});

/**
 * Lee y valida las variables del anti-robot (único lugar). Los errores nombran la variable, nunca su
 * valor. En producción se niega a aceptar `memory`.
 */
export function loadAntibotConfig(
  env: Record<string, string | undefined> = process.env,
): AntibotConfig {
  const isProduction = resolveAppEnv(env.NEXT_PUBLIC_APP_ENV) === PRODUCTION_ENV;

  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new AntibotConfigError(`Configuración anti-robot inválida: revisa ${names.join(", ")}.`);
  }
  const raw = parsed.data;

  const provider =
    raw.ANTIBOT_PROVIDER ?? (isProduction ? undefined : DEFAULT_TEST_ANTIBOT_PROVIDER);
  if (!provider) throw new AntibotConfigError("En producción hay que definir ANTIBOT_PROVIDER.");
  if (isProduction && FORBIDDEN_IN_PRODUCTION.includes(provider)) {
    throw new AntibotConfigError(
      `ANTIBOT_PROVIDER=${provider} no se permite en producción: la aplicación no arranca.`,
    );
  }

  if (provider === "turnstile") {
    if (!raw.TURNSTILE_SECRET_KEY) throw new AntibotConfigError("Falta TURNSTILE_SECRET_KEY.");
    if (!raw.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
      throw new AntibotConfigError("Falta NEXT_PUBLIC_TURNSTILE_SITE_KEY.");
    }
  }

  return {
    provider,
    turnstileSecretKey: raw.TURNSTILE_SECRET_KEY ?? null,
    turnstileSiteKey: raw.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null,
  };
}

export function createAntibotVerifier(config: AntibotConfig): AntibotVerifier {
  if (config.provider === "turnstile") {
    // `loadAntibotConfig` ya comprobó que la clave existe.
    return createTurnstileVerifier({ secretKey: config.turnstileSecretKey ?? "" });
  }
  return createMemoryAntibot();
}

let cached: AntibotVerifier | null = null;

/** Verificador según el entorno. Lanza `AntibotConfigError` si la configuración no sirve. */
export function getAntibotVerifier(): AntibotVerifier {
  cached ??= createAntibotVerifier(loadAntibotConfig());
  return cached;
}

/** Solo para pruebas. */
export function resetAntibotVerifierForTests(): void {
  cached = null;
}
