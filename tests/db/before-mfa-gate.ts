// Ayuda para las pruebas de migraciones ANTERIORES a 20261112100000_mfa_session_gate que comparan una función o una política con
// el texto de SU migración (o que la deshacen y la vuelven a aplicar). Esa migración (H-004a) reemplazó después varias
// funciones y políticas (`create_tenant`, `accept_invitation`, `invitation_preview`, `accept_current_legal_documents`,
// `current_tenant_id`, `my_tenant_ids`, `members_select`, `profiles_select`, `profiles_update`, `legal_acceptances_select`) y
// su texto vigente ya no es el de las migraciones de antes. Para probar la migración vieja tal como era, estas pruebas
// empiezan cada transacción DESHACIENDO la de H-004a con su propio archivo de deshacer (que además comprueba que el estado
// es el esperado); al terminar, la transacción se revierte entera y la base queda como estaba. Es el mismo orden inverso que
// sigue `npm run test:db:rollbacks`.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { undoAccountSetup } from "./before-account-setup";
import { actAsPostgres, withTx } from "./helpers";

const MFA_GATE_DOWN = readFileSync(
  path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "supabase",
    "rollbacks",
    "20261112100000_mfa_session_gate.down.sql",
  ),
  "utf8",
);

/**
 * Como `withTx`, pero con la migración 20261112100000 ya deshecha dentro de la transacción. Antes se deshace la de H-116
 * (20261125100000, que reemplazó después varias de las mismas funciones y políticas): es el orden inverso de siempre.
 */
export function withTxBeforeMfaGate<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  return withTx(client, async () => {
    await undoAccountSetup(client);
    await actAsPostgres(client);
    await client.query(MFA_GATE_DOWN);
    return fn();
  });
}

/** Deshace 20261112100000 en la transacción abierta de `client` (para pruebas que manejan `begin`/`rollback` a mano). */
export async function undoMfaGate(client: Client): Promise<void> {
  await undoAccountSetup(client);
  await actAsPostgres(client);
  await client.query(MFA_GATE_DOWN);
}
