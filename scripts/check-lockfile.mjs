// npm en Windows a veces borra del lockfile dependencias opcionales que Linux necesita,
// y entonces `npm ci` falla en GitHub Actions. Este control lo detecta antes de subir.
import { readFileSync } from "node:fs";

const REQUIRED_LOCK_ENTRIES = ["node_modules/@emnapi/core", "node_modules/@emnapi/runtime"];

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const missing = REQUIRED_LOCK_ENTRIES.filter((entry) => !(entry in lock.packages));

if (missing.length > 0) {
  console.error(
    `package-lock.json incompleto (faltan: ${missing.join(", ")}). ` +
      "Regenerar: borrar node_modules y package-lock.json y correr npm install.",
  );
  process.exit(1);
}
