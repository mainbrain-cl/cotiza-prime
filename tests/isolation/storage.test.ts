// H-012 · Storage: los logos de B no se leen ni se tocan con el pase de Ana, por ningún camino de la
// API de archivos. Se usa `fetch` directo a /storage/v1 con pases reales (nunca la llave maestra).
// Hallazgo que sostiene el diseño: Storage SÍ entrega a la base las cabeceras del pedido (verificado
// con una política de prueba el 2026-10-01), así que las políticas usan app.current_tenant_id().
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rest, storage, type HttpResult } from "../support/local-supabase";
import { fixture, openDb, tenantHeader, tokenOf } from "./context";
import { FIXTURE_LOGO_PNG, LOGO_BUCKET, type PersonaKey } from "./fixture";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const object = (path: string) => `object/${LOGO_BUCKET}/${path}`;
const PNG_SIZE = FIXTURE_LOGO_PNG.length;

/** Valores de cabecera con los que se intenta: la de A, la de B, ninguna y basura. */
function headerVariants() {
  const fx = fixture();
  return [
    { label: "con la cabecera de A", value: fx.orgs.A.tenantId },
    { label: "con la cabecera de B", value: fx.orgs.B.tenantId },
    { label: "sin cabecera", value: undefined },
    { label: "con cabecera basura", value: "no-es-un-uuid" },
  ];
}

const serves = (res: HttpResult) => res.status === 200;

/** Cantidad de archivos y tamaño total del bucket bajo una carpeta, leídos por la llave de la base. */
async function folderState(tenantId: string): Promise<{ count: number; names: string[] }> {
  const { rows } = await db.query<{ name: string }>(
    `select name from storage.objects where bucket_id = $1 and name like $2 order by name`,
    [LOGO_BUCKET, `${tenantId}/%`],
  );
  return { count: rows.length, names: rows.map((r) => r.name) };
}

async function sizeOf(path: string): Promise<number | null> {
  const { rows } = await db.query<{ size: string | null }>(
    `select metadata->>'size' as size from storage.objects where bucket_id = $1 and name = $2`,
    [LOGO_BUCKET, path],
  );
  return rows[0]?.size ? Number(rows[0].size) : null;
}

describe("S0 · el montaje: cada organización tiene su logo, y Ana lo lee con su cabecera", () => {
  it("el logo de A se descarga con el pase de Ana y la cabecera de A (control positivo)", async () => {
    const fx = fixture();
    const res = await storage(
      await tokenOf("ana"),
      "GET",
      `object/authenticated/${LOGO_BUCKET}/${fx.orgs.A.logoPath}`,
      { headers: tenantHeader(fx.orgs.A.tenantId) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect(await folderState(fx.orgs.A.tenantId)).toMatchObject({ count: 1 });
    expect(await folderState(fx.orgs.B.tenantId)).toMatchObject({ count: 1 });
  });

  it("sin la cabecera de A, Ana no puede leer ni su propio logo (la organización activa sale solo de la cabecera verificada)", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const variant of headerVariants().filter((v) => v.value !== fx.orgs.A.tenantId)) {
      const res = await storage(
        token,
        "GET",
        `object/authenticated/${LOGO_BUCKET}/${fx.orgs.A.logoPath}`,
        {
          headers: tenantHeader(variant.value),
        },
      );
      expect(serves(res), variant.label).toBe(false);
    }
  });
});

