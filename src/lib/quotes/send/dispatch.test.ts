import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SEND_TIMEOUT_MS,
  type EmailMessage,
  type EmailSendResult,
  type EmailTransport,
} from "@/lib/email/types";
import {
  CONFIRM_MAX_ATTEMPTS,
  SEND_LOCK_MARGIN_SECONDS,
  SEND_LOCK_SECONDS,
  SEND_MAX_ATTEMPTS,
  SEND_PAGE_MAX_DURATION_SECONDS,
  SEND_RESERVE_SECONDS,
  retryTransientDb,
  sendDeadline,
  sendWithRetry,
} from "./dispatch";

const message = { idempotencyKey: "clave-1" } as EmailMessage;
const noSleep = async () => undefined;

function transportFrom(results: (EmailSendResult | "hang" | "throw")[]) {
  const send = vi.fn(async (...args: [EmailMessage]): Promise<EmailSendResult> => {
    void args;
    const next = results[Math.min(send.mock.calls.length - 1, results.length - 1)];
    if (next === "throw") throw new Error("boom");
    if (next === "hang") return new Promise<EmailSendResult>(() => undefined);
    return next;
  });
  return { provider: "memory", send } as unknown as EmailTransport & { send: typeof send };
}

describe("sendWithRetry (I1)", () => {
  it("un envío bueno no reintenta", async () => {
    const transport = transportFrom([{ ok: true, providerMessageId: "m1" }]);
    const result = await sendWithRetry(transport, message, {
      deadlineMs: Date.now() + 50_000,
      sleep: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("reintenta con el MISMO mensaje (misma clave anti-duplicado) hasta lograrlo", async () => {
    const transport = transportFrom([
      { ok: false, retryable: true, code: "provider_unavailable" },
      "throw",
      { ok: true, providerMessageId: "m2" },
    ]);
    const result = await sendWithRetry(transport, message, {
      deadlineMs: Date.now() + 50_000,
      sleep: noSleep,
    });
    expect(result).toEqual({ ok: true, providerMessageId: "m2" });
    expect(transport.send).toHaveBeenCalledTimes(3);
    for (const [sent] of transport.send.mock.calls) expect(sent.idempotencyKey).toBe("clave-1");
  });

  it("no reintenta un rechazo definitivo", async () => {
    const transport = transportFrom([{ ok: false, retryable: false, code: "provider_rejected" }]);
    const result = await sendWithRetry(transport, message, {
      deadlineMs: Date.now() + 50_000,
      sleep: noSleep,
    });
    expect(result).toMatchObject({ ok: false, code: "provider_rejected" });
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("se detiene en el máximo de intentos", async () => {
    const transport = transportFrom([{ ok: false, retryable: true, code: "network_error" }]);
    const result = await sendWithRetry(transport, message, {
      deadlineMs: Date.now() + 50_000,
      sleep: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(transport.send).toHaveBeenCalledTimes(SEND_MAX_ATTEMPTS);
  });

  it("no reintenta si ya no queda tiempo", async () => {
    const transport = transportFrom([{ ok: false, retryable: true, code: "network_error" }]);
    const result = await sendWithRetry(transport, message, {
      deadlineMs: 1_000,
      now: () => 900,
      sleep: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("un proveedor que no responde se corta a los 15 s y se reintenta", async () => {
    vi.useFakeTimers();
    try {
      const transport = transportFrom(["hang", { ok: true, providerMessageId: "m3" }]);
      const promise = sendWithRetry(transport, message, {
        deadlineMs: Date.now() + 50_000,
        sleep: async () => undefined,
      });
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 10);
      expect(await promise).toEqual({ ok: true, providerMessageId: "m3" });
      expect(transport.send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retryTransientDb (I1)", () => {
  it("repite ante un fallo pasajero y devuelve el éxito", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: {} })
      .mockResolvedValueOnce({ data: null, error: { code: "08006" } })
      .mockResolvedValueOnce({ data: { status: "confirmed" }, error: null });
    const result = await retryTransientDb(call, noSleep);
    expect(result.error).toBeNull();
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("no repite una respuesta definitiva de la base", async () => {
    for (const code of ["42501", "CP423", "CP409", "CP404"]) {
      const call = vi.fn().mockResolvedValue({ data: null, error: { code } });
      const result = await retryTransientDb(call, noSleep);
      expect(result.error?.code).toBe(code);
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("se rinde tras el máximo de intentos", async () => {
    const call = vi.fn().mockResolvedValue({ data: null, error: { code: "XX000" } });
    const result = await retryTransientDb(call, noSleep);
    expect(result.error).not.toBeNull();
    expect(call).toHaveBeenCalledTimes(CONFIRM_MAX_ATTEMPTS);
  });
});

describe("tiempos del envío (I4)", () => {
  const root = join(__dirname, "..", "..", "..", "..");

  it("el valor fijo de la página coincide con la constante", () => {
    const page = readFileSync(
      join(root, "src/app/o/[tenantId]/cotizaciones/[quoteId]/enviar/page.tsx"),
      "utf8",
    );
    const match = /export const maxDuration = (\d+);/.exec(page);
    expect(match, "falta `export const maxDuration = N;` en la página de enviar").not.toBeNull();
    expect(Number(match![1])).toBe(SEND_PAGE_MAX_DURATION_SECONDS);
  });

  it("el candado de la base (`app.send_lock_seconds()`) coincide con la constante", () => {
    const dir = join(root, "supabase/migrations");
    let seconds: number | null = null;
    for (const file of readdirSync(dir).sort()) {
      const sql = readFileSync(join(dir, file), "utf8");
      const match =
        /function app\.send_lock_seconds\(\)\s+returns integer\s+language sql immutable as \$\$\s*select (\d+)\s*\$\$/i.exec(
          sql,
        );
      if (match) seconds = Number(match[1]);
    }
    expect(seconds, "no se encontró app.send_lock_seconds() en las migraciones").not.toBeNull();
    expect(seconds).toBe(SEND_LOCK_SECONDS);
  });

  it("maxDuration más el margen es menor que el candado", () => {
    expect(SEND_PAGE_MAX_DURATION_SECONDS + SEND_LOCK_MARGIN_SECONDS).toBeLessThan(
      SEND_LOCK_SECONDS,
    );
  });

  it("el límite de los intentos deja una reserva dentro de la duración máxima", () => {
    const start = 1_000_000;
    expect(sendDeadline(start)).toBe(
      start + (SEND_PAGE_MAX_DURATION_SECONDS - SEND_RESERVE_SECONDS) * 1_000,
    );
    expect(sendDeadline(start)).toBeLessThan(start + SEND_PAGE_MAX_DURATION_SECONDS * 1_000);
  });
});
