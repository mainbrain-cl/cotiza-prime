/**
 * Limpieza de un logo SVG (SEGURIDAD.md §3; H-007: "limpiar SVG de código").
 *
 * Un SVG es un documento que puede llevar scripts, controladores de eventos (`onload=`), enlaces a
 * recursos externos y estilos que descargan cosas. Aquí NUNCA se pasa nada del archivo original:
 * se lee con un lector estricto y se vuelve a escribir desde cero SOLO con las etiquetas, los
 * atributos y los valores de una lista cerrada, escapando todo texto. Lo que no está en la lista:
 *
 * - Código y datos de editores (script, foreignObject, animaciones, metadatos, etiquetas con prefijo
 *   como `inkscape:`): se eliminan junto con su contenido.
 * - Atributos desconocidos (`onclick`, `data-*`, `xlink:*`, `inkscape:*`): se eliminan.
 * - Etiquetas que dibujan pero que no se pueden incluir con seguridad (`image`, `use`, `filter`,
 *   `a`, `pattern`...): se rechaza el archivo y se le pide a la persona exportarlo como PNG.
 * - Un valor peligroso dentro de un atributo permitido (`fill="url(http://...)"`): se rechaza.
 * - DOCTYPE, entidades y XML mal formado: se rechaza.
 *
 * Sin dependencias: ningún sanitizador de terceros que mantener ni auditar.
 */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const MAX_DEPTH = 32;
const MAX_ELEMENTS = 5_000;
const MAX_TEXT_LENGTH = 20_000;
/** Largo máximo de un bloque de CSS (`<style>` o `style=""`); un logo real usa una fracción de esto. */
const MAX_CSS_LENGTH = 8_000;

/** Etiquetas que se conservan. */
const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "style",
]);

/** Etiquetas que se eliminan con todo su contenido, sin rechazar el archivo. */
const DROPPED_ELEMENTS = new Set([
  "script",
  "foreignObject",
  "set",
  "animate",
  "animateMotion",
  "animateTransform",
  "metadata",
]);

/** Etiquetas que aceptan texto dentro. */
const TEXT_ELEMENTS = new Set(["text", "tspan", "title", "desc", "style"]);

/** Atributos que se conservan (el resto se elimina). */
const ALLOWED_ATTRIBUTES = new Set([
  "id",
  "class",
  "style",
  "x",
  "y",
  "width",
  "height",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "x1",
  "y1",
  "x2",
  "y2",
  "d",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "href",
  "clip-path",
  "clip-rule",
  "clipPathUnits",
  "mask",
  "maskUnits",
  "maskContentUnits",
  "viewBox",
  "preserveAspectRatio",
  "version",
  "xmlns",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
  "display",
  "visibility",
  "role",
  "aria-label",
]);

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export type SvgResult = { ok: true; svg: string } | { ok: false; reason: string };

class SvgRejected extends Error {}

function reject(reason: string): never {
  throw new SvgRejected(reason);
}

const MALFORMED = "El SVG está mal formado.";
const UNSAFE = "El SVG trae contenido que no podemos incluir con seguridad.";

/** Convierte `&amp;`, `&#65;`… en texto. Cualquier otra entidad (o un `&` suelto) rechaza el archivo. */
function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&([^;\s&]{1,10});|&/g, (match, body: string | undefined) => {
    if (body === undefined) return reject(MALFORMED);
    if (body in XML_ENTITIES) return XML_ENTITIES[body];
    const numeric = /^#(?:x([0-9a-fA-F]{1,6})|(\d{1,7}))$/.exec(body);
    if (!numeric) return reject(UNSAFE);
    const code = numeric[1] ? Number.parseInt(numeric[1], 16) : Number(numeric[2]);
    const isControl = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    if (code === 0 || isControl || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return reject(MALFORMED);
    }
    return String.fromCodePoint(code);
  });
}

const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, "&quot;");

