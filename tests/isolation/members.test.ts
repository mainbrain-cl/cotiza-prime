// Sprint 5 · H-010 · Aislamiento de «cambiar el rol de un miembro o quitarlo»: ataques con pases reales y `fetch`
// directo.
//  1. Apuntar a los miembros de B con el pase de A (cabecera de B, vacía o ninguna): «No encontrado» y B intacta.
//  2. Beto (Dueño de B) apuntando a los miembros de A.
//  3. Quien está en A y en B (Mixta), parada en una, no puede tocar a los miembros de la otra.
//  4. `list_members` no entrega nada de otra organización (ni el canario, ni correos, ni identificadores).
//  5. Quien no maneja el equipo (Dante, Observador) no lista ni cambia a nadie, y la lista de correos no se le filtra.
//  6. Ex, quitada o no, con su pase vigente: nada de esto le funciona.
//  7. Nadie escribe directo en `members`.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rest, rpc } from "../support/local-supabase";
import { countWhere, fingerprint, fixture, openDb, tenantHeader, tokenOf } from "./context";
import type { PersonaKey } from "./fixture";
import { ISOLATION_TABLES } from "./registry";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const spec = (name: string) => ISOLATION_TABLES.find((t) => t.name === name)!;
const codeOf = (res: { json: unknown }) => (res.json as { code?: string } | null)?.code;
const WATCHED = ["members", "audit_log", "invitations", "profiles"].map(spec);

async function memberIdOf(persona: PersonaKey, org: "A" | "B"): Promise<string> {
  const fx = fixture();
  const { rows } = await db.query<{ id: string }>(
    "select id from public.members where tenant_id = $1 and user_id = $2",
    [fx.orgs[org].tenantId, fx.personas[persona].userId],
  );
  return rows[0].id;
}

const changeArgs = (memberId: string, role = "viewer", expected = "sales") => ({
  p_member_id: memberId,
  p_new_role: role,
  p_expected_role: expected,
});
const removeArgs = (memberId: string, expected = "sales") => ({
  p_member_id: memberId,
  p_expected_role: expected,
});

async function snapshot() {
  const before = new Map<string, string>();
  for (const t of WATCHED) before.set(t.name, await fingerprint(db, t));
  return async () => {
    for (const t of WATCHED) {
      expect(await fingerprint(db, t), `${t.name} cambió`).toBe(before.get(t.name));
    }
  };
}

describe("Ataque 1 · con el pase de A, cambiar o quitar a los miembros de B", () => {
  it("Ana, con la cabecera de B, vacía o ninguna, no puede listar, cambiar ni quitar: no es miembro de B (CP404) y B queda intacta", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const betoInB = await memberIdOf("beto", "B");
    const mixtaInB = await memberIdOf("mixta", "B");
    const unchanged = await snapshot();
    for (const header of [fx.orgs.B.tenantId, undefined, ""]) {
      const calls: [string, object][] = [
        ["list_members", {}],
        ["change_member_role", changeArgs(betoInB, "viewer", "owner")],
        ["change_member_role", changeArgs(mixtaInB, "viewer", "admin")],
        ["remove_member", removeArgs(betoInB, "owner")],
        ["remove_member", removeArgs(mixtaInB, "admin")],
      ];
      for (const [name, args] of calls) {
        const res = await rpc(token, name, args, tenantHeader(header));
        expect(res.status, `${name} ${header}`).toBeGreaterThanOrEqual(400);
        expect(codeOf(res), `${name} ${header}`).toBe("CP404");
        expect(res.text).not.toContain(fx.orgs.B.canary);
        expect(res.text).not.toContain(fx.personas.beto.email);
      }
    }
    await unchanged();
  });

  it("Ana, parada en SU organización A, con el id de un miembro de B: «miembro no encontrado» y B intacta", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const unchanged = await snapshot();
    for (const persona of ["beto", "mixta"] as const) {
      const memberId = await memberIdOf(persona, "B");
      for (const [name, args] of [
        ["change_member_role", changeArgs(memberId, "viewer", "admin")],
        ["remove_member", removeArgs(memberId, "admin")],
      ] as const) {
        const res = await rpc(token, name, args, tenantHeader(fx.orgs.A.tenantId));
        expect(res.status, `${name} ${persona}`).toBeGreaterThanOrEqual(400);
        expect(codeOf(res), `${name} ${persona}`).toBe("CP404");
        expect((res.json as { message?: string }).message).toBe("member_not_found");
        expect(res.text).not.toContain(fx.orgs.B.canary);
      }
    }
    await unchanged();
    expect(
      await countWhere(
        db,
        "members",
        `tenant_id = '${fx.orgs.B.tenantId}' and status = 'active' and role in ('owner', 'admin')`,
      ),
    ).toBe(2);
  });
});

