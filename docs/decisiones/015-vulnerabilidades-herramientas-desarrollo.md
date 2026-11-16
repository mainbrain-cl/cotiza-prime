# 015 · Vulnerabilidades sin corrección en herramientas de desarrollo

**Estado:** ⚠️ **superada el 2026-11-12** (Aarón, comentarios del issue #11): ya no hay vulnerabilidades altas ni críticas en ninguna dependencia, así que la regla completa de `SEGURIDAD.md` §8 y `STACK.md` §8 vuelve a aplicar a todo, y el CI bloquea también las de las herramientas de desarrollo (`npm audit --audit-level=high`). El texto de abajo se conserva como historia. · **Fecha:** 2026-10-05 ·
**Relaja:** `SEGURIDAD.md` §8 y `STACK.md` §8 ("no se integra con vulnerabilidades de severidad alta
o crítica abiertas"), solo para herramientas de desarrollo.

## Contexto

El 2026-10-05 aparecieron avisos de severidad **alta** en `braces` (agotamiento de pila con patrones
de búsqueda de archivos muy anidados). Llega a Cotiza Prime solo a través de herramientas que corren
**al programar o compilar**, nunca en la aplicación que usa la gente:

- `eslint-config-next` → `fast-glob` → `micromatch` → `braces` (el revisor de estilo)
- `shadcn` (la herramienta que copia componentes) → `fast-glob` / `ts-morph` → `braces`

**No existe versión corregida de `braces`** (todas las versiones figuran como afectadas), así que no
hay actualización posible. El ataque requiere que alguien entregue un patrón de archivos malicioso a
esas herramientas; en Cotiza Prime los patrones los escribimos nosotros y ningún dato de usuario
llega ahí.

## Decisión

1. `shadcn` pasa a **dependencia de desarrollo**: solo se usa para compilar los estilos
   (`@import "shadcn/tailwind.css"`), no en la aplicación en ejecución.
   *(Superado el 2026-10-28: el paquete `shadcn` ya no es dependencia; ver la actualización al final.)*
2. **Dependencias de producción** (lo que llega a la aplicación): se mantiene la regla completa. La
   integración en GitHub **bloquea** cualquier vulnerabilidad alta o crítica
   (`npm audit --omit=dev --audit-level=high`). Hoy: **0 vulnerabilidades**.
3. **Herramientas de desarrollo:** la integración **informa** las altas y **bloquea solo las
   críticas** (`npm audit --audit-level=critical`).
4. Cada vez que se actualicen dependencias se revisa si ya existe corrección para `braces` y, si
   existe, se aplica y se vuelve a la regla completa.

## Por qué

Bloquear todo el desarrollo por una falla sin corrección, en una herramienta que nunca procesa datos
de usuarios, no protege a nadie. La protección que importa —que lo que llega a producción esté
limpio— se mantiene intacta.

## Alternativas descartadas

- `npm audit fix --force`: bajaría `shadcn` a 1.0.0 y `eslint-config-next` a 14, rompiendo el proyecto.
- Forzar otra versión de `braces` con `overrides`: no hay versión corregida a la cual forzar.
- Seguir bloqueando: detendría toda integración sin ganancia de seguridad.

## Consecuencias

Si una herramienta de desarrollo llega a procesar entradas externas (por ejemplo, patrones que vengan
de usuarios), esta decisión deja de aplicar y se revisa.

## Actualización 2026-10-28

- Next.js 16.4.3, zod 4.6.7 y shadcn 4.23.0 corrigieron las vulnerabilidades crítica y altas que había
  (PR #2). Hoy `npm audit` no reporta altas ni críticas.
- Quedaban 3 de severidad baja en `deepmerge` (todas sus versiones están afectadas), que llegaba solo a
  través de `shadcn`. Como la aplicación usaba de `shadcn` únicamente un archivo de estilos, ese archivo
  se copió a `src/app/shadcn-tailwind.css` (MIT, con su aviso) y el paquete se quitó de las dependencias.
  El CSS compilado salió idéntico byte por byte. Con eso `npm audit` da **0 vulnerabilidades**.
- Para agregar componentes de shadcn/ui se usa `npx shadcn@4.23.0 add <componente>` (se ejecuta una vez,
  no queda instalado). Después de cada `add` se aplica la regla de revisión de `docs/DISENO.md` (el paquete `shadcn` y
  paquetes nuevos como `cn` no deben aparecer en `package.json` sin verificar su licencia).
- La regla de esta decisión sigue vigente por si vuelve a aparecer una falla sin corrección en una
  herramienta de desarrollo.

## Superada el 2026-11-12

- Aarón decidió endurecer el CI a `--audit-level=high` para todas las dependencias y marcar esta decisión como superada. El motivo de fondo ya había desaparecido: tras el PR #2 y la salida del paquete `shadcn`, `npm audit` no reporta altas ni críticas (2026-11-16: 25 de severidad moderada, ninguna alta ni crítica; las moderadas no bloquean).
- La regla de cada actualización de dependencias sigue: si vuelve a aparecer una falla alta o crítica sin corrección en una herramienta de desarrollo, se registra una decisión nueva y no se relaja el CI en silencio.
