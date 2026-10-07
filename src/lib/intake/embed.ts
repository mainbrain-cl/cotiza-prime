/**
 * Formulario público incrustable (H-093). Tres piezas puras:
 *  - `isValidEmbedOrigin`: qué sitios se pueden autorizar para mostrar el formulario.
 *  - `buildEmbedCsp`: la política `frame-ancestors` con solo esos sitios (nunca texto sin validar).
 *  - `buildEmbedSnippet`: el código que la organización pega en su sitio (un `iframe` y un script
 *    corto escrito como texto; nunca un `<script src>` nuestro dentro del sitio del cliente).
 */

import { SINGLE_LINE_UNSAFE } from "./unsafe-text";

export const MAX_EMBED_ORIGINS = 10;
export const MAX_EMBED_ORIGIN_LENGTH = 255;
export const EMBED_MIN_HEIGHT_PX = 200;
export const EMBED_MAX_HEIGHT_PX = 4_000;
export const EMBED_INITIAL_HEIGHT_PX = 640;
export const EMBED_MESSAGE_SOURCE = "cotiza-prime";
export const EMBED_MESSAGE_TYPE = "resize";
export const DEFAULT_EMBED_TITLE = "Solicitar una cotización";
export const MAX_EMBED_TITLE_LENGTH = 100;
const MAX_PORT = 65_535;
const BACKSLASH = String.fromCharCode(92);
const WHITESPACE_RUN = new RegExp(`${BACKSLASH}s+`, "g");
/** Escritura `\uXXXX` de un carácter, armada sin escribir la barra invertida a mano. */
const jsEscape = (code: number) => `${BACKSLASH}u${code.toString(16).padStart(4, "0")}`;
const UNSAFE_GLOBAL = new RegExp(SINGLE_LINE_UNSAFE.source, "gu");
const LINE_SEPARATORS = new RegExp(
  `[${String.fromCodePoint(0x2028)}${String.fromCodePoint(0x2029)}]`,
  "g",
);

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// Solo https, minúsculas, al menos un punto, sin comodines, rutas, usuarios, espacios ni `;`.
const EMBED_ORIGIN_PATTERN = new RegExp(
  `^https://(${HOST_LABEL}(?:\\.${HOST_LABEL})+)(?::([0-9]{1,5}))?$`,
);
// La dirección propia de la aplicación: https, o http solo en la máquina local (desarrollo).
const APP_ORIGIN_PATTERN = new RegExp(
  `^(?:https://${HOST_LABEL}(?:\\.${HOST_LABEL})*|http://(?:localhost|127\\.0\\.0\\.1))(?::[0-9]{1,5})?$`,
);

export class EmbedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedError";
  }
}

function portInRange(port: string | undefined): boolean {
  if (port === undefined) return true;
  const value = Number(port);
  return value >= 1 && value <= MAX_PORT && String(value) === port;
}

/** ¿Es un sitio que se puede autorizar para incrustar el formulario? */
export function isValidEmbedOrigin(origin: unknown): origin is string {
  if (typeof origin !== "string" || origin.length > MAX_EMBED_ORIGIN_LENGTH) return false;
  const match = EMBED_ORIGIN_PATTERN.exec(origin);
  return match !== null && portInRange(match[2]);
}

function isValidAppOrigin(origin: unknown): origin is string {
  if (typeof origin !== "string" || origin.length > MAX_EMBED_ORIGIN_LENGTH) return false;
  if (!APP_ORIGIN_PATTERN.test(origin)) return false;
  const port = /:([0-9]{1,5})$/.exec(origin)?.[1];
  return portInRange(port);
}

/**
 * Valor de `frame-ancestors` para `/incrustar`. Con la lista vacía, `'none'`: nadie puede mostrarlo.
 * Lanza `EmbedError` si algún origen no es válido: nunca se arma una política con texto dudoso.
 */
export function buildEmbedCsp(origins: readonly string[]): string {
  if (origins.length > MAX_EMBED_ORIGINS) {
    throw new EmbedError(`Se pueden autorizar hasta ${MAX_EMBED_ORIGINS} sitios.`);
  }
  const unique = [...new Set(origins)];
  for (const origin of unique) {
    if (!isValidEmbedOrigin(origin)) throw new EmbedError("Uno de los sitios no es válido.");
  }
  if (unique.length === 0) return "frame-ancestors 'none'";
  return `frame-ancestors ${unique.join(" ")}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

/** Texto del título del marco: sin controles ni invisibles, acotado y escapado. */
function safeTitle(title: string | undefined): string {
  const base = (title ?? DEFAULT_EMBED_TITLE)
    .replace(UNSAFE_GLOBAL, " ")
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .slice(0, MAX_EMBED_TITLE_LENGTH);
  return escapeHtml(base === "" ? DEFAULT_EMBED_TITLE : base);
}

/** Literal de JavaScript seguro para pegar dentro de `<script>`: sin `<`, `>`, `&` ni separadores. */
function jsString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, jsEscape(0x3c))
    .replace(/>/g, jsEscape(0x3e))
    .replace(/&/g, jsEscape(0x26))
    .replace(LINE_SEPARATORS, (ch) => jsEscape(ch.codePointAt(0) ?? 0));
}

export type EmbedSnippetOptions = { title?: string };

/**
 * Código para pegar en el sitio de la organización. El script ajusta la altura solo si el mensaje
 * viene de la dirección de la aplicación Y de ese mismo marco, y la acota a 200–4.000 px.
 */
export function buildEmbedSnippet(
  appOrigin: string,
  publicId: string,
  options: EmbedSnippetOptions = {},
): string {
  if (!isValidAppOrigin(appOrigin))
    throw new EmbedError("La dirección de la aplicación no es válida.");
  if (typeof publicId !== "string" || !PUBLIC_ID_PATTERN.test(publicId)) {
    throw new EmbedError("El identificador del formulario no es válido.");
  }
  const src = escapeHtml(`${appOrigin}/f/${publicId}/incrustar`);
  const title = safeTitle(options.title);
  const origin = jsString(appOrigin);

  return [
    `<iframe src="${src}" title="${title}" loading="lazy" style="width:100%;height:${EMBED_INITIAL_HEIGHT_PX}px;border:0;"></iframe>`,
    "<script>",
    "(function () {",
    "  var frame = document.currentScript.previousElementSibling;",
    `  var origin = ${origin};`,
    '  window.addEventListener("message", function (event) {',
    "    var data = event.data;",
    "    if (event.origin !== origin || !frame || event.source !== frame.contentWindow) return;",
    `    if (!data || data.source !== "${EMBED_MESSAGE_SOURCE}" || data.type !== "${EMBED_MESSAGE_TYPE}") return;`,
    '    if (typeof data.height !== "number" || !isFinite(data.height)) return;',
    `    frame.style.height = Math.min(${EMBED_MAX_HEIGHT_PX}, Math.max(${EMBED_MIN_HEIGHT_PX}, Math.round(data.height))) + "px";`,
    "  });",
    "})();",
    "</script>",
  ].join("\n");
}