describe("Ataque 2 · Beto, Dueño de B, apuntando a los miembros de A", () => {
  it("ni con la cabecera de A ni con la de B puede tocar a nadie de A", async () => {
    const fx = fixture();
    const token = await tokenOf("beto");
    const unchanged = await snapshot();
    for (const persona of ["ana", "dante", "mixta"] as const) {
      const memberId = await memberIdOf(persona, "A");
      for (const header of [fx.orgs.A.tenantId, fx.orgs.B.tenantId]) {
        for (const [name, args] of [
          ["change_member_role", changeArgs(memberId, "viewer", "admin")],
          ["remove_member", removeArgs(memberId, "admin")],
        ] as const) {
          const res = await rpc(token, name, args, tenantHeader(header));
          expect(res.status, `${name} ${persona} ${header}`).toBeGreaterThanOrEqual(400);
          expect(codeOf(res), `${name} ${persona} ${header}`).toBe("CP404");
        }
      }
    }
    const list = await rpc(token, "list_members", {}, tenantHeader(fx.orgs.A.tenantId));
    expect(codeOf(list)).toBe("CP404");
    expect(list.text).not.toContain(fx.orgs.A.canary);
    await unchanged();
  });
});

describe("Ataque 3 · quien está en A y en B no cruza de una a otra", () => {
  it("Mixta (Administradora de las dos), parada en A, no toca a nadie de B; parada en B, no toca a nadie de A", async () => {
    const fx = fixture();
    const token = await tokenOf("mixta");
    const unchanged = await snapshot();
    const inB = [await memberIdOf("beto", "B"), await memberIdOf("mixta", "B")];
    const inA = [await memberIdOf("ana", "A"), await memberIdOf("dante", "A")];
    const attempts: [string, string[], string][] = [
      ["A", inB, fx.orgs.A.tenantId],
      ["B", inA, fx.orgs.B.tenantId],
    ];
    for (const [label, ids, header] of attempts) {
      for (const memberId of ids) {
        for (const [name, args] of [
          ["change_member_role", changeArgs(memberId, "viewer", "viewer")],
          ["remove_member", removeArgs(memberId, "viewer")],
        ] as const) {
          const res = await rpc(token, name, args, tenantHeader(header));
          expect(res.status, `${name} desde ${label}`).toBeGreaterThanOrEqual(400);
          expect(codeOf(res), `${name} desde ${label}`).toBe("CP404");
          expect((res.json as { message?: string }).message).toBe("member_not_found");
        }
      }
    }
    await unchanged();
  });
});

describe("Ataque 4 · list_members no entrega nada de otra organización", () => {
  it("Ana y Mixta en A ven solo a los de A; Mixta en B ve solo a los de B (sin canarios, correos ni identificadores ajenos)", async () => {
    const fx = fixture();
    const cases: { persona: PersonaKey; org: "A" | "B"; foreign: "A" | "B" }[] = [
      { persona: "ana", org: "A", foreign: "B" },
      { persona: "mixta", org: "A", foreign: "B" },
      { persona: "mixta", org: "B", foreign: "A" },
      { persona: "beto", org: "B", foreign: "A" },
    ];
    for (const { persona, org, foreign } of cases) {
      const res = await rpc(
        await tokenOf(persona),
        "list_members",
        {},
        tenantHeader(fx.orgs[org].tenantId),
      );
      expect(res.status, `${persona} en ${org}: ${res.text}`).toBe(200);
      const list = res.json as { user_id: string; email: string }[];
      expect(list.length).toBeGreaterThan(0);
      expect(res.text, `${persona} en ${org}`).not.toContain(fx.orgs[foreign].canary);
      expect(res.text).not.toContain(fx.orgs[foreign].tenantId);
      // Ningún correo ni cuenta de quien SOLO es de la otra organización.
      const foreignOnly = foreign === "B" ? "beto" : "ana";
      expect(res.text).not.toContain(fx.personas[foreignOnly].email);
      expect(list.map((m) => m.user_id)).not.toContain(fx.personas[foreignOnly].userId);
      // Y sí a la persona misma (control: la prueba no pasa por estar vacía).
      expect(list.map((m) => m.user_id)).toContain(fx.personas[persona].userId);
      // Solo miembros activos de ESTA organización.
      const active = await db.query<{ user_id: string }>(
        "select user_id from public.members where tenant_id = $1 and status = 'active'",
        [fx.orgs[org].tenantId],
      );
      expect(new Set(list.map((m) => m.user_id))).toEqual(
        new Set(active.rows.map((r) => r.user_id)),
      );
    }
  });

  it("Carla (Dueña de la organización archivada C) no lista a su equipo con la cabecera de C", async () => {
    const fx = fixture();
    const res = await rpc(
      await tokenOf("carla"),
      "list_members",
      {},
      tenantHeader(fx.orgs.C.tenantId),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(res)).toBe("CP404");
  });

  it("el nombre de un ex miembro de A no lo lee nadie de B (perfiles)", async () => {
    const fx = fixture();
    // Ex es o fue Comercial de A. Beto, parado en B, no ve su perfil; tampoco con la cabecera de A.
    for (const header of [fx.orgs.B.tenantId, fx.orgs.A.tenantId, undefined]) {
      const res = await rest(
        await tokenOf("beto"),
        `profiles?user_id=eq.${fx.personas.ex.userId}&select=user_id,full_name`,
        { headers: tenantHeader(header) },
      );
      expect(res.json, `cabecera ${header}`).toEqual([]);
    }
  });
});

