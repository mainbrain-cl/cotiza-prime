import "server-only";
import { randomUUID } from "node:crypto";
import { decryptPii, encryptPii } from "@/lib/crypto/pii";
import { searchHash } from "@/lib/crypto/search-hash";
import { normalizeEmail } from "@/lib/normalize/email";
import { hashInvitationToken, invitationEmailBinding, newInvitationToken } from "./invitation-code";

/**
 * Armado y lectura de lo que se guarda de una invitación (H-008). El correo del invitado es un dato
 * personal: se cifra AQUÍ, en el servidor, con un sello que lo ata a su tabla, su organización y su fila
 * (copiarlo a otra fila hace fallar el descifrado). La base guarda texto cifrado, una huella del correo y el
 * vínculo con el código; nunca el código.
 */

const INVITATIONS_TABLE = "invitations";
const MAIL_TABLE = "email_messages";
const EMAIL_FIELD = "email";
const MAIL_FIELD = "to_email";
/** Campo con el que se calcula la huella del correo: el mismo que usan los clientes. */
const HASH_FIELD = "email";

/** Los argumentos de `create_invitation` (el código en claro va aparte, solo para el correo). */
export type NewInvitation = {
  invitationId: string;
  emailMessageId: string;
  /** Código del enlace en claro: SOLO para armar el correo. Nunca se guarda ni se registra. */
  token: string;
  email: string;
  params: {
    p_invitation_id: string;
    p_email_enc: string;
    p_email_hash: string;
    p_email_binding: string;
    p_token_sha256: string;
    p_role: string;
    p_email_message_id: string;
    p_to_email_enc: string;
  };
};

export function buildNewInvitation(
  tenantId: string,
  rawEmail: string,
  role: string,
): NewInvitation {
  const email = normalizeEmail(rawEmail);
  const invitationId = randomUUID();
  const emailMessageId = randomUUID();
  const token = newInvitationToken();
  const tokenSha256 = hashInvitationToken(token);
  return {
    invitationId,
    emailMessageId,
    token,
    email,
    params: {
      p_invitation_id: invitationId,
      p_email_enc: encryptPii(email, {
        table: INVITATIONS_TABLE,
        field: EMAIL_FIELD,
        tenantId,
        rowId: invitationId,
      }),
      p_email_hash: searchHash(HASH_FIELD, tenantId, email),
      p_email_binding: invitationEmailBinding(tokenSha256, email),
      p_token_sha256: tokenSha256,
      p_role: role,
      p_email_message_id: emailMessageId,
      p_to_email_enc: encryptPii(email, {
        table: MAIL_TABLE,
        field: MAIL_FIELD,
        tenantId,
        rowId: emailMessageId,
      }),
    },
  };
}

/** Los argumentos de `resend_invitation`: un código nuevo para el mismo correo. */
export type Resend = {
  emailMessageId: string;
  token: string;
  params: {
    p_invitation_id: string;
    p_email_binding: string;
    p_token_sha256: string;
    p_email_message_id: string;
    p_to_email_enc: string;
  };
};

export function buildResend(tenantId: string, invitationId: string, email: string): Resend {
  const emailMessageId = randomUUID();
  const token = newInvitationToken();
  const tokenSha256 = hashInvitationToken(token);
  return {
    emailMessageId,
    token,
    params: {
      p_invitation_id: invitationId,
      p_email_binding: invitationEmailBinding(tokenSha256, email),
      p_token_sha256: tokenSha256,
      p_email_message_id: emailMessageId,
      p_to_email_enc: encryptPii(normalizeEmail(email), {
        table: MAIL_TABLE,
        field: MAIL_FIELD,
        tenantId,
        rowId: emailMessageId,
      }),
    },
  };
}

/** Descifra el correo de una invitación. Devuelve `null` si no se puede (nunca lanza ni revela el motivo). */
export function readInvitationEmail(
  tenantId: string,
  invitationId: string,
  emailEnc: string | null,
): string | null {
  if (!emailEnc) return null;
  try {
    return decryptPii(emailEnc, {
      table: INVITATIONS_TABLE,
      field: EMAIL_FIELD,
      tenantId,
      rowId: invitationId,
    });
  } catch {
    return null;
  }
}
