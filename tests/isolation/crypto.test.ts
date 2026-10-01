// H-012 · Cifrado y huellas con la base real (ataques A17 y A18).
// Un mismo RUT en dos organizaciones deja huellas distintas, y un dato cifrado de una organización
// no se abre desde otra ni copiado a otra fila.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptPii, PiiCryptoError } from "@/lib/crypto/pii";
import { searchHash } from "@/lib/crypto/search-hash";
import { rest } from "../support/local-supabase";
import { fixture, openDb, tenantHeader, tokenOf } from "./context";
import { SHARED_CUSTOMER_RUT } from "./fixture";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

interface StoredCustomer {
  id: string;
  tenant_id: string;
  rut_enc: string;
  rut_hash: string;
  email_enc: string;
  email_hash: string;
}

const COLUMNS = "id,tenant_id,rut_enc,rut_hash,email_enc,email_hash";

async function sharedCustomerOf(
  persona: "ana" | "beto",
  orgKey: "A" | "B",
): Promise<StoredCustomer> {
  const fx = fixture();
  const res = await rest(
    await tokenOf(persona),
    `customers?select=${COLUMNS}&id=eq.${fx.orgs[orgKey].customerIds[0]}`,
    {
      headers: tenantHeader(fx.orgs[orgKey].tenantId),
    },
  );
  const rows = res.json as StoredCustomer[];
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("A17 · la huella de búsqueda es distinta en cada organización", () => {
  it("el mismo RUT y el mismo correo en A y en B dan huellas distintas, leídas de la base real", async () => {
    const fx = fixture();
    const a = await sharedCustomerOf("ana", "A");
    const b = await sharedCustomerOf("beto", "B");
    expect(a.rut_hash).not.toBe(b.rut_hash);
    expect(a.email_hash).not.toBe(b.email_hash);
    expect(a.rut_enc).not.toBe(b.rut_enc);
    // y son exactamente las que calcula la aplicación para cada organización
    expect(a.rut_hash).toBe(searchHash("rut", fx.orgs.A.tenantId, SHARED_CUSTOMER_RUT));
    expect(b.rut_hash).toBe(searchHash("rut", fx.orgs.B.tenantId, SHARED_CUSTOMER_RUT));
  });

  it("buscar por la huella del RUT de A, estando en B, no encuentra nada (y con la de B, tampoco en A)", async () => {
    const fx = fixture();
    const hashA = searchHash("rut", fx.orgs.A.tenantId, SHARED_CUSTOMER_RUT);
    const hashB = searchHash("rut", fx.orgs.B.tenantId, SHARED_CUSTOMER_RUT);
    // Beto, en B, con la huella de A
    const asBeto = await rest(await tokenOf("beto"), `customers?select=id&rut_hash=eq.${hashA}`, {
      headers: tenantHeader(fx.orgs.B.tenantId),
    });
    expect(asBeto.json).toEqual([]);
    // Ana, en A, con la huella de B (la que sí existe en B)
    const asAna = await rest(await tokenOf("ana"), `customers?select=id&rut_hash=eq.${hashB}`, {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect(asAna.json).toEqual([]);
    // control positivo: cada una encuentra la suya
    const own = await rest(await tokenOf("ana"), `customers?select=id&rut_hash=eq.${hashA}`, {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect((own.json as unknown[]).length).toBe(1);
  });

  it("en la base el RUT y el correo están cifrados: no hay texto en claro", async () => {
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from public.customers
       where rut_enc like '%${SHARED_CUSTOMER_RUT}%' or email_enc like '%ejemplo.test%'`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe("A18 · el dato cifrado de una organización no se abre desde otra", () => {
  it("con el contexto correcto se descifra; con el de otra organización o de otra fila, falla", async () => {
    const fx = fixture();
    const b = await sharedCustomerOf("beto", "B");
    const ctx = { table: "customers", field: "rut", tenantId: fx.orgs.B.tenantId, rowId: b.id };
    expect(decryptPii(b.rut_enc, ctx)).toBe(SHARED_CUSTOMER_RUT); // control positivo
    expect(() => decryptPii(b.rut_enc, { ...ctx, tenantId: fx.orgs.A.tenantId })).toThrow(
      PiiCryptoError,
    );
    expect(() => decryptPii(b.rut_enc, { ...ctx, rowId: fx.orgs.A.customerIds[0] })).toThrow(
      PiiCryptoError,
    );
    expect(() => decryptPii(b.rut_enc, { ...ctx, field: "email" })).toThrow(PiiCryptoError);
  });

  it("copiar el cifrado de un cliente de B a uno de A tampoco permite leerlo desde A", async () => {
    const fx = fixture();
    const b = await sharedCustomerOf("beto", "B");
    // Un intruso con acceso a la base copia el cifrado de B a una fila de A (aquí lo hace `pg`)
    const target = fx.orgs.A.customerIds[1];
    await db.query(`update public.customers set rut_enc = $1, rut_hash = $2 where id = $3`, [
      b.rut_enc,
      b.rut_hash,
      target,
    ]);
    const res = await rest(await tokenOf("ana"), `customers?select=${COLUMNS}&id=eq.${target}`, {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    const copied = (res.json as StoredCustomer[])[0];
    expect(() =>
      decryptPii(copied.rut_enc, {
        table: "customers",
        field: "rut",
        tenantId: fx.orgs.A.tenantId,
        rowId: target,
      }),
    ).toThrow(PiiCryptoError);
    // se deja como estaba
    await db.query(`update public.customers set rut_enc = null, rut_hash = null where id = $1`, [
      target,
    ]);
  });
});
