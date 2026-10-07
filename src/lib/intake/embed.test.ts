import { describe, expect, it } from "vitest";
import {
  EmbedError,
  MAX_EMBED_ORIGINS,
  buildEmbedCsp,
  buildEmbedSnippet,
  isValidEmbedOrigin,
} from "./embed";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const APP = "https://app.cotizaprime.test";
const ID = "Xk3aBcDeFgHiJkLmNoPqRs";

describe("isValidEmbedOrigin", () => {
  it.each([
    "https://sitio.cl",
    "https://www.sitio.cl",
    "https://sitio-permitido.test",
    "https://sub.dominio.empresa.cl:8443",
    "https://a1.cl:1",
    "https://a.cl:65535",
  ])("acepta %s", (origin) => {
    expect(isValidEmbedOrigin(origin)).toBe(true);
  });

  it.each([
    "http://sitio.cl",
    "https://*.sitio.cl",
    "*",
    "https://sitio.cl/",
    "https://sitio.cl/ruta",
    "https://sitio.cl?x=1",
    "https://sitio.cl#a",
    "https://sitio.cl; script-src *",
    "https://sitio.cl script-src",
    "https://sitio.cl\nContent-Type: x",
    "https://sitio.cl\r\n",
    "https://sitio.cl,https://otro.cl",
    "https://user@sitio.cl",
    "https://user:pw@sitio.cl",
    "https://SITIO.cl",
    "https://sitio",
    "https://sitio..cl",
    "https://.sitio.cl",
    "https://sitio.cl.",
    "https://-sitio.cl",
    "https://sitio.cl:0",
    "https://sitio.cl:65536",
    "https://sitio.cl:080",
    "https://sitio.cl:abc",
    "https://sitio.cl:",
    "https://sítio.cl",
    "https://sitio.cl'",
    `https://sitio.cl${cp(0x202e)}`,
    "data:text/html,x",
    "javascript:alert(1)",
    "'self'",
    "'none'",
    "",
    "https://",
    `https://${"a".repeat(260)}.cl`,
    5,
    null,
    undefined,
    {},
  ])("rechaza %j", (origin) => {
    expect(isValidEmbedOrigin(origin)).toBe(false);
  });
});

describe("buildEmbedCsp", () => {
  it("lista vacía: ninguno", () => {
    expect(buildEmbedCsp([])).toBe("frame-ancestors 'none'");
  });

  it("arma solo frame-ancestors con los orígenes", () => {
    expect(buildEmbedCsp(["https://a.cl", "https://b.cl:8443"])).toBe(
      "frame-ancestors https://a.cl https://b.cl:8443",
    );
  });

  it("quita repetidos", () => {
    expect(buildEmbedCsp(["https://a.cl", "https://a.cl"])).toBe("frame-ancestors https://a.cl");
  });

  it.each([
    "https://a.cl; script-src *",
    "https://a.cl\nframe-ancestors *",
    "https://*.a.cl",
    "*",
    "http://a.cl",
    "https://a.cl/ruta",
    "https://a.cl b.cl",
    "'self'",
  ])("lanza con %j y no arma la política", (bad) => {
    expect(() => buildEmbedCsp(["https://ok.cl", bad])).toThrow(EmbedError);
  });

  it("más de 10 sitios", () => {
    const many = Array.from({ length: MAX_EMBED_ORIGINS + 1 }, (_, i) => `https://s${i}.cl`);
    expect(() => buildEmbedCsp(many)).toThrow(EmbedError);
    expect(buildEmbedCsp(many.slice(0, MAX_EMBED_ORIGINS))).toContain("https://s9.cl");
  });

  it("nunca produce directivas distintas de frame-ancestors", () => {
    const csp = buildEmbedCsp(["https://a.cl"]);
    expect(csp).not.toContain(";");
    expect(csp.startsWith("frame-ancestors ")).toBe(true);
  });
});

