/** Estado que devuelven las acciones de formulario a las pantallas. */
export type FormState = {
  status: "idle" | "error" | "sent" | "saved";
  /** Mensaje general, arriba del formulario. */
  message?: string;
  /** Mensajes por campo, con el nombre del campo del formulario como llave. */
  fieldErrors?: Record<string, string>;
  /** Lo que la persona escribió, para no hacerla escribir de nuevo tras un error (nunca la contraseña). */
  values?: Record<string, string>;
};

export const INITIAL_FORM_STATE: FormState = { status: "idle" };
