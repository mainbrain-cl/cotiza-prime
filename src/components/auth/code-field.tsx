"use client";

import { useEffect, useRef } from "react";
import { Field, Input } from "@/components/ui/form-controls";

/**
 * Campo del código de 6 números de la aplicación de verificación (H-004a). Lo usan la pantalla del código y la de
 * activar: teclado numérico, relleno automático del código del teléfono, sin corrector, en Geist Mono y a 16 px o más
 * (el iPhone hace zoom si es menor). Sin `maxLength` corto: pegar «123 456» tiene que funcionar. Tras un error el campo
 * queda vacío y el foco vuelve a él.
 */
export function CodeField({
  error,
  focusSignal,
  autoFocus = false,
}: {
  error?: string;
  /** Cambia cada vez que hay un resultado nuevo (por ejemplo, un error): el foco vuelve al campo. */
  focusSignal?: unknown;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSignal !== undefined && focusSignal !== null) inputRef.current?.focus();
  }, [focusSignal]);

  return (
    <Field
      label="Código de 6 dígitos"
      hint="Son 6 números; cambian cada 30 segundos."
      error={error}
      required
    >
      {(control) => (
        <Input
          {...control}
          ref={inputRef}
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          enterKeyHint="done"
          autoFocus={autoFocus}
          spellCheck={false}
          autoCapitalize="off"
          className="font-mono tracking-widest"
          required
        />
      )}
    </Field>
  );
}
