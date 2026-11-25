/**
 * Las reglas de la configuración de Supabase Auth que cierran el ataque de H-116 («que nadie pueda adueñarse de una cuenta
 * registrándose antes con su correo»), en un solo lugar y sin tocar la red: las usan `scripts/check-auth-config.ts` (que consulta
 * un Supabase de verdad) y las pruebas (que las comparan con `supabase/config.toml` y con respuestas simuladas).
 *
 * Es la lista de `docs/arquitectura/h-116-registro-seguro.md` §5. Cada regla puede mirarse en dos lugares:
 *  - `public`: `GET /auth/v1/settings` (público, solo trae una parte de la configuración);
 *  - `management`: la API de gestión de Supabase, `GET /v1/projects/{ref}/config/auth` (necesita el token de quien opera el
 *    proyecto, que NUNCA vive en la aplicación ni en el repositorio).
 *
 * Reglas de la comprobación: lo que no se pudo leer NO se da por bueno. Una regla sin dato queda «sin dato» y el guion termina con
 * error; un valor distinto del esperado es un «fallo». Los nombres de los campos de la API de gestión salen de la documentación
 * de Supabase y no se han contrastado con un proyecto de producción (todavía no existe): si alguno cambia, la regla queda «sin
 * dato» y se corrige aquí, nunca se aprueba en silencio.
 */

/** Lo que se espera de un valor. */
export type Expectation =
  | { kind: "equals"; value: boolean | number | string }
  | { kind: "atLeast"; value: number }
  | { kind: "atMost"; value: number }
  | { kind: "nonEmpty" }
  /** Un texto de duración como «168h», «12h» o «30m» (el formato de `config.toml`) o un número de segundos. */
  | { kind: "seconds"; value: number };

export type ConfigRule = {
  id: string;
  /** El punto de la lista de §5 del diseño (para quien lee la salida). */
  point: number;
  label: string;
  expect: Expectation;
  /** Ruta con puntos dentro de `GET /auth/v1/settings` (por ejemplo `external.email`). */
  public?: string;
  /** Campo de `GET /v1/projects/{ref}/config/auth`. */
  management?: string;
  /** Dónde está el valor equivalente en `supabase/config.toml` (solo local); una prueba comprueba que coincida con `expect`. */
  local?: {
    section: string;
    key: string;
    /** En `config.toml` el interruptor significa lo contrario (`enable_signup` frente a `disable_signup`). */ inverted?: boolean;
  };
};

/** Los proveedores externos de ingreso: todos apagados (punto 7). `settings` los llama distinto a la API de gestión. */
export const EXTERNAL_PROVIDERS = [
  "apple",
  "azure",
  "bitbucket",
  "discord",
  "facebook",
  "figma",
  "fly",
  "github",
  "gitlab",
  "google",
  "kakao",
  "keycloak",
  "linkedin",
  "linkedin_oidc",
  "notion",
  "slack",
  "slack_oidc",
  "spotify",
  "twitch",
  "twitter",
  "workos",
  "zoom",
] as const;

const OFF = { kind: "equals", value: false } as const;
const ON = { kind: "equals", value: true } as const;

