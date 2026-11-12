import type { NextConfig } from "next";
import { LOGO_CONTENT_SECURITY_POLICY } from "./src/lib/brand/headers";
import { EMBED_ROUTE_EXCLUSION } from "./src/lib/intake/embed-headers";
import { HSTS_VALUE, TURNSTILE_HOST, buildContentSecurityPolicy } from "./src/lib/security/csp";

const isDev = process.env.NODE_ENV !== "production";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const baseCsp = { isDev, supabaseUrl };
const contentSecurityPolicy = buildContentSecurityPolicy({ ...baseCsp, frameAncestors: "'none'" });
// El PDF de la cotización es lo único que la propia aplicación enmarca (vista previa de enviar).
// Conserva TODA la política base y solo cambia quién puede enmarcarlo.
const pdfContentSecurityPolicy = buildContentSecurityPolicy({
  ...baseCsp,
  frameAncestors: "'self'",
});
// Formulario público (H-087): igual que la general, y con Turnstile se abre SOLO a Cloudflare. Sigue
// con `frame-ancestors 'none'`: la versión incrustable es otra ruta (`/f/:publicId/incrustar`, H-093) con
// su propia política, armada en `src/proxy.ts` con la lista de sitios de cada formulario.
const publicFormContentSecurityPolicy = buildContentSecurityPolicy({
  ...baseCsp,
  frameAncestors: "'none'",
  antibotHost: process.env.ANTIBOT_PROVIDER === "turnstile" ? TURNSTILE_HOST : undefined,
});

const securityHeaders = [
  { key: "Strict-Transport-Security", value: HSTS_VALUE },
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
      // Todo lleva `X-Frame-Options: DENY` y `frame-ancestors 'none'` MENOS el formulario incrustable
      // (`/f/:publicId/incrustar`, H-093): `X-Frame-Options` no admite una lista de sitios y, si estuviera,
      // el navegador bloquearía el marco en todos. Su cabecera, con la lista de ese formulario, la arma
      // `src/proxy.ts`. Una prueba vigila que esta sea la ÚNICA exclusión.
      { source: EMBED_ROUTE_EXCLUSION, headers: securityHeaders },
      // Todo lo que depende de quien lo mira es privado: nunca se guarda en cachés compartidas
      // (STACK.md §6b). Las pantallas de una organización y las de cuenta lo exigen.
      ...[
        "/o/:path*",
        "/organizaciones/:path*",
        "/aceptar-terminos",
        "/ingresar/codigo",
        "/cuenta/:path*",
      ].map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }],
      })),
      // Seguridad de la cuenta (H-004a): la pantalla de activar muestra la clave del segundo paso. Al salir no se manda la
      // dirección a ningún sitio.
      {
        source: "/cuenta/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      // Anular la activación del segundo paso (H-118b): el código del enlace va tras el «#» (el navegador no lo manda al
      // servidor). La página es pública y la abre quien recibe el correo: sin cachés ni buscadores, sin pasar la dirección a otros
      // sitios (repite lo de la regla general de `/cuenta`, para que esta no dependa de aquella) y, con `Cross-Origin-Opener-Policy: same-origin`, si otro sitio la abre en una
      // ventana nueva, ese sitio no puede controlarla ni verla.
      {
        source: "/cuenta/anular-dos-pasos",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      // La invitación (H-009): `/invitacion/:código` lleva el código secreto de la invitación. Nada se guarda en
      // cachés ni en buscadores, y al salir no se manda la dirección a ningún sitio.
      // `Cross-Origin-Opener-Policy: same-origin` (corrección I1): si otro sitio abre esta pantalla en una ventana
      // nueva, esa ventana queda en su propio grupo y el sitio que la abrió ya no puede controlarla ni verla.
      {
        source: "/invitacion/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      // El enlace del cliente (H-030) y el formulario público (H-087) los abre cualquiera: nada se guarda en
      // cachés ni en buscadores, y al salir de la página no se manda la dirección (lleva el token o el
      // identificador del formulario) a ningún sitio.
      ...["/c/:path*", "/f/:path*", "/api/v1/public/:path*"].map((source) => ({
        source,
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      })),
      // La página del formulario público: política propia (con Turnstile, abierta solo a Cloudflare).
      {
        source: "/f/:publicId",
        headers: [{ key: "Content-Security-Policy", value: publicFormContentSecurityPolicy }],
      },
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
      // El código QR del formulario (H-091) es otro archivo servido por nosotros: misma política estricta.
      {
        source: "/api/v1/tenants/:tenantId/intake-forms/:formId/qr",
        headers: [{ key: "Content-Security-Policy", value: LOGO_CONTENT_SECURITY_POLICY }],
      },
    ];
  },
};

export default nextConfig;
