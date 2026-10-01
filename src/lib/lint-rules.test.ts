import { ESLint } from "eslint";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const eslint = new ESLint({ cwd: ROOT });

// Armado por partes para que esta misma prueba no rompa la regla que verifica.
const HEADER_NAME = ["x-cp", "tenant", "id"].join("-");
// Cargar ESLint con la config completa tarda varios segundos con la máquina cargada.
const ESLINT_TEST_TIMEOUT_MS = 60_000;

async function messagesFor(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath: path.resolve(ROOT, filePath) });
  return result.messages;
}

describe(
  "reglas del linter que protegen el aislamiento",
  { timeout: ESLINT_TEST_TIMEOUT_MS },
  () => {
    it("prohíbe escribir la cabecera de la organización fuera de constants.ts", async () => {
      const literal = await messagesFor(`export const h = "${HEADER_NAME}";\n`, "src/lib/otro.ts");
      expect(literal.some((m) => m.ruleId === "no-restricted-syntax")).toBe(true);

      const template = await messagesFor(
        `export const h = \`${HEADER_NAME}\`;\n`,
        "src/lib/otro.ts",
      );
      expect(template.some((m) => m.ruleId === "no-restricted-syntax")).toBe(true);
    });

    it("permite la cabecera en constants.ts", async () => {
      const messages = await messagesFor(
        `export const TENANT_HEADER = "${HEADER_NAME}";\n`,
        "src/lib/tenant/constants.ts",
      );
      expect(messages.some((m) => m.ruleId === "no-restricted-syntax")).toBe(false);
    });

    it("prohíbe importar la llave maestra fuera de los lugares permitidos", async () => {
      const code = `import { createAdminClient } from "@/lib/supabase/admin-client";\nexport const c = createAdminClient;\n`;
      const forbidden = await messagesFor(code, "src/app/pagina.ts");
      expect(forbidden.some((m) => m.ruleId === "no-restricted-imports")).toBe(true);

      const lib = await messagesFor(code, "src/lib/customers/otro.ts");
      expect(lib.some((m) => m.ruleId === "no-restricted-imports")).toBe(true);

      for (const allowed of [
        "src/lib/audit/otro.ts",
        "src/lib/security/otro.ts",
        "src/server/jobs/tarea.ts",
        "scripts/semilla.mjs",
        "tests/db/x.ts",
      ]) {
        const messages = await messagesFor(code, allowed);
        expect(messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(false);
      }
    });
  },
);
