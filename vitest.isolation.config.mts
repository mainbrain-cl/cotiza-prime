import path from "node:path";
import { defineConfig } from "vitest/config";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

// Prueba de aislamiento entre organizaciones (H-012): ataca con pases reales, vía HTTP, la Supabase
// local. Necesita Docker, `supabase start` y `supabase db reset`. Corre con `npm run test:isolation`.
// Aparte de `test:db` porque monta una fixture (cuentas y datos ficticios) una vez por ejecución.

// Claves de cifrado de PRUEBAS: de .env.local si existe y, si faltan, al azar para esta ejecución
// (mismo criterio que tests/support/test-env.ts, que usa Playwright).
const envFile = path.resolve(import.meta.dirname, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const randomKey = () => randomBytes(32).toString("base64");
process.env.CP_PII_KEY_CURRENT ??= "v1";
process.env.CP_PII_KEY_V1 ??= randomKey();
process.env.CP_SEARCH_KEY_V1 ??= randomKey();

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // "server-only" lanza error fuera de Next.js; en pruebas se reemplaza por un módulo vacío.
      "server-only": path.resolve(import.meta.dirname, "src/test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/isolation/**/*.test.ts"],
    globalSetup: ["tests/isolation/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Los archivos comparten la base local y la fixture: uno a la vez.
    fileParallelism: false,
    env: {
      CP_PII_KEY_CURRENT: process.env.CP_PII_KEY_CURRENT ?? "",
      CP_PII_KEY_V1: process.env.CP_PII_KEY_V1 ?? "",
      CP_SEARCH_KEY_V1: process.env.CP_SEARCH_KEY_V1 ?? "",
    },
  },
});
