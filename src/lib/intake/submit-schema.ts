import { z } from "zod";
import { normalizeEmail } from "@/lib/normalize/email";
import { isValidPhone, normalizePhone } from "@/lib/normalize/phone";
import { parseQuantity } from "@/lib/quotes/parse";
import type { FieldMode, FieldModes, QuantityMode } from "./field-modes";
import { hasLoneSurrogate, MULTI_LINE_UNSAFE, SINGLE_LINE_UNSAFE } from "./unsafe-text";

/** Límites del envío del formulario público (plan del sprint 4, §2 paso 5). */
export const NAME_MIN = 2;
export const NAME_MAX = 120;
export const EMAIL_MAX = 254;
export const PHONE_MAX_LENGTH = 30;
export const SHORT_TEXT_MIN = 2;
export const COMPANY_MAX = 120;
export const COMUNA_MAX = 80;
export const SERVICE_ADDRESS_MAX = 200;
export const MESSAGE_MAX = 2_000;
export const ITEMS_MIN = 1;
export const ITEMS_MAX = 30;
export const QUANTITY_INPUT_MAX = 20;
export const RENDER_TOKEN_INPUT_MAX = 200;
export const ANTIBOT_TOKEN_INPUT_MAX = 2_048;
export const FORM_REVISION_MAX = 2_147_483_647;
export const DESIRED_DATE_MAX_DAYS_AHEAD_YEARS = 1;
/** Entradas más largas que esto ni se miran (la petición ya viene acotada a 16 kB). */
const RAW_TEXT_LIMIT = 10_000;
const CHILE_TIME_ZONE = "America/Santiago";
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MILLI_PER_UNIT = 1_000;

/** Nombre del campo que una persona nunca ve ni llena. */
export const HONEYPOT_FIELD = "website";

export type { FieldMode, QuantityMode };

export type IntakeFormConfig = {
  /** Nombre y correo son siempre obligatorios y no se configuran. */
  fields: FieldModes;
  items: readonly IntakeItemConfig[];
};

export type IntakeItemConfig = {
  id: string;
  quantityMode: QuantityMode;
  minQtyMilli?: number | null;
  maxQtyMilli?: number | null;
};

export type SubmitData = {
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  comuna: string | null;
  serviceAddress: string | null;
  message: string | null;
  /** `YYYY-MM-DD` o `null`. */
  desiredDate: string | null;
  items: { formItemId: string; quantityMilli: number | null }[];
  consent: true;
  submitKey: string;
  requestId: string;
  formRevision: number;
  renderToken: string;
  antibotToken: string;
};

export type BuildSubmitSchemaOptions = {
  /** Hoy en Chile, `YYYY-MM-DD`. Solo para pruebas; por defecto se calcula en cada validación. */
  today?: string;
};

const REQUIRED_MESSAGE = "Este dato es obligatorio.";
const NOT_ASKED_MESSAGE = "Este formulario no pide este dato.";
const UNSAFE_MESSAGE = "Hay caracteres que no se pueden usar. Escribe solo texto normal.";

function blankToNull(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
}

type TextRules = { min: number; max: number; multiline?: boolean };

function textSchema({ min, max, multiline = false }: TextRules): z.ZodType<string, unknown> {
  const unsafe = multiline ? MULTI_LINE_UNSAFE : SINGLE_LINE_UNSAFE;
  return z
    .string({ error: REQUIRED_MESSAGE })
    .max(RAW_TEXT_LIMIT, { error: `Máximo ${max} caracteres.` })
    .transform((raw) => {
      const nfc = raw.normalize("NFC");
      return multiline ? nfc.replace(/\r\n?/g, "\n").trim() : nfc.trim();
    })
    .pipe(
      z
        .string()
        .min(min, { error: min <= 1 ? REQUIRED_MESSAGE : `Escribe al menos ${min} caracteres.` })
        .max(max, { error: `Máximo ${max} caracteres.` })
        .refine((value) => !unsafe.test(value) && !hasLoneSurrogate(value), {
          error: UNSAFE_MESSAGE,
        }),
    );
}

function modeField(mode: FieldMode, inner: z.ZodType<string, unknown>) {
  if (mode === "required") return inner as z.ZodType<string | null, unknown>;
  if (mode === "optional") {
    return z.preprocess(blankToNull, inner.nullable()) as z.ZodType<string | null, unknown>;
  }
  return z.preprocess(blankToNull, z.null({ error: NOT_ASKED_MESSAGE })) as z.ZodType<
    string | null,
    unknown
  >;
}

