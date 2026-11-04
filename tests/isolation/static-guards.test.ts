// H-012 · Guardias estáticas: leen el código, sin red. Complementan (no repiten)
// `src/lib/tenant/guard-coverage.test.ts`, que ya exige `requireActiveTenant` en toda pantalla y
// acción de servidor. Aquí se vigilan los otros caminos por los que se puede romper el aislamiento.
import { readdirSync, readFileSync, statSync } from "node:fs";
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
    for (const route of discovered) {
      // Una ruta que no esté en el registro la atrapa G5; aquí solo cuentan las declaradas "none".
      if (withoutOrganization.has(routeKey(route))) continue;
      // Las del enlace del cliente tienen su propia guardia (8b).
      if (byToken.has(routeKey(route))) continue;
      // Las del formulario público tienen las suyas (10 a 10e).
      if (byForm.has(routeKey(route))) continue;
      // Las de avisos firmados por un proveedor tienen su propia guardia (8e).
      if (bySignature.has(routeKey(route))) continue;
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
