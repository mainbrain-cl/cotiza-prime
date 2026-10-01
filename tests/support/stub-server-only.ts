// Playwright carga el código de la aplicación fuera de Next.js, y el paquete "server-only" lanza
// error ahí. Vitest lo reemplaza con un alias; Playwright, con este parche. Se importa PRIMERO.
import Module from "node:module";

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internal = Module as unknown as { _load: Loader };
const original = internal._load;

internal._load = function patched(request, parent, isMain) {
  if (request === "server-only") return {};
  return original.call(this, request, parent, isMain);
};
