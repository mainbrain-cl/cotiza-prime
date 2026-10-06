/**
 * Formato básico del texto del correo (PROYECTO.md §13.8). Lector propio, sin librerías: el
 * comercial escribe texto plano con unas pocas marcas y NUNCA HTML libre.
 *
 *   **texto**            negrita
 *   - ítem               lista (una línea por ítem)
 *   [texto](https://...) enlace, solo https
 *   línea en blanco      párrafo nuevo; salto simple = salto de línea
 *
 * Todo lo demás se escapa: lo que parezca HTML se muestra como texto. Lo que no calza con una
 * marca (por ejemplo un enlace `javascript:` o `http://`) queda como texto literal, inofensivo.
 */

import { BODY_UNSAFE } from "./unsafe-characters";

export const MAX_BODY_LENGTH = 5_000;
export const MAX_LINKS = 20;
const MAX_URL_LENGTH = 2_000;
const DEFAULT_LINK_COLOR = "#2245c2";
const PARAGRAPH_STYLE = "margin:0 0 16px 0;";
const LIST_STYLE = "margin:0 0 16px 0;padding-left:24px;";

export type BasicFormatErrorCode =
  "empty" | "too_long" | "control_characters" | "too_many_links" | "misleading_link";

export type BasicFormatResult =
  { ok: true; html: string; text: string } | { ok: false; code: BasicFormatErrorCode };

export const BASIC_FORMAT_ERROR_MESSAGES: Record<BasicFormatErrorCode, string> = {
  empty: "El texto del correo no puede estar vacío.",
  too_long: `El texto del correo no puede pasar de ${MAX_BODY_LENGTH.toLocaleString("es-CL")} caracteres.`,
  control_characters:
    "El texto del correo tiene caracteres que no se pueden enviar. Vuelve a escribirlo.",
  too_many_links: `El texto del correo no puede tener más de ${MAX_LINKS} enlaces.`,
  misleading_link:
    "Un enlace muestra una dirección distinta a la que realmente abre. Escribe un texto descriptivo en vez de una dirección.",
};

// Control C0 (salvo tab y salto de línea), DEL y C1, separadores de línea/párrafo, marcas de
// dirección (bidi), espacios de ancho cero y BOM: sirven para esconder o disfrazar texto.
const FORBIDDEN_CHARACTERS = BODY_UNSAFE;

const INLINE_PATTERN = /\[([^[\]\n]{1,200})\]\((https:\/\/[^\s()<>"'`\\]+)\)|\*\*([^*\n]+?)\*\*/gu;
const LIST_ITEM_PATTERN = /^- (.*)$/;
const URL_LIKE_TEXT = /(?:https?:\/\/|www\.)([^\s/]+)/i;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function safeHttpsUrl(candidate: string): URL | null {
  if (candidate.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, "");

type Inline = { html: string; text: string };
type Context = { links: number; linkColor: string; failure: BasicFormatErrorCode | null };

function renderInline(source: string, context: Context): Inline {
  let html = "";
  let text = "";
  let cursor = 0;
  for (const match of source.matchAll(INLINE_PATTERN)) {
    const index = match.index;
    const literal = source.slice(cursor, index);
    html += escapeHtml(literal);
    text += literal;
    cursor = index + match[0].length;

    const [whole, label, href, bold] = match;
    if (bold !== undefined) {
      html += `<strong>${escapeHtml(bold)}</strong>`;
      text += bold;
      continue;
    }
    const url = safeHttpsUrl(href);
    if (!url) {
      // No es un enlace permitido: se muestra tal cual, como texto.
      html += escapeHtml(whole);
      text += whole;
      continue;
    }
    // Un texto que parece una dirección distinta a la real es la forma clásica de engañar.
    const shown = URL_LIKE_TEXT.exec(label);
    if (shown && stripWww(shown[1]) !== stripWww(url.host)) {
      context.failure = "misleading_link";
    }
    context.links += 1;
    html += `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer" style="color:${context.linkColor};text-decoration:underline;">${escapeHtml(label)}</a>`;
    text += `${label} (${url.href})`;
  }
  const rest = source.slice(cursor);
  html += escapeHtml(rest);
  text += rest;
  return { html, text };
}

/** Convierte el texto del comercial en HTML seguro y en texto plano. */
export function parseBasicFormat(
  input: string,
  options: { linkColor?: string } = {},
): BasicFormatResult {
  // Los saltos de línea de Windows se normalizan; cualquier otro \r suelto se rechaza abajo.
  const normalized = input.replace(/\r\n/g, "\n");
  if (normalized.length > MAX_BODY_LENGTH) return { ok: false, code: "too_long" };
  if (normalized.includes("\r") || FORBIDDEN_CHARACTERS.test(normalized)) {
    return { ok: false, code: "control_characters" };
  }
  if (normalized.trim().length === 0) return { ok: false, code: "empty" };

  const context: Context = {
    links: 0,
    linkColor: /^#[0-9a-f]{6}$/i.test(options.linkColor ?? "")
      ? options.linkColor!
      : DEFAULT_LINK_COLOR,
    failure: null,
  };

  const htmlBlocks: string[] = [];
  const textBlocks: string[] = [];
  let paragraph: Inline[] = [];
  let items: Inline[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    htmlBlocks.push(
      `<p style="${PARAGRAPH_STYLE}">${paragraph.map((p) => p.html).join("<br>")}</p>`,
    );
    textBlocks.push(paragraph.map((p) => p.text).join("\n"));
    paragraph = [];
  };
  const flushList = () => {
    if (items.length === 0) return;
    htmlBlocks.push(
      `<ul style="${LIST_STYLE}">${items.map((i) => `<li>${i.html}</li>`).join("")}</ul>`,
    );
    textBlocks.push(items.map((i) => `- ${i.text}`).join("\n"));
    items = [];
  };

  for (const line of normalized.split("\n")) {
    const trimmedEnd = line.replace(/[ \t]+$/, "");
    if (trimmedEnd.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const item = LIST_ITEM_PATTERN.exec(trimmedEnd);
    if (item) {
      flushParagraph();
      items.push(renderInline(item[1], context));
    } else {
      flushList();
      paragraph.push(renderInline(trimmedEnd, context));
    }
    if (context.links > MAX_LINKS) return { ok: false, code: "too_many_links" };
  }
  flushParagraph();
  flushList();

  if (context.failure) return { ok: false, code: context.failure };
  return { ok: true, html: htmlBlocks.join(""), text: textBlocks.join("\n\n") };
}
