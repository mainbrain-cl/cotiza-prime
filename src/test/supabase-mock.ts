import { vi } from "vitest";

type QueryResult = { data: unknown; error: { code?: string } | null };

/** Constructor de consultas falso: cualquier cadena de métodos termina en el resultado indicado. */
export function queryBuilder(result: QueryResult) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "update", "order", "limit"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  builder.then = (resolve: (value: QueryResult) => unknown) =>
    Promise.resolve(result).then(resolve);
  return builder;
}

/** Marcador de las redirecciones y del "No encontrado" de Next, que funcionan lanzando un error. */
export class RedirectSignal extends Error {
  constructor(public readonly target: string) {
    super(`redirect:${target}`);
  }
}
export class NotFoundSignal extends Error {
  constructor() {
    super("not-found");
  }
}
