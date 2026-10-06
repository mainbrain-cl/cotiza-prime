// Sprint 3 · Ataques 3 y 8: las funciones del enlace del cliente son solo del servidor, y un token
// de B abierto con la sesión de Ana no deja rastro de miembro ni toca nada de A.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localEnv, rest, rpc } from "../support/local-supabase";
import { fingerprint, fixture, openDb, tenantHeader, tokenOf } from "./context";
import { ISOLATION_TABLES } from "./registry";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

/** Llama como el servidor de la aplicación (llave maestra), que es quien usa estas funciones. */
const asServer = (name: string, args: object) => {
  const { secretKey } = localEnv();
  return rpc(secretKey, name, args, { apikey: secretKey });
};

const respondArgs = (sha: string) => ({
  p_token_sha256: sha,
  p_response_id: randomUUID(),
  p_response_key: randomUUID(),
  p_decision: "accepted",
  p_acceptor_name_enc: "ataque",
  p_reason_code: null,
  p_reason_text_enc: null,
  p_ip_enc: "ataque",
  p_origin_ip: "203.0.113.50",
  p_user_agent: "ataque",
  p_acceptance_text_version: "v1",
});

describe("Ataque 3 · las funciones del portero no las llama nadie con un pase ni sin sesión", () => {
  it("Ana, Beto y un visitante sin sesión, con el token real de B, no pueden llamarlas directo", async () => {
    const fx = fixture();
    const sha = fx.orgs.B.share!.tokenSha256;
    const calls: [string, object][] = [
      ["share_link_read", { p_token_sha256: sha }],
      ["share_link_record_view", { p_token_sha256: sha, p_ip_enc: "x", p_user_agent: "x" }],
      ["share_link_respond", respondArgs(sha)],
      [
        "record_email_event",
        {
          p_provider: "memory",
          p_provider_message_id: `fixture-${fx.orgs.B.share!.packageId}`,
          p_event: "bounced",
          p_occurred_at: null,
          p_bounce_type: "hard",
        },
      ],
    ];
    const specs = ISOLATION_TABLES.filter((t) =>
      [
        "quotes",
        "quote_events",
        "quote_responses",
        "share_links",
        "share_link_views",
        "audit_log",
        "email_messages",
      ].includes(t.name),
    );
    const before = new Map<string, string>();
    for (const spec of specs) before.set(spec.name, await fingerprint(db, spec));
    for (const token of [null, await tokenOf("ana"), await tokenOf("beto")]) {
      for (const header of [undefined, fx.orgs.A.tenantId, fx.orgs.B.tenantId]) {
        for (const [name, args] of calls) {
          const res = await rpc(token, name, args, tenantHeader(header));
          expect(res.status, `${name} ${token ? "con pase" : "anónimo"}`).toBeGreaterThanOrEqual(
            400,
          );
          expect(res.text).not.toContain(fx.orgs.B.canary);
        }
      }
    }
    for (const spec of specs) {
      expect(await fingerprint(db, spec), `${spec.name} cambió`).toBe(before.get(spec.name));
    }
  });

  it("control positivo: el servidor sí las ejecuta (así un rechazo no se debe a argumentos mal armados)", async () => {
    const fx = fixture();
    const res = await asServer("share_link_read", { p_token_sha256: fx.orgs.B.share!.tokenSha256 });
    expect(res.status, res.text).toBe(200);
    expect((res.json as { state: string }).state).toBe("responded");
    const unknown = await asServer("share_link_read", { p_token_sha256: "0".repeat(64) });
    expect(unknown.json).toEqual({ state: "not_found" });
    const event = await asServer("record_email_event", {
      p_provider: "memory",
      p_provider_message_id: "no-existe",
      p_event: "delivered",
      p_occurred_at: null,
      p_bounce_type: null,
    });
    expect(event.status, event.text).toBe(200);
    expect(event.json).toEqual({ result: "unknown" });
  });
});

describe("Ataque 8 · el token de B abierto con la sesión de Ana", () => {
  it("se lee solo como 'cliente' de B: no deja rastro en A ni se registra como miembro", async () => {
    const fx = fixture();
    const specs = ISOLATION_TABLES.filter((t) =>
      [
        "quotes",
        "quote_events",
        "quote_responses",
        "share_links",
        "share_link_views",
        "audit_log",
        "email_messages",
      ].includes(t.name),
    );
    const inA = (spec: { name: string }) =>
      db
        .query<{ h: string }>(
          `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h
           from public.${spec.name} t where tenant_id = $1`,
          [fx.orgs.A.tenantId],
        )
        .then((r) => r.rows[0].h);
    const beforeA = new Map<string, string>();
    for (const spec of specs) beforeA.set(spec.name, await inA(spec));
    const beforeB = new Map<string, string>();
    for (const spec of specs) beforeB.set(spec.name, await fingerprint(db, spec));

    // El portero lee con el sello del token; la sesión de Ana ni siquiera llega a la función.
    const res = await asServer("share_link_read", { p_token_sha256: fx.orgs.B.share!.tokenSha256 });
    const body = res.json as { tenant_id: string; quote_id: string; org_contact: { name: string } };
    expect(body.tenant_id).toBe(fx.orgs.B.tenantId);
    expect(body.quote_id).toBe(fx.orgs.B.share!.quoteId);
    expect(JSON.stringify(body)).not.toContain(fx.orgs.A.canary);
    expect(JSON.stringify(body)).not.toContain(fx.personas.ana.userId);

    for (const spec of specs) {
      expect(await inA(spec), `A: ${spec.name} cambió`).toBe(beforeA.get(spec.name));
      expect(await fingerprint(db, spec), `B: ${spec.name} cambió (leer no escribe)`).toBe(
        beforeB.get(spec.name),
      );
    }

    // Con la sesión de Ana por la API de la base, B sigue sin existir para ella.
    const token = await tokenOf("ana");
    for (const table of ["quotes", "share_links", "quote_responses"]) {
      const asAna = await asAnaRead(token, table, fx.orgs.A.tenantId, fx.orgs.B.tenantId);
      expect(asAna, table).toEqual([]);
    }
  });
});

async function asAnaRead(token: string, table: string, headerTenant: string, targetTenant: string) {
  const res = await rest(token, `${table}?select=id&tenant_id=eq.${targetTenant}`, {
    headers: tenantHeader(headerTenant),
  });
  return res.json;
}
