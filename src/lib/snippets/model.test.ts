import { describe, expect, it } from "vitest";
import { MAX_BODY_LENGTH, parseBasicFormat } from "@/lib/email/basic-format";
import { QUOTE_TEXT_MAX_LENGTH } from "@/lib/quotes/validity";
import {
  SNIPPETS_MAX_PER_TENANT,
  SNIPPET_BODY_MAX_LENGTH,
  SNIPPET_KINDS,
  SNIPPET_KIND_LABELS,
  SNIPPET_MAX_VARIABLES,
  SNIPPET_NAME_MAX_LENGTH,
  SNIPPET_VARIABLES,
  SNIPPET_VARIABLE_LABELS,
  SNIPPET_VARIABLE_VALUE_MAX_LENGTH,
  checkSnippetVariables,
  findVariableTokens,
  hasUnresolvedVariables,
  hasUnsafeSnippetCharacters,
  isSnippetKind,
  normalizeSnippetBody,
  normalizeSnippetName,
  renderVariables,
  sanitizeVariableValue,
  snippetLength,
  variableToken,
  type SnippetKind,
} from "./model";

const ALL_VALUES = {
  cliente: "Ana Pérez",
  numero: "COT-2026-0043 v2",
  remitente: "Juan",
  organizacion: "Fletes del Sur",
};

describe("topes y cuentas", () => {
  it("tienen los valores del diseño", () => {
    expect(SNIPPETS_MAX_PER_TENANT).toBe(50);
    expect(SNIPPET_NAME_MAX_LENGTH).toBe(80);
    expect(SNIPPET_BODY_MAX_LENGTH).toBe(4_000);
    expect(SNIPPET_MAX_VARIABLES).toBe(10);
    expect(SNIPPET_VARIABLE_VALUE_MAX_LENGTH).toBe(100);
  });

  it("el texto guardado mide lo mismo que las condiciones de una cotización", () => {
    expect(SNIPPET_BODY_MAX_LENGTH).toBe(QUOTE_TEXT_MAX_LENGTH);
  });

  it("4.000 + 10 × 100 = 5.000: un texto al máximo con todas sus variables siempre cabe en el correo", () => {
    expect(
      SNIPPET_BODY_MAX_LENGTH + SNIPPET_MAX_VARIABLES * SNIPPET_VARIABLE_VALUE_MAX_LENGTH,
    ).toBe(MAX_BODY_LENGTH);
  });

  it("en la práctica: 10 variables con valores de 100 caracteres, en un texto de 4.000, pasan el lector del correo", () => {
    const filler = "a".repeat(
      SNIPPET_BODY_MAX_LENGTH - SNIPPET_MAX_VARIABLES * "{{cliente}}".length,
    );
    const text = filler + "{{cliente}}".repeat(SNIPPET_MAX_VARIABLES);
    expect(snippetLength(text)).toBe(SNIPPET_BODY_MAX_LENGTH);
    expect(checkSnippetVariables("email_body", text).ok).toBe(true);
    const rendered = renderVariables(text, { ...ALL_VALUES, cliente: "x".repeat(500) });
    expect(snippetLength(rendered)).toBeLessThanOrEqual(MAX_BODY_LENGTH);
    expect(parseBasicFormat(rendered).ok).toBe(true);
  });
});

describe("tipos de texto y variables", () => {
  it("son los cuatro tipos y las cuatro variables, cada uno con nombre en español", () => {
    expect([...SNIPPET_KINDS]).toEqual(["email_body", "conditions", "exclusions", "footer_note"]);
    expect([...SNIPPET_VARIABLES]).toEqual(["cliente", "numero", "remitente", "organizacion"]);
    for (const kind of SNIPPET_KINDS) expect(SNIPPET_KIND_LABELS[kind]).toMatch(/\S/);
    for (const variable of SNIPPET_VARIABLES)
      expect(SNIPPET_VARIABLE_LABELS[variable]).toMatch(/\S/);
    expect(variableToken("cliente")).toBe("{{cliente}}");
  });

  it("isSnippetKind solo acepta los cuatro", () => {
    expect(SNIPPET_KINDS.every(isSnippetKind)).toBe(true);
    for (const value of ["", "Email_body", "email", null, undefined, 3]) {
      expect(isSnippetKind(value)).toBe(false);
    }
  });
});

