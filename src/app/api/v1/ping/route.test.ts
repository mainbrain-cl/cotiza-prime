import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/v1/ping", () => {
  it("responde ok sin datos sensibles", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
