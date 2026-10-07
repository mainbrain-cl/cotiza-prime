import "server-only";
import { decryptPii } from "@/lib/crypto/pii";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import type { QuoteResponseView } from "./response-text";

type ResponseRow = {
  id: string;
  decision: "accepted" | "rejected";
  acceptor_name_enc: string | null;
  reason_code: string | null;
  reason_text_enc: string | null;
  responded_at: string;
};

/**
 * La respuesta que el cliente dio a una cotización, para los miembros de la organización (H-031, I-3).
 * La visibilidad la impone la base: `quote_responses` solo se lee dentro de la organización activa
 * (políticas de RLS), igual que el resto de la cotización. El nombre de quien aceptó y el comentario
 * libre del rechazo van cifrados con el sello de su fila: se descifran aquí, en el servidor, y nunca
 * viajan a los registros. Devuelve `null` si el cliente aún no respondió (o si la consulta falló).
 */
export async function getQuoteResponse(
  active: ActiveTenant,
  quoteId: string,
): Promise<QuoteResponseView | null> {
  const { data, error } = await active.supabase
    .from("quote_responses")
    .select("id, decision, acceptor_name_enc, reason_code, reason_text_enc, responded_at")
    .eq("tenant_id", active.tenantId)
    .eq("quote_id", quoteId)
    .maybeSingle();
  if (error) {
    await serverLog("error", "quote_response_read_failed", { code: error.code });
    return null;
  }
  if (!data) return null;
  const row = data as ResponseRow;

  let unreadable = false;
  const open = (value: string | null, field: string): string | null => {
    if (!value) return null;
    try {
      return decryptPii(value, {
        table: "quote_responses",
        field,
        tenantId: active.tenantId,
        rowId: row.id,
      });
    } catch {
      unreadable = true;
      return null;
    }
  };
  const acceptorName = open(row.acceptor_name_enc, "acceptor_name");
  const reasonText = open(row.reason_text_enc, "reason_text");
  if (unreadable) await serverLog("error", "quote_response_decrypt_failed", { field: "response" });
  return {
    decision: row.decision,
    respondedAt: row.responded_at,
    acceptorName,
    reasonCode: row.reason_code,
    reasonText,
    unreadable,
  };
}
