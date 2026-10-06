import { z } from "zod";
import { PRODUCTION_ENV, resolveAppEnv, type AppEnv } from "@/lib/env/app-env";
import { EMAIL_PROVIDERS, type EmailProviderName } from "./types";

/** Valores por defecto y límites de la configuración de correo. */
export const DEFAULT_MAILPIT_API_URL = "http://127.0.0.1:56324";
export const DEFAULT_TEST_FROM_ADDRESS = "cotizaciones@ejemplo.test";
export const DEFAULT_TEST_PROVIDER: EmailProviderName = "memory";
export const TEST_ALLOWED_RECIPIENT_DOMAINS = ["ejemplo.test", "rebota.ejemplo.test"] as const;
export const BOUNCE_SIMULATION_DOMAIN = "rebota.ejemplo.test";
const MIN_WEBHOOK_SECRET_LENGTH = 16;
const FORBIDDEN_IN_PRODUCTION: readonly EmailProviderName[] = ["mailpit", "memory"];

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailConfigError";
  }
}

export type EmailConfig = {
  appEnv: AppEnv;
  provider: EmailProviderName;
  fromAddress: string;
  mailpitApiUrl: string;
  resendApiKey: string | null;
  webhookSecret: string | null;
  /** `null` = sin lista blanca (solo posible en producción). */
  allowedRecipientDomains: string[] | null;
};

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const rawSchema = z.object({
  EMAIL_PROVIDER: z.preprocess(emptyToUndefined, z.enum(EMAIL_PROVIDERS).optional()),
  EMAIL_FROM_ADDRESS: z.preprocess(emptyToUndefined, z.email().max(254).optional()),
  MAILPIT_API_URL: z.preprocess(emptyToUndefined, z.url({ protocol: /^https?$/ }).optional()),
  RESEND_API_KEY: z.preprocess(emptyToUndefined, z.string().trim().min(8).max(200).optional()),
  EMAIL_WEBHOOK_SECRET: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(MIN_WEBHOOK_SECRET_LENGTH).max(500).optional(),
  ),
  EMAIL_ALLOWED_RECIPIENT_DOMAINS: z.preprocess(emptyToUndefined, z.string().max(1000).optional()),
});

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function parseDomainList(raw: string): string[] {
  const domains = raw
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  for (const domain of domains) {
    if (!DOMAIN_PATTERN.test(domain)) {
      throw new EmailConfigError(
        "EMAIL_ALLOWED_RECIPIENT_DOMAINS trae un dominio con formato inválido.",
      );
    }
  }
  return domains;
}

/**
 * Lee y valida las variables de correo (único lugar). Los mensajes de error nombran la variable,
 * nunca su valor. En producción se niega a aceptar `mailpit` o `memory`.
 */
export function loadEmailConfig(
  env: Record<string, string | undefined> = process.env,
): EmailConfig {
  const appEnv = resolveAppEnv(env.NEXT_PUBLIC_APP_ENV);
  const isProduction = appEnv === PRODUCTION_ENV;

  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new EmailConfigError(`Configuración de correo inválida: revisa ${names.join(", ")}.`);
  }
  const raw = parsed.data;

  const provider = raw.EMAIL_PROVIDER ?? (isProduction ? undefined : DEFAULT_TEST_PROVIDER);
  if (!provider) throw new EmailConfigError("En producción hay que definir EMAIL_PROVIDER.");
  if (isProduction && FORBIDDEN_IN_PRODUCTION.includes(provider)) {
    throw new EmailConfigError(
      `EMAIL_PROVIDER=${provider} no se permite en producción: la aplicación no arranca.`,
    );
  }

  const fromAddress =
    raw.EMAIL_FROM_ADDRESS ?? (isProduction ? undefined : DEFAULT_TEST_FROM_ADDRESS);
  if (!fromAddress) throw new EmailConfigError("En producción hay que definir EMAIL_FROM_ADDRESS.");

  if (provider === "resend") {
    if (!raw.RESEND_API_KEY) throw new EmailConfigError("Falta RESEND_API_KEY.");
    if (isProduction && !raw.EMAIL_WEBHOOK_SECRET) {
      throw new EmailConfigError(
        "Falta EMAIL_WEBHOOK_SECRET: sin él no se verifican los avisos de rebote.",
      );
    }
  }

  let allowedRecipientDomains: string[] | null;
  if (raw.EMAIL_ALLOWED_RECIPIENT_DOMAINS) {
    allowedRecipientDomains = parseDomainList(raw.EMAIL_ALLOWED_RECIPIENT_DOMAINS);
  } else {
    allowedRecipientDomains = isProduction ? null : [...TEST_ALLOWED_RECIPIENT_DOMAINS];
  }

  return {
    appEnv,
    provider,
    fromAddress,
    mailpitApiUrl: (raw.MAILPIT_API_URL ?? DEFAULT_MAILPIT_API_URL).replace(/\/+$/, ""),
    resendApiKey: raw.RESEND_API_KEY ?? null,
    webhookSecret: raw.EMAIL_WEBHOOK_SECRET ?? null,
    allowedRecipientDomains,
  };
}
