"use client";

import { EnvBanner } from "@/components/env-banner";
import { ErrorScreen } from "@/components/ui/error-screen";
import { geistMono, geistSans } from "./fonts";
import "./globals.css";

/**
 * Último recurso: el error ocurrió en el propio diseño raíz. Reemplaza al diseño raíz, así que trae su
 * propio documento: las mismas tipografías, la franja de entorno y el ancho de pantalla del teléfono.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="es-CL" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <title>Algo salió mal · Cotiza Prime</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <EnvBanner />
        <main className="flex flex-1 items-center justify-center">
          <ErrorScreen error={error} retry={retry} />
        </main>
      </body>
    </html>
  );
}
