import { formatRut } from "@/lib/chile/rut";

// En la lista los datos personales se muestran enmascarados; el detalle los muestra completos.

const MASK = "•";
const PHONE_VISIBLE_DIGITS = 3;
const RUT_VISIBLE_DIGITS = 3;

export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return MASK.repeat(5);
  return `${email[0]}${MASK.repeat(4)}${email.slice(at)}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= PHONE_VISIBLE_DIGITS) return MASK.repeat(4);
  return `${MASK.repeat(4)} ${digits.slice(-PHONE_VISIBLE_DIGITS)}`;
}

/** `12345678-5` queda `••.•••.678-5`. */
export function maskRut(canonicalRut: string): string {
  const pretty = formatRut(canonicalRut);
  if (!pretty) return MASK.repeat(8);
  const [body, dv] = pretty.split("-");
  const visible = body.replace(/\./g, "").slice(-RUT_VISIBLE_DIGITS);
  return `${MASK.repeat(2)}.${MASK.repeat(3)}.${visible}-${dv}`;
}