const emailSchema = z
  .string({ error: REQUIRED_MESSAGE })
  .max(RAW_TEXT_LIMIT, { error: "Escribe un correo válido." })
  .refine((value) => !SINGLE_LINE_UNSAFE.test(value), { error: UNSAFE_MESSAGE })
  .transform(normalizeEmail)
  .pipe(
    z
      .string()
      .min(1, { error: REQUIRED_MESSAGE })
      .max(EMAIL_MAX, { error: "Escribe un correo válido." })
      .pipe(z.email({ error: "Escribe un correo válido, por ejemplo nombre@empresa.cl." })),
  );

const phoneSchema = z
  .string({ error: REQUIRED_MESSAGE })
  .max(RAW_TEXT_LIMIT, { error: "Escribe un teléfono válido." })
  .transform((raw) => normalizePhone(raw))
  .pipe(
    z
      .string()
      .min(1, { error: REQUIRED_MESSAGE })
      .max(PHONE_MAX_LENGTH, { error: "Escribe un teléfono válido." })
      .refine(isValidPhone, {
        error: "Escribe un teléfono válido, por ejemplo +56 9 1234 5678.",
      }),
  );

/** Hoy en Chile como `YYYY-MM-DD`. */
export function chileToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CHILE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts;
}

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Un año después de `today`; el 29 de febrero pasa al 28 de febrero del año siguiente. */
export function addOneYear(today: string): string {
  const match = DATE_PATTERN.exec(today);
  if (!match) throw new Error("Fecha inválida");
  const year = Number(match[1]) + DESIRED_DATE_MAX_DAYS_AHEAD_YEARS;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const safeDay = isRealDate(year, month, day) ? day : 28;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(safeDay, 2)}`;
}

function desiredDateSchema(options: BuildSubmitSchemaOptions): z.ZodType<string, unknown> {
  return z
    .string({ error: REQUIRED_MESSAGE })
    .max(RAW_TEXT_LIMIT, { error: "Escribe una fecha válida." })
    .transform((raw) => raw.trim())
    .pipe(
      z.string().superRefine((value, ctx) => {
        const match = DATE_PATTERN.exec(value);
        if (!match || !isRealDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
          ctx.addIssue({ code: "custom", message: "Elige una fecha válida." });
          return;
        }
        const today = options.today ?? chileToday();
        if (value < today) {
          ctx.addIssue({ code: "custom", message: "La fecha no puede ser anterior a hoy." });
        } else if (value > addOneYear(today)) {
          ctx.addIssue({
            code: "custom",
            message: "La fecha no puede ser más de un año en el futuro.",
          });
        }
      }),
    );
}

/** `2500` -> `"2,5"`. */
function formatMilli(milli: number): string {
  const integer = Math.floor(milli / MILLI_PER_UNIT);
  const fraction = String(milli % MILLI_PER_UNIT)
    .padStart(3, "0")
    .replace(/0+$/, "");
  const grouped = integer.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return fraction ? `${grouped},${fraction}` : grouped;
}

const itemSchema = z.strictObject(
  {
    formItemId: z.uuid({ error: "Este servicio no es válido." }),
    quantity: z
      .string({ error: "Escribe una cantidad válida." })
      .max(QUANTITY_INPUT_MAX, { error: "Escribe una cantidad válida." })
      .nullish(),
  },
  { error: "Este servicio no es válido." },
);

/**
 * Esquema del envío del formulario público, armado desde la configuración del formulario. Quien lo
 * usa recibe solo datos ya normalizados (NFC, recortados, sin caracteres peligrosos) y errores por
 * campo en español de Chile (`fieldErrors`).
 */
export function buildSubmitSchema(
  config: IntakeFormConfig,
  options: BuildSubmitSchemaOptions = {},
): z.ZodType<SubmitData, unknown> {
  const allowed = new Map(config.items.map((item) => [item.id, item]));

  const base = z.strictObject(
    {
      name: textSchema({ min: NAME_MIN, max: NAME_MAX }),
      email: emailSchema,
      phone: modeField(config.fields.phone, phoneSchema),
      company: modeField(
        config.fields.company,
        textSchema({ min: SHORT_TEXT_MIN, max: COMPANY_MAX }),
      ),
      comuna: modeField(config.fields.comuna, textSchema({ min: SHORT_TEXT_MIN, max: COMUNA_MAX })),
      serviceAddress: modeField(
        config.fields.serviceAddress,
        textSchema({ min: SHORT_TEXT_MIN, max: SERVICE_ADDRESS_MAX }),
      ),
      message: modeField(
        config.fields.message,
        textSchema({ min: 1, max: MESSAGE_MAX, multiline: true }),
      ),
      desiredDate: modeField(config.fields.desiredDate, desiredDateSchema(options)),
      items: z
        .array(itemSchema, { error: "Elige al menos un servicio." })
        .min(ITEMS_MIN, { error: "Elige al menos un servicio." })
        .max(ITEMS_MAX, { error: `Puedes pedir hasta ${ITEMS_MAX} servicios.` }),
      consent: z.literal(true, {
        error: "Para enviar tienes que aceptar el aviso de privacidad.",
      }),
      submitKey: z.uuid({ error: "No se pudo identificar el envío. Recarga la página." }),
      requestId: z.uuid({ error: "No se pudo identificar el envío. Recarga la página." }),
      formRevision: z
        .number({ error: "El formulario cambió. Recarga la página." })
        .int({ error: "El formulario cambió. Recarga la página." })
        .min(0, { error: "El formulario cambió. Recarga la página." })
        .max(FORM_REVISION_MAX, { error: "El formulario cambió. Recarga la página." }),
      [HONEYPOT_FIELD]: z.string().max(0, { error: "No se pudo enviar el formulario." }).nullish(),
      renderToken: z
        .string({ error: "Recarga la página para enviar el formulario." })
        .min(1, { error: "Recarga la página para enviar el formulario." })
        .max(RENDER_TOKEN_INPUT_MAX, { error: "Recarga la página para enviar el formulario." }),
      antibotToken: z
        .string({ error: "Confirma que no eres un robot." })
        .min(1, { error: "Confirma que no eres un robot." })
        .max(ANTIBOT_TOKEN_INPUT_MAX, { error: "Confirma que no eres un robot." }),
    },
    { error: "No se pudo leer el formulario." },
  );

  return base.transform((data, ctx): SubmitData => {
    const seen = new Set<string>();
    const items: SubmitData["items"] = [];
    data.items.forEach((item, index) => {
      const issue = (path: (string | number)[], message: string) =>
        ctx.issues.push({ code: "custom", message, input: item, path: ["items", index, ...path] });

      const rule = allowed.get(item.formItemId);
      if (!rule) {
        issue(["formItemId"], "Este servicio ya no está disponible. Recarga la página.");
        return;
      }
      if (seen.has(item.formItemId)) {
        issue(["formItemId"], "Elegiste este servicio más de una vez.");
        return;
      }
      seen.add(item.formItemId);

      const rawQuantity = (item.quantity ?? "").trim();
      let quantityMilli: number | null = null;
      if (rule.quantityMode === "none") {
        if (rawQuantity !== "") issue(["quantity"], "Este servicio no lleva cantidad.");
      } else if (rawQuantity === "") {
        if (rule.quantityMode === "required") issue(["quantity"], "Escribe la cantidad.");
      } else {
        const parsed = parseQuantity(rawQuantity);
        if (!parsed.ok) {
          issue(["quantity"], parsed.message);
        } else if (rule.minQtyMilli != null && parsed.value < rule.minQtyMilli) {
          issue(["quantity"], `La cantidad mínima es ${formatMilli(rule.minQtyMilli)}.`);
        } else if (rule.maxQtyMilli != null && parsed.value > rule.maxQtyMilli) {
          issue(["quantity"], `La cantidad máxima es ${formatMilli(rule.maxQtyMilli)}.`);
        } else {
          quantityMilli = parsed.value;
        }
      }
      items.push({ formItemId: item.formItemId, quantityMilli });
    });

    return {
      name: data.name,
      email: data.email,
      phone: data.phone,
      company: data.company,
      comuna: data.comuna,
      serviceAddress: data.serviceAddress,
      message: data.message,
      desiredDate: data.desiredDate,
      items,
      consent: data.consent,
      submitKey: data.submitKey,
      requestId: data.requestId,
      formRevision: data.formRevision,
      renderToken: data.renderToken,
      antibotToken: data.antibotToken,
    };
  });
}

/** Primer mensaje por campo, con rutas como `items.0.quantity`. Nunca incluye lo que escribió la persona. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".");
    // Una clave desconocida va a la raíz: no se repite el nombre que mandó el cliente.
    if (issue.code === "unrecognized_keys") {
      result.form ??= "No se pudo leer el formulario. Recarga la página.";
      continue;
    }
    result[path || "form"] ??= issue.message;
  }
  return result;
}
