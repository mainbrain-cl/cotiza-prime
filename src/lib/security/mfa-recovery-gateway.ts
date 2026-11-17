import "server-only";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin-client";

/**
 * El PORTERO de los códigos de respaldo del segundo paso (H-004b, migración 20261116100000): el ÚNICO archivo de la aplicación
 * que llama a las siete funciones `mfa_recovery_*` de la base, con la llave maestra (una guardia estática lo vigila: la 14 de
 * `static-guards.test.ts`). Cada respuesta se valida con un esquema: si la base devolviera otra forma, se lanza un error de
 * forma y el llamador trata la operación como fallida (nunca se «adivina»).
 *
 * Reglas:
 * - Solo recibe HUELLAS de códigos (`recoveryCodeHash`), nunca un código. Ninguna función devuelve un código ni una huella.
 * - La cuenta siempre la entrega el servidor (de la sesión); ninguna función de la base mira la sesión.
 * - Los errores traen solo un código (el de Postgres), nunca datos de la cuenta, y no se reintenta nada: `claim` no es
 *   repetible (si la primera llamada llegó y la respuesta se perdió, la segunda diría `invalid`), y las demás las repite
 *   quien llama si le conviene.
 * - El correo que devuelve `complete` es el de `auth.users`, leído por la base: sirve para el aviso y nunca viene de una
 *   petición.
 */

export class MfaRecoveryGatewayError extends Error {
  readonly code: string;
  constructor(operation: string, code?: string | null) {
    super(`mfa_recovery_gateway_${operation}${code ? `:${code}` : ""}`);
    this.name = "MfaRecoveryGatewayError";
    this.code = code ?? "unknown";
  }
}

const replacedSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("no_factor") }),
  z.object({ result: z.literal("busy") }),
  z.object({ result: z.literal("ok"), set_id: z.uuid(), total: z.number().int().min(1) }),
]);

export type ReplaceRecoveryCodesResult =
  /** El juego nuevo quedó guardado; `setId` identifica la generación (sirve para «Los guardé»). */
  | { result: "ok"; setId: string; total: number }
  /** El factor no es un TOTP verificado de esa cuenta: no hay a qué respaldar. */
  | { result: "no_factor" }
  /** Hay un código tomado en este momento (un uso en curso): no se reemplaza ahora. */
  | { result: "busy" };

/**
 * Reemplaza el juego de códigos de la cuenta por las 10 huellas dadas, atado al factor TOTP verificado `factorId`. Lanza si
 * las huellas no son 10 distintas con la forma correcta (error `CP422` de la base) o si la respuesta no calza.
 */
export async function replaceRecoveryCodes(
  userId: string,
  factorId: string,
  codeHashes: readonly string[],
): Promise<ReplaceRecoveryCodesResult> {
  const { data, error } = await createAdminClient().rpc("mfa_recovery_codes_replace", {
    p_user_id: userId,
    p_factor_id: factorId,
    p_code_hashes: [...codeHashes],
  });
  if (error) throw new MfaRecoveryGatewayError("replace", error.code);
  const parsed = replacedSchema.safeParse(data);
  if (!parsed.success) throw new MfaRecoveryGatewayError("replace", "shape");
  return parsed.data.result === "ok"
    ? { result: "ok", setId: parsed.data.set_id, total: parsed.data.total }
    : { result: parsed.data.result };
}

const claimedSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("invalid") }),
  z.object({ result: z.literal("ok"), code_id: z.uuid(), factor_id: z.uuid() }),
]);

/**
 * TOMA un código por 2 minutos (por su huella). `null` si no sirve, y la base no distingue por qué: no existe, es de otra
 * cuenta, ya se usó, está tomado o su factor ya no es un TOTP verificado. Esta función tampoco lo distingue.
 */
