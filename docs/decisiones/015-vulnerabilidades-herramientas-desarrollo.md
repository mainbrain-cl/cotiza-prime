# 015 · Vulnerabilidades sin corrección en herramientas de desarrollo

**Estado:** aceptada, **pendiente de ratificación de Aarón** · **Fecha:** 2026-10-05 ·
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
