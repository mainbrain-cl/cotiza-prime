// Ayuda para las pruebas de migraciones ANTERIORES a 20261125100000_account_setup (H-116) que comparan una función o una política con
// el texto de SU migración (o que la deshacen y la vuelven a aplicar). Esa migración reemplazó después `app.current_tenant_id()`,
// `app.my_tenant_ids()`, `create_tenant`, `accept_invitation`, `invitation_preview`, `app.handle_new_user` y la política
// `profiles_update`, y su texto vigente ya no es el de las migraciones de antes. Para probar la migración vieja tal como era, estas
// pruebas empiezan cada transacción DESHACIENDO la de H-116 con su propio archivo de deshacer (que además comprueba que el estado
// es el esperado); al terminar, la transacción se revierte entera y la base queda como estaba. Es el mismo orden inverso que sigue
// `npm run test:db:rollbacks`. Ojo: tras deshacerla, las columnas `profiles.account_ready_at` y `signup_email` ya no existen (el
// ayudante `createUser` de `helpers.ts` lo tolera).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { actAsPostgres, withTx } from "./helpers";

export const ACCOUNT_SETUP_DOWN = readFileSync(
  path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "supabase",
    "rollbacks",
    "20261125100000_account_setup.down.sql",
  ),
  "utf8",
);

/** Como `withTx`, pero con la migración 20261125100000 ya deshecha dentro de la transacción. */
export function withTxBeforeAccountSetup<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  return withTx(client, async () => {
    await actAsPostgres(client);
    await client.query(ACCOUNT_SETUP_DOWN);
    return fn();
  });
}

/** Deshace 20261125100000 en la transacción abierta de `client` (para pruebas que manejan `begin`/`rollback` a mano). */
export async function undoAccountSetup(client: Client): Promise<void> {
  await actAsPostgres(client);
  await client.query(ACCOUNT_SETUP_DOWN);
}
