import { defineConfig, devices } from "@playwright/test";
import { appSupabaseEnv } from "./tests/support/local-supabase";
import { ensureTestCryptoEnv } from "./tests/support/test-env";

const PORT = Number(process.env.E2E_PORT ?? 3100);

// Claves de cifrado de PRUEBAS (de .env.local o al azar) y dirección de la Supabase local: la misma
// fixture de aislamiento y el servidor de la prueba tienen que usar las mismas, también en CI.
ensureTestCryptoEnv();

const ISOLATION_FILES = /isolation\.(setup|spec)\.ts$/;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Con más de 2 a la vez el servidor de desarrollo (compilación bajo demanda) supera los 5 s de espera.
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: [
    { name: "chromium", testIgnore: ISOLATION_FILES, use: { ...devices["Desktop Chrome"] } },
    // H-012: arma la fixture de aislamiento e inicia sesión como cada persona.
    {
      name: "isolation-setup",
      testMatch: /isolation\.setup\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    // H-012: ataques de punta a punta desde el navegador. Sin reintentos: una falla es una falla.
    {
      name: "isolation",
      testMatch: /isolation\.spec\.ts$/,
      dependencies: ["isolation-setup"],
      retries: 0,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    // Las pruebas corren siempre como entorno de pruebas, sin depender de .env.local.
    // APP_ORIGIN: los enlaces de los correos deben apuntar al servidor de la prueba.
    env: {
      ...appSupabaseEnv(),
      CP_PII_KEY_CURRENT: process.env.CP_PII_KEY_CURRENT!,
      CP_PII_KEY_V1: process.env.CP_PII_KEY_V1!,
      CP_SEARCH_KEY_V1: process.env.CP_SEARCH_KEY_V1!,
      NEXT_PUBLIC_APP_ENV: "test",
      APP_ORIGIN: `http://localhost:${PORT}`,
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
