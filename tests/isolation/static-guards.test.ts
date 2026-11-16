// H-012 · Guardias estáticas: leen el código, sin red. Complementan (no repiten)
// `src/lib/tenant/guard-coverage.test.ts`, que ya exige `requireActiveTenant` en toda pantalla y
// acción de servidor. Aquí se vigilan los otros caminos por los que se puede romper el aislamiento.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ROUTES } from "./registry";
import { discoverAppRoutes, routeKey } from "./routes";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const isTest = (file: string) => /\.test\.(ts|tsx)$/.test(file);
const sourceFiles = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !isTest(f));
const read = (file: string) => readFileSync(file, "utf8");
const sorted = (values: Iterable<string>) => [...values].sort();

/** Quita comentarios, para no confundir una explicación con código. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Lo que está mal en el código de una ruta de `/api/v1/jobs/*` (guardia 8f). Una ruta así exporta SOLO la
 * configuración (`runtime`, `dynamic`, `maxDuration`) y `GET = cronJobRoute("<nombre>", <tarea>)`: el secreto, el
 * 404 / 401, los registros y las cabeceras los resuelve `cronJobRoute`. Cualquier otro `export` (un `HEAD`, un
 * `POST`, un `export { x as POST }`, un `GET` escrito a mano que llame a `verifyCronRequest` e ignore o interprete
 * mal su resultado, un `default`…) es un problema. Devuelve la lista de problemas, vacía si todo está bien.
 */
