// Sprint 3 · Ataques de aislamiento del envío y del enlace del cliente (plan §5: 1 a 8).
// Siempre con pases reales y `fetch` directo; la llave maestra solo sirve para montar y verificar.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rest, storage } from "../support/local-supabase";
import { fixture, openDb, tenantHeader, tokenOf } from "./context";
import { decryptPii, PiiCryptoError } from "@/lib/crypto/pii";
import { FIXTURE_PDF, QUOTE_DOCUMENTS_BUCKET } from "./fixture";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const object = (path: string) => `object/${QUOTE_DOCUMENTS_BUCKET}/${path}`;

async function objectState(path: string): Promise<{ exists: boolean; size: number | null }> {
  const { rows } = await db.query<{ size: string | null }>(
    `select metadata->>'size' as size from storage.objects where bucket_id = $1 and name = $2`,
    [QUOTE_DOCUMENTS_BUCKET, path],
  );
  return { exists: rows.length === 1, size: rows[0]?.size ? Number(rows[0].size) : null };
}

describe("Ataque 4 · columnas secretas y aperturas", () => {
  it("nadie con pase lee token_sha256, ip_enc ni user_agent_short, ni con `select=*`", async () => {
    const fx = fixture();
    for (const persona of ["ana", "mixta"] as const) {
      const token = await tokenOf(persona);
      const headers = tenantHeader(fx.orgs.A.tenantId);
      for (const query of [
        "share_links?select=token_sha256",
        "share_links?select=*",
        "share_links?select=id&token_sha256=like.*",
        "share_link_views?select=ip_enc",
        "share_link_views?select=user_agent_short",
        "share_link_views?select=*",
        "quote_responses?select=ip_enc",
        "quote_responses?select=user_agent_short",
        "quote_responses?select=*",
      ]) {
        const res = await rest(token, query, { headers });
        expect(res.status, `${persona} ${query}`).toBeGreaterThanOrEqual(400);
        expect(res.text).not.toContain(fx.orgs.A.share!.tokenSha256);
        expect(res.text).not.toMatch(/"v1.[A-Za-z0-9_-]{16}/); // ningún dato cifrado
      }
    }
  });

  it("un Comercial o Lector no ve las aperturas del enlace; Dueña y Administradora ven que existen", async () => {
    const fx = fixture();
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const view = "share_link_views?select=id,viewed_at";
    for (const persona of ["dante", "ex"] as const) {
      const res = await rest(await tokenOf(persona), view, { headers });
      expect(res.json, persona).toEqual([]);
    }
    for (const persona of ["ana", "mixta"] as const) {
      const res = await rest(await tokenOf(persona), view, { headers });
      expect((res.json as unknown[]).length, persona).toBeGreaterThan(0);
    }
  });
});

describe("Ataque 5 · Storage: documentos congelados", () => {
  it("control positivo: Ana descarga el PDF de A con la cabecera de A", async () => {
    const fx = fixture();
    const res = await storage(
      await tokenOf("ana"),
      "GET",
      `object/authenticated/${QUOTE_DOCUMENTS_BUCKET}/${fx.orgs.A.share!.pdfPath}`,
      { headers: tenantHeader(fx.orgs.A.tenantId) },
    );
    expect(res.status).toBe(200);
  });

  it("Ana no descarga el PDF de B con ninguna cabecera, ni como autenticada ni por la ruta firmada", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const path = fx.orgs.B.share!.pdfPath;
    for (const header of [fx.orgs.B.tenantId, fx.orgs.A.tenantId, undefined]) {
      const res = await storage(
        token,
        "GET",
        `object/authenticated/${QUOTE_DOCUMENTS_BUCKET}/${path}`,
        {
          headers: tenantHeader(header),
        },
      );
      expect(res.status, `cabecera ${header ?? "ninguna"}`).not.toBe(200);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    const info = await storage(
      token,
      "GET",
      `object/info/authenticated/${QUOTE_DOCUMENTS_BUCKET}/${path}`,
      {
        headers: tenantHeader(fx.orgs.B.tenantId),
      },
    );
    expect(info.status).toBeGreaterThanOrEqual(400);
    const sign = await storage(token, "POST", `object/sign/${QUOTE_DOCUMENTS_BUCKET}/${path}`, {
      headers: tenantHeader(fx.orgs.B.tenantId),
      body: { expiresIn: 60 },
    });
    expect(sign.status).toBeGreaterThanOrEqual(400);
    const list = await storage(token, "POST", `object/list/${QUOTE_DOCUMENTS_BUCKET}`, {
      headers: tenantHeader(fx.orgs.A.tenantId),
      body: { prefix: fx.orgs.B.tenantId, limit: 10 },
    });
    expect(list.text).not.toContain(path.split("/").at(-1));
  });

  it("Ana no sube, sobrescribe ni borra el PDF congelado de A (ni cambia el de B)", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const pathA = fx.orgs.A.share!.pdfPath;
    const pathB = fx.orgs.B.share!.pdfPath;
    const beforeA = await objectState(pathA);
    const beforeB = await objectState(pathB);
    expect(beforeA).toEqual({ exists: true, size: FIXTURE_PDF.length });
    const evil = new TextEncoder().encode("%PDF-1.4 PDF-FALSO-DE-ATAQUE");

    const attempts: { label: string; run: () => Promise<{ status: number; json: unknown }> }[] = [
      {
        label: "subir uno nuevo en la carpeta de A",
        run: () =>
          storage(
            token,
            "POST",
            object(`${fx.orgs.A.tenantId}/${randomUUID()}/${randomUUID()}.pdf`),
            {
              headers: tenantHeader(fx.orgs.A.tenantId),
              body: evil,
              contentType: "application/pdf",
            },
          ),
      },
      {
        label: "sobrescribir el de A con x-upsert",
        run: () =>
          storage(token, "POST", object(pathA), {
            headers: { ...tenantHeader(fx.orgs.A.tenantId), "x-upsert": "true" },
            body: evil,
            contentType: "application/pdf",
          }),
      },
      {
        label: "sobrescribir el de A con PUT",
        run: () =>
          storage(token, "PUT", object(pathA), {
            headers: tenantHeader(fx.orgs.A.tenantId),
            body: evil,
            contentType: "application/pdf",
          }),
      },
      {
        label: "borrar el de A",
        run: () =>
          storage(token, "DELETE", object(pathA), { headers: tenantHeader(fx.orgs.A.tenantId) }),
      },
      {
        label: "borrar en lote el de A",
        run: () =>
          storage(token, "DELETE", `object/${QUOTE_DOCUMENTS_BUCKET}`, {
            headers: tenantHeader(fx.orgs.A.tenantId),
            body: { prefixes: [pathA] },
          }),
      },
      {
        label: "mover el de A",
        run: () =>
          storage(token, "POST", "object/move", {
            headers: tenantHeader(fx.orgs.A.tenantId),
            body: {
              bucketId: QUOTE_DOCUMENTS_BUCKET,
              sourceKey: pathA,
              destinationKey: `${fx.orgs.A.tenantId}/${randomUUID()}.pdf`,
            },
          }),
      },
      {
        label: "subir en la carpeta de B",
        run: () =>
          storage(
            token,
            "POST",
            object(`${fx.orgs.B.tenantId}/${randomUUID()}/${randomUUID()}.pdf`),
            {
              headers: tenantHeader(fx.orgs.B.tenantId),
              body: evil,
              contentType: "application/pdf",
            },
          ),
      },
      {
        label: "sobrescribir el de B",
        run: () =>
          storage(token, "POST", object(pathB), {
            headers: { ...tenantHeader(fx.orgs.B.tenantId), "x-upsert": "true" },
            body: evil,
            contentType: "application/pdf",
          }),
      },
    ];
    for (const attempt of attempts) {
      const res = await attempt.run();
      // El borrado en lote responde 200 con una lista vacía cuando la política no deja tocar nada.
      const emptyBatch =
        attempt.label.includes("en lote") && Array.isArray(res.json) && res.json.length === 0;
      expect(res.status >= 400 || emptyBatch, attempt.label).toBe(true);
    }
    expect(await objectState(pathA)).toEqual(beforeA);
    expect(await objectState(pathB)).toEqual(beforeB);
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from storage.objects where bucket_id = $1 and name like $2`,
      [QUOTE_DOCUMENTS_BUCKET, `${fx.orgs.A.tenantId}/%`],
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});

describe("Ataque 7 · un enlace de A no apunta a un paquete de B (relación compuesta)", () => {
  it("aun con la llave maestra de la base, la relación lo impide", async () => {
    const fx = fixture();
    const attempt = async (sql: string, params: unknown[]) => {
      await db.query("begin");
      try {
        await db.query(sql, params);
        return "ok";
      } catch (e) {
        return (e as { code?: string }).code;
      } finally {
        await db.query("rollback");
      }
    };
    expect(
      await attempt(
        `insert into public.share_links (id, tenant_id, quote_id, package_id, email_message_id, token_sha256)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          fx.orgs.A.tenantId,
          fx.orgs.A.share!.quoteId,
          fx.orgs.B.share!.packageId,
          randomUUID(),
          "d".repeat(64),
        ],
      ),
    ).toBe("23503");
    expect(
      await attempt(
        `insert into public.share_link_views (tenant_id, share_link_id) values ($1, $2)`,
        [fx.orgs.A.tenantId, fx.orgs.B.share!.shareLinkId],
      ),
    ).toBe("23503");
    expect(
      await attempt(
        `update public.quotes set current_package_id = $1 where tenant_id = $2 and id = $3`,
        [fx.orgs.B.share!.packageId, fx.orgs.A.tenantId, fx.orgs.A.share!.quoteId],
      ),
    ).toBe("23503");
  });
});

