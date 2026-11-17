// Prueba de cobertura (docs/arquitectura/modelo-datos.md §2): nada de lo que toca datos de una
// organización puede olvidar resolver la organización activa con `requireActiveTenant`.
// Lee los archivos del código; no ejecuta nada. Si agregas una pantalla o una acción nueva y se
// te olvida la guardia, esta prueba falla.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "..");
const TENANT_PAGES_DIR = path.join(SRC, "app", "o", "[tenantId]");
const GUARD = "requireActiveTenant(";
const PERMISSION_GUARD = "requirePermission(";

/** Acciones que NO operan dentro de una organización, con la razón. Cada excepción debe justificarse. */
const ACTIONS_WITHOUT_ACTIVE_TENANT: Record<string, string> = {
  "lib/auth/actions.ts#signUpAction": "todavía no hay sesión ni organización",
  "lib/auth/actions.ts#signInAction": "todavía no hay sesión ni organización",
  "lib/auth/actions.ts#requestPasswordResetAction":
    "todavía no hay sesión: la persona olvidó su clave",
  "lib/auth/actions.ts#resetPasswordAction":
    "cambia la contraseña de la cuenta, no actúa sobre una organización",
  "lib/auth/actions.ts#signOutAction":
    "cierra la sesión de la cuenta, no actúa sobre una organización",
  "lib/auth/actions.ts#signOutKeepingInvitationAction":
    "cierra la sesión de la cuenta conservando la invitación; no actúa sobre una organización",
  "lib/auth/actions.ts#acceptLegalAction": "los términos son de la cuenta, no de una organización",
  "lib/auth/second-step-actions.ts#verifySecondStepAction":
    "es de la cuenta, no de una organización: escribe el código de la verificación en dos pasos",
  "lib/auth/second-step-actions.ts#startTotpEnrollmentAction":
    "es de la cuenta, no de una organización: prepara la verificación en dos pasos de la propia persona",
  "lib/auth/second-step-actions.ts#confirmTotpEnrollmentAction":
    "es de la cuenta, no de una organización: activa la verificación en dos pasos de la propia persona",
  "lib/auth/second-step-actions.ts#cancelTotpEnrollmentAction":
    "es de la cuenta, no de una organización: quita el intento a medias de la verificación en dos pasos de la propia persona",
  "lib/auth/recovery-code-actions.ts#regenerateRecoveryCodesAction":
    "es de la cuenta, no de una organización: crea los códigos de respaldo de la verificación en dos pasos de la propia persona, con su contraseña y el código de su aplicación",
  "lib/auth/recovery-code-actions.ts#acknowledgeRecoveryCodesAction":
    "es de la cuenta, no de una organización: la persona confirma que guardó sus propios códigos de respaldo",
  "lib/auth/recovery-code-actions.ts#verifyRecoveryCodeAction":
    "es de la cuenta, no de una organización: la persona con la sesión a medias entra con uno de sus propios códigos de respaldo (la base lo toma una sola vez), lo que desactiva su verificación en dos pasos",
  "lib/auth/second-step-manage-actions.ts#disableSecondStepAction":
    "es de la cuenta, no de una organización: la propia persona, con su sesión completa, su contraseña y un código (de su aplicación o de respaldo), desactiva su verificación en dos pasos; el aviso por correo sale antes y el factor se quita con su propia sesión",
  "lib/auth/mfa-annul-actions.ts#annulSecondStepAction":
    "es pública y sin sesión: la usa quien abre el enlace del correo de aviso (que puede no tener ya sesión) y no actúa sobre una organización; la autoriza el código del enlace, de un solo uso, que la base toma y consume",
  "lib/tenant/actions.ts#createTenantAction": "crea la organización: aún no existe una activa",
  "lib/team/accept-actions.ts#acceptInvitationAction":
    "la persona aún no es miembro: la organización la define la invitación, que decide la base de datos",
  "lib/team/accept-actions.ts#leaveInvitationAction":
    "solo borra el código guardado en este navegador, no actúa sobre una organización",
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");
const read = (file: string) => readFileSync(file, "utf8");

describe("toda pantalla de una organización resuelve la organización activa", () => {
  const files = walk(TENANT_PAGES_DIR).filter((file) => /\/(page|layout)\.tsx$/.test(rel(file)));

  it("hay pantallas que revisar", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((file) => [rel(file), file]))(
    "%s llama a requireActiveTenant",
    (_name, file) => {
      // El layout no protege a las páginas (la navegación del cliente puede saltárselo): cada una lo exige.
      expect(read(file)).toContain(GUARD);
    },
  );
});

describe("toda acción de servidor que usa Supabase resuelve la organización activa", () => {
  const actionFiles = walk(SRC).filter(
    (file) =>
      /\.(ts|tsx)$/.test(file) &&
      !/\.test\./.test(file) &&
      /^\s*["']use server["']/.test(read(file).trimStart()),
  );

  const actions = actionFiles.flatMap((file) => {
    const text = read(file);
    const usesSupabase = /createClient|createAdminClient|\.supabase\b/.test(text);
    const parts = text.split(/export async function /).slice(1);
    return parts.map((part) => ({
      id: `${rel(file)}#${part.slice(0, part.indexOf("(")).trim()}`,
      usesSupabase,
      body: part,
    }));
  });

  it("hay acciones que revisar", () => {
    expect(actions.length).toBeGreaterThan(5);
  });

  it.each(actions.map((action) => [action.id, action] as const))(
    "%s llama a requireActiveTenant o está justificada",
    (id, action) => {
      if (!action.usesSupabase) return;
      if (id in ACTIONS_WITHOUT_ACTIVE_TENANT) return;
      expect(action.body).toContain(GUARD);
    },
  );

  // H-011: además de resolver la organización, toda acción revisa el permiso del rol con la matriz
  // (`src/lib/permissions/`). Hasta las de solo lectura (buscar, cambiar de organización) lo hacen con
  // `org.view`, para que ninguna acción nueva se escriba sin pensar quién puede llamarla.
  it.each(
    actions
      .filter((action) => action.body.includes(GUARD))
      .map((action) => [action.id, action] as const),
  )("%s llama a requirePermission", (_id, action) => {
    expect(action.body).toContain(PERMISSION_GUARD);
  });

  it("las acciones sin organización activa son solo las justificadas", () => {
    const withoutTenant = actions
      .filter((action) => !action.body.includes(GUARD) && action.usesSupabase)
      .map((action) => action.id)
      .filter((id) => !(id in ACTIONS_WITHOUT_ACTIVE_TENANT));
    expect(withoutTenant).toEqual([]);
  });

  it("la lista de excepciones no tiene acciones que ya no existen", () => {
    const existing = new Set(actions.map((action) => action.id));
    for (const id of Object.keys(ACTIONS_WITHOUT_ACTIVE_TENANT)) {
      expect(existing.has(id), `${id} ya no existe: quítala de la lista`).toBe(true);
    }
  });
});