function jobRouteProblems(source: string): string[] {
  const text = stripComments(source);
  const problems: string[] = [];
  const allowedExport = [
    /^export const (runtime|dynamic) = "[a-z-]+";$/,
    /^export const maxDuration = \d+;$/,
  ];
  const getExport = /^export const GET = cronJobRoute\(\s*"[a-z0-9-]+",\s*[A-Za-z_]\w*,?\s*\);$/;
  let gets = 0;
  // cada `export` hasta su primer `;` (un `export function` con cuerpo no calza y se marca)
  for (const match of text.matchAll(/\bexport\b[^;]*;?/g)) {
    const statement = match[0].replace(/\s+/g, " ").trim();
    if (getExport.test(statement)) gets += 1;
    else if (!allowedExport.some((pattern) => pattern.test(statement))) {
      problems.push(`export no permitido: ${statement.slice(0, 80)}`);
    }
  }
  if (gets !== 1)
    problems.push(`debe exportar exactamente un GET = cronJobRoute(...) (hay ${gets})`);
  if (!/import \{\s*cronJobRoute\s*\} from "@\/lib\/jobs\/cron-auth";/.test(text)) {
    problems.push("debe importar cronJobRoute de @/lib/jobs/cron-auth");
  }
  if (/CRON_SECRET/.test(text)) problems.push("no lee CRON_SECRET por su cuenta");
  if (/verifyCronRequest/.test(text))
    problems.push("no llama a verifyCronRequest: lo hace cronJobRoute");
  if (/admin-client|supabase|\.rpc\(|\.from\(/.test(text)) problems.push("no toca la base");
  return problems;
}

/** Cada llamada `serverLog( … )` completa (con paréntesis anidados y sin contar los de dentro de textos). */
function serverLogCalls(text: string): string[] {
  const calls: string[] = [];
  const start = /serverLog\(/g;
  for (let match = start.exec(text); match; match = start.exec(text)) {
    let depth = 0;
    let quote: string | null = null;
    let index = match.index + "serverLog".length;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(text.slice(match.index, index + 1));
  }
  return calls;
}

/** Cada llamada `name( … )` completa (con paréntesis anidados y sin contar los de dentro de textos). */
function namedCalls(text: string, name: string): string[] {
  const calls: string[] = [];
  const start = new RegExp(`\\b${name}\\(`, "g");
  for (let match = start.exec(text); match; match = start.exec(text)) {
    let depth = 0;
    let quote: string | null = null;
    let index = match.index + name.length;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(text.slice(match.index, index + 1));
  }
  return calls;
}

/**
 * H-004a: ¿esta llamada a `serverLog` o `logAuditEvent` lleva el código de 6 números, la clave, el uri, el QR o el correo?
 * H-004b: tampoco la contraseña (ningún identificador que contenga «password» o «contrasena»), ni los códigos de respaldo
 * (`codes`, `recoveryCode…`), su forma normalizada ni su huella (identificadores con «normalized», «hash» o «fingerprint»).
 * Sin los textos entre comillas, solo se permite `code:` si su valor viene de un error (`errorCodeOf(error)`, `error.code`) y
 * no puede quedar ningún `code` suelto ni `x.code` que no sea de un error. Devuelve el motivo o `null`.
 */
function secondStepLogViolation(call: string): string | null {
  const noStrings = call.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
  const withoutErrorCodes = noStrings
    .replace(/\bcode:\s*[^,}]*(?:errorCodeOf\(|\berror\b)[^,}]*/g, "")
    // Un texto fijo (ya vaciado arriba) no puede llevar el código de nadie: `{ code: "unexpected" }` es inofensivo.
    .replace(/\bcode:\s*''/g, "")
    .replace(/\b[A-Za-z_]*error[A-Za-z_]*\??\.code\b/gi, "");
  const forbidden =
    /\.code\b|\bcode\b|\bcodes\b|\b(otp|totp|secret|uri|qrCode|qr_code|email|checked|parsed)\b|\b\w*(password|contrasena|recoveryCode|normalized|hash|fingerprint)\w*\b/i.exec(
      withoutErrorCodes,
    );
  return forbidden ? `«${forbidden[0]}» no puede ir en un registro` : null;
}

/**
 * El orden de `verifyRecoveryCodeAction` (H-004b §3.4): sesión a medias → límite de intentos → tomar el código → quitar los
 * factores → cerrar las otras sesiones → completar → redirigir. Devuelve el motivo si falta algo o está fuera de orden.
 */
function recoveryUseOrderViolation(body: string): string | null {
  const steps = [
    "requirePendingSecondStep(",
    "blockedAttemptState(",
    "claimRecoveryCode(",
    "removeAllFactors(",
    ".signOut(",
    "completeRecoveryCode(",
    "redirect(",
  ];
  let previous = -1;
  for (const step of steps) {
    const at = body.indexOf(step);
    if (at === -1) return `falta ${step}`;
    if (at < previous) return `${step} va antes de lo que debe`;
    previous = at;
  }
  return /\.signOut\(\s*\{\s*scope:\s*["']others["']/.test(body)
    ? null
    : "las otras sesiones se cierran con scope «others»";
}

/** La API de administración de cuentas de Supabase Auth (con la llave maestra): `auth.admin`, también con espacios o saltos. */
const AUTH_ADMIN_PATTERN =
  /\bauth\s*(?:\?\.|\.)\s*admin\b|\bauth\s*(?:\?\.)?\s*\[\s*["'`]admin["'`]\s*\]|\{[^{}]*\badmin\b[^{}]*\}\s*=\s*[^;\n]*\bauth\b|\bauth\s*:\s*\{[^{}]*\badmin\b[^{}]*\}/;
/** Y, dentro de ella, la de los factores del segundo paso. */
const AUTH_ADMIN_MFA_PATTERN =
  /\bauth\s*(?:\?\.|\.)\s*admin\s*(?:\?\.|\.)\s*mfa\b|\bauth\s*(?:\?\.)?\s*\[\s*["'`]admin["'`]\s*\]\s*(?:\?\.|\.)\s*mfa\b/;
/** H-004b: abrir una sesión con correo y contraseña. Solo el ingreso y la comprobación de «pedir la contraseña de nuevo». */
const SIGN_IN_WITH_PASSWORD_PATTERN = /\bsignInWithPassword\b/;
const SIGN_IN_WITH_PASSWORD_FILES: readonly string[] = [
  "src/lib/auth/actions.ts",
  "src/lib/auth/reauth.ts",
];
/** La pasarela de los factores (H-118). */
const MFA_ADMIN_GATEWAY = "src/lib/security/mfa-admin-gateway.ts";
/** La pasarela de los códigos de respaldo (H-004b): la ÚNICA que llama a las siete funciones `mfa_recovery_*` de la base. */
const MFA_RECOVERY_GATEWAY = "src/lib/security/mfa-recovery-gateway.ts";
/** Las siete funciones de la base (`mfa_recovery_codes_replace`, `mfa_recovery_code_claim`…). Ni el propósito de la huella (`"mfa_recovery_code"`) ni los nombres de la auditoría (`session.mfa_recovery_codes_created`) calzan. */
const MFA_RECOVERY_FUNCTION_PATTERN =
  /\bmfa_recovery_codes?_(?:replace|claim|complete|release|acknowledge|status|revoke)\b/;
/** Y la tabla: nadie la lee ni la escribe directo (ni siquiera la pasarela: todo pasa por las funciones). */
const MFA_RECOVERY_TABLE_PATTERN = /\.from\(\s*["'`]mfa_recovery_codes["'`]/;
/** Las acciones que desactivan el segundo paso o crean códigos con la sesión completa (se crean en la etapa C de H-004b). */
const SECOND_STEP_MANAGE_ACTIONS = "src/lib/auth/second-step-manage-actions.ts";
/** Crear códigos de respaldo con la sesión completa (pide el código de 6 números de la aplicación) y confirmar «Los guardé». */
const RECOVERY_CODE_ACTIONS = "src/lib/auth/recovery-code-actions.ts";
/** Los únicos archivos de la aplicación que pueden nombrar `auth.admin`. La pasarela de H-116 se agrega aquí. */
const AUTH_ADMIN_GATEWAYS: readonly string[] = [MFA_ADMIN_GATEWAY];

/**
 * Lo que NUNCA puede llegar a `serverLog` ni a `logAuditEvent` en los avisos de activación y su enlace (H-118): el código
 * secreto del enlace, su huella, la contraseña ni el correo (ni el nombre de un destinatario o una dirección).
 */
function annulLogViolation(call: string): string | null {
  const noStrings = call.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
  const forbidden =
    /\b(token\w*|\w*sha256\w*|\w*hash\w*|fingerprint\w*|password\w*|contrasena\w*|email\w*|recipient\w*|address\w*|secret\w*|url|link)\b/i.exec(
      noStrings,
    );
  return forbidden ? `«${forbidden[0]}» no puede ir en un registro` : null;
}

/**
 * H-004b: en el cuerpo de `confirmTotpEnrollmentAction`, la contraseña (`confirmPassword(`) se comprueba ANTES de los contadores
 * y del bloqueo del código (`checkCodeBeforeVerifying(`) y del permiso de activación (`permitEnrollment(`). Devuelve el
 * motivo si no se cumple, o `null`.
 */
function passwordBeforeCounters(body: string): string | null {
  const password = body.indexOf("confirmPassword(");
  const counters = body.indexOf("checkCodeBeforeVerifying(");
  const permit = body.indexOf("permitEnrollment(");
  if (password === -1) return "no pide la contraseña";
  if (counters === -1 || permit === -1) return "faltan los contadores o el permiso";
  if (password > counters) return "la contraseña va después de los contadores del código";
  if (password > permit) return "la contraseña va después del permiso";
  if (counters > permit) return "el permiso va antes de los contadores del código";
  return null;
}

/** Carpetas del formulario público y de las solicitudes donde `serverLog` no puede recibir datos de una persona. */
const INTAKE_LOG_SCOPE =
  /^src\/(lib\/intake\/|app\/f\/|app\/api\/v1\/public\/forms\/|components\/intake\/|app\/o\/\[tenantId\]\/(formularios|solicitudes)\/)/;
const INTAKE_LOG_FORBIDDEN =
  /\b(name|email|phone|message|ip|clientIp|publicId|antibotToken|renderToken|token|contactName|contactEmail|address|rut|company|comuna|headers|forwarded)\b/i;
/** Claves permitidas en los datos de un registro: solo códigos y cuentas. */
const INTAKE_LOG_KEYS = new Set([
  "code",
  "reason",
  "status",
  "count",
  "kind",
  "capKind",
  "total",
  "recipients",
  "limit",
]);

/**
 * Cómo puede terminar una ruta que se registra (`error.code`, `registration.reason`, `lista.length`…): solo códigos y
 * cuentas. SUPUESTO CONFIABLE: las terminaciones `code`, `reason` y `status` se dan por buenas, es decir, se confía en
 * que lo que guardan esos campos es un código de error o un estado y no un dato de una persona. Esta guardia no lo
 * puede comprobar: si algún día `reason` o `status` pasan a llevar texto libre, hay que quitarlos de aquí.
 */
const INTAKE_LOG_VALUE_TAILS = new Set(["code", "reason", "status", "length", "limited"]);
/**
 * Nombres sueltos permitidos en un valor: códigos ya calculados y las constantes de límite. Un error entero
 * (`error`, `cause`, `err`) NO está: `String(error)` o `error.message` pueden traer datos de una persona. Lo único que se
 * acepta de un error es lo que `vettedLogParts` retira (`x instanceof IntakeGatewayError ? x.message`, que solo trae
 * un código, y `codeOf(x)`).
 */
const INTAKE_LOG_VALUE_NAMES = new Set([
  "code",
  "failureCode",
  "MAX_NOTICE_RECIPIENTS",
  "null",
  "undefined",
  "true",
  "false",
]);
/** Nombres sueltos permitidos en el NOMBRE del evento: el texto ya armado por la función que registra y la acción. */
const INTAKE_LOG_EVENT_NAMES = new Set(["logName", "action"]);

/**
 * Retira de un valor lo único que se acepta de un error: el mensaje de un `IntakeGatewayError` (solo trae un código)
 * y la llamada al ayudante `codeOf(x)` (su definición la vigila la guardia 10i). Todo lo demás de un error queda.
 */
function vettedLogParts(value: string): string {
  return value
    .replace(/\b([A-Za-z_]\w*)\s+instanceof\s+IntakeGatewayError\s*\?\s*\1\.message\b/g, "")
    .replace(/\bcodeOf\(\s*[A-Za-z_]\w*\s*(?:,\s*"[^"]*"\s*)?\)/g, "");
}

/** Los pares `clave: valor` de un objeto escrito en la llamada (`{ code }` vale como `code: code`). */
function logObjectEntries(object: string): { key: string; value: string }[] {
  const body = object.trim().slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^([A-Za-z_]\w*)\s*(?::([\s\S]*))?$/.exec(part);
      return match
        ? { key: match[1], value: (match[2] ?? match[1]).trim() }
        : { key: "?", value: part };
    });
}

/**
 * ¿Por qué el valor de un dato del registro no sirve? `null` si está bien. Solo se aceptan textos fijos, números y
 * rutas que terminan en un código, un motivo, un estado o una cuenta: `{ code: row.contact_email_enc }` no pasa
 * aunque la clave sea `code`.
 */
function intakeLogValueProblem(
  value: string,
  extraNames: ReadonlySet<string> = new Set(),
): string | null {
  // De un texto con `${…}` solo importan las expresiones de adentro.
  const expressions = vettedLogParts(value).replace(
    /`([^`]*)`/g,
    (_, inner: string) => ` ${[...inner.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join(" ")} `,
  );
  const code = expressions.replace(/"[^"]*"|'[^']*'/g, '""');
  for (const route of code.match(/[A-Za-z_]\w*(?:\??\.[A-Za-z_]\w*)*/g) ?? []) {
    const parts = route.split(/\??\./);
    const last = parts[parts.length - 1];
    if (parts.length === 1) {
      if (!INTAKE_LOG_VALUE_NAMES.has(last) && !extraNames.has(last)) {
        return `valor no permitido (${route})`;
      }
    } else if (INTAKE_LOG_VALUE_TAILS.has(last)) {
      continue;
    } else {
      return `valor no permitido (${route})`;
    }
  }
  return null;
}

/**
 * ¿Por qué una llamada `serverLog(...)` no sirve? `null` si está bien. Debe ser nivel + nombre + (opcional) un objeto
 * escrito ahí mismo, con claves de una lista corta, y sin nombres de datos personales en los valores.
 */
function intakeLogProblem(call: string): string | null {
  // Se ignoran los textos y lo único aceptado de un error (`vettedLogParts`: solo trae un código, nunca datos).
  const code = vettedLogParts(call).replace(/"[^"]*"/g, '""');
  if (INTAKE_LOG_FORBIDDEN.test(code)) return "nombra un dato personal";
  const shape = call.match(
    /^serverLog\(\s*"[^"]*"\s*,\s*("[^"]*"|`[^`]*`|[A-Za-z_]\w*)\s*(?:,\s*(\{[\s\S]*\}))?\s*\)$/,
  );
  if (!shape) return "los datos no son un objeto escrito en la misma llamada";
  // El NOMBRE del evento también puede colar un dato (`intake_${row.contact_email_enc}`): se revisa igual que un valor.
  const eventProblem = intakeLogValueProblem(shape[1], INTAKE_LOG_EVENT_NAMES);
  if (eventProblem) return `${eventProblem} en el nombre del evento`;
  const object = shape[2];
  if (object === undefined) return null;
  const flat = object.replace(/"[^"]*"|`[^`]*`/g, '""');
  if (/\.\.\./.test(flat)) return "esparce un objeto armado afuera";
  const keys = [...flat.matchAll(/(?:^|[{,])\s*([A-Za-z_]\w*)\s*(?::|(?=[,}]))/g)].map((m) => m[1]);
  const unknown = keys.filter((key) => !INTAKE_LOG_KEYS.has(key));
  if (unknown.length > 0) return `clave no permitida (${unknown.join(", ")})`;
  for (const { key, value } of logObjectEntries(object)) {
    const problem = intakeLogValueProblem(value);
    if (problem) return `${problem} en «${key}»`;
  }
  return null;
}

describe("guardias estáticas del aislamiento", () => {
  it("1. el nombre de la cabecera de la organización solo está en constants.ts", () => {
    const offenders = sourceFiles
      .filter((f) => rel(f) !== "src/lib/tenant/constants.ts")
      .filter((f) => /x-cp-tenant-id/i.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("2. el cliente con la llave maestra solo se importa donde se permite", () => {
    const allowedPrefixes = [
      "src/lib/audit/",
      "src/lib/security/",
      "src/lib/brand/logo-storage.ts",
      "src/lib/quotes/send/document-storage.ts",
      "src/lib/share/gateway.ts",
      "src/lib/intake/gateway.ts",
      "src/lib/team/gateway.ts",
      "src/lib/email/delivery-events-service.ts",
      "src/server/jobs/",
    ];
    const offenders = sourceFiles
      .filter((f) => /admin-client/.test(stripComments(read(f))))
      .map(rel)
      .filter((f) => f !== "src/lib/supabase/admin-client.ts")
      .filter((f) => !allowedPrefixes.some((p) => f.startsWith(p)));
    expect(offenders).toEqual([]);
  });

  it("2b. la llave maestra solo se nombra en admin-client.ts", () => {
    const offenders = sourceFiles
      .filter((f) => /SERVICE_ROLE|SUPABASE_SECRET_KEY/.test(stripComments(read(f))))
      .map(rel)
      .filter((f) => f !== "src/lib/supabase/admin-client.ts");
    expect(offenders).toEqual([]);
  });

  it("3. toda ruta de servidor (route.*) que no se declara sin organización resuelve requireActiveTenant", () => {
    const discovered = discoverAppRoutes(path.join(SRC, "app")).filter((r) => r.kind !== "page");
    expect(discovered.length).toBeGreaterThan(0);
    const withoutOrganization = new Set(
      APP_ROUTES.filter((r) => r.scope === "none").map((r) => routeKey(r)),
    );
    const byToken = new Set(APP_ROUTES.filter((r) => r.scope === "token").map((r) => routeKey(r)));
    const bySignature = new Set(
      APP_ROUTES.filter((r) => r.scope === "signed").map((r) => routeKey(r)),
    );
    const byForm = new Set(APP_ROUTES.filter((r) => r.scope === "form").map((r) => routeKey(r)));
    const byJobSecret = new Set(
      APP_ROUTES.filter((r) => r.scope === "job").map((r) => routeKey(r)),
    );
    for (const route of discovered) {
      // Una ruta que no esté en el registro la atrapa G5; aquí solo cuentan las declaradas "none".
      if (withoutOrganization.has(routeKey(route))) continue;
      // Las del enlace del cliente tienen su propia guardia (8b).
      if (byToken.has(routeKey(route))) continue;
      // Las del formulario público tienen las suyas (10 a 10e).
      if (byForm.has(routeKey(route))) continue;
      // Las de avisos firmados por un proveedor tienen su propia guardia (8e).
      if (bySignature.has(routeKey(route))) continue;
      // Las tareas programadas con secreto tienen su propia guardia (8f).
      if (byJobSecret.has(routeKey(route))) continue;
      expect(
        read(route.absoluteFile),
        `src/app/${route.file} debe llamar a requireActiveTenant( o declararse sin organización en APP_ROUTES`,
      ).toContain("requireActiveTenant(");
    }
  });

  it("4. ningún código de servidor usa getSession() para decidir quién es la persona", () => {
    const offenders = sourceFiles
      .filter((f) => /\.getSession\s*\(/.test(stripComments(read(f))))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("5. la aplicación no abre conexiones SQL directas (pg / postgres)", () => {
    const offenders = sourceFiles
      .filter((f) => /from\s+["'](pg|postgres)["']|require\(["'](pg|postgres)["']\)/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("6. nunca se pide select('*') ni se lee last_tenant_id de `profiles`: eso va por my_last_tenant_id()", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(read(file));
      for (const match of text.matchAll(
        /from\(\s*["']profiles["']\s*\)([\s\S]{0,200}?)\.select\(([^)]*)\)/g,
      )) {
        const columns = match[2].replace(/["'`\s]/g, "");
        if (columns === "" || columns === "*" || columns.includes("last_tenant_id")) {
          offenders.push(`${rel(file)}: select(${match[2]})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("8. el portero del enlace del cliente solo llama a sus seis funciones y nunca lee una tabla", () => {
    const allowedFunctions = new Set([
      "share_link_read",
      "share_link_record_view",
      "share_link_respond",
      // el aviso interno de la respuesta (H-031): destinatarios ya filtrados por la base, anotarlo y cerrarlo
      "share_notice_recipients",
      "internal_notice_register",
      "internal_notice_settle",
    ]);
    const gateway = stripComments(read(path.join(SRC, "lib", "share", "gateway.ts"))).replace(
      /\s+/g,
      " ",
    );
    const called = [...gateway.matchAll(/\.rpc\(\s*["'`]([a-z_0-9]+)["'`]/g)].map((m) => m[1]);
    expect(sorted(new Set(called))).toEqual(sorted(allowedFunctions));
    // `.rpc(` con un nombre que no es un texto fijo (variable) tampoco vale
    expect(gateway.match(/\.rpc\(/g)?.length).toBe(called.length);
    // `.from(` solo después de `.storage` (el bucket privado); nunca sobre una tabla
    // (`Buffer.from(` arma bytes, no toca la base.)
    const fromCalls = gateway.match(/(?<!Buffer)\.from\(/g)?.length ?? 0;
    const storageCalls =
      gateway.match(/\.storage\s*\.from\(\s*QUOTE_DOCUMENTS_BUCKET\s*\)/g)?.length ?? 0;
    expect(fromCalls).toBeGreaterThan(0);
    expect(fromCalls).toBe(storageCalls);
    // nada de otras formas de llegar a la base
    // (`.update(` no se vigila aquí: lo usa el sello `sha256` del PDF; sin `.from(` sobre una tabla no
    // hay forma de escribir en ella.)
    expect(/\.(insert|upsert|delete|select)\(/.test(gateway)).toBe(false);
    // ni la API de cuentas (`auth.admin...`): los correos de destino los entrega la base ya filtrados
    expect(/\.auth\b/.test(gateway)).toBe(false);
  });

  it("8b. toda ruta del enlace del cliente valida el token y aplica los límites antes de leer", () => {
    const tokenRoutes = discoverAppRoutes(path.join(SRC, "app")).filter((r) =>
      APP_ROUTES.some((a) => a.scope === "token" && routeKey(a) === routeKey(r)),
    );
    expect(tokenRoutes.length).toBeGreaterThanOrEqual(3);
    for (const route of tokenRoutes) {
      const text = stripComments(read(route.absoluteFile));
      const gate = text.indexOf("passTokenGate(");
      const firstRead = text.indexOf("readShareLink(");
      expect(gate, `src/app/${route.file} debe llamar a passTokenGate(`).toBeGreaterThan(-1);
      if (firstRead !== -1) {
        expect(gate, `${route.file}: passTokenGate va antes de leer`).toBeLessThan(firstRead);
      }
      // nunca la llave maestra ni la base directo desde la ruta
      expect(/admin-client|createClient|\.rpc\(/.test(text), route.file).toBe(false);
    }
  });

  it("8c. TODA ruta del enlace con POST comprueba el Origin antes de la puerta del token", () => {
    const postRoutes = discoverAppRoutes(path.join(SRC, "app")).filter(
      (r) =>
        APP_ROUTES.some((a) => a.scope === "token" && routeKey(a) === routeKey(r)) &&
        /export\s+(async\s+)?function\s+POST\b|export\s+const\s+POST\b/.test(
          stripComments(read(r.absoluteFile)),
        ),
    );
    // por lo menos: view, accept y reject
    expect(postRoutes.length).toBeGreaterThanOrEqual(3);
    for (const route of postRoutes) {
      const text = stripComments(read(route.absoluteFile));
      const origin = text.indexOf("isSameOriginPost(");
      const gate = text.indexOf("passTokenGate(");
      expect(origin, `${route.file} debe llamar a isSameOriginPost(`).toBeGreaterThan(-1);
      expect(gate, `${route.file} debe llamar a passTokenGate(`).toBeGreaterThan(-1);
      expect(origin, `${route.file}: el origen se comprueba antes que nada`).toBeLessThan(gate);
    }
  });

  it("8d. las rutas de respuesta del cliente solo hablan con la base por el portero", () => {
    const text = stripComments(read(path.join(SRC, "lib", "share", "respond-service.ts"))).replace(
      /\s+/g,
      " ",
    );
    expect(/admin-client|createClient|\.rpc\(|\.from\(/.test(text)).toBe(false);
    expect(text).toContain("respondShareLink(");
  });

  it("8e. los avisos del proveedor de correo: la firma se verifica antes de tocar la base, y el servicio solo llama a record_email_event", () => {
    const signedRoutes = discoverAppRoutes(path.join(SRC, "app")).filter((r) =>
      APP_ROUTES.some((a) => a.scope === "signed" && routeKey(a) === routeKey(r)),
    );
    expect(signedRoutes.length).toBeGreaterThanOrEqual(1);
    for (const route of signedRoutes) {
      const text = stripComments(read(route.absoluteFile));
      const verify = text.indexOf("verifyAndParseWebhook(");
      const record = text.indexOf("recordDeliveryEvent(");
      expect(verify, `${route.file} debe verificar la firma`).toBeGreaterThan(-1);
      expect(record, `${route.file} debe anotar el aviso`).toBeGreaterThan(verify);
      // la ruta no toca la base ni la llave maestra directo: solo por el servicio
      expect(/admin-client|createClient|\.rpc\(|\.from\(/.test(text), route.file).toBe(false);
    }
    const service = stripComments(
      read(path.join(SRC, "lib", "email", "delivery-events-service.ts")),
    ).replace(/\s+/g, " ");
    // una sola función de la base, nombrada con una constante; nunca una tabla
    expect([...service.matchAll(/\.rpc\(\s*([A-Za-z_]+)\s*,/g)].map((m) => m[1])).toEqual([
      "RECORD_FUNCTION",
    ]);
    expect(service).toContain('RECORD_FUNCTION = "record_email_event"');
    expect(/\.(from|insert|update|upsert|delete|select)\(/.test(service)).toBe(false);
  });

  it("8f. las tareas programadas (/api/v1/jobs): cada route.ts exporta SOLO `GET = cronJobRoute(...)` y las constantes de configuración, y el secreto vive en un solo archivo", () => {
    const jobRoutes = discoverAppRoutes(path.join(SRC, "app")).filter(
      (r) => r.path === "/api/v1/jobs" || r.path.startsWith("/api/v1/jobs/"),
    );
    // la guardia mira de verdad la carpeta, y todo lo que hay ahí está declarado como `job`
    expect(jobRoutes.length).toBeGreaterThanOrEqual(1);
    const declared = new Set(APP_ROUTES.filter((r) => r.scope === "job").map((r) => routeKey(r)));
    for (const route of jobRoutes) {
      expect(declared.has(routeKey(route)), `${route.file} debe declararse con alcance "job"`).toBe(
        true,
      );
      expect(jobRouteProblems(read(route.absoluteFile)), route.file).toEqual([]);
    }
    // lo declarado como `job` existe de verdad en el código (el registro no se queda con rutas fantasma)
    expect(sorted(declared)).toEqual(sorted(jobRoutes.map((r) => routeKey(r))));

    // `CRON_SECRET` (y su nombre en una constante) solo se nombra en `cron-auth.ts`, en cualquier forma de leerlo
    // (`process.env.CRON_SECRET`, `process.env["CRON_SECRET"]`, el desestructurado…), y `verifyCronRequest` solo
    // se llama desde ahí: las rutas no verifican el secreto por su cuenta, lo hace `cronJobRoute`.
    const secretReaders = sourceFiles
      .filter((f) => /CRON_SECRET/.test(stripComments(read(f))))
      .map(rel);
    expect(secretReaders).toEqual(["src/lib/jobs/cron-auth.ts"]);
    const verifiers = sourceFiles
      .filter((f) => /verifyCronRequest\s*\(/.test(stripComments(read(f))))
      .map(rel);
    expect(verifiers).toEqual(["src/lib/jobs/cron-auth.ts"]);
  });

  it("8f. y la guardia muerde: cada forma de saltarse el secreto, o de exportar algo de más, se detecta", () => {
    const good = [
      'import { cronJobRoute } from "@/lib/jobs/cron-auth";',
      'import { runJob } from "@/server/jobs/job";',
      'export const runtime = "nodejs";',
      'export const dynamic = "force-dynamic";',
      "export const maxDuration = 60;",
      'export const GET = cronJobRoute("job-name", runJob);',
    ].join("\n");
    expect(jobRouteProblems(good)).toEqual([]);
    // comentarios que nombran lo prohibido no cuentan
    expect(
      jobRouteProblems(`// export async function POST() {}\n/* CRON_SECRET */\n${good}`),
    ).toEqual([]);

    const replaceGet = (code: string) => good.replace(/export const GET[^\n]*/, code);
    const cases: Record<string, string> = {
      "sin GET": replaceGet(""),
      "a. el resultado de verifyCronRequest se ignora": replaceGet(
        'export const GET = async (request: Request) => { verifyCronRequest(request.headers.get("authorization")); return Response.json(await runJob()); };',
      ),
      "b. solo corta en «disabled»": replaceGet(
        'export async function GET(request: Request) { const auth = verifyCronRequest(request.headers.get("authorization")); if (auth === "disabled") return new Response(null, { status: 404 }); return Response.json(await runJob()); }',
      ),
      "c. un HEAD escrito a mano": `${good}\nexport async function HEAD() { return Response.json(await runJob()); }`,
      "d. un POST con la tarea": `${good}\nexport const POST = async () => Response.json(await runJob());`,
      "e. un export con alias": `${good}\nconst x = async () => Response.json(await runJob());\nexport { x as POST };`,
      "f. un secreto propio como segundo argumento": replaceGet(
        'export const GET = async (request: Request) => { if (verifyCronRequest(request.headers.get("authorization"), "mio") !== "ok") return new Response(null, { status: 401 }); return Response.json(await runJob()); };',
      ),
      "OPTIONS escrito a mano": `${good}\nexport function OPTIONS() { return runJob(); }`,
      "export default": `${good}\nexport default function handler() { return runJob(); }`,
      "una constante exportada de más": `${good}\nexport const SECRET_HEADER = "x-secret";`,
      "export let": `${good}\nexport let counter = 0;`,
      "GET repetido": `${good}\nexport const GET = cronJobRoute("otro", runJob);`,
      "sin usar cronJobRoute": good.replace("cronJobRoute(", "runJobWith("),
      "lee el secreto por su cuenta": `${good}\nconst s = process.env["CRON_SECRET"];`,
      "toca la base": `${good}\nimport { createAdminClient } from "@/lib/supabase/admin-client";`,
    };
    for (const [name, text] of Object.entries(cases)) {
      expect(jobRouteProblems(text).length, `la guardia debe detectar: ${name}`).toBeGreaterThan(0);
    }
  });

  it("9. el token no se escribe en los registros del servidor", () => {
    const offenders = sourceFiles
      .filter((f) => f.includes(`${path.sep}share${path.sep}`) || f.includes("quote-links"))
      .filter((f) => {
        const text = stripComments(read(f)).replace(/\s+/g, " ");
        return [...text.matchAll(/serverLog\([^)]*\)/g)].some((m) => /\btoken\b/i.test(m[0]));
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("10. el portero del formulario público solo llama a sus seis funciones y nunca lee una tabla ni la API de cuentas", () => {
    const allowedFunctions = new Set([
      "intake_form_read",
      "intake_request_submit",
      "intake_record_block",
      // los avisos al equipo: destinatarios ya filtrados por la base, anotarlo y cerrarlo
      "intake_notice_recipients",
      "intake_notice_register",
      "intake_notice_settle",
    ]);
    const gateway = stripComments(read(path.join(SRC, "lib", "intake", "gateway.ts"))).replace(
      /\s+/g,
      " ",
    );
    const called = [...gateway.matchAll(/\.rpc\(\s*["'`]([a-z_0-9]+)["'`]/g)].map((m) => m[1]);
    expect(sorted(new Set(called))).toEqual(sorted(allowedFunctions));
    // `.rpc(` con un nombre que no es un texto fijo (variable) tampoco vale
    expect(gateway.match(/\.rpc\(/g)?.length).toBe(called.length);
    // `.from(` solo después de `.storage` (el bucket privado de logos); nunca sobre una tabla
    const fromCalls = gateway.match(/(?<!Buffer)\.from\(/g)?.length ?? 0;
    const storageCalls = gateway.match(/\.storage\s*\.from\(\s*LOGO_BUCKET\s*\)/g)?.length ?? 0;
    expect(fromCalls).toBeGreaterThan(0);
    expect(fromCalls).toBe(storageCalls);
    expect(/\.(insert|upsert|delete|select|update)\(/.test(gateway)).toBe(false);
    // ni la API de cuentas (`auth.admin...`): los correos de destino los entrega la base ya filtrados
    expect(/\.auth\b/.test(gateway)).toBe(false);
    // nadie más en lo público habla con la base ni con Storage: ni la llave maestra (guardia 2), ni
    // `.rpc(`, ni `.storage`.
    const others = sourceFiles
      .filter((f) => rel(f).startsWith("src/lib/intake/") || rel(f).startsWith("src/app/f/"))
      .filter((f) => rel(f) !== "src/lib/intake/gateway.ts")
      .filter((f) => !/\/(builder|requests|convert)-(actions|queries)\.ts$/.test(rel(f)))
      .filter((f) => /\.rpc\(|createAdminClient|\.storage\b/.test(stripComments(read(f))))
      .map(rel);
    expect(others).toEqual([]);
  });

  it("10g. (H-089) lo que escribió el visitante se muestra como texto plano: ni HTML inyectado ni formato básico en las pantallas de solicitudes", () => {
    const files = sourceFiles.filter(
      (f) =>
        rel(f).startsWith("src/app/o/[tenantId]/solicitudes/") ||
        /^src\/lib\/intake\/(requests|convert)-/.test(rel(f)) ||
        /^src\/components\/intake\/(request-|convert-|source-)/.test(rel(f)),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const code = stripComments(read(file));
      expect(/dangerouslySetInnerHTML/.test(code), rel(file)).toBe(false);
      expect(/basic-format|innerHTML/.test(code), rel(file)).toBe(false);
    }
  });

  it("10b. TODA ruta del formulario público con POST comprueba el Origin antes que cualquier otra cosa", () => {
    const formPostRoutes = discoverAppRoutes(path.join(SRC, "app")).filter(
      (r) =>
        APP_ROUTES.some((a) => a.scope === "form" && routeKey(a) === routeKey(r)) &&
        /export\s+(async\s+)?function\s+POST\b|export\s+const\s+POST\b/.test(
          stripComments(read(r.absoluteFile)),
        ),
    );
    expect(formPostRoutes.length).toBeGreaterThanOrEqual(1);
    for (const route of formPostRoutes) {
      const text = stripComments(read(route.absoluteFile));
      const origin = text.indexOf("isSameOriginPost(");
      expect(origin, `${route.file} debe llamar a isSameOriginPost(`).toBeGreaterThan(-1);
      // antes de leer los parámetros, el cuerpo o llamar a cualquier servicio
      for (const later of ["await ", "handleIntakeSubmit(", "request.json(", ".params"]) {
        const index = text.indexOf(later);
        if (index !== -1) {
          expect(origin, `${route.file}: el origen se comprueba antes de «${later}»`).toBeLessThan(
            index,
          );
        }
      }
      // nunca la llave maestra ni la base directo desde la ruta
      expect(/admin-client|createClient|\.rpc\(/.test(text), route.file).toBe(false);
    }
  });

  it("10c. el formulario público no importa nada de dinero, cálculo ni catálogo", () => {
    const publicFiles = sourceFiles.filter(
      (f) => rel(f).startsWith("src/app/f/") || rel(f).startsWith("src/components/intake/"),
    );
    expect(publicFiles.length).toBeGreaterThan(5);
    const offenders = publicFiles
      .filter((f) =>
        /from\s+["'][^"']*(@\/lib\/money|quotes\/calc|@\/lib\/catalog|\/catalog\/)[^"']*["']/.test(
          stripComments(read(f)),
        ),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("10d. nada de lo que escribe un visitante se pinta como HTML (sin dangerouslySetInnerHTML)", () => {
    const offenders = sourceFiles
      .filter(
        (f) =>
          rel(f).startsWith("src/app/f/") ||
          rel(f).startsWith("src/components/intake/") ||
          rel(f).startsWith("src/lib/intake/") ||
          rel(f).startsWith("src/app/o/[tenantId]/solicitudes/") ||
          rel(f).startsWith("src/app/o/[tenantId]/formularios/"),
      )
      .filter((f) => /dangerouslySetInnerHTML/.test(stripComments(read(f))))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("10e. serverLog en todo lo del formulario público y las solicitudes nunca recibe nombre, correo, teléfono, mensaje, IP ni el identificador del formulario", () => {
    const scoped = sourceFiles.filter((f) => INTAKE_LOG_SCOPE.test(rel(f)));
    // la guardia mira de verdad las carpetas de la superficie pública, no solo `src/lib/intake`
    expect(scoped.some((f) => rel(f).startsWith("src/lib/intake/"))).toBe(true);
    expect(scoped.some((f) => rel(f).startsWith("src/app/f/"))).toBe(true);
    expect(scoped.some((f) => rel(f).startsWith("src/app/api/v1/public/forms/"))).toBe(true);
    expect(scoped.some((f) => rel(f).startsWith("src/components/intake/"))).toBe(true);
    const offenders: string[] = [];
    let calls = 0;
    for (const file of scoped) {
      for (const call of serverLogCalls(stripComments(read(file)))) {
        calls += 1;
        const problem = intakeLogProblem(call);
        if (problem) offenders.push(`${rel(file)}: ${problem}: ${call}`);
      }
    }
    expect(calls).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });

  it("10h. (H-093) solo /f/:publicId/incrustar queda fuera de la regla que prohíbe enmarcar, y su política sale del proxy", () => {
    const config = stripComments(read(path.join(ROOT, "next.config.ts")));
    // Una sola regla con `X-Frame-Options: DENY`, y su `source` es la exclusión de esa única ruta.
    expect(config.match(/value:\s*"DENY"/g)?.length).toBe(1);
    expect(config).toMatch(/source:\s*EMBED_ROUTE_EXCLUSION,\s*headers:\s*securityHeaders/);
    expect(config).not.toMatch(/source:\s*["']\/:path\*["'],\s*headers:\s*securityHeaders/);
    // Nada más en la aplicación nombra `X-Frame-Options` ni `frame-ancestors` con una lista de sitios.
    const framing = sourceFiles
      .filter((f) => /x-frame-options/i.test(stripComments(read(f))))
      .map(rel);
    // Salvo `embed-headers.ts`, que solo lo pone en DENY para las variantes con otras mayúsculas de la ruta.
    expect(framing).toEqual(["src/lib/intake/embed-headers.ts"]);
    const embedHeaders = stripComments(read(path.join(SRC, "lib", "intake", "embed-headers.ts")));
    expect(embedHeaders.match(/x-frame-options/gi)).toHaveLength(1);
    expect(embedHeaders).toMatch(/"X-Frame-Options":\s*"DENY"/);
    // El proxy solo arma su política para esa ruta, con los sitios que valida el portero.
    const proxy = stripComments(read(path.join(SRC, "proxy.ts")));
    expect(proxy).toContain("parseEmbedPath(");
    expect(proxy).toContain("readFrameAncestors(");
    // Variantes con otras mayúsculas (Next no las distingue): DENY desde el proxy; y un límite por IP propio
    // ANTES de leer la base.
    expect(proxy).toContain("isEmbedPathLookalike(");
    expect(proxy).toContain("buildEmbedLookalikeHeaders(");
    expect(proxy.indexOf("allowEmbedRead(")).toBeGreaterThan(-1);
    expect(proxy.indexOf("allowEmbedRead(")).toBeLessThan(proxy.indexOf("readFrameAncestors("));
    expect(proxy).toContain('"/f/:publicId/incrustar"');
    expect(proxy).not.toMatch(/x-frame-options/i);
    // La ruta incrustable usa la MISMA pantalla que la normal (no se duplica la lógica pública).
    for (const page of [
      "src/app/f/[publicId]/page.tsx",
      "src/app/f/[publicId]/incrustar/page.tsx",
    ]) {
      expect(stripComments(read(path.join(ROOT, page))), page).toContain("<PublicIntakeScreen");
    }
    // La página incrustada solo informa su altura y no escucha mensajes de afuera.
    const resizer = stripComments(
      read(path.join(SRC, "components", "intake", "embed-resizer.tsx")),
    );
    expect(resizer).not.toMatch(/addEventListener\(\s*["']message["']/);
    // dos mensajes y nada más: la altura y el aviso «sube hasta el formulario» (sin datos)
    expect(resizer.match(/postMessage\(/g)?.length).toBe(2);
    expect(resizer).toContain("buildResizeMessage(");
    expect(resizer).toContain("buildScrollMessage(");
  });

  it("10f. la guardia 10e detecta de verdad una violación (nombre, correo, IP, identificador, variables sueltas)", () => {
    const sample = 'serverLog("warn", "x", { email: data.email, ip: clientIp })';
    expect(serverLogCalls(sample)).toHaveLength(1);
    expect(intakeLogProblem(serverLogCalls(sample)[0])).not.toBeNull();
    const violations = [
      'serverLog("warn", "x", { publicId })',
      'serverLog("warn", "x", { code: input.publicId })',
      'serverLog("warn", "x", { name: parsed.name })',
      'serverLog("warn", "x", { phone: row.phone })',
      'serverLog("warn", "x", { clientIp })',
      'serverLog("warn", "x", { code: request.headers.get("x-forwarded-for") })',
      // un objeto armado afuera puede esconder cualquier cosa: no se acepta
      'serverLog("warn", "x", context)',
      'serverLog("warn", "x", { ...context })',
      'serverLog("warn", "x", { detail: row })',
      // la clave es de las permitidas, pero el valor es un dato guardado: no se acepta (m8 de H-092)
      'serverLog("warn", "x", { code: row.contact_email_enc })',
      'serverLog("warn", "x", { code: row })',
      'serverLog("warn", "x", { code: `x_${row.contact_email_enc}` })',
      'serverLog("warn", "x", { count: items })',
      'serverLog("warn", "x", { reason: input.value, code: "ok" })',
      // el NOMBRE del evento también cuenta: no puede llevar un dato guardado ni uno del visitante
      'serverLog("warn", `intake_${row.contact_email_enc}`)',
      'serverLog("warn", `intake_${input.contactPhone}_failed`)',
      'serverLog("warn", contactEmailEnc)',
      'serverLog("warn", `intake_${row}`, { code: "x" })',
      // un error entero o su mensaje, sea cual sea su origen, no es un código
      'serverLog("warn", "x", { code: String(error) })',
      'serverLog("warn", "x", { code: String(cause) })',
      'serverLog("warn", "x", { code: error.message })',
      'serverLog("warn", "x", { code: cause.message })',
      'serverLog("warn", "x", { code: err })',
      // `.message` solo vale dentro de `x instanceof IntakeGatewayError ? x.message`: la otra rama no
      'serverLog("warn", "x", { code: cause instanceof IntakeGatewayError ? cause.message : error.message })',
      'serverLog("warn", "x", { code: other instanceof IntakeGatewayError ? cause.message : "x" })',
    ];
    for (const violation of violations) {
      const [call] = serverLogCalls(violation);
      expect(intakeLogProblem(call), violation).not.toBeNull();
    }
    const fine = [
      'serverLog("error", "intake_form_save_bad_response")',
      'serverLog("warn", `intake_request_${action}_failed`, { code: error.code ?? "unknown" })',
      'serverLog("error", logName, { code: error.code ?? "unknown" })',
      'serverLog("warn", "x", { code: codeOf(cause) })',
      'serverLog("warn", "x", { code: readError.code })',
      'serverLog("warn", "x", { status: saved.status })',
      'serverLog("warn", "x", { reason: `antibot_${verdict.reason}` })',
      'serverLog("warn", "x", { reason: "honeypot" })',
      'serverLog("warn", "x", { count: recipients.length })',
      'serverLog("warn", "x", { code })',
      'serverLog("warn", "x", { code: failureCode, status: saved.status })',
      'serverLog("warn", "x", { reason: `render_${stamp.reason}` })',
      'serverLog("warn", "x", { code: error?.code ?? "unknown" })',
      'serverLog("warn", "x", { code: info.limited ? "daily_limit" : "no_recipients" })',
      'serverLog("warn", "x", { code: cause instanceof IntakeGatewayError ? cause.message : "unexpected" })',
      'serverLog("warn", "x", { code: "recipients_over_limit", recipients: info.recipients.length, limit: MAX_NOTICE_RECIPIENTS })',
    ];
    for (const ok of fine) expect(intakeLogProblem(serverLogCalls(ok)[0]), ok).toBeNull();
    const balanced = 'serverLog("warn", "x", { code: String(cause) }); const other = (1)';
    expect(serverLogCalls(balanced)[0]).toBe('serverLog("warn", "x", { code: String(cause) })');
  });

  it("10i. (H-092) en lo público solo server-log.ts escribe en la consola, y `codeOf` solo devuelve un código", () => {
    const scoped = sourceFiles.filter((f) => INTAKE_LOG_SCOPE.test(rel(f)));
    // Nada de `console` (ni alias) en la superficie pública: todo registro pasa por `serverLog`, que es lo que vigila la 10e.
    const consoleUsers = scoped.filter((f) => /\bconsole\b/.test(stripComments(read(f)))).map(rel);
    expect(consoleUsers).toEqual([]);
    // La guardia no es vacía: `server-log.ts` (fuera de esas carpetas) es quien sí escribe.
    expect(stripComments(read(path.join(SRC, "lib", "log", "server-log.ts")))).toMatch(
      /\bconsole\./,
    );
    // `codeOf(x)` se acepta en un registro porque su definición solo devuelve el mensaje de un `IntakeGatewayError`
    // (un código) o textos fijos; ninguna otra rama puede traer `.message` ni `String(`.
    const definitions = scoped.flatMap((file) =>
      [...stripComments(read(file)).matchAll(/const codeOf = ([\s\S]*?);\n/g)].map((m) => ({
        file: rel(file),
        body: m[1],
      })),
    );
    expect(definitions.length).toBeGreaterThan(0);
    for (const { file, body } of definitions) {
      expect(body, file).toMatch(/(\w+) instanceof IntakeGatewayError\s*\?\s*\1\.message/);
      const rest = body.replace(/(\w+) instanceof IntakeGatewayError\s*\?\s*\1\.message/, "");
      expect(rest, file).not.toMatch(/\.message|String\(|JSON|toString/);
    }
    // y la regla de 10e no acepta `codeOf` como nombre suelto
    expect(intakeLogProblem('serverLog("warn", "x", { code: codeOf })')).not.toBeNull();
  });

  it("11. (H-008) el portero de invitaciones solo llama a sus cuatro funciones y nunca lee ni escribe una tabla", () => {
    const gateway = stripComments(read(path.join(SRC, "lib", "team", "gateway.ts"))).replace(
      /\s+/g,
      " ",
    );
    const called = [...gateway.matchAll(/\.rpc\(\s*["'`]([a-z_0-9]+)["'`]/g)].map((m) => m[1]);
    expect(sorted(new Set(called))).toEqual([
      "invitation_email_settle",
      "invitation_notice_recipients",
      "invitation_notice_register",
      "invitation_notices_pending",
    ]);
    expect(gateway.match(/\.rpc\(/g)?.length).toBe(called.length);
    expect(/\.(insert|upsert|delete|select|update)\(/.test(gateway)).toBe(false);
    expect(/(?<!Buffer)\.from\(/.test(gateway)).toBe(false);
    expect(/\.auth\b|\.storage\b/.test(gateway)).toBe(false);
    // invitar, reenviar y cancelar corren con el pase de la persona: en el resto de `src/lib/team/` no hay llave maestra
    const others = sourceFiles
      .filter(
        (f) => rel(f).startsWith("src/lib/team/") || rel(f).startsWith("src/components/team/"),
      )
      .filter((f) => rel(f) !== "src/lib/team/gateway.ts")
      .filter((f) => /admin-client|createAdminClient/.test(stripComments(read(f))))
      .map(rel);
    expect(others).toEqual([]);
  });

  it("11b. (H-008) serverLog en lo de invitaciones nunca recibe el correo, el nombre ni el código del enlace", () => {
    const scoped = sourceFiles.filter(
      (f) =>
        rel(f).startsWith("src/lib/team/") ||
        rel(f).startsWith("src/components/team/") ||
        rel(f).startsWith("src/app/o/[tenantId]/equipo/") ||
        // la ruta que recibe el código en claro y la pantalla que lo usa (H-009)
        rel(f).startsWith("src/app/invitacion/") ||
        rel(f) === "src/lib/email/invitation.ts" ||
        rel(f) === "src/lib/email/invitation-owner-notice.ts" ||
        rel(f) === "src/lib/email/invitation-names.ts" ||
        rel(f).startsWith("src/server/jobs/"),
    );
    expect(scoped.length).toBeGreaterThan(8);
    const offenders: string[] = [];
    let calls = 0;
    for (const file of scoped) {
      const code = stripComments(read(file));
      for (const call of serverLogCalls(code)) {
        calls += 1;
        const problem = intakeLogProblem(call);
        if (problem) offenders.push(`${rel(file)}: ${problem}: ${call}`);
      }
      // el código y el correo tampoco van a la consola ni a la auditoría por otro camino
      expect(/console\./.test(code), `${rel(file)} escribe en la consola`).toBe(false);
      expect(
        /logAuditEvent\(/.test(code),
        `${rel(file)} escribe en la auditoría de la aplicación`,
      ).toBe(false);
    }
    expect(calls).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });

  it("12. (H-048a) los textos guardados solo se escriben por sus tres funciones, con el pase de la persona, y nada de lo que se escribe llega a un log ni se pinta como HTML", () => {
    const scoped = sourceFiles.filter(
      (f) =>
        rel(f).startsWith("src/lib/snippets/") ||
        rel(f).startsWith("src/components/snippets/") ||
        rel(f).startsWith("src/app/o/[tenantId]/configuracion/textos/"),
    );
    expect(scoped.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    const rpcNames = new Set<string>();
    let calls = 0;
    for (const file of scoped) {
      const code = stripComments(read(file));
      if (/admin-client|createAdminClient|SERVICE_ROLE/.test(code)) {
        offenders.push(`${rel(file)}: usa la llave maestra`);
      }
      if (/dangerouslySetInnerHTML/.test(code)) offenders.push(`${rel(file)}: pinta HTML`);
      if (/console\./.test(code)) offenders.push(`${rel(file)}: escribe en la consola`);
      if (/logAuditEvent\(/.test(code)) offenders.push(`${rel(file)}: escribe en la auditoría`);
      // la tabla solo se lee: escribir va siempre por las funciones de la base
      if (/\.(insert|upsert|delete|update)\(/.test(code)) {
        offenders.push(`${rel(file)}: escribe directo en una tabla`);
      }
      for (const match of code.matchAll(/\.rpc\(\s*["'`]([a-z_0-9]+)["'`]/g))
        rpcNames.add(match[1]);
      if (
        (code.match(/\.rpc\(/g)?.length ?? 0) !==
        [...code.matchAll(/\.rpc\(\s*["'`][a-z_0-9]+["'`]/g)].length
      ) {
        offenders.push(`${rel(file)}: llama a una función con un nombre que no es un texto fijo`);
      }
      for (const call of serverLogCalls(code)) {
        calls += 1;
        const problem = intakeLogProblem(call);
        if (problem) offenders.push(`${rel(file)}: ${problem}: ${call}`);
      }
    }
    expect(calls).toBeGreaterThan(3);
    expect(sorted(rpcNames)).toEqual([
      "create_text_snippet",
      "delete_text_snippet",
      "update_text_snippet",
    ]);
    expect(offenders).toEqual([]);
  });

  it("13. (H-040) la regla de aprobación solo se escribe por `set_approval_rule`, con el pase de la persona; nada de lo que se escribe llega a un log ni se pinta como HTML, y el permiso sale de la matriz", () => {
    const scoped = sourceFiles.filter(
      (f) =>
        rel(f).startsWith("src/lib/approvals/") ||
        rel(f).startsWith("src/app/o/[tenantId]/configuracion/aprobaciones/"),
    );
    expect(scoped.length).toBeGreaterThan(8);
    const offenders: string[] = [];
    const rpcNames = new Set<string>();
    let calls = 0;
    for (const file of scoped) {
      const code = stripComments(read(file));
      if (/admin-client|createAdminClient|SERVICE_ROLE/.test(code)) {
        offenders.push(`${rel(file)}: usa la llave maestra`);
      }
      if (/dangerouslySetInnerHTML/.test(code)) offenders.push(`${rel(file)}: pinta HTML`);
      if (/console\./.test(code)) offenders.push(`${rel(file)}: escribe en la consola`);
      if (/logAuditEvent\(/.test(code)) offenders.push(`${rel(file)}: escribe en la auditoría`);
      // la tabla solo se lee: escribir va siempre por la función de la base
      if (/\.(insert|upsert|delete|update)\(/.test(code)) {
        offenders.push(`${rel(file)}: escribe directo en una tabla`);
      }
      // el permiso sale de la matriz, no de un nombre de rol escrito a mano
      if (
        /["'`](owner|admin|approver|sales|viewer)["'`]/.test(code) &&
        !/\.test\./.test(rel(file))
      ) {
        offenders.push(`${rel(file)}: nombra un rol a mano`);
      }
      for (const match of code.matchAll(/\.rpc\(\s*["'`]([a-z_0-9]+)["'`]/g))
        rpcNames.add(match[1]);
      if (
        (code.match(/\.rpc\(/g)?.length ?? 0) !==
        [...code.matchAll(/\.rpc\(\s*["'`][a-z_0-9]+["'`]/g)].length
      ) {
        offenders.push(`${rel(file)}: llama a una función con un nombre que no es un texto fijo`);
      }
      for (const call of serverLogCalls(code)) {
        calls += 1;
        const problem = intakeLogProblem(call);
        if (problem) offenders.push(`${rel(file)}: ${problem}: ${call}`);
      }
    }
    expect(calls).toBeGreaterThan(3);
    expect(sorted(rpcNames)).toEqual(["set_approval_rule"]);
    expect(offenders).toEqual([]);
  });

  it("14. (H-004a) la sesión y su nivel de seguridad solo se miran en session.ts; el alta, la verificación y el borrado de factores, solo en second-step-actions.ts", () => {
    const only = (pattern: RegExp, allowed: string | readonly string[]) =>
      sourceFiles
        .filter((f) => pattern.test(stripComments(read(f))))
        .map(rel)
        .filter((f) => !(Array.isArray(allowed) ? allowed : [allowed]).includes(f));
    // Quién es la persona y a qué nivel llegó: un solo archivo (recordatorio permanente del proyecto).
    expect(
      only(
        /\.(getUser|getClaims|getSession|getAuthenticatorAssuranceLevel)\s*\(/,
        "src/lib/auth/session.ts",
      ),
    ).toEqual([]);
    // Los factores: solo las acciones de la verificación en dos pasos.
    expect(
      only(
        /\.mfa\s*\.\s*(enroll|challenge|verify|challengeAndVerify|unenroll|listFactors)\s*\(/,
        // También la pasarela de administración, que lista y borra factores con la llave maestra (`auth.admin.mfa`), y
        // (H-004b) las acciones de desactivar y de crear códigos con la sesión completa: `mfa.unenroll` y `challengeAndVerify`.
        [
          "src/lib/auth/second-step-actions.ts",
          MFA_ADMIN_GATEWAY,
          SECOND_STEP_MANAGE_ACTIONS,
          RECOVERY_CODE_ACTIONS,
        ],
      ),
    ).toEqual([]);
    // H-004b: las siete funciones de los códigos de respaldo, solo desde su pasarela; la tabla, desde ninguna parte.
    expect(only(MFA_RECOVERY_FUNCTION_PATTERN, MFA_RECOVERY_GATEWAY)).toEqual([]);
    expect(only(MFA_RECOVERY_TABLE_PATTERN, [])).toEqual([]);
    // La API de administración de cuentas (`auth.admin.*`, con la llave maestra): solo en las pasarelas. Hoy hay una (H-118);
    // la de H-116 se suma a esta lista cuando exista. `auth.admin.mfa` solo vive en la de los factores.
    expect(only(AUTH_ADMIN_PATTERN, AUTH_ADMIN_GATEWAYS)).toEqual([]);
    expect(only(AUTH_ADMIN_MFA_PATTERN, MFA_ADMIN_GATEWAY)).toEqual([]);
    // H-004b: comprobar una contraseña (abrir una sesión con ella) solo se hace en el ingreso y en «pedir la contraseña de nuevo».
    expect(only(SIGN_IN_WITH_PASSWORD_PATTERN, SIGN_IN_WITH_PASSWORD_FILES)).toEqual([]);
    // Y esas acciones no usan la llave maestra ni nombran los métodos de sesión.
    const actions = stripComments(read(path.join(SRC, "lib/auth/second-step-actions.ts")));
    expect(/admin-client|createAdminClient/.test(actions)).toBe(false);
    expect(/\.(getUser|getClaims|getSession)\s*\(/.test(actions)).toBe(false);
  });

  it("14b. (H-004a, H-004b) serverLog y logAuditEvent en la verificación en dos pasos nunca reciben el código de 6 números, la clave, el uri, el QR, el correo ni la contraseña", () => {
    const files = [
      "src/lib/auth/second-step-actions.ts",
      "src/lib/auth/session.ts",
      "src/lib/security/login-rate-limit.ts",
      // H-004b: pedir la contraseña de nuevo (la contraseña ni el correo van a un registro).
      "src/lib/auth/reauth.ts",
      // H-004b: los códigos de respaldo (ni el código, ni su forma normalizada, ni su huella, ni el juego).
      "src/lib/auth/recovery-code.ts",
      MFA_RECOVERY_GATEWAY,
      // Las acciones de los pasos 4 a 6 de H-004b: la guardia las cubre apenas existen (hoy no existen todas).
      RECOVERY_CODE_ACTIONS,
      SECOND_STEP_MANAGE_ACTIONS,
      // H-004b paso 4: lo que comparten las acciones (contadores y bloqueo del código), el que crea el juego y el que envía el aviso.
      "src/lib/auth/second-step-checks.ts",
      "src/lib/auth/recovery-code-issue.ts",
      "src/lib/security/mfa-account-notice-send.ts",
    ].filter((file) => existsSync(path.join(ROOT, file)));
    // Lo que ya existe tiene que estar en la lista: ningún archivo de los códigos de respaldo queda sin vigilar.
    for (const required of [
      "src/lib/auth/reauth.ts",
      "src/lib/auth/recovery-code.ts",
      MFA_RECOVERY_GATEWAY,
      RECOVERY_CODE_ACTIONS,
      "src/lib/auth/second-step-checks.ts",
      "src/lib/auth/recovery-code-issue.ts",
    ]) {
      expect(files, required).toContain(required);
    }
    let found = 0;
    for (const file of files) {
      const text = stripComments(read(path.join(ROOT, file)));
      for (const name of ["serverLog", "logAuditEvent"]) {
        for (const call of namedCalls(text, name)) {
          found += 1;
          expect(secondStepLogViolation(call), `${file}: ${call}`).toBeNull();
        }
      }
    }
    // La guardia no puede pasar en vacío: las acciones llaman a las dos funciones muchas veces.
    expect(found).toBeGreaterThanOrEqual(8);
    // Las acciones y lo que comparten (los contadores y la auditoría de los fallos viven en `second-step-checks.ts`).
    const actions = stripComments(
      read(path.join(ROOT, "src/lib/auth/second-step-actions.ts")) +
        read(path.join(ROOT, "src/lib/auth/second-step-checks.ts")),
    );
    expect(namedCalls(actions, "serverLog").length).toBeGreaterThan(2);
    expect(namedCalls(actions, "logAuditEvent").length).toBeGreaterThan(4);
  });

  it("14d. la guardia 14b detecta de verdad el código (checked.code, parsed.data.code, `code` suelto o abreviado), la clave y el correo; deja pasar el código de un error", () => {
    const bad = [
      "logAuditEvent({ action: 'session.mfa_failed', details: { code: checked.code } })",
      "logAuditEvent({ details: { reason: parsed.data.code } })",
      "serverLog('warn', 'mfa', { stage, code })",
      "serverLog('warn', 'mfa', { stage, c: otp })",
      "serverLog('warn', 'mfa', { secret: enrollment.secret })",
      "logAuditEvent({ details: { email: user.email } })",
      "serverLog('error', 'x', { code: userCode })",
      // H-004b: la contraseña, con cualquier nombre que la delate
      "serverLog('warn', 'reauth', { password })",
      "logAuditEvent({ details: { reason: 'wrong_password', value: passwordFormat.data.password } })",
      "logAuditEvent({ details: { contrasena } })",
      "serverLog('warn', 'reauth', { code: 'x', pw: parsed.password })",
      // H-004b: los códigos de respaldo, su forma normalizada y su huella
      "serverLog('warn', 'recovery', { codes })",
      "logAuditEvent({ details: { reason: 'x', codes: result.codes } })",
      "serverLog('warn', 'recovery', { recoveryCode })",
      "logAuditEvent({ details: { value: recoveryCodeInput } })",
      "serverLog('warn', 'recovery', { normalized })",
      "logAuditEvent({ details: { value: normalizedCode } })",
      "serverLog('warn', 'recovery', { hash: recoveryCodeHash(user.id, normalized) })",
      "logAuditEvent({ details: { codeHash } })",
      "serverLog('warn', 'recovery', { fingerprint })",
    ];
    for (const call of bad) expect(secondStepLogViolation(call), call).not.toBeNull();
    const good = [
      "serverLog('warn', 'mfa_verify_failed', { stage, code: errorCodeOf(error) })",
      "serverLog('error', 'x', { code: error.code ?? String(error.status) })",
      "logAuditEvent({ action: 'session.mfa_verified', result: 'success', actorUserId: user.id, details: { stage: 'sign_in', factorType: MFA_FACTOR_TYPE } })",
      // H-004b: el motivo y el para qué (textos fijos o variables que no son la contraseña) y un código fijo
      "logAuditEvent({ action: 'session.reauth_failed', result: 'failure', actorUserId: user.id, details: { reason, purpose } })",
      "serverLog('warn', 'reauth_sign_out_failed', { code: 'unexpected' })",
      // H-004b: lo que sí se registra de los códigos de respaldo: motivos, etapas y códigos de error
      "logAuditEvent({ action: 'session.mfa_recovery_used', result: 'success', actorUserId: user.id, details: { stage: 'sign_in' } })",
      "logAuditEvent({ action: 'session.mfa_disabled', result: 'success', actorUserId: user.id, details: { via: 'recovery_code' } })",
      "logAuditEvent({ action: 'session.mfa_recovery_codes_created', result: 'success', actorUserId: user.id, details: { stage: 'regenerate' } })",
      "serverLog('error', 'mfa_recovery_claim_failed', { code: error instanceof MfaRecoveryGatewayError ? error.code : 'unexpected' })",
    ];
    for (const call of good) expect(secondStepLogViolation(call), call).toBeNull();
    // Y encuentra las llamadas (con paréntesis anidados) de las dos funciones.
    expect(
      namedCalls("serverLog('a', { b: f(1) }); logAuditEvent({ c: g(h(2)) });", "serverLog"),
    ).toHaveLength(1);
    expect(namedCalls("serverLog('a'); logAuditEvent({ c: 1 });", "logAuditEvent")).toHaveLength(1);
  });

  it("14c. (H-004a) la guardia 14 detecta de verdad una violación", () => {
    expect(
      /\.(getUser|getClaims|getSession|getAuthenticatorAssuranceLevel)\s*\(/.test(
        "await supabase.auth.getClaims()",
      ),
    ).toBe(true);
    expect(
      /\.mfa\s*\.\s*(enroll|challenge|verify|challengeAndVerify|unenroll|listFactors)\s*\(/.test(
        "supabase.auth.mfa.unenroll({ factorId })",
      ),
    ).toBe(true);
    expect(
      /\.mfa\s*\.\s*(enroll|challenge|verify|challengeAndVerify|unenroll|listFactors)\s*\(/.test(
        "supabase.auth.mfa.getAuthenticatorAssuranceLevel()",
      ),
    ).toBe(false);
    // La API de administración: la detecta aunque venga encadenada, con espacios o saltos de línea; no confunde otras `auth`.
    for (const violation of [
      "await createAdminClient().auth.admin.mfa.deleteFactor({ id, userId })",
      "admin.auth\n  .admin\n  .listUsers()",
      "const { auth } = client; auth.admin.updateUserById(id, {})",
      // Las formas con que se podría esquivar la regla simple
      "await client.auth?.admin.listUsers()",
      "await client.auth ?. admin.listUsers()",
      "await client.auth['admin'].listUsers()",
      'await client.auth["admin"]?.mfa.deleteFactor({})',
      "const { admin } = client.auth; await admin.listUsers()",
      "const { admin: cuentas, other } = createAdminClient().auth;",
      // Desestructurar anidado (revisión Opus, ronda 2 de H-118)
      "const { auth: { admin } } = createAdminClient(); await admin.listUsers()",
    ]) {
      expect(AUTH_ADMIN_PATTERN.test(violation), violation).toBe(true);
    }
    expect(AUTH_ADMIN_MFA_PATTERN.test("x.auth.admin.mfa.deleteFactor({})")).toBe(true);
    expect(AUTH_ADMIN_MFA_PATTERN.test("x.auth.admin.listUsers()")).toBe(false);
    expect(AUTH_ADMIN_MFA_PATTERN.test("x.auth?.admin?.mfa.deleteFactor({})")).toBe(true);
    expect(AUTH_ADMIN_MFA_PATTERN.test('x.auth["admin"].mfa.deleteFactor({})')).toBe(true);
    for (const harmless of [
      "supabase.auth.getUser()",
      "const isAdmin = true",
      "auth.administrador()",
      "const { admin } = props;",
      "const { data, auth } = await load();",
    ]) {
      expect(AUTH_ADMIN_PATTERN.test(harmless), harmless).toBe(false);
    }
    // Y de verdad muerde: un archivo cualquiera con `auth.admin` aparece como infractor; la pasarela, no.
    const flagged = (text: string, file: string) =>
      AUTH_ADMIN_PATTERN.test(stripComments(text)) && !AUTH_ADMIN_GATEWAYS.includes(file);
    expect(flagged("admin.auth.admin.deleteUser(id)", "src/lib/auth/second-step-actions.ts")).toBe(
      true,
    );
    expect(flagged("// auth.admin.deleteUser(id)", "src/lib/auth/second-step-actions.ts")).toBe(
      false,
    );
    expect(flagged("admin.auth.admin.mfa.deleteFactor({})", MFA_ADMIN_GATEWAY)).toBe(false);
  });

  it("14e. (menor 6 del PR #44) cancelTotpEnrollmentAction exige sesión y solo quita un factor TOTP SIN verificar de la persona, visto en su propia lista, antes de llamar a unenroll", () => {
    const text = stripComments(read(path.join(ROOT, "src/lib/auth/second-step-actions.ts")));
    const start = text.indexOf("export async function cancelTotpEnrollmentAction");
    expect(start, "falta cancelTotpEnrollmentAction").toBeGreaterThan(-1);
    const body = text.slice(start);
    const unenrollAt = body.indexOf(".unenroll(");
    expect(unenrollAt, "debe llamar a unenroll").toBeGreaterThan(-1);
    const before = body.slice(0, unenrollAt);
    expect(before).toMatch(/await requireUser\(\)/);
    expect(before).toMatch(/\.mfa\.listFactors\(\)/);
    expect(before).toMatch(/factor_type === MFA_FACTOR_TYPE/);
    expect(before).toMatch(/status === "unverified"/);
    // Quita el factor que salió de la lista, no el texto que llegó del navegador.
    expect(body.slice(unenrollAt, unenrollAt + 60)).toMatch(/factorId:\s*factor\.id/);
  });

  it("14f. (H-118) serverLog y logAuditEvent en el aviso de activación del segundo paso y su enlace nunca reciben el código del enlace, su huella, la contraseña ni el correo", () => {
    const files = [
      "src/lib/security/mfa-admin-gateway.ts",
      "src/lib/security/mfa-alerts-gateway.ts",
      "src/lib/security/mfa-annul-token.ts",
      "src/lib/security/mfa-enrollment-notice.ts",
      "src/lib/email/mfa-enrollment-notice.ts",
      // H-118b
      "src/lib/security/mfa-annul.ts",
      "src/lib/auth/mfa-annul-actions.ts",
      "src/lib/email/mfa-annulled-notice.ts",
    ];
    let found = 0;
    for (const file of files) {
      const text = stripComments(read(path.join(ROOT, file)));
      for (const name of ["serverLog", "logAuditEvent"]) {
        for (const call of namedCalls(text, name)) {
          found += 1;
          expect(annulLogViolation(call), `${file}: ${call}`).toBeNull();
        }
      }
    }
    // La guardia no puede pasar en vacío: el envío del aviso registra sus fallos.
    expect(found).toBeGreaterThanOrEqual(3);
    const notice = stripComments(
      read(path.join(ROOT, "src/lib/security/mfa-enrollment-notice.ts")),
    );
    expect(namedCalls(notice, "serverLog").length).toBeGreaterThan(1);
    expect(namedCalls(notice, "logAuditEvent").length).toBeGreaterThan(0);
    // Ninguno de esos archivos manda el correo ni el código a una auditoría o un registro por otro camino.
    for (const file of files) {
      const text = stripComments(read(path.join(ROOT, file)));
      expect(/console\./.test(text), `${file}: escribe en la consola`).toBe(false);
    }
  });

  it("14h. (H-118b) la página de anular no usa la llave maestra, no lee ni consulta nada al abrirse, y la acción solo habla con el servicio de anulación", () => {
    const dir = path.join(SRC, "app/cuenta/anular-dos-pasos");
    const pageFiles = readdirSync(dir).filter((name) => /\.(ts|tsx)$/.test(name));
    expect(pageFiles).toEqual(expect.arrayContaining(["page.tsx", "annul-form.tsx"]));
    for (const name of pageFiles) {
      const text = stripComments(read(path.join(dir, name)));
      expect(
        /admin-client|createAdminClient|SERVICE_ROLE|auth\s*\.\s*admin/.test(text),
        `${name}: llave maestra`,
      ).toBe(false);
      expect(
        /@\/lib\/security\//.test(text),
        `${name}: importa un módulo de seguridad del servidor`,
      ).toBe(false);
      expect(/@\/lib\/supabase\//.test(text), `${name}: habla con Supabase`).toBe(false);
    }
    // Al ABRIRLA (GET) no lee el código ni la sesión ni las cookies, ni consulta la base: no es async ni usa nada de la petición.
    const page = stripComments(read(path.join(dir, "page.tsx")));
    expect(
      /searchParams|cookies\(|headers\(|await |getSessionState|requireUser|\.rpc\(|\.from\(/.test(
        page,
      ),
    ).toBe(false);
    // El código solo sale del cliente por el campo oculto del formulario: no va en la ruta ni en la consulta.
    const form = stripComments(read(path.join(dir, "annul-form.tsx")));
    expect(form).toMatch(/window\.location\.hash/);
    expect(form).toMatch(/history\.replaceState/);
    expect(/useSearchParams|fetch\(/.test(form)).toBe(false);
    // La acción no usa la llave maestra ni nombra la API de cuentas: todo pasa por el servicio.
    const action = stripComments(read(path.join(SRC, "lib/auth/mfa-annul-actions.ts")));
    expect(/admin-client|createAdminClient|auth\s*\.\s*admin/.test(action)).toBe(false);
    expect(action).toMatch(/annulSecondStep\(/);
    // Y el servicio no abre una sesión de recuperación: no hay inicio de sesión ni cambio de contraseña con el pase de nadie.
    const service = stripComments(read(path.join(SRC, "lib/security/mfa-annul.ts")));
    expect(
      /signIn|verifyOtp|exchangeCodeForSession|setSession|signInWithPassword/.test(service),
    ).toBe(false);
  });

  it("14i. (H-118) las pantallas cuyas acciones envían avisos de la activación del segundo paso declaran un `maxDuration` de al menos 60 s (3 envíos de 15 s más margen)", () => {
    // Un literal: Next lo lee sin ejecutar la pantalla. El plazo del hosting debe respetarlo (lista «Antes del piloto»).
    const MIN_SECONDS = 60;
    const screens = [
      "src/app/(auth)/ingresar/page.tsx", // signInAction reintenta los avisos pendientes
      "src/app/(auth)/ingresar/codigo/page.tsx", // verifySecondStepAction los reintenta
      "src/app/cuenta/seguridad/page.tsx", // confirmTotpEnrollmentAction los envía
      "src/app/cuenta/anular-dos-pasos/page.tsx", // annulSecondStepAction manda dos correos
    ];
    for (const screen of screens) {
      const text = stripComments(read(path.join(ROOT, screen)));
      const match = /export const maxDuration = (\d+);/.exec(text);
      expect(match, `${screen}: falta export const maxDuration = <segundos>`).not.toBeNull();
      expect(Number(match![1]), screen).toBeGreaterThanOrEqual(MIN_SECONDS);
    }
    // Y la guardia muerde: sin la declaración, o con un plazo corto, se detecta.
    expect(/export const maxDuration = (\d+);/.exec("export const metadata = {};")).toBeNull();
    expect(
      Number(/export const maxDuration = (\d+);/.exec("export const maxDuration = 30;")![1]),
    ).toBeLessThan(MIN_SECONDS);
  });

  it("14j. (H-004b) «pedir la contraseña de nuevo»: el correo sale de la sesión (no del formulario), usa el límite del ingreso, cierra la sesión desechable solo en local, y la acción de activar la pide ANTES de los contadores y del permiso", () => {
    const reauth = stripComments(read(path.join(ROOT, "src/lib/auth/reauth.ts")));
    // El correo no puede venir del formulario ni de un parámetro: solo la sesión.
    expect(reauth).toMatch(/getSessionState\(\)/);
    expect(/formData|FormData|readText/.test(reauth)).toBe(false);
    // Ni la llave maestra, ni los factores, ni la API de administración.
    expect(/admin-client|createAdminClient|auth\s*\.\s*admin|\.mfa\./.test(reauth)).toBe(false);
    // El límite del ingreso (no un presupuesto de intentos aparte).
    for (const name of ["isLoginLocked", "recordLoginFailure", "clearLoginFailures"]) {
      expect(reauth, name).toMatch(new RegExp(`\\b${name}\\(`));
    }
    // La sesión desechable: sin cookies ni renovación, y se cierra SIEMPRE con alcance local (nunca global ni «others»).
    expect(reauth).toMatch(/persistSession:\s*false/);
    expect(reauth).toMatch(/autoRefreshToken:\s*false/);
    const signOuts = [...reauth.matchAll(/\.signOut\(([^)]*)\)/g)].map((match) => match[1]);
    expect(signOuts.length).toBeGreaterThan(0);
    for (const argument of signOuts) expect(argument).toMatch(/scope:\s*"local"/);
    // La acción de activar: la contraseña va después de validar la forma y ANTES de todo lo demás.
    const actions = stripComments(read(path.join(ROOT, "src/lib/auth/second-step-actions.ts")));
    const body = actions.slice(
      actions.indexOf("export async function confirmTotpEnrollmentAction"),
    );
    expect(passwordBeforeCounters(body)).toBeNull();
    // Y la guardia muerde: sin la contraseña, o con ella después de los contadores o del permiso, se detecta.
    expect(
      passwordBeforeCounters("checkCodeBeforeVerifying(a); permitEnrollment(b);"),
    ).not.toBeNull();
    expect(
      passwordBeforeCounters(
        "checkCodeBeforeVerifying(a); confirmPassword(u, p, 'enroll'); permitEnrollment(b);",
      ),
    ).not.toBeNull();
    expect(
      passwordBeforeCounters(
        "confirmPassword(u, p, 'enroll'); permitEnrollment(b); checkCodeBeforeVerifying(a);",
      ),
    ).not.toBeNull();
    expect(
      passwordBeforeCounters(
        "confirmPassword(u, p, 'enroll'); checkCodeBeforeVerifying(a); permitEnrollment(b);",
      ),
    ).toBeNull();
    // El patrón de signInWithPassword también muerde: se ve aunque venga encadenado.
    expect(
      SIGN_IN_WITH_PASSWORD_PATTERN.test(
        "await client.auth.signInWithPassword({ email, password })",
      ),
    ).toBe(true);
    expect(SIGN_IN_WITH_PASSWORD_PATTERN.test("await client.auth.signInWithOtp({ email })")).toBe(
      false,
    );
  });

  it("14k. (H-004b) los códigos de respaldo: solo la pasarela llama a las siete funciones de la base, nadie lee ni escribe la tabla directo, y la pasarela y las piezas de los códigos no registran ni escriben en la consola", () => {
    // La pasarela existe, nombra las siete funciones y ningún otro archivo de la aplicación nombra ninguna.
    const gateway = stripComments(read(path.join(ROOT, MFA_RECOVERY_GATEWAY)));
    const functionNames = [
      "mfa_recovery_codes_replace",
      "mfa_recovery_code_claim",
      "mfa_recovery_code_complete",
      "mfa_recovery_code_release",
      "mfa_recovery_codes_acknowledge",
      "mfa_recovery_codes_status",
      "mfa_recovery_codes_revoke",
    ];
    for (const name of functionNames) {
      expect(gateway, name).toMatch(new RegExp(`\\.rpc\\(\\s*"${name}"`));
    }
    const offenders = sourceFiles
      .filter((file) => MFA_RECOVERY_FUNCTION_PATTERN.test(stripComments(read(file))))
      .map(rel)
      .filter((file) => file !== MFA_RECOVERY_GATEWAY);
    expect(offenders).toEqual([]);
    // La pasarela usa la llave maestra (es su razón de ser) pero no la API de cuentas ni los factores: eso es de la otra pasarela.
    expect(gateway).toMatch(/createAdminClient/);
    expect(AUTH_ADMIN_PATTERN.test(gateway)).toBe(false);
    expect(/\.mfa\s*\./.test(gateway)).toBe(false);
    expect(MFA_RECOVERY_TABLE_PATTERN.test(gateway)).toBe(false);
    // La huella: solo se calcula en `recovery-code.ts`, con la llave de búsqueda (nada de comparar a mano).
    const pieces = stripComments(read(path.join(ROOT, "src/lib/auth/recovery-code.ts")));
    expect(pieces).toMatch(/searchHash\(/);
    expect(pieces).toMatch(/from "node:crypto"/);
    expect(/Math\.random/.test(pieces)).toBe(false);
    for (const file of ["src/lib/auth/recovery-code.ts", MFA_RECOVERY_GATEWAY]) {
      const text = stripComments(read(path.join(ROOT, file)));
      expect(/console\./.test(text), `${file}: escribe en la consola`).toBe(false);
      expect(/\bserverLog\(|\blogAuditEvent\(/.test(text), `${file}: no debe registrar nada`).toBe(
        false,
      );
    }
    // Y la guardia muerde: cada forma de llamar a una función, o de leer la tabla, fuera de la pasarela se detecta; las demás no.
    const flagged = (text: string, file: string) =>
      (MFA_RECOVERY_FUNCTION_PATTERN.test(stripComments(text)) && file !== MFA_RECOVERY_GATEWAY) ||
      MFA_RECOVERY_TABLE_PATTERN.test(stripComments(text));
    for (const violation of [
      'await admin.rpc("mfa_recovery_code_claim", { p_user_id: id, p_code_hash: hash })',
      "await admin.rpc('mfa_recovery_codes_replace', args)",
      "await admin.rpc(`mfa_recovery_codes_status`, { p_user_id })",
      'const name = "mfa_recovery_codes_revoke"; await admin.rpc(name, args)',
      'await admin.from("mfa_recovery_codes").select("code_hash")',
      "await admin.from('mfa_recovery_codes').delete().eq('user_id', id)",
    ]) {
      expect(flagged(violation, "src/lib/auth/second-step-manage-actions.ts"), violation).toBe(
        true,
      );
      expect(flagged(violation, MFA_RECOVERY_GATEWAY), `${violation} en la pasarela`).toBe(
        violation.includes(".from("),
      );
    }
    for (const harmless of [
      'searchHash("mfa_recovery_code", PLATFORM_TENANT_ID, value)',
      "// admin.rpc('mfa_recovery_code_claim', args)",
      'const table = "mfa_recovery_codes"',
      "await claimRecoveryCode(user.id, hash)",
    ]) {
      expect(flagged(harmless, "src/lib/auth/second-step-manage-actions.ts"), harmless).toBe(false);
    }
  });

  it("14l. (H-004b) entrar con un código de respaldo: sesión a medias primero; el código se toma antes de quitar los factores, las otras sesiones se cierran DESPUÉS de quitarlos, y la redirección es lo último; el código ni su huella llegan a un registro", () => {
    const text = stripComments(read(path.join(ROOT, RECOVERY_CODE_ACTIONS)));
    const start = text.indexOf("export async function verifyRecoveryCodeAction");
    expect(start, "falta verifyRecoveryCodeAction").toBeGreaterThan(-1);
    const body = text.slice(start);
    expect(recoveryUseOrderViolation(body)).toBeNull();
    // Sin llave maestra ni métodos de sesión en el archivo: los factores se quitan por la pasarela.
    expect(
      /admin-client|createAdminClient|auth\s*\.\s*admin|\.mfa\s*\.\s*unenroll/.test(text),
    ).toBe(false);
    // Y la guardia muerde: el orden roto se detecta.
    const ordered = [
      "await requirePendingSecondStep();",
      "await blockedAttemptState(a);",
      "await claimRecoveryCode(a);",
      "await removeAllFactors(a);",
      "await supabase.auth.signOut({ scope: 'others' });",
      "await completeRecoveryCode(a);",
      "redirect(b);",
    ];
    expect(recoveryUseOrderViolation(ordered.join("\n"))).toBeNull();
    for (const swap of [
      [2, 3], // quitar los factores antes de tomar el código
      [3, 4], // cerrar las otras sesiones antes de quitar el factor
      [0, 1], // contar el intento antes de pedir la sesión a medias
      [5, 6], // redirigir antes de completar
    ]) {
      const broken = [...ordered];
      [broken[swap[0]], broken[swap[1]]] = [broken[swap[1]], broken[swap[0]]];
      expect(recoveryUseOrderViolation(broken.join("\n")), swap.join("↔")).not.toBeNull();
    }
    expect(recoveryUseOrderViolation(ordered.slice(1).join("\n"))).not.toBeNull();
  });

  it("14g. la guardia 14f detecta de verdad el código del enlace, su huella, la contraseña y el correo; deja pasar un código de error", () => {
    const bad = [
      "serverLog('warn', 'x', { token })",
      "serverLog('warn', 'x', { tokenSha256 })",
      "serverLog('warn', 'x', { fp: hashMfaAnnulToken(raw) })",
      "logAuditEvent({ details: { email: user.email } })",
      "logAuditEvent({ details: { to: reserved.email } })",
      "serverLog('warn', 'x', { password })",
      "serverLog('warn', 'x', { url: annulUrl })",
    ];
    for (const call of bad) expect(annulLogViolation(call), call).not.toBeNull();
    const good = [
      "serverLog('warn', 'mfa_notice_failed', { code: failureCode })",
      "serverLog('error', 'mfa_notice_settle_failed', { code: codeOf(cause) })",
      "logAuditEvent({ action: 'session.mfa_enroll_reverted', result: 'failure', actorUserId: user.id, details: { reason: 'provider_rejected', stage: 'enrollment' } })",
    ];
    for (const call of good) expect(annulLogViolation(call), call).toBeNull();
  });

  it("7. la guardia detecta de verdad: el texto de una violación sí coincide con las reglas", () => {
    // Evita que una regla quede inútil por un error en su expresión regular.
    expect(/x-cp-tenant-id/i.test('headers["X-CP-Tenant-Id"]')).toBe(true);
    expect(/\.getSession\s*\(/.test("await supabase.auth.getSession()")).toBe(true);
    const sample = 'supabase.from("profiles").select("*")';
    expect(/from\(\s*["']profiles["']\s*\)([\s\S]{0,200}?)\.select\(([^)]*)\)/.test(sample)).toBe(
      true,
    );
  });
});