describe("buildEmbedSnippet", () => {
  it("trae un iframe con la dirección exacta y carga diferida", () => {
    const snippet = buildEmbedSnippet(APP, ID);
    expect(snippet).toContain(`<iframe data-cotiza-prime="${ID}" src="${APP}/f/${ID}/incrustar"`);
    expect(snippet).toContain('title="Solicitar una cotización"');
    expect(snippet).toContain('loading="lazy"');
    expect(snippet.match(/<iframe/g)).toHaveLength(1);
  });

  it("no carga ningún script externo", () => {
    const snippet = buildEmbedSnippet(APP, ID);
    expect(snippet).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(snippet.match(/<script>/g)).toHaveLength(1);
    expect(snippet.match(/<\/script>/g)).toHaveLength(1);
    expect(snippet).not.toMatch(/fetch|XMLHttpRequest|eval|innerHTML|document\.write|import\(/);
  });

  it("el script es corto", () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(buildEmbedSnippet(APP, ID))?.[1] ?? "";
    expect(script.trim().split("\n").length).toBeLessThanOrEqual(22);
    // ya no depende de dónde quede el script respecto al marco (WordPress puede envolverlo en <p>)
    expect(script).not.toContain("currentScript");
    expect(script).not.toContain("previousElementSibling");
    expect(script).toContain(`querySelectorAll("iframe[data-cotiza-prime=\\"${ID}\\"]")`);
  });

  it("acepta localhost por http solo para desarrollo", () => {
    expect(buildEmbedSnippet("http://localhost:3000", ID)).toContain(
      `http://localhost:3000/f/${ID}/incrustar`,
    );
    expect(() => buildEmbedSnippet("http://sitio.cl", ID)).toThrow(EmbedError);
  });

  it.each([
    `${APP}"><script>alert(1)</script>`,
    `${APP}/`,
    `${APP}/ruta`,
    `${APP}'; alert(1); '`,
    `${APP}\n`,
    "https://*.cl",
    "javascript:alert(1)",
    "//app.cotizaprime.test",
    "",
  ])("rechaza el origen de la aplicación %j", (origin) => {
    expect(() => buildEmbedSnippet(origin, ID)).toThrow(EmbedError);
  });

  it.each([
    `${ID}"><script>alert(1)</script>`,
    "corto",
    `${ID}x`,
    `${ID.slice(0, -1)}/`,
    `${ID.slice(0, -1)}.`,
    "../../../../etc/passwd/abcdef",
    "",
    `${ID}\n`,
  ])("rechaza el identificador %j", (id) => {
    expect(() => buildEmbedSnippet(APP, id)).toThrow(EmbedError);
  });

  it("escapa un título malicioso", () => {
    const snippet = buildEmbedSnippet(APP, ID, {
      title: `"><script>alert(1)</script> onload='x' \`y\` & \n${cp(0x202e)} fin`,
    });
    const iframe = snippet.split("\n")[0];
    expect(iframe).not.toContain("<script");
    expect(iframe).not.toContain(cp(0x202e));
    expect(iframe).toContain("&quot;&gt;&lt;script&gt;");
    expect(iframe).toContain("&#39;x&#39;");
    // Un único atributo title: no se pudo cerrar la comilla.
    expect(iframe.match(/ title="/g)).toHaveLength(1);
    expect(iframe.match(/<script/g)).toBeNull();
    expect(snippet.match(/<script>/g)).toHaveLength(1);
  });

  it("acota el título a 100 caracteres y usa uno por defecto si queda vacío", () => {
    expect(buildEmbedSnippet(APP, ID, { title: "a".repeat(500) })).toContain(
      `title="${"a".repeat(100)}"`,
    );
    expect(buildEmbedSnippet(APP, ID, { title: " \n\t " })).toContain(
      'title="Solicitar una cotización"',
    );
  });

  describe("comportamiento del script", () => {
    type Listener = (event: unknown) => void;

    function run(appOrigin: string) {
      const snippet = buildEmbedSnippet(appOrigin, ID);
      const body = /<script>([\s\S]*)<\/script>/.exec(snippet)?.[1] ?? "";
      let listener: Listener | null = null;
      let scrolls = 0;
      const frame = {
        style: { height: "" },
        contentWindow: { id: "marco" },
        scrollIntoView: (options: unknown) => {
          expect(options).toEqual({ block: "start" });
          scrolls += 1;
        },
      };
      const other = {
        style: { height: "" },
        contentWindow: { id: "otro" },
        scrollIntoView: () => {},
      };
      const queries: string[] = [];
      const fakeWindow = {
        addEventListener: (type: string, fn: Listener) => {
          if (type === "message") listener = fn;
        },
      };
      // Sin `currentScript`: el marco se busca por su atributo, esté donde esté el script.
      const fakeDocument = {
        querySelectorAll: (selector: string) => {
          queries.push(selector);
          return selector === `iframe[data-cotiza-prime="${ID}"]` ? [other, frame] : [];
        },
      };
      new Function("window", "document", body)(fakeWindow, fakeDocument);
      const send = (event: { origin: string; source: unknown; data: unknown }) => listener?.(event);
      return {
        frame,
        other,
        send,
        queries,
        scrolls: () => scrolls,
        hasListener: () => listener !== null,
      };
    }

    it("encuentra el marco por su atributo y ajusta el correcto entre varios", () => {
      const env = run(APP);
      env.send({
        origin: APP,
        source: env.frame.contentWindow,
        data: { source: "cotiza-prime", type: "resize", height: 700 },
      });
      expect(env.queries).toEqual([`iframe[data-cotiza-prime="${ID}"]`]);
      expect(env.frame.style.height).toBe("700px");
      expect(env.other.style.height).toBe("");
    });

    it("el mensaje de scroll lleva el marco a la vista solo si viene del origen y del marco", () => {
      const env = run(APP);
      const data = { source: "cotiza-prime", type: "scroll" };
      env.send({ origin: "https://malo.test", source: env.frame.contentWindow, data });
      env.send({ origin: APP, source: { id: "otro-marco" }, data });
      env.send({
        origin: APP,
        source: env.frame.contentWindow,
        data: { source: "x", type: "scroll" },
      });
      expect(env.scrolls()).toBe(0);
      env.send({ origin: APP, source: env.frame.contentWindow, data });
      expect(env.scrolls()).toBe(1);
    });

    const good = (height: unknown) => ({
      origin: APP,
      source: { id: "marco" },
      data: { source: "cotiza-prime", type: "resize", height },
    });

    it("ajusta la altura cuando el mensaje viene del origen y del marco", () => {
      const env = run(APP);
      expect(env.hasListener()).toBe(true);
      const message = good(900.4);
      message.source = env.frame.contentWindow;
      env.send(message);
      expect(env.frame.style.height).toBe("900px");
    });

    it("acota entre 200 y 4.000", () => {
      const env = run(APP);
      for (const [input, expected] of [
        [10, "200px"],
        [-50, "200px"],
        [999_999, "4000px"],
      ] as const) {
        const message = good(input);
        message.source = env.frame.contentWindow;
        env.send(message);
        expect(env.frame.style.height).toBe(expected);
      }
    });

    it("ignora otro origen, otro marco, forma errónea y alturas que no son número", () => {
      const env = run(APP);
      const withFrame = (m: ReturnType<typeof good>) => ({ ...m, source: env.frame.contentWindow });
      env.send({ ...withFrame(good(500)), origin: "https://malo.test" });
      env.send({ ...withFrame(good(500)), origin: `${APP}.malo.test` });
      env.send(good(500)); // otro marco
      env.send({ ...withFrame(good(500)), data: { source: "otro", type: "resize", height: 500 } });
      env.send({
        ...withFrame(good(500)),
        data: { source: "cotiza-prime", type: "x", height: 500 },
      });
      env.send({ ...withFrame(good(500)), data: null });
      env.send({ ...withFrame(good(500)), data: "texto" });
      for (const bad of ["500", Number.NaN, Infinity, null, undefined, {}]) {
        env.send(withFrame(good(bad)));
      }
      expect(env.frame.style.height).toBe("");
    });
  });
});