export const CONFIG_RULES: readonly ConfigRule[] = [
  // 1. El registro público de Supabase, apagado: la defensa que de verdad cierra el ataque.
  {
    id: "signup-disabled",
    point: 1,
    label: "«Allow new users to sign up» apagado (el registro público de Supabase)",
    expect: ON,
    public: "disable_signup",
    management: "disable_signup",
    local: { section: "auth", key: "enable_signup", inverted: true },
  },
  // 2. El proveedor Email, encendido: es el ingreso con contraseña y la recuperación.
  {
    id: "email-provider-on",
    point: 2,
    label: "Proveedor Email encendido (ingreso con contraseña y recuperación)",
    expect: ON,
    public: "external.email",
    management: "external_email_enabled",
    local: { section: "auth.email", key: "enable_signup" },
  },
  // 3. Confirmar el correo: nadie entra con un correo que no confirmó.
  {
    id: "confirm-email",
    point: 3,
    label: "«Confirm email» encendido (sin autoconfirmación)",
    expect: OFF,
    public: "mailer_autoconfirm",
    management: "mailer_autoconfirm",
    local: { section: "auth.email", key: "enable_confirmations", inverted: true },
  },
  // 4. Cambio de correo en dos clics.
  {
    id: "secure-email-change",
    point: 4,
    label: "«Secure email change» encendido (el cambio de correo se confirma en los dos correos)",
    expect: ON,
    management: "mailer_secure_email_change_enabled",
    local: { section: "auth.email", key: "double_confirm_changes" },
  },
  // 5. Cambio de contraseña con sesión reciente.
  {
    id: "secure-password-change",
    point: 5,
    label: "«Secure password change» encendido (cambiar la contraseña exige una sesión reciente)",
    expect: ON,
    management: "security_update_password_require_reauthentication",
    local: { section: "auth.email", key: "secure_password_change" },
  },
  // 6. Largo mínimo de la contraseña.
  {
    id: "password-min-length",
    point: 6,
    label: "Largo mínimo de la contraseña: 10 o más",
    expect: { kind: "atLeast", value: 10 },
    management: "password_min_length",
    local: { section: "auth", key: "minimum_password_length" },
  },
  // 7. Todo lo que abre otra puerta de entrada, apagado.
  {
    id: "anonymous-off",
    point: 7,
    label: "Ingreso anónimo apagado",
    expect: OFF,
    public: "external.anonymous_users",
    management: "external_anonymous_users_enabled",
    local: { section: "auth", key: "enable_anonymous_sign_ins" },
  },
  {
    id: "manual-linking-off",
    point: 7,
    label: "Enlace manual de cuentas apagado",
    expect: OFF,
    management: "security_manual_linking_enabled",
    local: { section: "auth", key: "enable_manual_linking" },
  },
  {
    id: "phone-off",
    point: 7,
    label: "Ingreso por teléfono apagado",
    expect: OFF,
    public: "external.phone",
    management: "external_phone_enabled",
  },
  {
    id: "saml-off",
    point: 7,
    label: "SAML apagado",
    expect: OFF,
    public: "saml_enabled",
    management: "saml_enabled",
  },
  {
    id: "mfa-phone-off",
    point: 7,
    label: "Segundo paso por teléfono apagado (solo se maneja la aplicación de códigos)",
    expect: OFF,
    management: "mfa_phone_enroll_enabled",
  },
  {
    id: "mfa-webauthn-off",
    point: 7,
    label: "Segundo paso con llaves de seguridad (WebAuthn) apagado",
    expect: OFF,
    management: "mfa_web_authn_enroll_enabled",
  },
  {
    id: "web3-solana-off",
    point: 7,
    label: "Ingreso con Solana apagado",
    expect: OFF,
    management: "external_web3_solana_enabled",
    local: { section: "auth.web3.solana", key: "enabled" },
  },
  {
    id: "web3-ethereum-off",
    point: 7,
    label: "Ingreso con Ethereum apagado",
    expect: OFF,
    management: "external_web3_ethereum_enabled",
  },
  ...EXTERNAL_PROVIDERS.map((provider): ConfigRule => ({
    id: `provider-${provider}-off`,
    point: 7,
    label: `Proveedor externo «${provider}» apagado`,
    expect: OFF,
    public: `external.${provider}`,
    management: `external_${provider}_enabled`,
    // `config.toml` solo trae la sección de `apple` (los demás proveedores quedan apagados por defecto).
    ...(provider === "apple" ? { local: { section: "auth.external.apple", key: "enabled" } } : {}),
  })),
  // 8. Pases y sesiones.
  {
    id: "jwt-expiry",
    point: 8,
    label: "Pase de sesión de 900 s",
    expect: { kind: "equals", value: 900 },
    management: "jwt_exp",
    local: { section: "auth", key: "jwt_expiry" },
  },
  {
    id: "refresh-rotation",
    point: 8,
    label: "Rotación del pase de renovación encendida",
    expect: ON,
    management: "refresh_token_rotation_enabled",
    local: { section: "auth", key: "enable_refresh_token_rotation" },
  },
  {
    id: "refresh-reuse-interval",
    point: 8,
    label: "Intervalo de reutilización del pase de renovación: 10 s",
    expect: { kind: "equals", value: 10 },
    management: "security_refresh_token_reuse_interval",
    local: { section: "auth", key: "refresh_token_reuse_interval" },
  },
  {
    id: "session-timebox",
    point: 8,
    label: "Duración máxima de la sesión: 168 h (puede exigir un plan de pago)",
    expect: { kind: "seconds", value: 168 * 3600 },
    management: "sessions_timebox",
    local: { section: "auth.sessions", key: "timebox" },
  },
  {
    id: "session-inactivity",
    point: 8,
    label: "Cierre por inactividad: 12 h (puede exigir un plan de pago)",
    expect: { kind: "seconds", value: 12 * 3600 },
    management: "sessions_inactivity_timeout",
    local: { section: "auth.sessions", key: "inactivity_timeout" },
  },
  // 9. Correo propio.
  {
    id: "smtp-configured",
    point: 9,
    label:
      "SMTP propio configurado para los correos de Supabase (el de serie solo llega al equipo del proyecto)",
    expect: { kind: "nonEmpty" },
    management: "smtp_host",
  },
  // 11. Direcciones.
  {
    id: "site-url",
    point: 11,
    label: "Site URL definida (la dirección de producción, sin «localhost»)",
    expect: { kind: "nonEmpty" },
    management: "site_url",
  },
  // 12. Ganchos: ninguno.
  ...[
    "hook_custom_access_token_enabled",
    "hook_mfa_verification_attempt_enabled",
    "hook_password_verification_attempt_enabled",
    "hook_send_email_enabled",
    "hook_send_sms_enabled",
    "hook_before_user_created_enabled",
  ].map((field): ConfigRule => ({
    id: field.replaceAll("_", "-"),
    point: 12,
    label: `Gancho de Supabase apagado (${field.replace(/^hook_/, "").replace(/_enabled$/, "")})`,
    expect: OFF,
    management: field,
  })),
  // 17. Largo del código del correo.
  {
    id: "otp-length",
    point: 17,
    label: "Largo del código del correo: 10 (con 6 se podría adivinar)",
    expect: { kind: "equals", value: 10 },
    management: "mailer_otp_length",
    local: { section: "auth.email", key: "otp_length" },
  },
  {
    id: "otp-expiry",
    point: 17,
    label: "El enlace del correo vale 1 hora (3600 s)",
    expect: { kind: "equals", value: 3600 },
    management: "mailer_otp_exp",
    local: { section: "auth.email", key: "otp_expiry" },
  },
] as const;

