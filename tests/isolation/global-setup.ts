// Montaje global de la prueba de aislamiento: arma la fixture una sola vez y la comparte con todos
// los archivos. Un inicio de sesión por persona y ejecución, así no se toca el límite de ingresos.
import { randomUUID } from "node:crypto";
import type { TestProject } from "vitest/node";
import { createIsolationFixture, type IsolationFixture } from "./fixture";

declare module "vitest" {
  export interface ProvidedContext {
    fixture: IsolationFixture;
  }
}

export default async function setup(project: TestProject) {
  const runId = randomUUID().slice(0, 8);
  project.provide("fixture", await createIsolationFixture(runId));
}