describe("S1 · listar", () => {
  it("Ana no ve los archivos de B al listar su carpeta, con ninguna cabecera", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const variant of headerVariants()) {
      for (const prefix of [fx.orgs.B.tenantId, `${fx.orgs.B.tenantId}/`, ""]) {
        const res = await storage(token, "POST", `object/list/${LOGO_BUCKET}`, {
          headers: tenantHeader(variant.value),
          body: { prefix, limit: 100, offset: 0 },
        });
        const label = `${variant.label}, prefijo "${prefix}"`;
        expect(res.text, label).not.toContain(fx.orgs.B.tenantId);
        expect(res.text, label).not.toContain("bbbbbbbbbbbb");
      }
    }
  });

  it("con la cabecera de A, Ana lista la carpeta de A (control positivo)", async () => {
    const fx = fixture();
    const res = await storage(await tokenOf("ana"), "POST", `object/list/${LOGO_BUCKET}`, {
      headers: tenantHeader(fx.orgs.A.tenantId),
      body: { prefix: fx.orgs.A.tenantId, limit: 100, offset: 0 },
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain("logo-aaaaaaaaaaaa.png");
  });

  it("buscar por texto tampoco filtra archivos de B", async () => {
    const fx = fixture();
    const res = await storage(await tokenOf("ana"), "POST", `object/list/${LOGO_BUCKET}`, {
      headers: tenantHeader(fx.orgs.A.tenantId),
      body: { prefix: "", search: "bbbbbbbbbbbb", limit: 100, offset: 0 },
    });
    expect(res.text).not.toContain("bbbbbbbbbbbb");
  });

  it("la API v2 de listado tampoco", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const variant of headerVariants()) {
      const res = await storage(token, "POST", `object/list-v2/${LOGO_BUCKET}`, {
        headers: tenantHeader(variant.value),
        body: { prefix: fx.orgs.B.tenantId, limit: 100 },
      });
      expect(res.text, variant.label).not.toContain("bbbbbbbbbbbb");
    }
  });
});

describe("S2 · leer", () => {
  it("el logo de B no se descarga con el pase de Ana, por ninguna dirección de lectura", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const path = fx.orgs.B.logoPath!;
    for (const variant of headerVariants()) {
      for (const url of [
        `object/authenticated/${LOGO_BUCKET}/${path}`,
        `object/${LOGO_BUCKET}/${path}`,
        `object/info/authenticated/${LOGO_BUCKET}/${path}`,
        `object/info/${LOGO_BUCKET}/${path}`,
        `object/public/${LOGO_BUCKET}/${path}`,
        `render/image/authenticated/${LOGO_BUCKET}/${path}`,
      ]) {
        const res = await storage(token, "GET", url, { headers: tenantHeader(variant.value) });
        expect(serves(res), `${variant.label}: ${url}`).toBe(false);
      }
    }
  });

  it("anónimo (solo la llave pública): nada del bucket se lee, ni de A ni de B", async () => {
    const fx = fixture();
    for (const org of [fx.orgs.A, fx.orgs.B]) {
      for (const url of [
        `object/public/${LOGO_BUCKET}/${org.logoPath}`,
        `object/authenticated/${LOGO_BUCKET}/${org.logoPath}`,
        `object/${LOGO_BUCKET}/${org.logoPath}`,
      ]) {
        const res = await storage(null, "GET", url, { headers: tenantHeader(org.tenantId) });
        expect(serves(res), url).toBe(false);
      }
      const list = await storage(null, "POST", `object/list/${LOGO_BUCKET}`, {
        headers: tenantHeader(org.tenantId),
        body: { prefix: org.tenantId, limit: 10, offset: 0 },
      });
      expect(list.text).not.toContain("logo-");
    }
  });

  it("los enlaces con `..` o con la carpeta de B escondida no saltan la política", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const A = fx.orgs.A.tenantId;
    for (const path of [
      `${A}/../${fx.orgs.B.logoPath}`,
      `${A}/%2e%2e/${fx.orgs.B.logoPath}`,
      `${fx.orgs.B.tenantId.toUpperCase()}/logo-bbbbbbbbbbbb.png`,
      `${A}//..//${fx.orgs.B.logoPath}`,
    ]) {
      const res = await storage(token, "GET", `object/authenticated/${LOGO_BUCKET}/${path}`, {
        headers: tenantHeader(A),
      });
      expect(serves(res), path).toBe(false);
    }
  });
});

