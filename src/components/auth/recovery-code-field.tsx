"use client";

import { useEffect, useRef } from "react";
import { Field, Input } from "@/components/ui/form-controls";

/**
 * Campo del código de respaldo del segundo paso (H-004b): 12 letras y números, que se pueden escribir con o sin guiones y en
 * minúsculas. A 16 px o más (el iPhone hace zoom si es menor), en Geist Mono, sin corrector ni relleno automático y con
 * mayúsculas en el teclado del teléfono. Sin `maxLength` corto: pegar «7KQM-3XHP-W2RT» tiene que funcionar. Tras un error el
 * campo queda vacío y el foco vuelve a él.
 */
export function RecoveryCodeField({
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
      label="Código de respaldo"
      hint="Son 12 letras y números, por ejemplo ABCD-1234-EFGH. Cada código sirve una sola vez."
      error={error}
      required
    >
      {(control) => (
        <Input
          {...control}
          ref={inputRef}
          name="recoveryCode"
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
