// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · H-048a · Aislamiento de los textos guardados: ataques con pases reales y `fetch` directo.
//  1. Ana (A) apunta a B con su pase —cabecera de B, sin cabecera, mal escrita— para crear, cambiar o borrar: «No encontrado».
//  2. Beto (Dueño de B) hace lo mismo hacia A. Mixta (Administradora de A y de B), parada en A, no toca los de B.
//  3. Ex (quien ya no es miembro, o es Comercial) y Dante (Observador) no pueden escribir en A.
//  4. Nadie con un pase escribe directo en la tabla, ni siquiera en los textos de su propia organización.
//  5. Lectura: cada miembro ve los de su organización y ninguno de B; el texto canario de B no aparece en ninguna respuesta.
//  6. Reutilizar el identificador de un texto de B no sirve para nada y no filtra su contenido.
//  7. La auditoría de lo que hace A queda con el tenant_id de A y sin el texto.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rest, rpc } from "../support/local-supabase";
import { countWhere, fingerprint, fixture, openDb, tenantHeader, tokenOf } from "./context";
import { ISOLATION_TABLES } from "./registry";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const codeOf = (res: { json: unknown }) => (res.json as { code?: string } | null)?.code;
const messageOf = (res: { json: unknown }) => (res.json as { message?: string } | null)?.message;
const spec = (name: string) => ISOLATION_TABLES.find((t) => t.name === name)!;

const createArgs = (over: Record<string, unknown> = {}) => ({
  p_snippet_id: randomUUID(),
  p_kind: "conditions",
  p_name: "Texto de ataque",
  p_body: "Texto de ataque.",
  p_is_default: false,
  ...over,
});
const updateArgs = (id: string, over: Record<string, unknown> = {}) => ({
  p_snippet_id: id,
  p_expected_revision: 1,
  p_name: "Texto pisado",
  p_body: "Texto pisado.",
  p_is_default: false,
  ...over,
});

/** Las tablas que un ataque a un texto podría tocar. */
const WATCHED = ["text_snippets", "audit_log"] as const;
async function snapshot() {
  const out = new Map<string, string>();
  for (const name of WATCHED) out.set(name, await fingerprint(db, spec(name)));
  return out;
}
async function expectUntouched(before: Map<string, string>) {
  for (const name of WATCHED) {
    expect(await fingerprint(db, spec(name)), `${name} cambió`).toBe(before.get(name));
  }
}

describe("Ataque 1 · Ana, con su pase, apunta a B", () => {
  it("con la cabecera de B, sin cabecera o mal escrita: crear, cambiar y borrar dan «No encontrado» y B queda intacta", async () => {
    const fx = fixture();
    const b = fx.orgs.B.snippets!;
    const token = await tokenOf("ana");
    const before = await snapshot();
    const headers = [
      fx.orgs.B.tenantId,
      fx.orgs.B.tenantId.toUpperCase(),
      fx.orgs.B.tenantId.replaceAll("-", ""),
      `{${fx.orgs.B.tenantId}}`,
      undefined,
      "",
      "null",
    ];
    for (const header of headers) {
      const calls: [string, object][] = [
        ["create_text_snippet", createArgs()],
        ["update_text_snippet", updateArgs(b.emailId)],
        ["update_text_snippet", updateArgs(b.conditionsId)],
        ["delete_text_snippet", { p_snippet_id: b.emailId }],
        ["delete_text_snippet", { p_snippet_id: b.conditionsId }],
      ];
      for (const [name, args] of calls) {
        const res = await rpc(token, name, args, tenantHeader(header));
        const label = `${name} ${header}`;
        expect(res.status, label).toBeGreaterThanOrEqual(400);
        expect(codeOf(res), label).toBe("CP404");
        expect(res.text, label).not.toContain(fx.orgs.B.canary);
        expect(res.text, label).not.toContain(fx.orgs.B.tenantId);
      }
    }
    await expectUntouched(before);
    expect(await countWhere(db, "text_snippets", `id = '${b.emailId}' and revision = 1`)).toBe(1);
  });

  it("con SU organización, cambiar o borrar un texto de B por su identificador: «snippet_not_found», sin pistas de que existe", async () => {
    const fx = fixture();
    const b = fx.orgs.B.snippets!;
    const token = await tokenOf("ana");
    const before = await snapshot();
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const update = await rpc(token, "update_text_snippet", updateArgs(b.emailId), headers);
    const remove = await rpc(token, "delete_text_snippet", { p_snippet_id: b.emailId }, headers);
    const nowhere = await rpc(
      token,
      "delete_text_snippet",
      { p_snippet_id: randomUUID() },
      headers,
    );
    for (const res of [update, remove]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(codeOf(res)).toBe("CP404");
      expect(messageOf(res)).toBe("snippet_not_found");
      expect(res.text).not.toContain(fx.orgs.B.canary);
    }
    // una respuesta idéntica a la de un texto que no existe en ninguna parte
    expect(messageOf(nowhere)).toBe(messageOf(remove));
    expect(codeOf(nowhere)).toBe(codeOf(remove));
    await expectUntouched(before);
  });
});