/** Lo que ninguna API de configuración dice y alguien tiene que revisar a mano (puntos de §5). */
export const MANUAL_CHECKS: readonly { point: number; label: string }[] = [
  { point: 9, label: "SPF, DKIM y DMARC del dominio de correo (con el proveedor)" },
  {
    point: 10,
    label:
      "Plantillas de Supabase en español cargadas en el panel (recuperación, cambio de correo con la advertencia, contraseña cambiada; las demás apuntan a la aplicación)",
  },
  {
    point: 11,
    label:
      "Redirecciones permitidas: solo `/auth/recuperar` y `/auth/callback` de producción, sin comodines ni «localhost»",
  },
  {
    point: 13,
    label:
      "En la aplicación: `APP_ORIGIN`, `EMAIL_PROVIDER` real y anti-robot real (la propia aplicación lo revisa al arrancar)",
  },
  {
    point: 15,
    label:
      "Cero cuentas sin verificar antes de abrir el piloto (consulta de solo lectura en el editor SQL del panel)",
  },
  {
    point: 16,
    label: "Protección de contraseñas filtradas, si el plan la incluye (decisión de Aarón)",
  },
];

export type RuleStatus = "ok" | "fail" | "unknown";

export type RuleResult = {
  id: string;
  point: number;
  label: string;
  status: RuleStatus;
  /** Qué se leyó y de dónde (nunca un secreto: solo el valor de configuración). */
  detail: string;
};

/** Lee un valor de un objeto con una ruta de puntos. `undefined` si falta algo en el camino. */
export function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** «168h», «12h30m», «45m», «90s» o un número de segundos → segundos. `null` si no se entiende. */
export function parseDurationSeconds(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const pattern = /(\d+(?:\.\d+)?)(h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[1]);
    total += amount * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1);
    consumed += match[0].length;
  }
  return consumed > 0 && consumed === text.length ? total : null;
}

