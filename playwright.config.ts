import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Con más de 2 a la vez el servidor de desarrollo (compilación bajo demanda) supera los 5 s de espera.
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    // Las pruebas corren siempre como entorno de pruebas, sin depender de .env.local.
    // APP_ORIGIN: los enlaces de los correos deben apuntar al servidor de la prueba.
    env: { NEXT_PUBLIC_APP_ENV: "test", APP_ORIGIN: `http://localhost:${PORT}` },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
