"use client";

import { ErrorScreen } from "@/components/ui/error-screen";

/** Error inesperado en una pantalla de la organización: nunca muestra el detalle técnico. */
export default function TenantError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <ErrorScreen error={error} retry={retry} />;
}
