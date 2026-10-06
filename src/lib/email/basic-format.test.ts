import { describe, expect, it } from "vitest";
import { MAX_BODY_LENGTH, MAX_LINKS, escapeHtml, parseBasicFormat } from "./basic-format";

function ok(input: string) {
  const result = parseBasicFormat(input);
  if (!result.ok) throw new Error(`esperaba ok, vino ${result.code}`);
  return result;
}

describe("parseBasicFormat — lo permitido", () => {
  it("negrita, listas, enlaces https y saltos de línea", () => {
    const { html, text } = ok(
      "Hola **Ana**,\nsegunda línea\n\n- uno\n- dos\n\nVer [la web](https://ejemplo.cl/a?b=1).",
    );
    expect(html).toContain("<strong>Ana</strong>");
    expect(html).toContain("<br>");
    expect(html).toContain("<ul");
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain('href="https://ejemplo.cl/a?b=1"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(text).toBe(
      "Hola Ana,\nsegunda línea\n\n- uno\n- dos\n\nVer la web (https://ejemplo.cl/a?b=1).",
    );
  });

  it("acepta saltos de línea de Windows", () => {
    expect(ok("a\r\nb").text).toBe("a\nb");
  });

  it("acepta tildes, ñ y emojis", () => {
    expect(ok("Señor Muñoz ✓ 😀").html).toContain("Señor Muñoz ✓ 😀");
  });

  it("usa el color de enlace solo si es hex válido", () => {
    const good = parseBasicFormat("[a](https://x.cl)", { linkColor: "#112233" });
    const bad = parseBasicFormat("[a](https://x.cl)", { linkColor: 'red;" onclick="x' });
    expect(good.ok && good.html).toContain("color:#112233");
    expect(bad.ok && bad.html).not.toContain("onclick");
  });
});

describe("parseBasicFormat — ataques", () => {
  it("escapa <script> y cualquier HTML", () => {
    const { html } = ok('<script>alert(1)</script> <img src=x onerror="alert(1)"> **<b>x</b>**');
    expect(html).not.toMatch(/<script|<img|<b>/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>&lt;b&gt;x&lt;/b&gt;</strong>");
  });

  it("no convierte enlaces javascript:, data:, http:// ni sin protocolo", () => {
    for (const bad of [
      "[x](javascript:alert(1))",
      "[x](JAVASCRIPT:alert(1))",
      "[x](data:text/html;base64,AAAA)",
      "[x](http://ejemplo.cl)",
      "[x](//ejemplo.cl)",
      "[x](ejemplo.cl)",
      "[x](ftp://ejemplo.cl)",
    ]) {
      const { html } = ok(bad);
      expect(html, bad).not.toContain("<a ");
    }
  });

  it("rechaza URLs https con usuario y contraseña", () => {
    expect(ok("[x](https://user:pass@ejemplo.cl)").html).not.toContain("<a ");
  });

  it("atributos on*= quedan como texto inofensivo", () => {
    const { html } = ok('[x](https://a.cl" onmouseover="alert(1))');
    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/<[^>]*onmouseover/);
  });

  it("un enlace dentro de otro no abre dos enlaces anidados", () => {
    const { html } = ok("[a]([b](https://uno.cl))");
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toMatch(/<a [^>]*><a /);
  });

  it("el texto del enlace nunca se interpreta como HTML", () => {
    const { html } = ok('[<b onclick="x">](https://uno.cl)');
    expect(html).toContain("&lt;b onclick=&quot;x&quot;&gt;");
  });

  it("rechaza más de 20 enlaces y acepta 20", () => {
    const link = (n: number) => `[l${n}](https://ejemplo.cl/${n})`;
    const twenty = Array.from({ length: MAX_LINKS }, (_, n) => link(n)).join(" ");
    expect(parseBasicFormat(twenty).ok).toBe(true);
    expect(parseBasicFormat(`${twenty} ${link(99)}`)).toEqual({
      ok: false,
      code: "too_many_links",
    });
  });

  it("rechaza un texto que muestra una dirección distinta a la real", () => {
    expect(parseBasicFormat("[https://mibanco.cl](https://malo.cl)")).toEqual({
      ok: false,
      code: "misleading_link",
    });
    expect(parseBasicFormat("[www.mibanco.cl](https://malo.cl)").ok).toBe(false);
    expect(parseBasicFormat("[https://www.ejemplo.cl](https://ejemplo.cl/x)").ok).toBe(true);
  });

  it("rechaza caracteres de control, \\r suelto y NUL", () => {
    for (const bad of ["a\rb", "a\u0000b", "a\u001bb", "a\u007fb", "a\u0085b", "a b"]) {
      expect(parseBasicFormat(bad), JSON.stringify(bad)).toEqual({
        ok: false,
        code: "control_characters",
      });
    }
  });

  it("rechaza unicode que disfraza texto: bidi, ancho cero, BOM", () => {
    for (const bad of ["a‮b", "a⁦b", "a​b", "a‏b", "a﻿b", "a⁠b"]) {
      expect(parseBasicFormat(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("respeta el tope de largo", () => {
    expect(parseBasicFormat("a".repeat(MAX_BODY_LENGTH)).ok).toBe(true);
    expect(parseBasicFormat("a".repeat(MAX_BODY_LENGTH + 1))).toEqual({
      ok: false,
      code: "too_long",
    });
  });

  it("rechaza vacío o solo espacios", () => {
    expect(parseBasicFormat("  \n\n ")).toEqual({ ok: false, code: "empty" });
  });

  it("una negrita sin cerrar queda literal", () => {
    expect(ok("**abierta").html).toContain("**abierta");
  });

  it("no permite que un salto de línea inyecte un ítem de lista dentro de un enlace", () => {
    const { html } = ok("[a\n](https://x.cl)");
    expect(html).not.toContain("<a ");
  });

  it("escapeHtml cubre los cinco caracteres", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