describe("revisión de variables", () => {
  type Case = { name: string; kind: SnippetKind; text: string; expected: string | string[] };
  const cases: Case[] = [
    // texto del correo: lo permitido
    {
      name: "sin variables",
      kind: "email_body",
      text: "Hola, adjunto la cotización.",
      expected: [],
    },
    {
      name: "una variable",
      kind: "email_body",
      text: "Estimado {{cliente}}:",
      expected: ["cliente"],
    },
    {
      name: "las cuatro, repetidas",
      kind: "email_body",
      text: "{{cliente}} {{numero}} {{remitente}} {{organizacion}} {{cliente}}",
      expected: ["cliente", "numero", "remitente", "organizacion", "cliente"],
    },
    {
      name: "pegadas entre sí",
      kind: "email_body",
      text: "{{cliente}}{{numero}}",
      expected: ["cliente", "numero"],
    },
    // texto del correo: lo rechazado
    {
      name: "variable desconocida",
      kind: "email_body",
      text: "Hola {{nombre}}",
      expected: "unknown_variable",
    },
    {
      name: "mayúsculas",
      kind: "email_body",
      text: "Hola {{Cliente}}",
      expected: "unknown_variable",
    },
    {
      name: "con espacios adentro",
      kind: "email_body",
      text: "Hola {{ cliente }}",
      expected: "unknown_variable",
    },
    { name: "vacía", kind: "email_body", text: "Hola {{}}", expected: "unknown_variable" },
    {
      name: "llaves anidadas",
      kind: "email_body",
      text: "{{{{cliente}}}}",
      expected: "unknown_variable",
    },
    {
      name: "llaves anidadas con nombre",
      kind: "email_body",
      text: "{{cli{{cliente}}ente}}",
      expected: "unknown_variable",
    },
    {
      name: "una llave suelta de apertura",
      kind: "email_body",
      text: "Hola {cliente",
      expected: "unknown_variable",
    },
    {
      name: "llaves dobles sin cerrar",
      kind: "email_body",
      text: "Hola {{cliente",
      expected: "unknown_variable",
    },
    {
      name: "llaves dobles solo de cierre",
      kind: "email_body",
      text: "Hola cliente}}",
      expected: "unknown_variable",
    },
    {
      name: "llaves simples alrededor de una variable",
      kind: "email_body",
      text: "{{{cliente}}}",
      expected: "unknown_variable",
    },
    {
      name: "una variable válida y una mala",
      kind: "email_body",
      text: "{{cliente}} {{otra}}",
      expected: "unknown_variable",
    },
    {
      name: "10 variables (el máximo)",
      kind: "email_body",
      text: "{{cliente}}".repeat(10),
      expected: Array<string>(10).fill("cliente"),
    },
    {
      name: "11 variables",
      kind: "email_body",
      text: "{{cliente}}".repeat(11),
      expected: "too_many_variables",
    },
    // los otros tipos: ninguna variable
    { name: "condiciones sin llaves", kind: "conditions", text: "Pago a 30 días.", expected: [] },
    {
      name: "condiciones con una llave simple",
      kind: "conditions",
      text: "Opción {A} o {B}.",
      expected: [],
    },
    {
      name: "condiciones con una variable",
      kind: "conditions",
      text: "Para {{cliente}}",
      expected: "variables_not_allowed",
    },
    {
      name: "exclusiones con llaves de cierre dobles",
      kind: "exclusions",
      text: "No incluye }} nada",
      expected: "variables_not_allowed",
    },
    {
      name: "notas con llaves dobles de apertura",
      kind: "footer_note",
      text: "{{",
      expected: "variables_not_allowed",
    },
  ];

  for (const c of cases) {
    it(`${c.kind}: ${c.name}`, () => {
      const result = checkSnippetVariables(c.kind, c.text);
      if (typeof c.expected === "string") {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.problem).toBe(c.expected);
          expect(result.message).toMatch(/\S/);
        }
      } else {
        expect(result).toEqual({ ok: true, variables: c.expected });
      }
    });
  }

  it("findVariableTokens lista lo que hay entre llaves dobles, en orden", () => {
    expect(findVariableTokens("a {{x}} b {{cliente}} {{}}")).toEqual(["x", "cliente", ""]);
    expect(findVariableTokens("nada")).toEqual([]);
  });

  it("hasUnresolvedVariables detecta variables válidas que quedaron sin completar", () => {
    expect(hasUnresolvedVariables("Hola {{cliente}}")).toBe(true);
    expect(hasUnresolvedVariables("Hola Ana")).toBe(false);
    expect(hasUnresolvedVariables("Hola { {cliente} }")).toBe(false);
  });
});

