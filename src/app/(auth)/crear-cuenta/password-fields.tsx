"use client";

import { useState } from "react";
import { Field, Input } from "@/components/ui/form-controls";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/schemas";

/**
 * Contraseña y su repetición, con una casilla para verlas mientras se escribe (la contraseña nunca vuelve del servidor: tras
 * un error los campos quedan vacíos). La casilla es nativa, de 44 px, y no se envía con el formulario (sin `name`).
 */
export function PasswordFields({
  passwordError,
  confirmError,
  hint,
}: {
  passwordError?: string;
  confirmError?: string;
  hint: string;
}) {
  const [visible, setVisible] = useState(false);
  const type = visible ? "text" : "password";
  return (
    <>
      <Field label="Contraseña" error={passwordError} hint={hint} required>
        {(control) => (
          <Input
            {...control}
            name="password"
            type={type}
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            required
          />
        )}
      </Field>
      <Field label="Repite la contraseña" error={confirmError} required>
        {(control) => (
          <Input
            {...control}
            name="confirmPassword"
            type={type}
            autoComplete="new-password"
            required
          />
        )}
      </Field>
      <label className="flex min-h-11 items-center gap-3 text-sm text-fg-muted">
        <input
          type="checkbox"
          checked={visible}
          onChange={(event) => setVisible(event.target.checked)}
          // Sin formulario dueño (el id no existe): al terminar una acción, React vacía los campos del formulario y también
          // desmarcaría esta casilla, y las contraseñas se quedarían a la vista con la casilla sin marcar.
          form="sin-formulario"
          data-testid="show-passwords"
          className="size-5 shrink-0 accent-accent"
        />
        Mostrar las contraseñas
      </label>
    </>
  );
}