describe("S3 · enlaces firmados", () => {
  it("Ana no puede pedir un enlace firmado del logo de B, con ninguna cabecera", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const variant of headerVariants()) {
      const res = await storage(token, "POST", `object/sign/${LOGO_BUCKET}/${fx.orgs.B.logoPath}`, {
        headers: tenantHeader(variant.value),
        body: { expiresIn: 3600 },
      });
      expect(res.text, variant.label).not.toContain("signedURL");
      expect(res.text, variant.label).not.toContain("token=");

      const batch = await storage(token, "POST", `object/sign/${LOGO_BUCKET}`, {
        headers: tenantHeader(variant.value),
        body: { expiresIn: 3600, paths: [fx.orgs.B.logoPath] },
      });
      expect(batch.text, `lote ${variant.label}`).not.toMatch(/"signedURL":"[^"]/);
    }
  });

  it("tampoco puede pedir una URL de subida firmada hacia la carpeta de B", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const variant of headerVariants()) {
      const res = await storage(
        token,
        "POST",
        `object/upload/sign/${LOGO_BUCKET}/${fx.orgs.B.tenantId}/logo-dddddddddddd.png`,
        { headers: tenantHeader(variant.value) },
      );
      expect(res.text, variant.label).not.toContain("token=");
    }
    expect((await folderState(fx.orgs.B.tenantId)).count).toBe(1);
  });

  it("con la cabecera de A, el enlace firmado del logo de A sí se emite (control positivo)", async () => {
    const fx = fixture();
    const res = await storage(
      await tokenOf("ana"),
      "POST",
      `object/sign/${LOGO_BUCKET}/${fx.orgs.A.logoPath}`,
      {
        headers: tenantHeader(fx.orgs.A.tenantId),
        body: { expiresIn: 60 },
      },
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("signedURL");
  });
});

describe("S4 · escribir, reemplazar y borrar", () => {
  it("Ana no sube nada a la carpeta de B, con ninguna cabecera, y B queda intacta", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const before = await folderState(fx.orgs.B.tenantId);
    let n = 0;
    for (const variant of headerVariants()) {
      const path = `${fx.orgs.B.tenantId}/logo-${String(++n).padStart(12, "0")}.png`;
      const res = await storage(token, "POST", object(path), {
        headers: tenantHeader(variant.value),
        body: FIXTURE_LOGO_PNG,
        contentType: "image/png",
      });
      expect(res.status, variant.label).toBeGreaterThanOrEqual(400);
    }
    expect(await folderState(fx.orgs.B.tenantId)).toEqual(before);
  });

  it("Ana no reemplaza (upsert ni PUT) el logo de B, y el archivo de B no cambia", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const path = fx.orgs.B.logoPath!;
    const evil = new TextEncoder().encode("contenido de Ana");
    for (const variant of headerVariants()) {
      for (const [method, extra] of [
        ["POST", { "x-upsert": "true" }],
        ["PUT", {}],
      ] as const) {
        const res = await storage(token, method, object(path), {
          headers: { ...tenantHeader(variant.value), ...extra },
          body: evil,
          contentType: "image/png",
        });
        expect(res.status, `${method} ${variant.label}`).toBeGreaterThanOrEqual(400);
      }
    }
    expect(await sizeOf(path)).toBe(PNG_SIZE);
  });

  it("Ana no borra el logo de B, ni uno ni en lote, con ninguna cabecera", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const before = await folderState(fx.orgs.B.tenantId);
    for (const variant of headerVariants()) {
      await storage(token, "DELETE", object(fx.orgs.B.logoPath!), {
        headers: tenantHeader(variant.value),
      });
      await storage(token, "DELETE", `object/${LOGO_BUCKET}`, {
        headers: tenantHeader(variant.value),
        body: { prefixes: [fx.orgs.B.logoPath] },
      });
    }
    expect(await folderState(fx.orgs.B.tenantId)).toEqual(before);
  });

  it("Ana no copia ni mueve archivos de B hacia A, ni de A hacia B", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const A = fx.orgs.A.tenantId;
    const beforeA = await folderState(A);
    const beforeB = await folderState(fx.orgs.B.tenantId);
    for (const variant of headerVariants()) {
      for (const action of ["copy", "move"] as const) {
        await storage(token, "POST", `object/${action}`, {
          headers: tenantHeader(variant.value),
          body: {
            bucketId: LOGO_BUCKET,
            sourceKey: fx.orgs.B.logoPath,
            destinationKey: `${A}/logo-${action === "copy" ? "cccccccccccc" : "eeeeeeeeeeee"}.png`,
          },
        });
        await storage(token, "POST", `object/${action}`, {
          headers: tenantHeader(variant.value),
          body: {
            bucketId: LOGO_BUCKET,
            sourceKey: fx.orgs.A.logoPath,
            destinationKey: `${fx.orgs.B.tenantId}/logo-${action === "copy" ? "cccccccccccc" : "eeeeeeeeeeee"}.png`,
          },
        });
      }
    }
    expect(await folderState(A)).toEqual(beforeA);
    expect(await folderState(fx.orgs.B.tenantId)).toEqual(beforeB);
  });

  it("subir a la carpeta de A con la cabecera de A funciona, y borrarlo también (control positivo)", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const path = `${fx.orgs.A.tenantId}/logo-123456789abc.png`;
    const up = await storage(token, "POST", object(path), {
      headers: tenantHeader(fx.orgs.A.tenantId),
      body: FIXTURE_LOGO_PNG,
      contentType: "image/png",
    });
    expect(up.status).toBe(200);
    expect((await folderState(fx.orgs.A.tenantId)).names).toContain(path);

    // sin la cabecera de A no se borra ni lo propio
    await storage(token, "DELETE", object(path), { headers: tenantHeader(fx.orgs.B.tenantId) });
    expect((await folderState(fx.orgs.A.tenantId)).names).toContain(path);

    await storage(token, "DELETE", object(path), { headers: tenantHeader(fx.orgs.A.tenantId) });
    expect((await folderState(fx.orgs.A.tenantId)).names).not.toContain(path);
  });

  it("el bucket solo acepta PNG, JPG y SVG de hasta 1 MB aunque la política deje pasar", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const A = fx.orgs.A.tenantId;
    const html = await storage(token, "POST", object(`${A}/logo-aaaaaaaaaa01.png`), {
      headers: tenantHeader(A),
      body: new TextEncoder().encode("<html><script>alert(1)</script></html>"),
      contentType: "text/html",
    });
    expect(html.status).toBeGreaterThanOrEqual(400);
    const big = await storage(token, "POST", object(`${A}/logo-aaaaaaaaaa02.png`), {
      headers: tenantHeader(A),
      body: new Uint8Array(1_048_576 + 1),
      contentType: "image/png",
    });
    expect(big.status).toBeGreaterThanOrEqual(400);
    const names = (await folderState(A)).names;
    expect(names).not.toContain(`${A}/logo-aaaaaaaaaa01.png`);
    expect(names).not.toContain(`${A}/logo-aaaaaaaaaa02.png`);
  });
});