describe("limpieza del valor de una variable", () => {
  const cases: { name: string; input: string; expected: string }[] = [
    { name: "texto normal queda igual", input: "Ana Pérez", expected: "Ana Pérez" },
    {
      name: "saltos de línea y tabuladores pasan a un espacio",
      input: "Ana\nPérez\t\r\nGómez",
      expected: "Ana Pérez Gómez",
    },
    {
      name: "caracteres de control se quitan",
      input: "An\u0001a\u0007 \u007fP",
      expected: "Ana P",
    },
    {
      name: "invisibles y marcas de dirección se quitan",
      input: "A\u200bn\u202ea\u2066 \ufeffP\u00ad",
      expected: "Ana P",
    },
    {
      name: "espacios de los bordes y repetidos",
      input: "   Ana     Pérez   ",
      expected: "Ana Pérez",
    },
    { name: "** pasa a *", input: "**Oferta** Ana", expected: " *Oferta* Ana" },
    {
      name: "empieza con ( : espacio al inicio",
      input: "(https://malo.ejemplo)",
      expected: " (https://malo.ejemplo)",
    },
    {
      name: "termina en ] : espacio al final",
      input: "[Fletes del Sur]",
      expected: "[Fletes del Sur] ",
    },
    { name: "termina en * : espacio al final", input: "Ana*", expected: "Ana* " },
    {
      name: "empieza y termina en * : espacio a los dos lados",
      input: "*Juan*",
      expected: " *Juan* ",
    },
    { name: "un solo asterisco", input: "*", expected: " * " },
    { name: "un paréntesis en medio no cambia", input: "Ana (Sur)", expected: "Ana (Sur)" },
    { name: "muchos asteriscos", input: "a********b", expected: "a*b" },
    {
      name: "]( pasa a ] (",
      input: "[Paga aquí](https://malo.ejemplo)",
      expected: "[Paga aquí] (https://malo.ejemplo)",
    },
    { name: "]( repetido", input: "](](", expected: "] (] (" },
    { name: "llaves separadas", input: "{{numero}}", expected: "{ { numero } }" },
    { name: "llave simple", input: "a{b}c", expected: "a{ b }c" },
    { name: "vacío", input: "", expected: "" },
    { name: "solo basura", input: "\n\u200b\t", expected: "" },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(sanitizeVariableValue(c.input)).toBe(c.expected);
    });
  }

  it("corta a 100 caracteres (por carácter, no por unidad de UTF-16)", () => {
    expect(snippetLength(sanitizeVariableValue("a".repeat(500)))).toBe(100);
    const emoji = sanitizeVariableValue("😀".repeat(300));
    expect(snippetLength(emoji)).toBe(100);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("un corte que deja una llave al final la quita", () => {
    const value = sanitizeVariableValue("a".repeat(99) + "{");
    expect(value.endsWith("{")).toBe(false);
    expect(snippetLength(value)).toBeLessThanOrEqual(100);
  });
});

