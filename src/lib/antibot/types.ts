/**
 * Contrato de la protección anti-robot del formulario público (decisión 019). Cada proveedor es un
 * adaptador intercambiable; quien llama no sabe cuál hay detrás.
 */
export const ANTIBOT_PROVIDERS = ["turnstile", "memory"] as const;
export type AntibotProviderName = (typeof ANTIBOT_PROVIDERS)[number];

/** Por qué se rechazó un intento. Sirve para contar bloqueos; nunca se muestra al visitante. */
export const ANTIBOT_FAIL_REASONS = [
  "missing_token",
  "invalid_token",
  "hostname_mismatch",
  "action_mismatch",
  "unreachable",
  "bad_response",
] as const;
export type AntibotFailReason = (typeof ANTIBOT_FAIL_REASONS)[number];

export type AntibotVerifyInput = {
  /** Lo que entregó el widget en el navegador. */
  token: string;
  /** IP de quien envía, si se conoce. */
  remoteIp?: string | null;
  /** Dirección (sin puerto ni esquema) donde debe haberse resuelto la prueba. */
  expectedHostname: string;
  /** Acción con que se mostró el widget. */
  expectedAction: string;
};

export type AntibotVerifyResult = { ok: true } | { ok: false; reason: AntibotFailReason };

export interface AntibotVerifier {
  readonly provider: AntibotProviderName;
  verify(input: AntibotVerifyInput): Promise<AntibotVerifyResult>;
}