describe("S5 · según el rol y entre dos organizaciones", () => {
  it("Dante (Observador de A) lee el logo de A pero no sube ni borra", async () => {
    const fx = fixture();
    const token = await tokenOf("dante");
    const A = fx.orgs.A.tenantId;
    const read = await storage(
      token,
      "GET",
      `object/authenticated/${LOGO_BUCKET}/${fx.orgs.A.logoPath}`,
      {
        headers: tenantHeader(A),
      },
    );
    expect(read.status).toBe(200);

    const up = await storage(token, "POST", object(`${A}/logo-aaaaaaaaaa03.png`), {
      headers: tenantHeader(A),
      body: FIXTURE_LOGO_PNG,
      contentType: "image/png",
    });
    expect(up.status).toBeGreaterThanOrEqual(400);
    await storage(token, "DELETE", object(fx.orgs.A.logoPath!), { headers: tenantHeader(A) });
    expect((await folderState(A)).names).toContain(fx.orgs.A.logoPath);
    expect((await folderState(A)).names).not.toContain(`${A}/logo-aaaaaaaaaa03.png`);
  });

  it("Mixta (Administradora de A y de B) solo accede a la organización de la cabecera", async () => {
    const fx = fixture();
    const token = await tokenOf("mixta");
    const get = (path: string, header: string | undefined) =>
      storage(token, "GET", `object/authenticated/${LOGO_BUCKET}/${path}`, {
        headers: tenantHeader(header),
      });
    expect((await get(fx.orgs.A.logoPath!, fx.orgs.A.tenantId)).status).toBe(200);
    expect((await get(fx.orgs.B.logoPath!, fx.orgs.B.tenantId)).status).toBe(200);
    expect(serves(await get(fx.orgs.B.logoPath!, fx.orgs.A.tenantId))).toBe(false);
    expect(serves(await get(fx.orgs.A.logoPath!, fx.orgs.B.tenantId))).toBe(false);
    expect(serves(await get(fx.orgs.A.logoPath!, undefined))).toBe(false);

    // trabajando en A, no puede escribir en la carpeta de B (y viceversa)
    const before = await folderState(fx.orgs.B.tenantId);
    for (const [target, header] of [
      [fx.orgs.B.tenantId, fx.orgs.A.tenantId],
      [fx.orgs.A.tenantId, fx.orgs.B.tenantId],
    ]) {
      const res = await storage(token, "POST", object(`${target}/logo-aaaaaaaaaa04.png`), {
        headers: tenantHeader(header),
        body: FIXTURE_LOGO_PNG,
        contentType: "image/png",
      });
      expect(res.status, `${target} con ${header}`).toBeGreaterThanOrEqual(400);
    }
    expect(await folderState(fx.orgs.B.tenantId)).toEqual(before);
  });

  it("Beto no ve nada de A (la prueba simétrica)", async () => {
    const fx = fixture();
    const token = await tokenOf("beto");
    for (const variant of headerVariants()) {
      const res = await storage(
        token,
        "GET",
        `object/authenticated/${LOGO_BUCKET}/${fx.orgs.A.logoPath}`,
        {
          headers: tenantHeader(variant.value),
        },
      );
      expect(serves(res), variant.label).toBe(false);
    }
  });
});