describe("completar variables", () => {
  it("las cuatro", () => {
    expect(
      renderVariables(
        "Estimado {{cliente}}: le enviamos la cotización {{numero}}. Saluda {{remitente}}, {{organizacion}}.",
        ALL_VALUES,
      ),
    ).toBe(
      "Estimado Ana Pérez: le enviamos la cotización COT-2026-0043 v2. Saluda Juan, Fletes del Sur.",
    );
  });

  it("una variable repetida se completa cada vez", () => {
    expect(renderVariables("{{cliente}} y {{cliente}}", ALL_VALUES)).toBe("Ana Pérez y Ana Pérez");
  });

  it("si falta el dato: el cliente es «cliente»; los demás quedan vacíos", () => {
    const empty = { cliente: null, numero: undefined, remitente: "", organizacion: " \n " };
    expect(
      renderVariables("Estimado {{cliente}}:[{{numero}}][{{remitente}}][{{organizacion}}]", empty),
    ).toBe("Estimado cliente:[][][]");
  });

  it("un cliente llamado {{numero}} NO se vuelve a completar", () => {
    const out = renderVariables("Hola {{cliente}}, cotización {{numero}}", {
      ...ALL_VALUES,
      cliente: "{{numero}}",
    });
    expect(out).toBe("Hola { { numero } }, cotización COT-2026-0043 v2");
    expect(hasUnresolvedVariables(out)).toBe(false);
  });

  it("un cliente llamado {{cliente}} tampoco se reexpande (no hay recursión)", () => {
    const out = renderVariables("{{cliente}}", {
      ...ALL_VALUES,
      cliente: "{{cliente}}{{cliente}}",
    });
    expect(out).toBe("{ { cliente } }{ { cliente } }");
  });

  it("[Paga aquí](https://malo.ejemplo) como nombre de cliente no genera un enlace en el correo", () => {
    const out = renderVariables("Estimado {{cliente}}:\n\nAdjunto la cotización.", {
      ...ALL_VALUES,
      cliente: "[Paga aquí](https://malo.ejemplo)",
    });
    const parsed = parseBasicFormat(out);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.html).not.toContain("<a ");
      expect(parsed.html).not.toContain("href");
    }
  });

  it("un nombre con ** no se vuelve negrita", () => {
    const out = renderVariables("Estimado {{cliente}}:", {
      ...ALL_VALUES,
      cliente: "**Importante**",
    });
    const parsed = parseBasicFormat(out);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.html).not.toContain("<strong");
  });

  it("variables pegadas con llaves en los valores no forman llaves dobles", () => {
    const out = renderVariables("{{cliente}}{{numero}}{{remitente}}", {
      cliente: "a{",
      numero: "{b}",
      remitente: "}c",
      organizacion: "x",
    });
    expect(out).not.toContain("{{");
    expect(out).not.toContain("}}");
  });

  it("dos valores pegados no forman un enlace: [Fletes del Sur] + (https://malo.ejemplo)", () => {
    const out = renderVariables("Estimado {{organizacion}}{{cliente}}", {
      ...ALL_VALUES,
      organizacion: "[Fletes del Sur]",
      cliente: "(https://malo.ejemplo)",
    });
    expect(out).not.toContain("](");
    const parsed = parseBasicFormat(out);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.html).not.toContain("<a ");
      expect(parsed.html).not.toContain("href");
    }
  });

  it("tres valores pegados no forman negrita: Ana* + *Juan* + *Org", () => {
    const out = renderVariables("{{cliente}}{{remitente}}{{organizacion}}", {
      ...ALL_VALUES,
      cliente: "Ana*",
      remitente: "*Juan*",
      organizacion: "*Org",
    });
    expect(out).not.toContain("**");
    const parsed = parseBasicFormat(out);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.html).not.toContain("<strong");
  });

  it("el corte a 100 cuenta los espacios de los bordes y no deja de más", () => {
    for (const edge of ["]", "*"]) {
      for (const n of [97, 98, 99, 100, 101, 150]) {
        const out = sanitizeVariableValue("a".repeat(n - 1) + edge);
        expect(snippetLength(out), `${edge} ${n}`).toBeLessThanOrEqual(
          SNIPPET_VARIABLE_VALUE_MAX_LENGTH,
        );
        expect(out.startsWith(" ")).toBe(false);
        expect(out.trimEnd().length).toBeGreaterThan(0);
      }
    }
    const starting = sanitizeVariableValue("(" + "a".repeat(200) + "]");
    expect(snippetLength(starting)).toBeLessThanOrEqual(SNIPPET_VARIABLE_VALUE_MAX_LENGTH);
    expect(starting.startsWith(" (")).toBe(true);
    // lo que sobra de espacios al final por el corte se quita
    expect(sanitizeVariableValue("a".repeat(99) + " b")).toBe("a".repeat(99));
  });

  it("propiedad: sean cuales sean los valores, el resultado COMPLETO no trae llaves dobles, ** ni ](, y el lector del correo no genera enlaces ni negritas", () => {
    const alphabet = [
      "{",
      "}",
      "{{",
      "}}",
      "*",
      "**",
      "](",
      "[",
      "]",
      "(https://malo.ejemplo)",
      "https://malo.ejemplo",
      " ",
      "a",
      "\n",
      "\u200b",
      "😀",
      "(",
      ")",
    ];
    let seed = 12_345;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    const randomValue = () =>
      Array.from({ length: next() % 130 }, () => alphabet[next() % alphabet.length]).join("");
    const templates = [
      "{{cliente}}{{numero}} {{remitente}}{{organizacion}}{{cliente}}",
      "Estimado {{organizacion}}{{cliente}}",
      "{{cliente}}{{remitente}}{{organizacion}}{{numero}}",
    ];
    for (let i = 0; i < 1500; i++) {
      const template = templates[i % templates.length];
      const out = renderVariables(template, {
        cliente: randomValue(),
        numero: randomValue(),
        remitente: randomValue(),
        organizacion: randomValue(),
      });
      const label = JSON.stringify(out);
      expect(out, label).not.toContain("{{");
      expect(out, label).not.toContain("}}");
      expect(out, label).not.toContain("**");
      expect(out, label).not.toContain("](");
      const parsed = parseBasicFormat(out);
      if (parsed.ok) {
        expect(parsed.html, label).not.toContain("<a ");
        expect(parsed.html, label).not.toContain("<strong");
      }
      const clean = sanitizeVariableValue(randomValue());
      expect(snippetLength(clean)).toBeLessThanOrEqual(SNIPPET_VARIABLE_VALUE_MAX_LENGTH);
    }
  });

  it("deja tal cual una variable que no es una de las cuatro", () => {
    expect(renderVariables("{{otra}}", ALL_VALUES)).toBe("{{otra}}");
  });
});

