// Descubre en el código TODA pantalla (`page.*`) y TODA ruta de servidor (`route.*`) bajo
// `src/app`, para que ninguna quede fuera del registro de aislamiento (guardia G5 y guardia
// estática 3). Solo bajo Vitest: lee archivos, sin red.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { AppRoute } from "./registry";

const ROUTE_FILE = /^(page|route)\.(ts|tsx|js|jsx|mjs|cjs)$/;
/** Archivos de prueba que conviven con la ruta (p. ej. `route.test.ts`) no son rutas. */
const TEST_FILE = /\.(test|spec)\.[a-z]+$/;

export interface DiscoveredRoute {
  path: string;
  kind: AppRoute["kind"];
  /** Archivo del que sale, relativo a `src/app` (para mensajes de error). */
  file: string;
  /** Ruta absoluta del archivo. */
  absoluteFile: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** `(grupo)` y `@ranura` no forman parte de la dirección. */
const isInvisibleSegment = (segment: string) => /^\(.*\)$/.test(segment) || segment.startsWith("@");

export function discoverAppRoutes(appDir: string): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];
  for (const absoluteFile of walk(appDir)) {
    const base = path.basename(absoluteFile);
    const match = base.match(ROUTE_FILE);
    if (!match || TEST_FILE.test(base)) continue;
    const relFile = path.relative(appDir, absoluteFile).split(path.sep).join("/");
    const segments = path
      .relative(appDir, path.dirname(absoluteFile))
      .split(path.sep)
      .filter((s) => s !== "" && !isInvisibleSegment(s));
    const urlPath = "/" + segments.join("/");
    const isApi = match[1] === "route" && (urlPath === "/api/v1" || urlPath.startsWith("/api/v1/"));
    found.push({
      path: urlPath,
      kind: match[1] === "page" ? "page" : isApi ? "api" : "route",
      file: relFile,
      absoluteFile,
    });
  }
  return found;
}

/** Clave que une una ruta descubierta con una del registro. */
export const routeKey = (route: Pick<AppRoute, "path" | "kind">) => `${route.kind} ${route.path}`;
