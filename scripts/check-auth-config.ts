// Comprobación de la configuración de Supabase Auth que cierra el ataque de H-116 (registro previo con el correo de otra persona).
// La lista es la de `docs/arquitectura/h-116-registro-seguro.md` §5; las reglas viven en `src/lib/auth/auth-config-rules.ts`.
//
// Lo corre QUIEN OPERA EL PROYECTO de Supabase (Aarón o quien él designe) antes de abrir el piloto y deja la salida guardada junto
// a la lista del piloto de `CLAUDE.md`. SOLO USO MANUAL: usa `tsx` (herramienta de desarrollo) y NO es parte de la aplicación.
//
// Qué consulta:
//  - `GET {url}/auth/v1/settings`: la parte PÚBLICA de la configuración (la llave pública de Supabase basta).
//  - `GET https://api.supabase.com/v1/projects/{ref}/config/auth`: la API de GESTIÓN, que trae casi todo lo demás. Necesita un
//    token personal de quien opera el proyecto. El token se pasa por la variable de entorno `SUPABASE_ACCESS_TOKEN` de ESA
//    máquina, nunca va en el repositorio, en `.env.local` compartido ni en la aplicación. El guion nunca lo muestra.
//
// Uso:
//   SUPABASE_ACCESS_TOKEN=… npm run check:auth-config -- --url https://<ref>.supabase.co --anon-key <llave pública> --ref <ref>
//   npm run check:auth-config -- --public-only --url http://127.0.0.1:56321 --anon-key <llave pública>   (parcial: sin token)
//
// Termina con código 0 solo si TODAS las reglas están en orden. Con `--public-only` solo se evalúan las reglas que la parte pública
// puede contestar y el resultado se declara PARCIAL (no sirve como salida del piloto). Lo que no se pudo leer cuenta como fallo.
import {
  CONFIG_RULES,
  MANUAL_CHECKS,
  allRulesPass,
  evaluateRules,
  type RuleResult,
} from "../src/lib/auth/auth-config-rules";

const MANAGEMENT_API = "https://api.supabase.com";
const REQUEST_TIMEOUT_MS = 15_000;
const REF_PATTERN = /^[a-z0-9]{20}$/;

type Args = { url?: string; anonKey?: string; ref?: string; publicOnly: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { publicOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--public-only") args.publicOnly = true;
    else if (flag === "--url") args.url = argv[++index];
    else if (flag === "--anon-key") args.anonKey = argv[++index];
    else if (flag === "--ref") args.ref = argv[++index];
    else throw new Error(`Argumento desconocido: ${flag}`);
  }
  return args;
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`  ${new URL(url).host}: respondió ${response.status}`);
      return null;
    }
    return (await response.json()) as unknown;
  } catch {
    console.error(`  ${new URL(url).host}: no respondió`);
    return null;
  }
}

function print(results: readonly RuleResult[]): void {
  const mark = { ok: "OK   ", fail: "FALLA", unknown: "?????" } as const;
  for (const result of results) {
    console.log(
      `  [${mark[result.status]}] (${result.point}) ${result.label}\n          ${result.detail}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.anonKey) {
    throw new Error(
      "Faltan --url (la dirección del proyecto de Supabase) y --anon-key (su llave pública).",
    );
  }
  const baseUrl = args.url.replace(/\/+$/, "");
  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();

  console.log(`Configuración de Supabase Auth de ${new URL(baseUrl).host}`);
  const publicSettings = await getJson(`${baseUrl}/auth/v1/settings`, { apikey: args.anonKey });

  let management: unknown | null = null;
  if (!args.publicOnly) {
    if (!token || !args.ref) {
      throw new Error(
        "Falta el token (variable SUPABASE_ACCESS_TOKEN) o --ref. Para una comprobación parcial, sin token, usa --public-only.",
      );
    }
    if (!REF_PATTERN.test(args.ref))
      throw new Error("--ref no parece la referencia de un proyecto de Supabase.");
    management = await getJson(`${MANAGEMENT_API}/v1/projects/${args.ref}/config/auth`, {
      authorization: `Bearer ${token}`,
    });
  }

  const evaluated = evaluateRules({ publicSettings, management });
  // En una comprobación parcial solo cuentan las reglas que la parte pública puede contestar.
  const results = args.publicOnly
    ? evaluated.filter((result) => CONFIG_RULES.find((rule) => rule.id === result.id)?.public)
    : evaluated;
  print(results);

  console.log("\nA mano (este guion no puede comprobarlo):");
  for (const check of MANUAL_CHECKS) console.log(`  [ A MANO ] (${check.point}) ${check.label}`);

  const passed = allRulesPass(results);
  if (args.publicOnly) {
    console.log(
      `\nRESULTADO PARCIAL (solo la parte pública, ${results.length} reglas): ${passed ? "en orden" : "HAY FALLAS"}. No reemplaza la comprobación completa del piloto.`,
    );
  } else {
    console.log(
      `\nRESULTADO: ${passed ? "TODO EN ORDEN (falta lo que está «A MANO»)" : "HAY FALLAS O DATOS QUE NO SE PUDIERON LEER"}`,
    );
  }
  if (!passed || publicSettings === null) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Error desconocido");
  process.exitCode = 1;
});