export async function claimRecoveryCode(
  userId: string,
  codeHash: string,
): Promise<{ codeId: string; factorId: string } | null> {
  const { data, error } = await createAdminClient().rpc("mfa_recovery_code_claim", {
    p_user_id: userId,
    p_code_hash: codeHash,
  });
  if (error) throw new MfaRecoveryGatewayError("claim", error.code);
  const parsed = claimedSchema.safeParse(data);
  if (!parsed.success) throw new MfaRecoveryGatewayError("claim", "shape");
  return parsed.data.result === "ok"
    ? { codeId: parsed.data.code_id, factorId: parsed.data.factor_id }
    : null;
}

const completedSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("invalid") }),
  z.object({ result: z.literal("ok"), email: z.string().min(3).max(254).nullable() }),
]);

/**
 * El código tomado se usó: la base lo marca usado y borra los demás de la cuenta. Devuelve el correo de la cuenta (de
 * `auth.users`), o `null` en `email` si la cuenta no tiene. Devuelve `null` si el código ya no estaba tomado con su plazo de
 * 2 minutos vigente (pasó el plazo, o se soltó): el llamador no debe darlo por usado.
 */
export async function completeRecoveryCode(
  codeId: string,
): Promise<{ email: string | null } | null> {
  const { data, error } = await createAdminClient().rpc("mfa_recovery_code_complete", {
    p_code_id: codeId,
  });
  if (error) throw new MfaRecoveryGatewayError("complete", error.code);
  const parsed = completedSchema.safeParse(data);
  if (!parsed.success) throw new MfaRecoveryGatewayError("complete", "shape");
  return parsed.data.result === "ok" ? { email: parsed.data.email } : null;
}

/** Suelta el código tomado (algo falló): se puede volver a usar sin esperar los 2 minutos. `false` si ya estaba usado o no existe. */
export async function releaseRecoveryCode(codeId: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("mfa_recovery_code_release", {
    p_code_id: codeId,
  });
  if (error) throw new MfaRecoveryGatewayError("release", error.code);
  if (typeof data !== "boolean") throw new MfaRecoveryGatewayError("release", "shape");
  return data;
}

/** «Los guardé»: marca el juego vigente. `false` con un juego viejo, ajeno o sin factor verificado. Repetirlo da `true`. */
export async function acknowledgeRecoveryCodes(userId: string, setId: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("mfa_recovery_codes_acknowledge", {
    p_user_id: userId,
    p_set_id: setId,
  });
  if (error) throw new MfaRecoveryGatewayError("acknowledge", error.code);
  if (typeof data !== "boolean") throw new MfaRecoveryGatewayError("acknowledge", "shape");
  return data;
}

const statusSchema = z.union([
  z.object({ total: z.literal(0) }),
  z.object({
    total: z.number().int().min(1),
    acknowledged: z.boolean(),
    set_id: z.uuid(),
    created_at: z.string().min(1),
  }),
]);

export type RecoveryCodesStatus =
  { total: 0 } | { total: number; acknowledged: boolean; setId: string; createdAt: string };

/** El juego vigente de la cuenta: cuántos códigos sin usar quedan, si la persona confirmó que los guardó y cuándo se crearon. */
export async function getRecoveryCodesStatus(userId: string): Promise<RecoveryCodesStatus> {
  const { data, error } = await createAdminClient().rpc("mfa_recovery_codes_status", {
    p_user_id: userId,
  });
  if (error) throw new MfaRecoveryGatewayError("status", error.code);
  const parsed = statusSchema.safeParse(data);
  if (!parsed.success) throw new MfaRecoveryGatewayError("status", "shape");
  const status = parsed.data;
  if (!("set_id" in status)) return { total: 0 };
  return {
    total: status.total,
    acknowledged: status.acknowledged,
    setId: status.set_id,
    createdAt: status.created_at,
  };
}

/** Borra todos los códigos de la cuenta y devuelve cuántos había. Repetirlo da 0. */
export async function revokeRecoveryCodes(userId: string): Promise<number> {
  const { data, error } = await createAdminClient().rpc("mfa_recovery_codes_revoke", {
    p_user_id: userId,
  });
  if (error) throw new MfaRecoveryGatewayError("revoke", error.code);
  if (typeof data !== "number" || !Number.isInteger(data) || data < 0) {
    throw new MfaRecoveryGatewayError("revoke", "shape");
  }
  return data;
}
