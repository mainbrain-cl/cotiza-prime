import { describe, expect, it } from "vitest";
import { INTAKE_BODY_MAX_BYTES, readLimitedJsonBody } from "./request-body";

const post = (body: BodyInit | null, headers: Record<string, string>) =>
  new Request("https://app.ejemplo.test/x", { method: "POST", headers, body });

describe("lectura acotada del cuerpo del envío público", () => {
  it("lee un JSON chico, también con charset", async () => {
    const result = await readLimitedJsonBody(
      post(JSON.stringify({ a: 1 }), { "content-type": "application/json; charset=utf-8" }),
    );
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rechaza todo lo que no es application/json", async () => {
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "",
      "application/jsonx",
    ]) {
      const result = await readLimitedJsonBody(post("{}", type ? { "content-type": type } : {}));
      expect(result, type).toEqual({ ok: false, reason: "unsupported_type" });
    }
  });

  it("corta apenas pasa los 16 kB, aunque no declare el tamaño", async () => {
    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode("a".repeat(4_000));
        for (let i = 0; i < 10; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request("https://app.ejemplo.test/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big,
      duplex: "half",
    } as RequestInit);
    expect(await readLimitedJsonBody(request)).toEqual({ ok: false, reason: "too_large" });
  });

  it("corta de inmediato si la cabecera ya declara demasiado", async () => {
    const result = await readLimitedJsonBody(
      post("{}", {
        "content-type": "application/json",
        "content-length": String(INTAKE_BODY_MAX_BYTES + 1),
      }),
    );
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("un JSON roto o un cuerpo vacío es malformado", async () => {
    expect(await readLimitedJsonBody(post("{no", { "content-type": "application/json" }))).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await readLimitedJsonBody(post(null, { "content-type": "application/json" }))).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
