import { createHash } from "node:crypto";
import { SINGLE_LINE_UNSAFE } from "./unsafe-text";

/**
 * Aviso de privacidad y consentimiento del formulario público (Ley 21.719). El texto está versionado
 * en el repositorio: el navegador solo manda `consent: true` y la revisión; el servidor rearma el
 * texto y guarda la versión y su huella. Cambiar el texto SIN subir la versión rompe una prueba.
 *
 * El texto lo debe revisar el abogado antes del piloto (decisión pendiente, plan del sprint 4 §10).
 */
export const CONSENT_TEMPLATE_VERSION = "v1";

/** Texto de la versión v1, con sus huecos. No se edita: una versión nueva es un texto nuevo. */
export const CONSENT_TEMPLATE_V1 =
  "Tus datos los recibirá {organization} ({contact}) para responder tu solicitud de cotización. " +
  "Se guardan hasta 12 meses si no se concreta. " +
  "Puedes pedir acceso o supresión en {contact}. " +
  "Cotiza Prime los procesa por encargo de {organization}.";

const MAX_NAME_LENGTH = 120;
const MAX_CONTACT_LENGTH = 254;
const MAX_URL_LENGTH = 500;

export class ConsentNoticeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentNoticeError";
  }
}

export type ConsentNoticeInput = {
  organizationName: string;
  /** Correo de contacto de la organización. */
  contactEmail: string;
  /** Política de privacidad propia de la organización (solo https). */
  privacyPolicyUrl?: string | null;
};

export type ConsentNotice = {
  templateVersion: string;
  /** Texto exacto que se muestra junto a la casilla. */
  text: string;
  /** Enlace a la política de la organización, si la tiene. */
  privacyPolicyUrl: string | null;
};

function cleanLine(value: string, label: string, max: number): string {
  const nfc = value.normalize("NFC");
  const clean = nfc.replace(/ +/g, " ").trim();
  if (clean === "" || clean.length > max || SINGLE_LINE_UNSAFE.test(nfc.trim())) {
    throw new ConsentNoticeError(`${label} no es válido para el aviso de privacidad.`);
  }
  return clean;
}

function cleanPolicyUrl(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (trimmed.length > MAX_URL_LENGTH || SINGLE_LINE_UNSAFE.test(trimmed)) {
    throw new ConsentNoticeError("El enlace a la política de privacidad no es válido.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConsentNoticeError("El enlace a la política de privacidad no es válido.");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new ConsentNoticeError("El enlace a la política de privacidad debe ser https.");
  }
  return url.href;
}

export function buildConsentNotice(input: ConsentNoticeInput): ConsentNotice {
  const organization = cleanLine(
    input.organizationName,
    "El nombre de la organización",
    MAX_NAME_LENGTH,
  );
  const contact = cleanLine(input.contactEmail, "El contacto", MAX_CONTACT_LENGTH);
  // Una sola pasada: lo que escribió la organización no se vuelve a interpretar como hueco.
  const text = CONSENT_TEMPLATE_V1.replace(/\{(organization|contact)\}/g, (_hole, name: string) =>
    name === "organization" ? organization : contact,
  );
  return {
    templateVersion: CONSENT_TEMPLATE_VERSION,
    text,
    privacyPolicyUrl: cleanPolicyUrl(input.privacyPolicyUrl),
  };
}

/** Huella (sha256 en hex) de lo que la persona leyó: el texto y, si lo había, el enlace a la política. */
export function consentTextSha256(notice: ConsentNotice): string {
  const material = notice.privacyPolicyUrl
    ? `${notice.text}\n${notice.privacyPolicyUrl}`
    : notice.text;
  return createHash("sha256").update(material, "utf8").digest("hex");
}
