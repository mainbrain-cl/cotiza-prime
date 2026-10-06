import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailpitTransport } from "./adapters/mailpit";
import { getMemoryOutbox, resetMemoryOutbox } from "./adapters/memory";
import { createResendTransport } from "./adapters/resend";
import { SEND_TIMEOUT_MS } from "./adapters/shared";
import { EmailConfigError, loadEmailConfig } from "./config";
import { getEmailTransport } from "./transport";
import type { EmailMessage } from "./types";

const message = (over: Partial<EmailMessage> = {}): EmailMessage => ({
  from: { name: "Negocio Demo", address: "cotizaciones@ejemplo.test" },
  to: "cliente@ejemplo.test",
  subject: "Hola",
  html: "<p>Hola</p>",
  text: "Hola",
  attachments: [
    { filename: "a.pdf", contentType: "application/pdf", content: new Uint8Array([1, 2, 3]) },
  ],
  idempotencyKey: "k1",
  ...over,
});

const memoryTransport = () => getEmailTransport(loadEmailConfig({ EMAIL_PROVIDER: "memory" }));

beforeEach(() => resetMemoryOutbox());
afterEach(() => vi.restoreAllMocks());

describe("loadEmailConfig", () => {
  it("en pruebas usa valores seguros por defecto (memory y lista blanca)", () => {
    const config = loadEmailConfig({});
    expect(config.provider).toBe("memory");
    expect(config.allowedRecipientDomains).toEqual(["ejemplo.test", "rebota.ejemplo.test"]);
  });

  it("en producción se niega con mailpit o memory", () => {
    for (const provider of ["mailpit", "memory"]) {
      expect(() =>
        loadEmailConfig({
          NEXT_PUBLIC_APP_ENV: "production",
          EMAIL_PROVIDER: provider,
          EMAIL_FROM_ADDRESS: "a@b.cl",
        }),
      ).toThrow(EmailConfigError);
    }
  });

  it("en producción exige proveedor, remitente, clave y secreto de avisos", () => {
    const base = { NEXT_PUBLIC_APP_ENV: "production" };
    expect(() => loadEmailConfig(base)).toThrow(/EMAIL_PROVIDER/);
    expect(() => loadEmailConfig({ ...base, EMAIL_PROVIDER: "resend" })).toThrow(
      /EMAIL_FROM_ADDRESS/,
    );
    expect(() =>
      loadEmailConfig({ ...base, EMAIL_PROVIDER: "resend", EMAIL_FROM_ADDRESS: "a@b.cl" }),
    ).toThrow(/RESEND_API_KEY/);
    expect(() =>
      loadEmailConfig({
        ...base,
        EMAIL_PROVIDER: "resend",
        EMAIL_FROM_ADDRESS: "a@b.cl",
        RESEND_API_KEY: "re_clave_larga",
      }),
    ).toThrow(/EMAIL_WEBHOOK_SECRET/);
    const ok = loadEmailConfig({
      ...base,
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM_ADDRESS: "a@b.cl",
      RESEND_API_KEY: "re_clave_larga",
      EMAIL_WEBHOOK_SECRET: "secreto-de-16-o-mas-caracteres",
    });
    expect(ok.allowedRecipientDomains).toBeNull();
  });

  it("valores inválidos dan un error que nombra la variable y no revela su valor", () => {
    try {
      loadEmailConfig({ EMAIL_FROM_ADDRESS: "no-es-correo-SECRETO" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("EMAIL_FROM_ADDRESS");
      expect((error as Error).message).not.toContain("SECRETO");
    }
    expect(() => loadEmailConfig({ EMAIL_PROVIDER: "otro" })).toThrow(EmailConfigError);
    expect(() =>
      loadEmailConfig({ EMAIL_ALLOWED_RECIPIENT_DOMAINS: "bien.cl, mal dominio" }),
    ).toThrow(EmailConfigError);
  });

  it("acepta una lista blanca propia", () => {
    expect(
      loadEmailConfig({ EMAIL_ALLOWED_RECIPIENT_DOMAINS: "A.cl, b.cl" }).allowedRecipientDomains,
    ).toEqual(["a.cl", "b.cl"]);
  });
});

describe("getEmailTransport", () => {
  it("smtp lanza un error claro de que no está configurado", () => {
    expect(() => getEmailTransport(loadEmailConfig({ EMAIL_PROVIDER: "smtp" }))).toThrow(
      /SMTP no está configurado/,
    );
  });

  it("resend sin clave lanza error de configuración", () => {
    expect(() => getEmailTransport(loadEmailConfig({ EMAIL_PROVIDER: "resend" }))).toThrow(
      EmailConfigError,
    );
  });
});

describe("reglas comunes de envío", () => {
  it("bloquea destinatarios fuera de la lista blanca sin enviar nada", async () => {
    const transport = memoryTransport();
    for (const to of [
      "persona@gmail.com",
      "x@ejemplo.test.evil.com",
      "x@evil-ejemplo.test",
      "x@sub.ejemplo.test",
    ]) {
      expect(await transport.send(message({ to })), to).toEqual({
        ok: false,
        retryable: false,
        code: "recipient_not_allowed",
      });
    }
    expect(getMemoryOutbox()).toHaveLength(0);
  });

  it("compara el dominio sin importar mayúsculas", async () => {
    expect((await memoryTransport().send(message({ to: "X@EJEMPLO.TEST" }))).ok).toBe(true);
  });

  it("rechaza saltos de línea y caracteres de control en cabeceras", async () => {
    const transport = memoryTransport();
    const bad: Array<Partial<EmailMessage>> = [
      { subject: "Hola\r\nBcc: x@y.cl" },
      { subject: "" },
      { subject: "a".repeat(151) },
      { to: "a@ejemplo.test\r\nBcc: x@y.cl" },
      { from: { name: "Nombre\nX", address: "a@ejemplo.test" } },
      { from: { name: 'Nombre"', address: "a@ejemplo.test" } },
      { from: { name: "Nombre", address: "a@ejemplo.test\r\n" } },
      { to: "no-es-correo" },
      {
        attachments: [
          { filename: "../a.pdf", contentType: "application/pdf", content: new Uint8Array(1) },
        ],
      },
      {
        attachments: [
          { filename: "a\r\n.pdf", contentType: "application/pdf", content: new Uint8Array(1) },
        ],
      },
    ];
    for (const over of bad) {
      expect(await transport.send(message(over)), JSON.stringify(over)).toMatchObject({
        ok: false,
        code: "invalid_message",
        retryable: false,
      });
    }
    expect(getMemoryOutbox()).toHaveLength(0);
  });

  it("memory guarda el correo y respeta la clave anti-duplicado", async () => {
    const transport = memoryTransport();
    const first = await transport.send(message());
    const second = await transport.send(message());
    expect(first.ok && second.ok && first.providerMessageId === second.providerMessageId).toBe(
      true,
    );
    expect(getMemoryOutbox()).toHaveLength(1);
  });

  it("simula rebote para @rebota.ejemplo.test", async () => {
    const result = await memoryTransport().send(
      message({ to: "x@rebota.ejemplo.test", idempotencyKey: "k2" }),
    );
    expect(result.ok && result.simulatedEvents).toEqual([
      expect.objectContaining({ event: "bounced", bounceType: "hard" }),
    ]);
    const normal = await memoryTransport().send(message({ idempotencyKey: "k3" }));
    expect(normal.ok && normal.simulatedEvents).toBeUndefined();
  });
});

describe("adaptador mailpit", () => {
  it("envía a la API de Mailpit con adjunto en base64 y devuelve el ID", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ID: "abc" }), { status: 200 }));
    const result = await createMailpitTransport("http://127.0.0.1:56324").send(message());
    expect(result).toMatchObject({ ok: true, providerMessageId: "abc" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:56324/api/v1/send");
    const body = JSON.parse(String(init?.body));
    expect(body.From).toEqual({ Email: "cotizaciones@ejemplo.test", Name: "Negocio Demo" });
    expect(body.Attachments[0]).toMatchObject({ Filename: "a.pdf", Content: "AQID" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("clasifica fallos: 5xx reintentable, 4xx no, red y tiempo agotado", async () => {
    const transport = createMailpitTransport("http://127.0.0.1:56324");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    expect(await transport.send(message())).toEqual({
      ok: false,
      retryable: true,
      code: "provider_unavailable",
    });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 400 }));
    expect(await transport.send(message())).toEqual({
      ok: false,
      retryable: false,
      code: "provider_rejected",
    });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await transport.send(message())).toEqual({
      ok: false,
      retryable: true,
      code: "network_error",
    });
    fetchMock.mockRejectedValueOnce(new DOMException("t", "TimeoutError"));
    expect(await transport.send(message())).toEqual({
      ok: false,
      retryable: true,
      code: "timeout",
    });
  });

  it("tiene tope de 15 segundos", () => {
    expect(SEND_TIMEOUT_MS).toBe(15_000);
  });
});

