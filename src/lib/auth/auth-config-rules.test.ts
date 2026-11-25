import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_RULES,
  EXTERNAL_PROVIDERS,
  MANUAL_CHECKS,
  allRulesPass,
  evaluateRules,
  meets,
  parseDurationSeconds,
  readPath,
  type ConfigRule,
} from "./auth-config-rules";

// La lista de configuración de Supabase de H-116 (§5 del diseño): las reglas, cómo se leen y que coinciden con `config.toml`.

const config = readFileSync(path.join(process.cwd(), "supabase", "config.toml"), "utf8");

/** Valor de `key` dentro de `[section]` de `config.toml` (el encabezado va al inicio de una línea). */
function localValue(section: string, key: string): string | undefined {
  const heading = new RegExp(`^\\[${section.replaceAll(".", "\\.")}\\]\\s*$`, "m").exec(config);
  if (!heading) return undefined;
  const rest = config.slice(heading.index + heading[0].length);
  const next = rest.search(/^\[/m);
  const body = next === -1 ? rest : rest.slice(0, next);
  return body.match(new RegExp(`^${key}\\s*=\\s*(.+?)\\s*$`, "m"))?.[1]?.replace(/^"(.*)"$/, "$1");
}

/** Lo que `config.toml` entrega, ya traducido a lo que mira la regla (los interruptores invertidos se dan vuelta). */
function localReading(rule: ConfigRule): unknown {
  if (!rule.local) return undefined;
  const raw = localValue(rule.local.section, rule.local.key);
  if (raw === undefined) return undefined;
  if (raw === "true" || raw === "false") {
    const value = raw === "true";
    return rule.local.inverted ? !value : value;
  }
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

/** Una configuración que cumple TODAS las reglas, armada desde las propias reglas (para cambiarle una cosa a la vez). */
function compliantSources() {
  const publicSettings: Record<string, unknown> = {};
  const management: Record<string, unknown> = {};
  const setPath = (target: Record<string, unknown>, route: string, value: unknown) => {
    const parts = route.split(".");
    let node = target;
    for (const part of parts.slice(0, -1)) {
      node[part] = (node[part] as Record<string, unknown>) ?? {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts.at(-1)!] = value;
  };
  for (const rule of CONFIG_RULES) {
    const value =
      rule.expect.kind === "nonEmpty"
        ? "valor"
        : rule.expect.kind === "seconds" ||
            rule.expect.kind === "equals" ||
            rule.expect.kind === "atLeast" ||
            rule.expect.kind === "atMost"
          ? rule.expect.value
          : undefined;
    if (rule.public) setPath(publicSettings, rule.public, value);
    if (rule.management) management[rule.management] = value;
  }
  return { publicSettings, management };
}

describe("las reglas de configuración de Supabase (H-116 §5)", () => {
  it("cada regla se puede leer en algún lugar y los puntos del diseño están cubiertos", () => {
    for (const rule of CONFIG_RULES) {
      expect(rule.public || rule.management, rule.id).toBeTruthy();
    }
    const ids = CONFIG_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    const points = new Set([
      ...CONFIG_RULES.map((rule) => rule.point),
      ...MANUAL_CHECKS.map((check) => check.point),
    ]);
    // Del 1 al 17 de §5: el 14 es correr este guion y el 13 lo revisa la aplicación al arrancar (está en «a mano»).
    for (const point of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17]) {
      expect(points.has(point), `punto ${point}`).toBe(true);
    }
  });

  it("incluye el registro público apagado y cada proveedor externo, uno por uno", () => {
    expect(CONFIG_RULES.find((rule) => rule.id === "signup-disabled")?.management).toBe(
      "disable_signup",
    );
    for (const provider of EXTERNAL_PROVIDERS) {
      expect(
        CONFIG_RULES.some((rule) => rule.id === `provider-${provider}-off`),
        provider,
      ).toBe(true);
    }
  });

  it("lo que `supabase/config.toml` dice coincide con lo que las reglas esperan (los valores de local son los del piloto)", () => {
    let compared = 0;
    for (const rule of CONFIG_RULES.filter((entry) => entry.local)) {
      const reading = localReading(rule);
      expect(
        reading,
        `${rule.id}: no se encontró [${rule.local!.section}] ${rule.local!.key} en config.toml`,
      ).not.toBeUndefined();
      expect(meets(rule.expect, reading), `${rule.id}: config.toml dice ${String(reading)}`).toBe(
        true,
      );
      compared += 1;
    }
    // Una prueba que no compara nada no prueba nada.
    expect(compared).toBeGreaterThan(14);
  });
});

describe("evaluateRules", () => {
  it("una configuración que cumple todo queda en orden", () => {
    const results = evaluateRules(compliantSources());
    expect(results.filter((result) => result.status !== "ok")).toEqual([]);
    expect(allRulesPass(results)).toBe(true);
  });

  it("un registro público abierto es un fallo, en la parte pública y en la de gestión", () => {
    const sources = compliantSources();
    (sources.publicSettings as Record<string, unknown>).disable_signup = false;
    const results = evaluateRules(sources);
    const signup = results.find((result) => result.id === "signup-disabled")!;
    expect(signup.status).toBe("fail");
    expect(signup.detail).toContain("público: false");
    expect(allRulesPass(results)).toBe(false);

    const management = compliantSources();
    management.management.disable_signup = false;
    expect(
      evaluateRules(management).find((result) => result.id === "signup-disabled")?.status,
    ).toBe("fail");
  });

  it("cada cambio de una regla la hace fallar: contraseña corta, código de 6, cambio de correo sin doble clic, ganchos y proveedores encendidos", () => {
    const cases: [string, string, unknown][] = [
      ["password-min-length", "password_min_length", 8],
      ["otp-length", "mailer_otp_length", 6],
      ["secure-email-change", "mailer_secure_email_change_enabled", false],
      ["secure-password-change", "security_update_password_require_reauthentication", false],
      ["confirm-email", "mailer_autoconfirm", true],
      ["hook-send-email-enabled", "hook_send_email_enabled", true],
      ["provider-google-off", "external_google_enabled", true],
      ["anonymous-off", "external_anonymous_users_enabled", true],
      ["jwt-expiry", "jwt_exp", 3600],
      ["session-timebox", "sessions_timebox", 0],
      ["smtp-configured", "smtp_host", ""],
    ];
    for (const [id, field, value] of cases) {
      const sources = compliantSources();
      sources.management[field] = value;
      const result = evaluateRules(sources).find((entry) => entry.id === id)!;
      expect(result.status, `${id} con ${String(value)}`).toBe("fail");
    }
  });

  it("lo que no se pudo leer NO se da por bueno: sin dato queda «sin dato» y el guion falla", () => {
    // Sin la API de gestión (sin token), las reglas que solo ella contesta quedan sin dato.
    const onlyPublic = evaluateRules({
      publicSettings: compliantSources().publicSettings,
      management: null,
    });
    expect(onlyPublic.find((result) => result.id === "otp-length")?.status).toBe("unknown");
    expect(onlyPublic.find((result) => result.id === "signup-disabled")?.status).toBe("ok");
    expect(allRulesPass(onlyPublic)).toBe(false);
    // Una respuesta sin el campo (un nombre que cambió) tampoco se aprueba.
    const sources = compliantSources();
    delete sources.management.mailer_otp_length;
    expect(evaluateRules(sources).find((result) => result.id === "otp-length")?.status).toBe(
      "unknown",
    );
    // Ninguna fuente: todo sin dato.
    expect(
      evaluateRules({ publicSettings: null, management: null }).every(
        (result) => result.status === "unknown",
      ),
    ).toBe(true);
  });

  it("si una fuente dice que sí y la otra no se pudo leer, no se da por bueno todo", () => {
    const sources = compliantSources();
    delete sources.management.disable_signup;
    const signup = evaluateRules(sources).find((result) => result.id === "signup-disabled")!;
    expect(signup.status).toBe("unknown");
  });

  it("nunca muestra secretos: el detalle solo trae el valor de configuración, cortado", () => {
    const sources = compliantSources();
    sources.management.smtp_host = "x".repeat(500);
    const smtp = evaluateRules(sources).find((result) => result.id === "smtp-configured")!;
    expect(smtp.detail.length).toBeLessThan(200);
  });
});

describe("lectura de valores", () => {
  it("readPath sigue rutas con puntos y devuelve `undefined` si falta algo", () => {
    expect(readPath({ external: { email: true } }, "external.email")).toBe(true);
    expect(readPath({ external: null }, "external.email")).toBeUndefined();
    expect(readPath({}, "external.email")).toBeUndefined();
  });

  it("parseDurationSeconds entiende «168h», «12h30m», números y rechaza lo raro", () => {
    expect(parseDurationSeconds("168h")).toBe(604_800);
    expect(parseDurationSeconds("12h")).toBe(43_200);
    expect(parseDurationSeconds("1h30m")).toBe(5_400);
    expect(parseDurationSeconds(604_800)).toBe(604_800);
    expect(parseDurationSeconds("604800")).toBe(604_800);
    expect(parseDurationSeconds("mucho")).toBeNull();
    expect(parseDurationSeconds("12 horas")).toBeNull();
    expect(parseDurationSeconds(undefined)).toBeNull();
  });

  it("meets acepta números como texto (la API de gestión devuelve algunos así) y no confunde tipos", () => {
    expect(meets({ kind: "equals", value: 10 }, "10")).toBe(true);
    expect(meets({ kind: "equals", value: 10 }, 9)).toBe(false);
    expect(meets({ kind: "equals", value: true }, "true")).toBeNull();
    expect(meets({ kind: "equals", value: false }, undefined)).toBeNull();
    expect(meets({ kind: "atLeast", value: 10 }, 12)).toBe(true);
    expect(meets({ kind: "nonEmpty" }, "   ")).toBe(false);
    expect(meets({ kind: "nonEmpty" }, 5)).toBeNull();
  });
});
