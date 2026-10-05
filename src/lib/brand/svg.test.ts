import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "./svg";

const NS = 'xmlns="http://www.w3.org/2000/svg"';

function clean(source: string): string {
  const result = sanitizeSvg(source);
  if (!result.ok) throw new Error(`rechazado: ${result.reason}`);
  return result.svg;
}

function rejected(source: string): string {
  const result = sanitizeSvg(source);
  if (result.ok) throw new Error(`debía rechazarse, pero salió: ${result.svg}`);
  return result.reason;
}

describe("sanitizeSvg: lo legítimo pasa", () => {
  it("conserva un logo simple y agrega el espacio de nombres si falta", () => {
    const out = clean(
      '<svg viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="#2b54e0"/></svg>',
    );
    expect(out).toBe(
      `<svg ${NS} viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="#2b54e0"/></svg>`,
    );
  });

  it("acepta la declaración XML, comentarios, degradados con referencias internas y texto", () => {
    const out = clean(`<?xml version="1.0" encoding="UTF-8"?>
      <!-- hecho en un editor -->
      <svg ${NS} width="100" height="40" xmlns:xlink="http://www.w3.org/1999/xlink">
        <defs>
          <linearGradient id="g" xlink:href="#base"><stop offset="0" stop-color="#fff"/></linearGradient>
        </defs>
        <path d="M0,0 L10,10z" fill="url(#g)" style="stroke:#000;stroke-width:2"/>
        <text x="1" y="2">Ñandú &amp; Cía</text>
      </svg>`);
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain('href="#base"');
    expect(out).toContain("Ñandú &amp; Cía");
    expect(out).not.toContain("xlink");
    expect(out).not.toContain("<?xml");
    expect(out).not.toContain("<!--");
  });

  it("acepta estilos simples, también dentro de CDATA", () => {
    const out = clean(
      `<svg ${NS}><style><![CDATA[.a{fill:#ff0000;stroke:url(#g)} #b, .c{opacity:.5}]]></style><rect class="a" width="1" height="1"/></svg>`,
    );
    expect(out).toContain(".a{fill:#ff0000;stroke:url(#g)}");
  });
});

