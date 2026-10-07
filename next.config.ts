import type { NextConfig } from "next";
import { LOGO_CONTENT_SECURITY_POLICY } from "./src/lib/brand/headers";

const isDev = process.env.NODE_ENV !== "production";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

// CSP inicial. Next.js inserta scripts en línea, por eso 'unsafe-inline' en script-src;
// más adelante se puede pasar a una CSP con nonce. 'unsafe-eval' solo en desarrollo.
const buildContentSecurityPolicy = (frameAncestors: "'none'" | "'self'") =>
  [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabaseUrl}${isDev ? " ws: wss:" : ""}`.trim(),
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
const contentSecurityPolicy = buildContentSecurityPolicy("'none'");
// El PDF de la cotización es lo único que la propia aplicación enmarca (vista previa de enviar).
// Conserva TODA la política base y solo cambia quién puede enmarcarlo.
const pdfContentSecurityPolicy = buildContentSecurityPolicy("'self'");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // La insignia flotante del modo de desarrollo cae justo sobre el botón «Cerrar sesión» del menú vertical
  // y tapa el clic en las pruebas locales; los errores de compilación se siguen mostrando.
  devIndicators: false,
  // El PDF se arma en el servidor con @react-pdf/renderer; las tipografías incrustadas viven en el
  // repositorio y hay que llevarlas al despliegue (se leen en tiempo de ejecución, no se importan).
  serverExternalPackages: ["@react-pdf/renderer"],
  outputFileTracingIncludes: {
    "/api/v1/tenants/[tenantId]/quotes/[quoteId]/pdf": ["./src/lib/pdf/fonts/**/*"],
    // El envío (H-029) arma el PDF dentro de una acción de la pantalla de enviar.
    "/o/[tenantId]/cotizaciones/[quoteId]/enviar": ["./src/lib/pdf/fonts/**/*"],
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
      // El enlace del cliente (H-030) lo abre cualquiera con el token: nada se guarda en cachés ni en
      // buscadores, y al salir de la página no se manda la dirección (lleva el token) a ningún sitio.
      ...["/c/:path*", "/api/v1/public/:path*"].map((source) => ({
        source,
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      })),
      // La vista previa de enviar muestra el PDF dentro de la propia aplicación (iframe del mismo
      // origen): solo este archivo puede enmarcarse, y solo desde nuestras pantallas.
      {
        source: "/api/v1/tenants/:tenantId/quotes/:quoteId/pdf",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: pdfContentSecurityPolicy },
        ],
      },
      // El logo es un archivo de una organización: política propia y estricta, más fuerte que la general.
      {
        source: "/api/v1/tenants/:tenantId/logo",
        headers: [{ key: "Content-Security-Policy", value: LOGO_CONTENT_SECURITY_POLICY }],
      },
    ];
  },
};

export default nextConfig;