describe("Ataque 6 · lo cifrado del paquete y de la respuesta no se abre desde otra organización", () => {
  it("copiar el cifrado de B a una fila de A no permite leerlo, y con su propio sello sí se abre", async () => {
    const fx = fixture();
    const b = fx.orgs.B.share!;
    const { rows: pkg } = await db.query<{ enc: string }>(
      "select customer_snapshot_enc as enc from public.quote_packages where id = $1",
      [b.packageId],
    );
    const { rows: resp } = await db.query<{ name: string; ip: string }>(
      "select acceptor_name_enc as name, ip_enc as ip from public.quote_responses where id = $1",
      [b.responseId],
    );
    const { rows: mail } = await db.query<{ enc: string }>(
      "select to_email_enc as enc from public.email_messages where id = $1",
      [b.emailMessageId],
    );
    const own = {
      snapshot: {
        table: "quote_packages",
        field: "customer_snapshot",
        tenantId: fx.orgs.B.tenantId,
        rowId: b.packageId,
      },
      name: {
        table: "quote_responses",
        field: "acceptor_name",
        tenantId: fx.orgs.B.tenantId,
        rowId: b.responseId,
      },
      ip: {
        table: "quote_responses",
        field: "ip",
        tenantId: fx.orgs.B.tenantId,
        rowId: b.responseId,
      },
      mail: {
        table: "email_messages",
        field: "to_email",
        tenantId: fx.orgs.B.tenantId,
        rowId: b.emailMessageId,
      },
    };
    // control positivo: con su propio contexto se abre y trae el canario de B
    expect(decryptPii(pkg[0].enc, own.snapshot)).toContain(fx.orgs.B.canary);
    expect(decryptPii(resp[0].name, own.name)).toContain(fx.orgs.B.canary);
    expect(decryptPii(mail[0].enc, own.mail)).toBe("cliente@ejemplo.test");
    // copiado a las filas de A (como lo haría alguien con acceso a la base): falla
    const a = fx.orgs.A.share!;
    const asIfInA = {
      snapshot: { ...own.snapshot, tenantId: fx.orgs.A.tenantId, rowId: a.packageId },
      name: { ...own.name, tenantId: fx.orgs.A.tenantId, rowId: a.responseId },
      ip: { ...own.ip, tenantId: fx.orgs.A.tenantId, rowId: a.responseId },
      mail: { ...own.mail, tenantId: fx.orgs.A.tenantId, rowId: a.emailMessageId },
    };
    expect(() => decryptPii(pkg[0].enc, asIfInA.snapshot)).toThrow(PiiCryptoError);
    expect(() => decryptPii(resp[0].name, asIfInA.name)).toThrow(PiiCryptoError);
    expect(() => decryptPii(resp[0].ip, asIfInA.ip)).toThrow(PiiCryptoError);
    expect(() => decryptPii(mail[0].enc, asIfInA.mail)).toThrow(PiiCryptoError);
    // y entre campos de la misma fila (el sello incluye el campo)
    expect(() => decryptPii(resp[0].name, own.ip)).toThrow(PiiCryptoError);
  });

  it("Ana no lee por la API ninguna de esas filas de B, con la cabecera de A ni con la de B", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const header of [fx.orgs.A.tenantId, fx.orgs.B.tenantId]) {
      for (const [table, columns] of [
        ["quote_packages", "id,customer_snapshot_enc,email_subject"],
        ["email_messages", "id,to_email_enc"],
        ["quote_responses", "id,acceptor_name_enc,reason_text_enc"],
      ]) {
        const res = await rest(
          token,
          `${table}?select=${columns}&tenant_id=eq.${fx.orgs.B.tenantId}`,
          {
            headers: tenantHeader(header),
          },
        );
        expect(res.json, `${table} con la cabecera ${header}`).toEqual([]);
        expect(res.text).not.toContain(fx.orgs.B.canary);
      }
    }
  });
});
