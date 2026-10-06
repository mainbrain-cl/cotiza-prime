/**
 * Se ejecuta una vez al arrancar el servidor. En producción comprueba la configuración del correo:
 * si falta algo o se eligió `mailpit` o `memory`, la aplicación no arranca.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { PRODUCTION_ENV, resolveAppEnv } = await import("@/lib/env/app-env");
  if (resolveAppEnv(process.env.NEXT_PUBLIC_APP_ENV) !== PRODUCTION_ENV) return;
  const { getEmailTransport } = await import("@/lib/email/transport");
  getEmailTransport();
}
