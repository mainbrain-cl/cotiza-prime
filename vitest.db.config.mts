import path from "node:path";
import { defineConfig } from "vitest/config";

// Pruebas de la base de datos: necesitan Docker (Supabase local levantado y `supabase db reset`).
// Se corren aparte de `npm test` con `npm run test:db`.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Una sola conexión de pruebas a la vez: los archivos comparten la base local.
    fileParallelism: false,
  },
});