describe("Ataque 2 · entre organizaciones, en los dos sentidos", () => {
  it("Beto (Dueño de B) no toca los textos de A ni con la cabecera de A ni con la suya", async () => {
    const fx = fixture();
    const a = fx.orgs.A.snippets!;
    const token = await tokenOf("beto");
    const before = await snapshot();
    const withA = tenantHeader(fx.orgs.A.tenantId);
    const withB = tenantHeader(fx.orgs.B.tenantId);
    for (const [name, args] of [
      ["update_text_snippet", updateArgs(a.emailId)],
      ["delete_text_snippet", { p_snippet_id: a.emailId }],
    ] as [string, object][]) {
      const asA = await rpc(token, name, args, withA);
      expect(codeOf(asA), `${name} con A`).toBe("CP404");
      expect(messageOf(asA), `${name} con A`).toBe("not_found");
      const asB = await rpc(token, name, args, withB);
      expect(codeOf(asB), `${name} con B`).toBe("CP404");
      expect(messageOf(asB), `${name} con B`).toBe("snippet_not_found");
      expect(asA.text + asB.text).not.toContain(fx.orgs.A.canary);
    }
    const create = await rpc(token, "create_text_snippet", createArgs(), withA);
    expect(codeOf(create)).toBe("CP404");
    await expectUntouched(before);
  });

  it("Mixta (Administradora de A y de B), parada en A, no puede cambiar ni borrar los textos de B", async () => {
    const fx = fixture();
    const b = fx.orgs.B.snippets!;
    const token = await tokenOf("mixta");
    const before = await snapshot();
    const headers = tenantHeader(fx.orgs.A.tenantId);
    for (const res of [
      await rpc(token, "update_text_snippet", updateArgs(b.emailId), headers),
      await rpc(token, "update_text_snippet", updateArgs(b.conditionsId), headers),
      await rpc(token, "delete_text_snippet", { p_snippet_id: b.emailId }, headers),
      await rpc(token, "delete_text_snippet", { p_snippet_id: b.conditionsId }, headers),
    ]) {
      expect(codeOf(res)).toBe("CP404");
      expect(messageOf(res)).toBe("snippet_not_found");
    }
    await expectUntouched(before);
  });

  it("Mixta puede administrar los textos de A (es Administradora) y el que crea nace en A, no en B", async () => {
    const fx = fixture();
    const token = await tokenOf("mixta");
    const id = randomUUID();
    const created = await rpc(
      token,
      "create_text_snippet",
      createArgs({ p_snippet_id: id }),
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(created.status, created.text).toBe(200);
    expect(created.json).toEqual({ result: "created", id, revision: 1 });
    expect(
      await countWhere(db, "text_snippets", `id = '${id}' and tenant_id = '${fx.orgs.A.tenantId}'`),
    ).toBe(1);
    expect(
      await countWhere(db, "text_snippets", `id = '${id}' and tenant_id = '${fx.orgs.B.tenantId}'`),
    ).toBe(0);
    const removed = await rpc(
      token,
      "delete_text_snippet",
      { p_snippet_id: id },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(removed.json).toEqual({ result: "deleted" });
    expect(await countWhere(db, "text_snippets", `id = '${id}'`)).toBe(0);
  });

  it("Ana puede cambiar los suyos (control positivo): la revisión sube y solo cambia la fila de A", async () => {
    const fx = fixture();
    const a = fx.orgs.A.snippets!;
    const token = await tokenOf("ana");
    const before = await fingerprint(db, spec("text_snippets"));
    const bRows = await countWhere(db, "text_snippets", `tenant_id = '${fx.orgs.B.tenantId}'`);
    const res = await rpc(
      token,
      "update_text_snippet",
      updateArgs(a.conditionsId, { p_name: a.conditionsName, p_body: `${a.conditionsBody} Más.` }),
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ result: "updated", id: a.conditionsId, revision: 2 });
    // se deja como estaba (otra revisión, mismo contenido) para las demás pruebas
    const back = await rpc(
      token,
      "update_text_snippet",
      updateArgs(a.conditionsId, {
        p_expected_revision: 2,
        p_name: a.conditionsName,
        p_body: a.conditionsBody,
      }),
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(back.status, back.text).toBe(200);
    expect(await countWhere(db, "text_snippets", `tenant_id = '${fx.orgs.B.tenantId}'`)).toBe(
      bRows,
    );
    expect(await fingerprint(db, spec("text_snippets"))).toBe(before); // B (lo que mira la huella) no cambió
  });
});

describe("Ataque 3 · quienes no pueden escribir en A", () => {
  it("Dante (Observador) lee los textos de A pero no crea, cambia ni borra", async () => {
    const fx = fixture();
    const a = fx.orgs.A.snippets!;
    const token = await tokenOf("dante");
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const before = await snapshot();
    const read = await rest(token, "text_snippets?select=id,kind,name", { headers });
    expect((read.json as { id: string }[]).map((r) => r.id)).toEqual(
      expect.arrayContaining([a.emailId, a.conditionsId]),
    );
    for (const [name, args] of [
      ["create_text_snippet", createArgs()],
      ["update_text_snippet", updateArgs(a.emailId)],
      ["delete_text_snippet", { p_snippet_id: a.emailId }],
    ] as [string, object][]) {
      const res = await rpc(token, name, args, headers);
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      expect(codeOf(res), name).toBe("42501");
    }
    await expectUntouched(before);
  });

  it("Ex (ya no es miembro, o solo es Comercial) no puede escribir en A", async () => {
    const fx = fixture();
    const a = fx.orgs.A.snippets!;
    const token = await tokenOf("ex");
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const before = await snapshot();
    for (const [name, args] of [
      ["create_text_snippet", createArgs()],
      ["update_text_snippet", updateArgs(a.emailId)],
      ["delete_text_snippet", { p_snippet_id: a.emailId }],
    ] as [string, object][]) {
      const res = await rpc(token, name, args, headers);
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      // Comercial: «sin permiso»; ya quitada de la organización: «no encontrado». Nunca un éxito.
      expect(["42501", "CP404"], name).toContain(codeOf(res));
    }
    await expectUntouched(before);
  });
});

describe("Ataque 4 · escribir directo en la tabla", () => {
  it("nadie con un pase (ni la Dueña, ni la Administradora, ni el Observador) crea, edita ni borra por la API de tablas", async () => {
    const fx = fixture();
    const a = fx.orgs.A.snippets!;
    const before = await snapshot();
    for (const persona of ["ana", "mixta", "dante"] as const) {
      const token = await tokenOf(persona);
      const headers = { ...tenantHeader(fx.orgs.A.tenantId), Prefer: "return=representation" };
      const post = await rest(token, "text_snippets", {
        method: "POST",
        headers,
        body: {
          id: randomUUID(),
          tenant_id: fx.orgs.A.tenantId,
          kind: "conditions",
          name: `Directo ${persona}`,
          body: "Directo.",
        },
      });
      expect(post.status, `${persona} POST`).toBeGreaterThanOrEqual(400);
      const patch = await rest(token, `text_snippets?id=eq.${a.emailId}`, {
        method: "PATCH",
        headers,
        body: { body: "Pisado directo." },
      });
      expect(patch.status, `${persona} PATCH`).toBeGreaterThanOrEqual(400);
      const del = await rest(token, `text_snippets?id=eq.${a.emailId}`, {
        method: "DELETE",
        headers,
      });
      expect(del.status, `${persona} DELETE`).toBeGreaterThanOrEqual(400);
      // ni siquiera las columnas «sensibles» de control
      for (const body of [
        { revision: 99 },
        { is_default: false },
        { tenant_id: fx.orgs.B.tenantId },
      ]) {
        const res = await rest(token, `text_snippets?id=eq.${a.emailId}`, {
          method: "PATCH",
          headers,
          body,
        });
        expect(res.status, `${persona} PATCH ${Object.keys(body)[0]}`).toBeGreaterThanOrEqual(400);
      }
    }
    await expectUntouched(before);
    expect(await countWhere(db, "text_snippets", `name like 'Directo %'`)).toBe(0);
  });
});

describe("Ataque 5 · quién lee qué", () => {
  it("Ana, Mixta y Dante, en A, ven los textos de A; ninguno de B ni su canario", async () => {
    const fx = fixture();
    for (const persona of ["ana", "mixta", "dante"] as const) {
      const res = await rest(await tokenOf(persona), "text_snippets?select=*", {
        headers: tenantHeader(fx.orgs.A.tenantId),
      });
      expect(res.status, persona).toBe(200);
      const rows = res.json as { id: string; tenant_id: string }[];
      expect(
        rows.map((r) => r.id),
        persona,
      ).toEqual(
        expect.arrayContaining([fx.orgs.A.snippets!.emailId, fx.orgs.A.snippets!.conditionsId]),
      );
      expect(
        rows.every((r) => r.tenant_id === fx.orgs.A.tenantId),
        persona,
      ).toBe(true);
      expect(
        rows.map((r) => r.id),
        persona,
      ).not.toContain(fx.orgs.B.snippets!.emailId);
      expect(res.text, persona).not.toContain(fx.orgs.B.canary);
      expect(res.text, persona).not.toContain(fx.orgs.B.tenantId);
    }
  });

  it("Ana con la cabecera de B (no es miembro), sin cabecera o con una mal escrita no ve nada, ni pidiendo el texto de B por su id o su canario", async () => {
    const fx = fixture();
    const b = fx.orgs.B.snippets!;
    const token = await tokenOf("ana");
    for (const header of [
      fx.orgs.B.tenantId,
      undefined,
      "",
      "null",
      fx.orgs.B.tenantId.toUpperCase(),
    ]) {
      for (const query of [
        "text_snippets?select=id,name,body",
        `text_snippets?select=id,name,body&id=eq.${b.emailId}`,
        `text_snippets?select=id,body&tenant_id=eq.${fx.orgs.B.tenantId}`,
        `text_snippets?select=id,body&name=ilike.*${fx.orgs.B.canary}*`,
        `text_snippets?select=id,body&body=ilike.*${fx.orgs.B.canary}*`,
      ]) {
        const res = await rest(token, query, { headers: tenantHeader(header) });
        expect(res.json, `${header} ${query}`).toEqual([]);
        expect(res.text).not.toContain(fx.orgs.B.canary);
      }
    }
  });

  it("Beto solo ve los textos de B", async () => {
    const fx = fixture();
    const res = await rest(await tokenOf("beto"), "text_snippets?select=id,tenant_id,body", {
      headers: tenantHeader(fx.orgs.B.tenantId),
    });
    const rows = res.json as { id: string; tenant_id: string }[];
    expect(rows.map((r) => r.id).sort()).toEqual(
      [fx.orgs.B.snippets!.emailId, fx.orgs.B.snippets!.conditionsId].sort(),
    );
    expect(rows.every((r) => r.tenant_id === fx.orgs.B.tenantId)).toBe(true);
    expect(res.text).not.toContain(fx.orgs.A.canary);
  });
});

describe("Ataque 6 · reutilizar el identificador de un texto de B", () => {
  it("crear con el id de uno de B (desde A) se rechaza sin tocar el de B ni mostrar su contenido", async () => {
    const fx = fixture();
    const b = fx.orgs.B.snippets!;
    const before = await snapshot();
    const res = await rpc(
      await tokenOf("ana"),
      "create_text_snippet",
      createArgs({ p_snippet_id: b.emailId, p_name: "Robo", p_body: "Robado." }),
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(res)).toBe("CP422");
    expect(messageOf(res)).toBe("id_in_use");
    expect(res.text).not.toContain(fx.orgs.B.canary);
    expect(res.text).not.toContain(b.emailBody);
    await expectUntouched(before);
    expect(
      await countWhere(
        db,
        "text_snippets",
        `id = '${b.emailId}' and tenant_id = '${fx.orgs.B.tenantId}' and name = '${b.emailName}'`,
      ),
    ).toBe(1);
  });
});

describe("Ataque 7 · la auditoría", () => {
  it("lo que hace Ana en A queda con el tenant_id de A, sin el texto, y no aparece nada en la auditoría de B", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const id = randomUUID();
    const secret = `SECRETO-${fx.runId}`;
    const bAuditBefore = await countWhere(db, "audit_log", `tenant_id = '${fx.orgs.B.tenantId}'`);
    await rpc(
      token,
      "create_text_snippet",
      createArgs({ p_snippet_id: id, p_body: `Condiciones ${secret}` }),
      headers,
    );
    await rpc(
      token,
      "update_text_snippet",
      updateArgs(id, { p_body: `Cambiadas ${secret}` }),
      headers,
    );
    await rpc(token, "delete_text_snippet", { p_snippet_id: id }, headers);

    const { rows } = await db.query<{ action: string; tenant_id: string; details: unknown }>(
      `select action, tenant_id, details from public.audit_log where resource_id = $1 order by id`,
      [id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      "text_snippet.created",
      "text_snippet.updated",
      "text_snippet.deleted",
    ]);
    expect(rows.every((r) => r.tenant_id === fx.orgs.A.tenantId)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(await countWhere(db, "audit_log", `tenant_id = '${fx.orgs.B.tenantId}'`)).toBe(
      bAuditBefore,
    );

    // y la Dueña de A, al leer la auditoría, ve esas filas pero ni una de B
    const read = await rest(
      token,
      `audit_log?select=action,tenant_id,details&resource_id=eq.${id}`,
      { headers },
    );
    expect(
      (read.json as { tenant_id: string }[]).every((r) => r.tenant_id === fx.orgs.A.tenantId),
    ).toBe(true);
    const all = await rest(
      token,
      "audit_log?select=tenant_id,action,details&action=like.text_snippet.*",
      { headers },
    );
    expect(all.text).not.toContain(fx.orgs.B.canary);
    expect(
      (all.json as { tenant_id: string }[]).every((r) => r.tenant_id === fx.orgs.A.tenantId),
    ).toBe(true);
  });
});
