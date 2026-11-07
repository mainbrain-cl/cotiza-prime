# Cotiza Prime

Plataforma web donde cada empresa crea su organización para cotizar con su marca, sus precios y
sus reglas, y seguir cada cotización hasta que se paga. El plan completo está en
[`docs/PROYECTO.md`](docs/PROYECTO.md).

## Cómo levantarlo en local

Requisitos: Node 24, npm 11 y Docker Desktop abierto.

1. Instalar dependencias: `npm ci`
2. Levantar la base de datos local: `npx supabase start`
   (usa los puertos 56321 a 56329, para no chocar con otros proyectos de Supabase local)
3. Copiar `.env.example` a `.env.local` y completar los valores con `npx supabase status -o env`
4. Generar las claves de cifrado (una para datos personales y otra, distinta, para las huellas de
   búsqueda) y pegarlas en `.env.local` como `CP_PII_KEY_V1` y `CP_SEARCH_KEY_V1`, con
   `CP_PII_KEY_CURRENT=v1`. Cada clave sale de:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   Cada entorno usa claves distintas. Si se pierde `CP_PII_KEY_V1`, los datos cifrados no se
   recuperan.

5. Cargar datos ficticios: `npm run db:seed` (se niega a correr si la URL de Supabase no es local;
   crea ana, beto, mixta, carla (Comercial de Negocio Demo 1), dario (Aprobador), dante (Observador) y ex `@ejemplo.test`, con la contraseña que imprime al terminar)
6. Levantar la aplicación: `npm run dev` y abrir http://localhost:3000

Para apagar la base local: `npx supabase stop`.

## Scripts

| Comando                | Qué hace                                  |
| ---------------------- | ----------------------------------------- |
| `npm run dev`          | Servidor de desarrollo                    |
| `npm run build`        | Compila para producción                   |
| `npm run typecheck`    | Revisa los tipos de TypeScript            |
| `npm run lint`         | Revisa el código con ESLint               |
| `npm run format`       | Da formato con Prettier                   |
| `npm run format:check` | Verifica el formato sin modificar         |
| `npm test`             | Pruebas unitarias (Vitest)                |
| `npm run test:e2e`     | Pruebas de extremo a extremo (Playwright) |
| `npm run test:db`      | Pruebas de la base de datos (necesitan `supabase start` y `supabase db reset`) |
| `npm run db:seed`      | Datos ficticios en la base local (solo local) |
| `npm run test:db:rollbacks` | Prueba los deshacer de las migraciones (borra los datos de la base local) |

La primera vez, `npx playwright install chromium` descarga el navegador de las pruebas.

## Despliegue: anti-robot del formulario público

- `ANTIBOT_PROVIDER` es **obligatorio y no tiene valor por defecto** (`turnstile` o, solo local, `memory`). Con
  `turnstile` también hacen falta `TURNSTILE_SECRET_KEY` y `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
- **Tiene que estar definido también al compilar** (`next build`), no solo al arrancar: la política de seguridad
  (CSP) de `/f/*` se arma en `next.config.ts` y con `turnstile` abre `script-src` y `frame-src` a
  `https://challenges.cloudflare.com`. Si se compila sin la variable, el formulario carga pero Cloudflare queda
  bloqueado y nadie puede enviar. En Vercel: definirla para el entorno de compilación y de ejecución, y
  recompilar si se cambia.
- `memory` (acepta un token fijo) **no arranca** con `NODE_ENV=production`, con cualquier `VERCEL_ENV` ni con
  `NEXT_PUBLIC_APP_ENV=production`. La única excepción es `ANTIBOT_ALLOW_MEMORY=1`, pensada solo para CI y las
  pruebas de punta a punta con la aplicación compilada (ya va en `playwright.config.ts`); con
  `NEXT_PUBLIC_APP_ENV=production` se ignora. No se define nunca en un entorno real.

## Despliegue: cuentas y correo verificado (aceptar invitaciones, H-009)

Aceptar una invitación solo funciona con el mismo correo al que se envió, y eso descansa en que el correo verificado
de una cuenta (`email_confirmed_at`) sea realmente de su dueño. Hoy esas opciones están solo en
`supabase/config.toml` (la base local); **el proyecto de Supabase de producción hay que configurarlo a mano**:

- **H-009 exige en el proyecto de producción: Confirm email ON, Secure email change ON y sin proveedores externos
  (OAuth) ni ingreso anónimo, salvo decisión registrada.**
- Es requisito de **salida a producción y del piloto**: revisarlo en el panel de Supabase (Authentication) antes de
  invitar a la primera persona real.

## Estructura

```
docs/                 Plan, decisiones, sprints y base técnica
e2e/                  Pruebas de extremo a extremo
supabase/             Configuración y migraciones de la base de datos
src/app/              Páginas y rutas (App Router)
src/app/api/v1/       API versionada
src/components/ui/    Componentes de shadcn/ui
src/lib/auth/         Único lugar donde se valida el pase de sesión
src/lib/tenant/       Único lugar donde se resuelve la organización activa
src/lib/supabase/     Clientes de Supabase (servidor y navegador)
```
