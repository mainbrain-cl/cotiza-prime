# 013 · Forma de desarrollo: subagentes, paralelo y aprobación por sprint

**Estado:** aceptada · **Fecha:** 2026-10-01 · **Detalle en:** `docs/sprints/001-base-segura.md`

## Contexto

El equipo trabaja en modo vibecoding y quiere avanzar rápido, gastar pocos tokens y mantener la
calidad.

## Decisión

Se aplican las propuestas de aceleración 1, 2, 3 y 5 del sprint 1:

1. **Piezas existentes antes que construir:** componentes de pantalla listos, lo que trae Supabase
   (sesión, recuperación, dos pasos) y servicios hechos para correo, PDF y validación. Cada
   dependencia con licencia verificada (`LEGAL.md` §2.3).
2. **Subagentes en paralelo:** la sesión principal coordina; **Sonnet construye** en copias aisladas
   del proyecto (2 o 3 a la vez) las historias que no se tocan entre sí. Los cambios de base de
   datos los hace uno solo y en orden. Las historias 🔒 nunca van en paralelo.
3. **Aprobación por sprint:** Aarón aprueba las historias de un sprint de una vez, antes de
   construir, y prueba cada una en pantalla al cerrarla. El **revisor (Opus)** revisa cada historia
   🔒 por separado y las chicas en lote. El **planificador (Opus)** diseña antes cada historia 🔒.
5. **Adelantar lo que no es código:** cuentas, dominio de correo y borradores legales en paralelo.

La propuesta 4 (lanzar con menos historias) **no se aplica** por ahora.

**Infraestructura para empezar:**
- **Base de datos de pruebas local**, con Supabase corriendo en Docker en el computador de Aarón.
  Supabase en la nube y Vercel se configuran cuando haga falta publicar.
- **GitHub:** repositorio **privado** en la cuenta de Aarón por ahora; se transfiere a la
  organización de Main Brain cuando la agencia se formalice (GitHub lo permite sin perder historial).
- **Supabase en la nube:** cuenta con un correo creado para la agencia, con verificación en dos
  pasos. El plan gratuito sirve para **pruebas**; **producción necesita un plan con respaldos
  automáticos antes del piloto**, porque `SEGURIDAD.md` §2 exige respaldos con restauración probada.

## Por qué

Construir es lo que más tokens consume y Sonnet lo hace bien; Opus aporta donde un error sale caro
(diseño de lo delicado y revisión). Trabajar en local permite partir hoy, sin esperar cuentas.

## Alternativas descartadas

- Construir todo con Opus: más caro sin una mejora proporcional en las historias simples.
- Aprobar historia por historia: más lento, sin ganancia real de control.
- Lanzar con menos historias (propuesta 4): se deja para más adelante.

## Consecuencias

`PROCESO.md` pide avanzar "de a un paso"; aquí el paso es el sprint, pero cada historia se sigue
mostrando funcionando y se cierra por separado. Ningún control de seguridad se relaja.
