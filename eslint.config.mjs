import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "base-tecnica/**",
    "playwright-report/**",
    "test-results/**",
    ".claude/**",
  ]),

  // La cabecera de la organización activa solo se escribe en constants.ts (modelo-datos.md §2.3).
  {
    files: ["src/**/*.{ts,tsx}", "e2e/**/*.ts"],
    ignores: ["src/lib/tenant/constants.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/x-cp-tenant-id/i]",
          message:
            "El nombre de la cabecera de la organización solo se escribe en src/lib/tenant/constants.ts. Importa TENANT_HEADER.",
        },
        {
          selector: "TemplateElement[value.raw=/x-cp-tenant-id/i]",
          message:
            "El nombre de la cabecera de la organización solo se escribe en src/lib/tenant/constants.ts. Importa TENANT_HEADER.",
        },
      ],
    },
  },

  // La llave maestra (service_role) solo se importa donde se permite (modelo-datos.md §4.6).
  {
    files: ["**/*.{ts,tsx,mjs,js}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/admin-client", "**/admin-client.ts"],
              message:
                "El cliente con la llave maestra solo puede importarse desde src/lib/audit/, src/lib/security/, src/lib/brand/logo-storage.ts, src/lib/quotes/send/document-storage.ts, src/lib/share/gateway.ts, src/server/jobs/, scripts/ y tests/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/lib/audit/**",
      "src/lib/security/**",
      // Subida de logos ya limpiados: único uso de la llave maestra en el módulo de marca (H-007).
      "src/lib/brand/logo-storage.ts",
      // PDF y logo congelados de cada envío (H-029): único uso de la llave maestra en cotizaciones.
      "src/lib/quotes/send/document-storage.ts",
      // El portero del enlace del cliente (H-030, decisión 017): tres funciones y el PDF congelado.
      "src/lib/share/gateway.ts",
      "src/server/jobs/**",
      "scripts/**",
      "tests/**",
    ],
    rules: { "no-restricted-imports": "off" },
  },
]);

export default eslintConfig;