describe("sanitizeSvg: lo peligroso se elimina o se rechaza", () => {
  it("elimina <script> con todo su contenido, también si va en CDATA o con símbolos", () => {
    const out = clean(
      `<svg ${NS}><script>if (a && b) { alert(1) }</script><script><![CDATA[alert(2)]]></script><circle r="1"/></svg>`,
    );
    expect(out).toBe(`<svg ${NS}><circle r="1"/></svg>`);
  });

  it("elimina foreignObject y animaciones, con lo que llevan adentro", () => {
    const out = clean(
      `<svg ${NS}><foreignObject><div onclick="x()">hola</div></foreignObject><rect width="1" height="1"><animate attributeName="x" to="9"/></rect><set attributeName="href" to="javascript:alert(1)"/></svg>`,
    );
    expect(out).toBe(`<svg ${NS}><rect width="1" height="1"></rect></svg>`);
  });

  it("elimina controladores de eventos y atributos desconocidos", () => {
    const out = clean(
      `<svg ${NS} onload="alert(1)"><rect onclick="x()" onmouseover="y()" data-x="1" xlink:show="new" width="1" height="1"/></svg>`,
    );
    expect(out).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>`);
    expect(out).not.toMatch(/on[a-z]+=/i);
  });

  it("elimina etiquetas con prefijo de editores (inkscape, sodipodi, rdf)", () => {
    const out = clean(
      `<svg ${NS} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"><sodipodi:namedview inkscape:zoom="2"/><metadata><rdf:RDF>x</rdf:RDF></metadata><g inkscape:label="a"><rect width="1" height="1"/></g></svg>`,
    );
    expect(out).toBe(`<svg ${NS}><g><rect width="1" height="1"/></g></svg>`);
  });

  it.each([
    [
      "javascript: en href",
      `<svg ${NS}><a href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>`,
    ],
    [
      "imagen incrustada",
      `<svg ${NS}><image href="data:image/png;base64,AAAA" width="1" height="1"/></svg>`,
    ],
    ["imagen externa", `<svg ${NS}><image href="https://example.com/x.png"/></svg>`],
    ["use", `<svg ${NS}><use href="#a"/></svg>`],
    ["filter", `<svg ${NS}><filter id="f"><feImage href="https://example.com/x"/></filter></svg>`],
    [
      "fill con url externa",
      `<svg ${NS}><rect fill="url(https://example.com/a.svg#b)" width="1" height="1"/></svg>`,
    ],
    [
      "fill con url de datos",
      `<svg ${NS}><rect fill="url('data:image/svg+xml,<svg/>')" width="1" height="1"/></svg>`,
    ],
    [
      "href externo en degradado",
      `<svg ${NS}><linearGradient href="https://example.com/g.svg#g"/></svg>`,
    ],
    [
      "javascript en un valor",
      `<svg ${NS}><rect fill="javascript:alert(1)" width="1" height="1"/></svg>`,
    ],
    [
      "@import en estilo",
      `<svg ${NS}><style>@import url(https://example.com/x.css);</style></svg>`,
    ],
    [
      "url externa en estilo",
      `<svg ${NS}><style>.a{fill:url(https://example.com/x)}</style></svg>`,
    ],
    [
      "expression en style",
      `<svg ${NS}><rect style="width:expression(alert(1))" width="1" height="1"/></svg>`,
    ],
    [
      "URL externa en style attr",
      `<svg ${NS}><rect style="fill:url(http://x.cl/a)" width="1" height="1"/></svg>`,
    ],
    [
      "espacio de nombres ajeno",
      `<svg xmlns="http://www.w3.org/1999/xhtml"><rect width="1" height="1"/></svg>`,
    ],
    ["raíz que no es svg", `<html ${NS}><body/></html>`],
    ["DOCTYPE", `<!DOCTYPE svg SYSTEM "http://example.com/x.dtd"><svg ${NS}/>`],
    ["entidad definida", `<!DOCTYPE svg [<!ENTITY a "bbb">]><svg ${NS}>&a;</svg>`],
    ["entidad desconocida", `<svg ${NS}><text>&xxe;</text></svg>`],
    ["etiqueta sin cerrar", `<svg ${NS}><g><rect width="1" height="1"/></svg>`],
    ["etiquetas cruzadas", `<svg ${NS}><g><rect></g></rect></svg>`],
    ["dos raíces", `<svg ${NS}/><svg ${NS}/>`],
    ["texto fuera de la raíz", `<svg ${NS}/>hola`],
    ["atributo sin comillas", `<svg ${NS}><rect width=1/></svg>`],
    ["atributo repetido", `<svg ${NS}><rect width="1" width="2"/></svg>`],
    ["byte nulo", `<svg ${NS}>\0</svg>`],
  ])("rechaza: %s", (_name, source) => {
    expect(rejected(source)).toMatch(/\S/);
  });

  it("no deja pasar código escondido en texto ni en valores: todo sale escapado", () => {
    const out = clean(
      `<svg ${NS}><title>&lt;script&gt;alert(1)&lt;/script&gt;</title><text aria-label='a"b'>x</text></svg>`,
    );
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain('aria-label="a&quot;b"');
  });

  it("pone un tope a la complejidad", () => {
    expect(rejected(`<svg ${NS}>${"<g>".repeat(40)}${"</g>".repeat(40)}</svg>`)).toMatch(
      /complejo/,
    );
    expect(rejected(`<svg ${NS}>${'<rect width="1"/>'.repeat(6000)}</svg>`)).toMatch(/complejo/);
  });

  it("la salida es estable: limpiar lo ya limpio no cambia nada", () => {
    const first = clean(
      `<svg ${NS} viewBox="0 0 4 4" onload="x()"><g fill="#123456"><path d="M0 0h4v4z"/></g><script>1</script></svg>`,
    );
    expect(clean(first)).toBe(first);
  });
});
