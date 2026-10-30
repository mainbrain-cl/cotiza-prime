import { z } from "zod";
import { normalizeEmail } from "@/lib/normalize/email";
import { isGrantableRole } from "@/lib/permissions/matrix";

export const INVITATION_EMAIL_MAX_LENGTH = 254;

/**
 * Lo que llega del formulario de invitar: un correo (queda normalizado) y un rol de los que se pueden dar.
 * El Dueño no se puede invitar. La base de datos vuelve a exigir lo mismo.
 */
export const inviteSchema = z.object({
  email: z
    .string({ error: "Ingresa el correo de la persona." })
    .trim()
    .min(1, "Ingresa el correo de la persona.")
    .max(INVITATION_EMAIL_MAX_LENGTH, "El correo es demasiado largo.")
    .pipe(z.email({ error: "Revisa el correo: no parece una dirección válida." }))
    .transform(normalizeEmail),
  role: z
    .string({ error: "Elige el rol." })
    .min(1, "Elige el rol.")
    .refine(isGrantableRole, "Elige uno de los roles de la lista."),
});

export type InviteInput = z.infer<typeof inviteSchema>;

/** Un identificador de invitación que llega de la pantalla. */
export const invitationIdSchema = z.uuid();