describe("adaptador resend", () => {
  const okResponse = () => new Response(JSON.stringify({ id: "re_9" }), { status: 200 });

  it("llama a la API con clave, anti-duplicado y adjuntos; sin usar librería", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    const result = await createResendTransport("re_clave_secreta").send(message());
    expect(result).toEqual({ ok: true, providerMessageId: "re_9" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_clave_secreta");
    expect(headers["Idempotency-Key"]).toBe("k1");
    const body = JSON.parse(String(init?.body));
    expect(body.from).toBe("Negocio Demo <cotizaciones@ejemplo.test>");
    expect(body.to).toEqual(["cliente@ejemplo.test"]);
    expect(body.attachments).toEqual([{ filename: "a.pdf", content: "AQID" }]);
  });

  it("clasifica los fallos del proveedor", async () => {
    const transport = createResendTransport("k");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cases: Array<[Response, string, boolean]> = [
      [new Response("{}", { status: 429 }), "rate_limited", true],
      [new Response("{}", { status: 500 }), "provider_unavailable", true],
      [new Response("{}", { status: 401 }), "provider_auth", false],
      [new Response("{}", { status: 422 }), "provider_rejected", false],
      [
        new Response(JSON.stringify({ name: "concurrent_idempotent_requests" }), { status: 409 }),
        "provider_conflict",
        true,
      ],
      [
        new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 }),
        "provider_conflict",
        false,
      ],
    ];
    for (const [response, code, retryable] of cases) {
      fetchMock.mockResolvedValueOnce(response);
      expect(await transport.send(message()), code).toEqual({ ok: false, retryable, code });
    }
  });

  it("una respuesta aceptada sin id se trata como incierta y reintentable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await createResendTransport("k").send(message())).toEqual({
      ok: false,
      retryable: true,
      code: "provider_unavailable",
    });
  });

  it("nunca escribe correos ni contenido en los logs", async () => {
    const spies = [
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "error"),
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 500 }));
    await createResendTransport("re_clave_secreta").send(
      message({ subject: "ASUNTO-SECRETO", html: "<p>CUERPO-SECRETO</p>" }),
    );
    const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0]))).join("\n");
    expect(logged).toContain("email_send_failed");
    for (const secret of [
      "cliente@ejemplo.test",
      "ASUNTO-SECRETO",
      "CUERPO-SECRETO",
      "re_clave_secreta",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});

// Prueba de humo contra un Mailpit real: no corre en el CI (no hay Mailpit). Para correrla:
//   $env:EMAIL_SMOKE_MAILPIT="1"; npm test -- src/lib/email/transport.test.ts
describe.skipIf(!process.env.EMAIL_SMOKE_MAILPIT)("humo contra Mailpit real", () => {
  it("entrega un correo con PDF y queda en la bandeja", async () => {
    const api = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:56324";
    const marker = `humo-${Date.now()}`;
    const transport = getEmailTransport(
      loadEmailConfig({ EMAIL_PROVIDER: "mailpit", MAILPIT_API_URL: api }),
    );
    const result = await transport.send(message({ subject: marker, to: "humo@ejemplo.test" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await (await fetch(`${api}/api/v1/message/${result.providerMessageId}`)).json();
    expect(stored.Subject).toBe(marker);
    expect(stored.From.Name).toBe("Negocio Demo");
    expect(stored.Attachments).toHaveLength(1);
  });
});