/**
 * Compara un valor con lo esperado. Los textos con la forma de un número se tratan como número (la API de gestión devuelve
 * algunos largos como texto). `null` = el valor no se puede interpretar.
 */
export function meets(expectation: Expectation, raw: unknown): boolean | null {
  if (raw === undefined || raw === null) return null;
  switch (expectation.kind) {
    case "equals": {
      if (typeof expectation.value === "boolean")
        return typeof raw === "boolean" ? raw === expectation.value : null;
      if (typeof expectation.value === "number") {
        const number = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
        return typeof number === "number" && Number.isFinite(number)
          ? number === expectation.value
          : null;
      }
      return typeof raw === "string" ? raw === expectation.value : null;
    }
    case "atLeast":
    case "atMost": {
      const number = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof number !== "number" || !Number.isFinite(number)) return null;
      return expectation.kind === "atLeast"
        ? number >= expectation.value
        : number <= expectation.value;
    }
    case "nonEmpty":
      return typeof raw === "string" ? raw.trim().length > 0 : null;
    case "seconds": {
      const seconds = parseDurationSeconds(raw);
      return seconds === null ? null : seconds === expectation.value;
    }
  }
}

function describe(expectation: Expectation): string {
  switch (expectation.kind) {
    case "equals":
      return String(expectation.value);
    case "atLeast":
      return `${expectation.value} o más`;
    case "atMost":
      return `${expectation.value} o menos`;
    case "nonEmpty":
      return "con algún valor";
    case "seconds":
      return `${expectation.value} s`;
  }
}

/**
 * Evalúa todas las reglas con lo que se pudo leer (`null` = esa fuente no se consultó o no respondió). Una regla con dos
 * fuentes falla si CUALQUIERA de las dos dice otra cosa; queda «sin dato» si ninguna pudo contestar.
 */
export function evaluateRules(sources: {
  publicSettings: unknown | null;
  management: unknown | null;
}): RuleResult[] {
  return CONFIG_RULES.map((rule): RuleResult => {
    const readings: { from: string; ok: boolean | null; shown: string }[] = [];
    if (rule.public && sources.publicSettings !== null) {
      const raw = readPath(sources.publicSettings, rule.public);
      readings.push({ from: "público", ok: meets(rule.expect, raw), shown: shownValue(raw) });
    }
    if (rule.management && sources.management !== null) {
      const raw = (sources.management as Record<string, unknown>)[rule.management];
      readings.push({ from: "gestión", ok: meets(rule.expect, raw), shown: shownValue(raw) });
    }
    const base = { id: rule.id, point: rule.point, label: rule.label };
    const expected = `se espera ${describe(rule.expect)}`;
    const answered = readings.filter((reading) => reading.ok !== null);
    if (answered.length === 0) {
      const where = [
        rule.public ? "la configuración pública" : null,
        rule.management ? "la API de gestión" : null,
      ]
        .filter(Boolean)
        .join(" o ");
      return { ...base, status: "unknown", detail: `no se pudo leer en ${where} (${expected})` };
    }
    const failed = answered.filter((reading) => reading.ok === false);
    if (failed.length > 0) {
      return {
        ...base,
        status: "fail",
        detail: `${failed.map((reading) => `${reading.from}: ${reading.shown}`).join(", ")} (${expected})`,
      };
    }
    // Una fuente contestó que sí y otra no pudo leerse: no se da por bueno todo, se avisa.
    const silent = readings.filter((reading) => reading.ok === null);
    const detail = answered.map((reading) => `${reading.from}: ${reading.shown}`).join(", ");
    return silent.length > 0
      ? {
          ...base,
          status: "unknown",
          detail: `${detail}; no se pudo leer en ${silent.map((reading) => reading.from).join(" ni ")} (${expected})`,
        }
      : { ...base, status: "ok", detail };
  });
}

function shownValue(raw: unknown): string {
  if (raw === undefined) return "no viene";
  if (raw === null) return "vacío";
  // Valores de configuración simples; nunca se muestran textos largos (una clave de SMTP no es de estas reglas).
  return typeof raw === "string" ? `«${raw.slice(0, 60)}»` : String(raw);
}

/** ¿Todo en orden? Solo si ninguna regla falló ni quedó sin dato. */
export function allRulesPass(results: readonly RuleResult[]): boolean {
  return results.every((result) => result.status === "ok");
}
