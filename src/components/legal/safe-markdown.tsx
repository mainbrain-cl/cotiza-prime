import type { ReactNode } from "react";

/**
 * Renderizador mínimo de Markdown para los textos legales, sin librerías y sin HTML crudo.
 * Todo texto pasa por React, que lo escapa; no existe `dangerouslySetInnerHTML`.
 * Soporta: títulos (#, ##, ###), párrafos, listas (con viñetas y numeradas), citas (>),
 * tablas simples, **negrita**, `código` y [enlaces](/ruta o https://...).
 */

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
const LINK_PATTERN = /^\[([^\]]+)\]\(([^)\s]+)\)$/;
const SAFE_URL_PATTERN = /^(\/(?!\/)|https:\/\/)/;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE_PATTERN).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={key} className="font-semibold text-foreground">
          {renderInline(part.slice(2, -2), key)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = LINK_PATTERN.exec(part);
    if (link && SAFE_URL_PATTERN.test(link[2])) {
      const external = link[2].startsWith("https://");
      return (
        <a
          key={key}
          href={link[2]}
          className="text-foreground underline underline-offset-4"
          {...(external ? { rel: "noopener noreferrer", target: "_blank" } : {})}
        >
          {link[1]}
        </a>
      );
    }
    return part;
  });
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const isTableSeparator = (line: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line);

export function SafeMarkdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let blockIndex = 0;
  const nextKey = () => `b${blockIndex++}`;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const key = nextKey();
      const content = renderInline(heading[2], key);
      if (level === 1) {
        blocks.push(
          <h1 key={key} className="text-3xl font-semibold tracking-tight text-foreground">
            {content}
          </h1>,
        );
      } else if (level === 2) {
        blocks.push(
          <h2 key={key} className="mt-10 text-xl font-semibold tracking-tight text-foreground">
            {content}
          </h2>,
        );
      } else {
        blocks.push(
          <h3 key={key} className="mt-6 text-base font-semibold text-foreground">
            {content}
          </h3>,
        );
      }
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const key = nextKey();
      blocks.push(
        <blockquote
          key={key}
          role="note"
          className="rounded-lg border border-border bg-muted p-4 text-foreground"
        >
          {renderInline(quoted.join(" "), key)}
        </blockquote>,
      );
      continue;
    }

    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const key = nextKey();
      blocks.push(
        <div key={key} className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
            <thead className="bg-muted text-foreground">
              <tr>
                {header.map((cell, c) => (
                  <th key={c} scope="col" className="px-3 py-2 font-semibold">
                    {renderInline(cell, `${key}-h${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r} className="border-t border-border align-top">
                  {row.map((cell, c) => (
                    <td key={c} className="px-3 py-2">
                      {renderInline(cell, `${key}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const unordered = /^[-*]\s+/.test(line);
    const ordered = /^\d+\.\s+/.test(line);
    if (unordered || ordered) {
      const marker = unordered ? /^[-*]\s+/ : /^\d+\.\s+/;
      const items: string[] = [];
      while (i < lines.length && marker.test(lines[i])) {
        items.push(lines[i].replace(marker, ""));
        i++;
      }
      const key = nextKey();
      const children = items.map((item, n) => (
        <li key={n} className="pl-1">
          {renderInline(item, `${key}-${n}`)}
        </li>
      ));
      blocks.push(
        unordered ? (
          <ul key={key} className="list-disc space-y-2 pl-6">
            {children}
          </ul>
        ) : (
          <ol key={key} className="list-decimal space-y-2 pl-6">
            {children}
          </ol>
        ),
      );
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3}\s|>|[-*]\s|\d+\.\s)/.test(lines[i]) &&
      !lines[i].trim().startsWith("|")
    ) {
      paragraph.push(lines[i]);
      i++;
    }
    if (paragraph.length === 0) {
      // Línea que ningún bloque reconoce: se trata como párrafo para no quedar en bucle.
      paragraph.push(lines[i]);
      i++;
    }
    const key = nextKey();
    blocks.push(<p key={key}>{renderInline(paragraph.join(" "), key)}</p>);
  }

  return <div className="space-y-4 leading-relaxed text-muted-foreground">{blocks}</div>;
}