describe("S6 · la administración de buckets y de la marca no es de las personas", () => {
  it("Ana no crea, vacía ni borra buckets, y el de logos sigue existiendo", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const create = await storage(token, "POST", "bucket", {
      headers: tenantHeader(fx.orgs.A.tenantId),
      body: { id: `ana-${fx.runId}`, name: `ana-${fx.runId}`, public: true },
    });
    expect(create.status).toBeGreaterThanOrEqual(400);
    for (const [method, url] of [
      ["POST", `bucket/${LOGO_BUCKET}/empty`],
      ["DELETE", `bucket/${LOGO_BUCKET}`],
      ["PUT", `bucket/${LOGO_BUCKET}`],
    ] as const) {
      const res = await storage(token, method, url, {
        headers: tenantHeader(fx.orgs.A.tenantId),
        body: method === "PUT" ? { public: true } : undefined,
      });
      expect(res.status, `${method} ${url}`).toBeGreaterThanOrEqual(400);
    }
    const { rows } = await db.query(
      `select public from storage.buckets where id = $1 or id = $2 order by id`,
      [LOGO_BUCKET, `ana-${fx.runId}`],
    );
    expect(rows).toEqual([{ public: false }]);
    expect((await folderState(fx.orgs.A.tenantId)).count).toBeGreaterThanOrEqual(1);
  });

  it("Ana no puede apuntar el logo de A a un archivo de B, ni cambiar el logo de B", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const toB = await rest(token, `tenants?tenant_id=eq.${fx.orgs.A.tenantId}`, {
      method: "PATCH",
      headers: { ...tenantHeader(fx.orgs.A.tenantId), Prefer: "return=representation" },
      body: { logo_path: fx.orgs.B.logoPath },
    });
    expect(toB.status).toBeGreaterThanOrEqual(400);

    const editB = await rest(token, `tenants?tenant_id=eq.${fx.orgs.B.tenantId}`, {
      method: "PATCH",
      headers: { ...tenantHeader(fx.orgs.A.tenantId), Prefer: "return=representation" },
      body: { logo_path: null, brand_primary_color: "#000000" },
    });
    expect(editB.json).toEqual([]);
    const { rows } = await db.query(
      `select logo_path, brand_primary_color from public.tenants where tenant_id = $1`,
      [fx.orgs.B.tenantId],
    );
    expect(rows[0]).toEqual({ logo_path: fx.orgs.B.logoPath, brand_primary_color: "#2b54e0" });
  });

  it("el Observador de A no puede cambiar la marca de A", async () => {
    const fx = fixture();
    const res = await rest(
      await tokenOf("dante" satisfies PersonaKey),
      `tenants?tenant_id=eq.${fx.orgs.A.tenantId}`,
      {
        method: "PATCH",
        headers: { ...tenantHeader(fx.orgs.A.tenantId), Prefer: "return=representation" },
        body: { brand_primary_color: "#000000" },
      },
    );
    expect(res.json).toEqual([]);
    const { rows } = await db.query(
      `select brand_primary_color from public.tenants where tenant_id = $1`,
      [fx.orgs.A.tenantId],
    );
    expect(rows[0].brand_primary_color).toBe("#2b54e0");
  });
});