const SAFE_URL_REFERENCE = /url\(\s*['"]?#[\w.-]+['"]?\s*\)/g;

/** Quita las referencias internas `url(#id)` (las únicas permitidas) para revisar el resto. */
const withoutInternalReferences = (value: string) => value.replace(SAFE_URL_REFERENCE, "ref");

const FORBIDDEN_IN_VALUES = /javascript|vbscript|data:|expression|behavior|binding|@import|\\|<|&/i;
const SAFE_VALUE = /^[\p{L}\p{N}\s#%.,()+\-_'":;]*$/u;

function isSafeValue(value: string): boolean {
  const stripped = withoutInternalReferences(value);
  return (
    !FORBIDDEN_IN_VALUES.test(stripped) && !/url\s*\(/i.test(stripped) && SAFE_VALUE.test(stripped)
  );
}

/** Un `style=""` o el contenido de un `<style>`: reglas simples, sin `@`, sin `url()` externo. */
function sanitizeCss(css: string): string {
  if (css.length > MAX_CSS_LENGTH) return reject("El SVG es demasiado complejo.");
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (clean === "") return "";
  const stripped = withoutInternalReferences(clean);
  if (FORBIDDEN_IN_VALUES.test(stripped) || /url\s*\(|@/i.test(stripped)) return reject(UNSAFE);
  // Reglas de la forma `selector, selector { propiedad: valor; ... }`
  // Sin ambigüedad entre repeticiones (cada regla empieza con un selector y termina con `}`): no hay
  // retroceso catastrófico aunque el texto termine en algo que no calza.
  const ruleList =
    /^\s*(?:[.#]?[A-Za-z_][\w-]*(?:\s*,\s*[.#]?[A-Za-z_][\w-]*)*\s*\{[^{}]*\}\s*)*$/.test(stripped);
  const declarationsOnly = !/[{}]/.test(stripped);
  if (!ruleList && !declarationsOnly) return reject(UNSAFE);
  const bodies = ruleList ? [...stripped.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]) : [stripped];
  for (const body of bodies) {
    for (const declaration of body.split(";")) {
      if (declaration.trim() === "") continue;
      if (!/^\s*[a-zA-Z-]+\s*:[\p{L}\p{N}\s#%.,()+\-_'"]*$/u.test(declaration)) {
        return reject(UNSAFE);
      }
    }
  }
  return clean;
}

function readAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /\s+([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  let index = 0;
  while (index < raw.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(raw);
    if (!match) return reject(MALFORMED);
    if (attributes.has(match[1])) return reject(MALFORMED);
    attributes.set(match[1], decodeEntities(match[2] ?? match[3] ?? ""));
    index = pattern.lastIndex;
  }
  return attributes;
}

/** Atributos ya revisados, listos para escribir. */
function cleanAttributes(name: string, attributes: Map<string, string>): [string, string][] {
  const kept: [string, string][] = [];
  for (const [rawKey, value] of attributes) {
    // Los editores antiguos escriben `xlink:href`; es lo mismo que `href` (solo se aceptan referencias internas).
    const key = rawKey === "xlink:href" ? "href" : rawKey;
    // `href` y `xlink:href` a la vez saldrían como dos `href` (XML mal formado): se rechaza.
    if (key === "href" && attributes.has("href") && attributes.has("xlink:href")) {
      return reject(MALFORMED);
    }
    if (!ALLOWED_ATTRIBUTES.has(key)) continue; // onclick, data-*, xlink:*, inkscape:*… se eliminan
    if (key === "xmlns") {
      if (value !== SVG_NAMESPACE) return reject(UNSAFE);
      continue; // se vuelve a escribir en la raíz
    }
    if (key === "href") {
      if (!/^#[\w.-]+$/.test(value)) return reject(UNSAFE); // solo referencias internas
    } else if (key === "id") {
      if (!/^[\w.:-]+$/.test(value)) return reject(UNSAFE);
    } else if (key === "class") {
      if (!/^[\w.:\s-]+$/.test(value)) return reject(UNSAFE);
    } else if (key === "style") {
      kept.push([key, sanitizeCss(value)]);
      continue;
    } else if (!isSafeValue(value)) {
      return reject(UNSAFE);
    }
    kept.push([key, value]);
  }
  if (name === "svg") kept.unshift(["xmlns", SVG_NAMESPACE]);
  return kept;
}

type Frame = { name: string; emit: boolean };

/**
 * Lee y vuelve a escribir un SVG. Devuelve el SVG limpio, o el motivo por el que no se acepta
 * (en español, listo para mostrarle a la persona).
 */
export function sanitizeSvg(source: string): SvgResult {
  try {
    return { ok: true, svg: rewrite(source) };
  } catch (error) {
    if (error instanceof SvgRejected) return { ok: false, reason: error.message };
    throw error;
  }
}

const TAG =
  /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_:][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;

function rewrite(source: string): string {
  if (source.includes("\0")) return reject(MALFORMED);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    return reject("El SVG trae definiciones externas (DOCTYPE o entidades) que no admitimos.");
  }

  const out: string[] = [];
  const stack: Frame[] = [];
  let rootClosed = false;
  let rootSeen = false;
  let elements = 0;
  // Trozos de texto pendientes; las entidades se leen solo si el texto se va a conservar.
  let textParts: { text: string; cdata: boolean }[] = [];
  let index = 0;

  const top = () => stack[stack.length - 1];

  function flushText() {
    const frame = top();
    const parts = textParts;
    textParts = [];
    if (parts.length === 0) return;
    if (frame?.emit && TEXT_ELEMENTS.has(frame.name)) {
      const text = parts
        .map((part) => (part.cdata ? part.text : decodeEntities(part.text)))
        .join("");
      if (text.length > MAX_TEXT_LENGTH) reject(UNSAFE);
      out.push(escapeText(frame.name === "style" ? sanitizeCss(text) : text));
    } else if (!frame && parts.some((part) => part.text.trim() !== "")) {
      reject(MALFORMED); // texto suelto fuera del <svg>
    }
  }

  while (index < source.length) {
    if (source[index] !== "<") {
      const next = source.indexOf("<", index);
      const end = next === -1 ? source.length : next;
      textParts.push({ text: source.slice(index, end), cdata: false });
      index = end;
      continue;
    }
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end === -1) return reject(MALFORMED);
      index = end + 3;
      continue;
    }
    if (source.startsWith("<?", index)) {
      const end = source.indexOf("?>", index + 2);
      if (end === -1) return reject(MALFORMED);
      index = end + 2;
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      // Se admite dentro de <style> (así exportan algunos editores) y dentro de lo que se elimina.
      const frame = top();
      const end = source.indexOf("]]>", index + 9);
      if (end === -1 || !frame || (frame.emit && frame.name !== "style")) return reject(UNSAFE);
      textParts.push({ text: source.slice(index + 9, end), cdata: true });
      index = end + 3;
      continue;
    }
    if (source.startsWith("<!", index)) return reject(UNSAFE);

    TAG.lastIndex = index;
    const match = TAG.exec(source);
    if (!match) return reject(MALFORMED);
    index = TAG.lastIndex;
    const [, closing, name, rawAttributes, selfClosing] = match;

    flushText();

    if (closing) {
      const frame = stack.pop();
      if (!frame || frame.name !== name || rawAttributes.trim() !== "" || selfClosing) {
        return reject(MALFORMED);
      }
      if (frame.emit) out.push(`</${name}>`);
      if (stack.length === 0) rootClosed = true;
      continue;
    }

    if (rootClosed) return reject(MALFORMED); // un solo elemento raíz
    if (stack.length >= MAX_DEPTH) return reject("El SVG es demasiado complejo.");
    if (++elements > MAX_ELEMENTS) return reject("El SVG es demasiado complejo.");

    const parentEmits = stack.length === 0 || top().emit;
    const hasPrefix = name.includes(":");
    const dropped = hasPrefix || DROPPED_ELEMENTS.has(name);
    if (parentEmits && !dropped && !ALLOWED_ELEMENTS.has(name)) {
      return reject(
        "El SVG usa elementos (imágenes incrustadas, filtros, enlaces u otros) que no podemos incluir con seguridad. Expórtalo como PNG.",
      );
    }
    if (stack.length === 0) {
      if (name !== "svg") return reject("El archivo no es un SVG válido.");
      rootSeen = true;
    }
    const emit = parentEmits && !dropped;

    if (emit) {
      const attributes = cleanAttributes(name, readAttributes(rawAttributes));
      const rendered = attributes.map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`);
      out.push(`<${name}${rendered.join("")}${selfClosing ? "/>" : ">"}`);
    }
    if (selfClosing) {
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push({ name, emit });
    }
  }

  flushText();
  if (stack.length > 0 || !rootSeen) return reject(MALFORMED);
  return out.join("");
}
