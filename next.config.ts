import type { NextConfig } from "next";
import { LOGO_CONTENT_SECURITY_POLICY } from "./src/lib/brand/headers";

const isDev = process.env.NODE_ENV !== "production";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

// CSP inicial. Next.js inserta scripts en línea, por eso 'unsafe-inline' en script-src;
// más adelante se puede pasar a una CSP con nonce. 'unsafe-eval' solo en desarrollo.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseUrl}${isDev ? " ws: wss:" : ""}`.trim(),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // El PDF se arma en el servidor con @react-pdf/renderer; las tipografías incrustadas viven en el
  // repositorio y hay que llevarlas al despliegue (se leen en tiempo de ejecución, no se importan).
  serverExternalPackages: ["@react-pdf/renderer"],
  outputFileTracingIncludes: {
    "/api/v1/tenants/[tenantId]/quotes/[quoteId]/pdf": ["./src/lib/pdf/fonts/**/*"],
  },
  experimental: {
    // El logo (hasta 1 MB, LOGO_MAX_BYTES) viaja en el formulario de Marca; el límite por defecto es 1 MB.
    serverActions: { bodySizeLimit: "2mb" },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Todo lo que depende de quien lo mira es privado: nunca se guarda en cachés compartidas
      // (STACK.md §6b). Las pantallas de una organización y las de cuenta lo exigen.
      ...["/o/:path*", "/organizaciones/:path*", "/aceptar-terminos"].map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }],
      })),
      // El logo es un archivo de una organización: política propia y estricta, más fuerte que la general.
      {
        source: "/api/v1/tenants/:tenantId/logo",
        headers: [{ key: "Content-Security-Policy", value: LOGO_CONTENT_SECURITY_POLICY }],
      },
    ];
  },
};

export default nextConfig;