describe("Ataque 5 · quien no maneja el equipo no lista ni cambia a nadie", () => {
  it("Dante (Observador de A) recibe «sin permiso» (42501) y A queda intacta", async () => {
    const fx = fixture();
    const token = await tokenOf("dante");
    const header = tenantHeader(fx.orgs.A.tenantId);
    const unchanged = await snapshot();
    const exInA = await memberIdOf("ex", "A");
    const list = await rpc(token, "list_members", {}, header);
    expect(codeOf(list)).toBe("42501");
    expect(list.text).not.toContain(fx.personas.ana.email);
    expect(list.text).not.toContain(fx.orgs.A.canary);
    for (const [name, args] of [
      ["change_member_role", changeArgs(exInA, "viewer", "sales")],
      ["remove_member", removeArgs(exInA, "sales")],
    ] as const) {
      const res = await rpc(token, name, args, header);
      expect(codeOf(res), name).toBe("42501");
    }
    await unchanged();
  });

  it("anónimo: ninguna de las tres responde", async () => {
    const fx = fixture();
    const exInA = await memberIdOf("ex", "A");
    for (const [name, args] of [
      ["list_members", {}],
      ["change_member_role", changeArgs(exInA)],
      ["remove_member", removeArgs(exInA)],
    ] as const) {
      const res = await rpc(null, name, args, tenantHeader(fx.orgs.A.tenantId));
      expect(res.status, name).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("Ataque 6 · Ex, con su pase vigente", () => {
  it("no lista ni cambia ni quita a nadie de A (si todavía es Comercial: sin permiso; si ya la quitaron: no encontrada)", async () => {
    const fx = fixture();
    const token = await tokenOf("ex");
    const unchanged = await snapshot();
    const anaInA = await memberIdOf("ana", "A");
    const danteInA = await memberIdOf("dante", "A");
    for (const header of [fx.orgs.A.tenantId, fx.orgs.B.tenantId, undefined]) {
      for (const [name, args] of [
        ["list_members", {}],
        ["change_member_role", changeArgs(danteInA, "admin", "viewer")],
        ["remove_member", removeArgs(danteInA, "viewer")],
        ["remove_member", removeArgs(anaInA, "owner")],
      ] as const) {
        const res = await rpc(token, name, args, tenantHeader(header));
        expect(res.status, `${name} ${header}`).toBeGreaterThanOrEqual(400);
        expect(["42501", "CP404"], `${name} ${header}`).toContain(codeOf(res));
        expect(res.text).not.toContain(fx.personas.ana.email);
      }
    }
    await unchanged();
  });
});

describe("Ataque 7 · nadie escribe directo en members", () => {
  it("la Dueña de A no puede insertar, cambiar ni borrar filas de members por la API", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const unchanged = await snapshot();
    const danteInA = await memberIdOf("dante", "A");
    const insert = await rest(token, "members", {
      method: "POST",
      headers: { Prefer: "return=representation", ...headers },
      body: {
        tenant_id: fx.orgs.A.tenantId,
        user_id: fx.personas.carla.userId,
        role: "viewer",
      },
    });
    expect(insert.status, insert.text).toBeGreaterThanOrEqual(400);
    const update = await rest(token, `members?id=eq.${danteInA}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation", ...headers },
      body: { role: "admin" },
    });
    expect(update.status, update.text).toBeGreaterThanOrEqual(400);
    const remove = await rest(token, `members?id=eq.${danteInA}`, {
      method: "DELETE",
      headers: { Prefer: "return=representation", ...headers },
    });
    expect(remove.status, remove.text).toBeGreaterThanOrEqual(400);
    await unchanged();
  });
});
