/**
 * Único lugar donde se lee el entorno de la aplicación.
 *
 * Falla seguro: solo `production` (escrito exactamente así) cuenta como producción. Si la variable
 * falta o trae cualquier otro valor, se asume pruebas y se muestra la franja.
 */
export type AppEnv = "test" | "production";

export const PRODUCTION_ENV: AppEnv = "production";
export const TEST_ENV: AppEnv = "test";

export function resolveAppEnv(rawValue: string | undefined): AppEnv {
  return rawValue === PRODUCTION_ENV ? PRODUCTION_ENV : TEST_ENV;
}

export function isTestEnv(env: AppEnv): boolean {
  return env !== PRODUCTION_ENV;
}

/** La referencia directa a `process.env.NEXT_PUBLIC_APP_ENV` permite que Next la inserte al compilar. */
export const APP_ENV: AppEnv = resolveAppEnv(process.env.NEXT_PUBLIC_APP_ENV);
