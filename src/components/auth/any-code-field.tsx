"use client";

import { useEffect, useRef } from "react";
import { Field, Input } from "@/components/ui/form-controls";

/**
 * Campo único para el código de la aplicación (6 números) O un código de respaldo (12 letras y números), como el que pide
 * «Desactivar la verificación en dos pasos» (H-004b): el servidor los distingue por su forma. A 16 px o más (el iPhone hace
 * zoom si es menor), en Geist Mono, sin corrector, sin relleno automático y sin `maxLength` corto (pegar «7KQM-3XHP-W2RT» o
 * «123 456» tiene que funcionar). Tras un error el campo queda vacío y el foco vuelve a él.
 */
export function AnyCodeField({
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
      label="Código de tu aplicación o código de respaldo"
      hint="El de 6 números que muestra tu aplicación, o uno de tus 12 letras y números. Cada código de respaldo sirve una sola vez."
      error={error}
      required
    >
      {(control) => (
        <Input
          {...control}
          ref={inputRef}
          name="code"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          enterKeyHint="done"
          autoFocus={autoFocus}
          spellCheck={false}
          className="font-mono tracking-widest uppercase"
          required
        />
      )}
    </Field>
  );
}
