import { z } from "zod";
import { formatRut, isValidRut, normalizeRut } from "@/lib/rut";

/**
 * Los datos de transferencia de la organización (H-050): forma, validación y cómo se muestran. Sin dependencias del servidor.
 * Se guardan cifrados como un solo bloque (`bank_accounts.details_enc`); en claro solo quedan los últimos 4 del número.
 */

export const BANKS = [
  "Banco de Chile",
  "BancoEstado",
  "Banco Santander",
  "Banco BCI",
  "Scotiabank",
  "Banco Itaú",
  "Banco BICE",
  "Banco Security",
  "Banco Falabella",
  "Banco Ripley",
  "Banco Consorcio",
  "Banco Internacional",
  "Coopeuch",
  "Mercado Pago",
  "Tenpo",
] as const;

export const ACCOUNT_TYPES = {
  checking: "Cuenta corriente",
  vista: "Cuenta vista / Cuenta RUT",
  savings: "Cuenta de ahorro",
} as const;
export type AccountType = keyof typeof ACCOUNT_TYPES;

export type BankDetails = {
  bank: string;
  accountType: AccountType;
  accountNumber: string;
  holderName: string;
  holderRut: string;
  email: string;
};

const ACCOUNT_NUMBER = /^[0-9][0-9-]{2,24}[0-9]$/;

export const bankDetailsSchema = z.object({
  bank: z.enum(BANKS, { error: "Elige el banco." }),
  accountType: z.enum(Object.keys(ACCOUNT_TYPES) as [AccountType, ...AccountType[]], {
    error: "Elige el tipo de cuenta.",
  }),
  accountNumber: z
    .string()
    .trim()
    .transform((value) => value.replace(/\s+/g, ""))
    .refine(
      (value) => ACCOUNT_NUMBER.test(value),
      "Escribe el número de cuenta (solo números y guiones).",
    ),
  holderName: z
    .string()
    .trim()
    .min(2, "Escribe el nombre del titular.")
    .max(100, "El nombre del titular es demasiado largo."),
  holderRut: z
    .string()
    .trim()
    .refine((value) => isValidRut(value), "El RUT del titular no es válido.")
    .transform((value) => normalizeRut(value) ?? value),
  email: z.string().trim().toLowerCase().pipe(z.email("Escribe un correo válido.").max(254)),
});

/** Los últimos 4 caracteres del número (sin guiones): lo único que queda en claro, para la auditoría. */
export function accountLast4(accountNumber: string): string {
  return accountNumber.replace(/[^0-9A-Za-z]/g, "").slice(-4);
}

/** El número con todo oculto salvo los últimos 4: `•••• 4321`. */
export function maskedAccount(last4: string): string {
  return `•••• ${last4}`;
}

/** Los datos, en el orden y con los nombres que ve el cliente (correo y enlace). */
export function bankDetailLines(details: BankDetails): { label: string; value: string }[] {
  return [
    { label: "Banco", value: details.bank },
    { label: "Tipo de cuenta", value: ACCOUNT_TYPES[details.accountType] ?? details.accountType },
    { label: "Número de cuenta", value: details.accountNumber },
    { label: "Titular", value: details.holderName },
    { label: "RUT", value: formatRut(details.holderRut) },
    { label: "Correo de confirmación", value: details.email },
  ];
}

/** Lee un bloque descifrado; si no tiene la forma esperada, `null` (nunca se muestra a medias). */
export function parseBankDetails(json: string): BankDetails | null {
  try {
    const parsed = bankDetailsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
