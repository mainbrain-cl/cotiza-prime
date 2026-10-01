import { APP_ENV, isTestEnv } from "@/lib/env/app-env";

/**
 * Franja fija arriba que avisa que la aplicación corre contra el entorno de pruebas.
 * En producción no se dibuja nada. Va en el layout raíz, así aparece en todas las pantallas,
 * incluidos el enlace del cliente y el formulario público.
 *
 * Es `sticky` y no `fixed` a propósito: ocupa su propio alto y empuja el contenido, así nunca
 * lo tapa, y se queda arriba mientras se desplaza.
 */
export function EnvBanner() {
  if (!isTestEnv(APP_ENV)) return null;

  return (
    <div
      role="note"
      aria-label="Entorno de pruebas: los datos son ficticios"
      className="sticky top-0 z-50 flex shrink-0 items-center justify-center bg-warning pt-[env(safe-area-inset-top)] text-xs font-semibold tracking-[0.08em] text-on-accent"
    >
      <span className="flex h-(--env-banner-height) items-center">PRUEBAS</span>
    </div>
  );
}
