// Entorno común de las pruebas que usan cifrado (Vitest de aislamiento y Playwright).
// Si faltan las claves de cifrado, se generan al azar para ESTA ejecución: son claves de pruebas,
// nunca las de otro entorno. Las lee la aplicación al correr en el mismo proceso o ser lanzada por él.
import { randomBytes } from "node:crypto";
import { loadLocalEnvFile } from "./local-supabase";

const KEY_BYTES = 32;

export function ensureTestCryptoEnv(): void {
  loadLocalEnvFile();
  const randomKey = () => randomBytes(KEY_BYTES).toString("base64");
  process.env.CP_PII_KEY_CURRENT ??= "v1";
  process.env.CP_PII_KEY_V1 ??= randomKey();
  process.env.CP_SEARCH_KEY_V1 ??= randomKey();
  // Formulario público (H-087): sello de tiempo (mínimo 32 caracteres) y anti-robot de pruebas.
  process.env.INTAKE_RENDER_SECRET ??= randomKey();
  process.env.ANTIBOT_PROVIDER ??= "memory";
}