describe("caracteres no permitidos y texto listo para guardar", () => {
  it("el texto de varias líneas deja pasar el tabulador y el salto de línea; el de una línea no", () => {
    expect(hasUnsafeSnippetCharacters("a\tb\nc", true)).toBe(false);
    expect(hasUnsafeSnippetCharacters("a\tb", false)).toBe(true);
    expect(hasUnsafeSnippetCharacters("a\nb", false)).toBe(true);
  });

  const unsafe: [string, string][] = [
    ["\u0001", "control"],
    ["\u000d", "retorno de carro"],
    ["\u007f", "DEL"],
    ["\u0085", "C1"],
    ["\u00ad", "guion blando"],
    ["\u200b", "ancho cero"],
    ["\u200f", "marca de dirección"],
    ["\u2028", "separador de línea"],
    ["\u202e", "inversión de dirección"],
    ["\u2066", "aislamiento bidi"],
    ["\ufeff", "BOM"],
    ["\u{e0041}", "etiqueta Unicode"],
  ];
  for (const [char, name] of unsafe) {
    it(`rechaza ${name}`, () => {
      expect(hasUnsafeSnippetCharacters(`a${char}b`, true)).toBe(true);
      expect(hasUnsafeSnippetCharacters(`a${char}b`, false)).toBe(true);
    });
  }

  it("acepta tildes, eñes, emojis y símbolos corrientes", () => {
    expect(hasUnsafeSnippetCharacters("Señor Peña: ¡cotización!  — 50% (IVA) 😀 «ok»", true)).toBe(
      false,
    );
  });

  it("normaliza: saltos de Windows a uno solo, sin espacios ni saltos en los bordes", () => {
    expect(normalizeSnippetBody("  \r\nHola\r\n\r\nChao\r  \n")).toBe("Hola\n\nChao");
    expect(normalizeSnippetName("  Mi texto \t")).toBe("Mi texto");
    expect(normalizeSnippetName("\u00a0Mi texto")).toBe("\u00a0Mi texto");
  });

  it("normaliza a NFC: la tilde separada queda unida a la letra", () => {
    const separated = "Condicio\u0301n";
    const joined = "Condici\u00f3n";
    expect(separated).not.toBe(joined);
    expect(normalizeSnippetName(separated)).toBe(joined);
    expect(normalizeSnippetBody(`  ${separated}\r\n`)).toBe(joined);
  });

  it("el largo se cuenta por carácter", () => {
    expect(snippetLength("😀😀")).toBe(2);
    expect("😀😀".length).toBe(4);
  });

  it("no hay tipos repetidos", () => {
    expect(new Set(SNIPPET_KINDS).size).toBe(SNIPPET_KINDS.length);
    expect(new Set(SNIPPET_VARIABLES).size).toBe(SNIPPET_VARIABLES.length);
  });
});
