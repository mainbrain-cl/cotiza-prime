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
   crea ana, beto, mixta, carla (Comercial de Negocio Demo 1) y ex `@ejemplo.test`, con la contraseña que imprime al terminar)
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
