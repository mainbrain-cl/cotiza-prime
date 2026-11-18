"use client";

import { ErrorScreen } from "@/components/ui/error-screen";

/**
 * Error inesperado fuera de la organización (ingreso, registro, cuenta…). El formulario público, el enlace
 * del cliente y las invitaciones tienen su propio `error.tsx`. Sin este archivo, un fallo mostraba la
 * pantalla de error genérica de Next, en inglés.
 */
export default function RootError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="flex flex-1 items-center justify-center">
      <ErrorScreen error={error} retry={retry} />
    </main>
  );
}
