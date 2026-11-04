# Cotiza Prime

## En una frase

**Cotiza Prime** es una plataforma web donde cada empresa crea su organización para cotizar con su
marca, sus precios y sus reglas, y seguir cada cotización hasta que se paga.

- **Objetivo:** que una pyme chilena pase de cotizar a mano y sin control a enviar cotizaciones
  profesionales en minutos, aprobadas por quien corresponde y con seguimiento hasta el pago.
- **Para quién:** pymes chilenas con más de una persona vendiendo; primer rubro especializado: logística.
- **Cómo se muestra:** profesional, confiable y simple. Hacia el cliente final manda la marca de cada
  empresa; hacia quien la usa, español de Chile y sin jerga técnica.
- **Qué no es:** no factura, no procesa pagos, no es CRM ni sistema de operación logística.

La ficha completa está al inicio de `docs/PROYECTO.md` ("Cotiza Prime en una página"), y el orden
de construcción en su sección 15.

## Documentos que mandan en este proyecto

@docs/00-base/STACK.md
@docs/00-base/SEGURIDAD.md
@docs/00-base/LEGAL.md
@docs/00-base/PROCESO.md
@docs/PROYECTO.md
@docs/DISENO.md

## Precedencia

`PROYECTO.md` puede ser **más exigente** que la base. Nunca menos. Relajar un control
de la base exige una decisión registrada en `docs/decisiones/`.

## Estado

**Fase 4 — Desarrollo.** Plan, historias y sprint 1 aprobados (Compuerta 3 cruzada el
2026-10-01). Forma de trabajo: decisión 013. Las decisiones están en `docs/decisiones/`.

## Para retomar (actualizado 2026-10-01)

Al abrir una sesión nueva, **parte por aquí**.

**Sprint 1 — ✅ cerrado el 2026-10-01** (Aarón lo probó en pantalla; cierre en `docs/sprints/001-base-segura.md`).
Las 10 historias están integradas en `main`, revisadas por Opus (H-012 por separado) y con los
hallazgos corregidos. Pruebas: `npm test`, `test:db`, `test:isolation` (504 ataques entre
organizaciones), `test:db:rollbacks`, `test:e2e`; todo en verde local y en GitHub Actions.

- **Base:** Next.js 16 + Supabase local en Docker (puertos **56320–56329**). 40 migraciones. Datos de
  prueba: `npm run db:seed` (`ana`, `beto`, `mixta`, `ex` `@ejemplo.test`, contraseña
  `Prueba-Cotiza-2026`; Negocio Demo 1 y 2). Cómo levantarlo: `README.md`.
- **Documentos de arquitectura:** `docs/arquitectura/modelo-datos.md` (aprobado) y
  `docs/arquitectura/h-012-aislamiento.md` (plan y registro de cierre).
- **Diseño:** `docs/DISENO.md` v1.0 aprobado. **Decisión 014:** licencias de `sharp` y `caniuse-lite`.
- **Historia nueva H-114** (IP de auditoría falsificable), en el sprint 6, antes del piloto.

**En curso: sprint 2** → `docs/sprints/002-primera-cotizacion-pdf.md` (orden de construcción y decisiones:
la plantilla 1 del PDF la propone la sesión principal con vista previa; PDF con `@react-pdf/renderer`).

### Traspaso del 2026-11-04 — lo primero que hay que saber

**Quedó en `main` (`42a1fff`):** PR #19, #21, #20 (H-009), #22 y #23 (H-048a), en ese orden, por pedido de Aarón.
No hay PR abiertos. Ya se puede invitar y aceptar de punta a punta, y existe Configuración → «Textos listos».

**Cómo se mezcló, para no repetir el trabajo:**
- **#20 entró antes que #22**, no después como sugería José: su migración tiene fecha anterior y la regla pide que
  cada una sea posterior a la última integrada.
- **#23 se cambió de base a `main`** antes de mezclarlo. Sin eso habría quedado en la rama de #22.
- **Se subieron commits de mezcla a las ramas de José** `feat/h-048a-textos-base` y `feat/h-048a-textos-pantallas`
  para juntar `registry.ts`, `labels.ts` y `sprint-5-h-048-textos.md`. Los tres choques eran solo adiciones y quedaron
  ambos lados. Quien tenga esas ramas abiertas debe partir de `main`.

**Verificado en local, con los cinco juntos:** tipos, lint y formato limpios; 2.050 unitarias (1 omitida), 907 de base
de datos, 1.188 de aislamiento (3 pendientes), e2e `chromium` 141 de 141 y `isolation` 19 de 19, ambos con
`E2E_PROD=1`. En `main` ya mezclado solo se repitieron tipos, formato, unitarias y las guardias de aislamiento: quedó
igual salvo el orden de unas líneas. Ahí `guards.test.ts` y `render.test.tsx` fallaron por tiempo con la máquina
cargada y pasaron al correrlas solas.

**Lo que NO se hizo:**
- **Sin CI** (facturación de GitHub) y sin `test:db:rollbacks` sobre el conjunto (vacía la base local; José lo pasó
  en la rama de #23, sin H-009).
- **Aarón no lo probó en pantalla.** Mezcló #20 (delicado) por pedido expreso, sin revisarlo él. Lo revisó el agente
  `revisor` en las rondas que cuenta cada PR; aquí se leyó la migración de H-009, no todo el código de los PR.
- **La regla cero de Aarón (2026-11-03) pide CI verde y revisión adversarial aparte de lo delicado antes de integrar.**
  El CI no corre, y para esta tanda no se lanzó una revisión adversarial nueva.
- Firefox, lector de pantalla e iPhone real, sin probar.

**Antes del piloto, nuevo por H-009:** en el proyecto de Supabase de producción, Confirm email ON, Secure email change
ON y sin proveedores externos ni ingreso anónimo. Si no, la regla «solo con el mismo correo» no vale. Además, el
código de la invitación viaja en la URL antes de la redirección y puede quedar en registros de acceso.

**Qué sigue:** **H-010** (cambiar el rol o quitar a un miembro; ya no está bloqueada) → H-011b → H-004a/b → H-041 →
H-048b → H-004c. Tras aceptar, nadie ve al nuevo miembro en «Tu equipo» hasta H-010. H-040 se puede construir, pero
no mezclar hasta la decisión 15.

**Le toca a Aarón:** decisión 15 (quién envía sin aprobación; supuesto: la regla aplica a todos los que envían, con
excepción por persona más adelante), facturación de GitHub, y las opciones del issue #11 (decisión 015 y CI,
`AGENTS.md`, decisión #17). Probar en pantalla: `npm run dev`, `ana@ejemplo.test`, «Equipo» y «Configuración → Textos
listos»; los correos llegan a http://127.0.0.1:56324. Si los textos de ejemplo no aparecen, correr `npm run db:seed`.

**Ojo con dos cosas de esta máquina:** al caerse VS Code, las pruebas en segundo plano pueden seguir vivas y ocupar
el puerto 3100 (mirar antes de reintentar). Y el 2026-11-04 había otra app en `C:\dev\wt\lote` con `next start -p 3000`;
no es de esta tanda y no se tocó, pero si usa la misma base puede cargar la máquina o ensuciar las pruebas.

### Estado al 2026-11-04 — empezar por aquí (traspaso a José)

**Lee primero `docs/TRASPASO.md`**: es la guía para ponerse al día (cómo levantarlo, qué leer, dónde
quedó todo, trampas, qué decide Aarón y cómo trabaja). Este bloque es solo el resumen.

**Dónde está:** 38 historias construidas de 92 (el total es anterior a partir H-004 y H-048; `HISTORIAS.md` tiene hoy 97 fichas: falta recontar). Sprint 1 cerrado; sprint 2 construido (falta que
Aarón lo pruebe y apruebe la plantilla 1); sprint 3 con 8 de 9 (falta **H-076**, las tres plantillas de
PDF con selector, que espera la aprobación del diseño de las plantillas 2 y 3); **sprint 4 completo**
(H-092 construida y en `main`). **Sprint 5 (equipo y permisos) confirmado por José el 2026-10-28**
(Compuerta 3) y en construcción: **H-011a (matriz única de permisos) en `main` desde el 2026-10-29**
(PR #12), **H-008 (invitar, PR #15)**, **H-009 (aceptar, PR #20)** y **H-048a (textos listos, PR #22 y #23)**; siguen
H-010 y H-011b. Documentos: `docs/sprints/005-equipo-y-permisos.md` y
`docs/arquitectura/sprint-5-equipo-y-permisos.md`. Sprints 6 a 12 sin partir. 40 migraciones. Pruebas (2026-11-04, local): 2.050 unitarias (1 omitida), 907 de base de
datos, 1.188 de aislamiento (3 pendientes), e2e `isolation` 19 de 19 y e2e `chromium` 141 de 141 con la app compilada.
`test:db:rollbacks` no se corrió sobre el conjunto (vacía la base local).

**Lo que ya funciona (en local):** registro y organizaciones, catálogo y clientes, cotizador con PDF,
enviar por correo, enlace del cliente (aceptar o rechazar con motivo obligatorio), rebotes, vencimiento,
revocar enlace, registro de actividad, formulario público (constructor, página pública con anti-robot,
resumen en vivo sin precios, incrustable, QR), solicitudes (asignar, descartar, anonimizar, convertir en
cotización), panel de protección con tope diario (H-092), «Tu equipo» para invitar, reenviar y cancelar (H-008),
aceptar una invitación (H-009) y «Textos listos» en Configuración (H-048a; todavía no se usan al cotizar, eso es
H-048b). Menú flotante vertical, tarjetas, contadores y
fondos animados (React Bits, decisión 018).

**Mezclas del 2026-10-28.** Por orden explícita de José y **sin revisión de Aarón** se mezclaron en `main`
los PR #2 (Next 16.4.3, zod 4.6.7, shadcn 4.23.0), #8 (quita el paquete `shadcn`; reemplaza al #3, que
GitHub cerró solo al borrarse su rama base), #1 (H-092), #6 (menores de H-092), #4 (guía de orientación) y
#5 (diseño del sprint 5). Los de código pasaron por el agente `revisor` (Opus). **Desde ahora el trabajo va
por ramas y PR: nada directo a `main`.** La rama remota `wip/h-092-bloqueos-y-tope` ya no hace falta, pero
sigue ahí: se puede borrar cuando José lo ordene.

**Decisión 020** (en `main`): quién decide mientras Aarón no esté disponible. Aprobada por José el
2026-10-28 y **ratificada por Aarón el 2026-10-29**; plazo de aviso 24 h. José decide lo corriente; Aarón
sigue decidiendo producto, dinero, proveedores y lo que ve el cliente final; y lo delicado (permisos,
aislamiento entre organizaciones, dinero, superficie pública) **no se mezcla sin Aarón**.

**El CI de GitHub no corre por la facturación de la cuenta** (las corridas fallan en 2 s con «recent
account payments have failed…»). Aarón debe regularizarlo. Mientras tanto se verifica todo en local y,
**en cada integración grande, se corre la suite completa de punta a punta** (`E2E_PROD=1 npx playwright
test --project=chromium` y `npx playwright test --project=isolation`), no solo las pruebas de la zona
tocada. **El `chromium` se corre con `E2E_PROD=1`** (app compilada, unos 8 minutos): con el servidor de
desarrollo cada pantalla se compila al abrirla y supera la espera de 5 s de las pruebas, y fallan 5 o más
pruebas distintas en cada corrida (2026-10-30: 91 de 112 con el servidor de desarrollo, 111 de 112 compilada).

**Mezclas del 2026-10-29.** Aarón revisó y mezcló los PR #7 (decisión 020), #9 (estado al día, `sharp`
declarado), #10 (menores de H-092) y #12 (H-011a). Verificado en local con los cuatro juntos: 1.593
unitarias, 665 de base de datos, 1.063 de aislamiento, e2e `isolation` 18 de 18 y `chromium` con fallas
inestables que pasan al repetirse. La única que se repite, `intake-embed.spec.ts:506` (incrustado a 375 px),
falla igual en `main` sin los PR (sospecha: tope diario del formulario de prueba, sin confirmar). Además,
`src/lib/permissions/guards.test.ts` a veces pasa el límite de 5 s con la máquina cargada.

**Aclaración del 2026-10-30.** Esas fallas «inestables» eran en su mayoría el servidor de desarrollo (ver
arriba). Con la app compilada queda 1 de 112: un salto de redirección del ingreso que una vez pasó los 5 s
(`intake-form-builder.spec.ts:136`, pasa 3 de 3 sola); `intake-embed.spec.ts:506` no falló. La del botón
«Guardando…» de `intake-protection.spec.ts` era un error real (el campo del tope diario pisaba lo que se
escribía mientras se guardaba) y se corrigió en el PR #14.

**Mezclas del 2026-11-02.** Aarón pidió mezclar los PR #15 (H-008), #16 (diseños de H-040 y H-048, sin
construir) y #17 (tope diario privado). Se probaron juntos antes de mezclar, con las cifras de arriba; sin CI y
sin prueba en pantalla. Se leyeron las migraciones y el código más delicado, no todo el PR #15.

**Decisiones de Aarón pendientes** (el código aplica un supuesto): quién puede enviar sin aprobación (nº 15 de
`PROYECTO.md` §16.2) y cómo se programa la tarea de avisos al Dueño (nº 17); aprobar las plantillas de PDF; regla de
enlaces ya respondidos (rechazada: tras la vigencia solo aviso; aceptada: activo hasta pagada más un plazo);
proveedor y dominio de correo (decisión 016, propuesta Resend); anti-robot real (decisión 019, propuesta
Turnstile o ALTCHA; antes de correos reales, además, que un nombre de organización con una dirección web no se
vuelva enlace en la invitación); dominio y marca; facturación de GitHub; antes del piloto, abogado, datos de Main Brain
para los términos (29 marcadores), custodia de claves de cifrado y quién responde un incidente.

**Qué sigue:** terminar el sprint 5 (H-010, H-011b y el resto de su lista) → revisión grande de Aarón (decirle qué está listo, el link
`http://localhost:3000` y los accesos) → 6 aprobación y datos de pago → 7 cobro → piloto privado. Estimación: unas 2 a 3 semanas hasta el piloto y 4 a 6 hasta el lanzamiento.

**Cómo se prueba en pantalla:** `npm run dev` → http://localhost:3000 (Docker abierto y `npx supabase
start`). Usuarios `ana`, `carla` (Comercial), `beto`, `mixta`, `ex` `@ejemplo.test`, contraseña
`Prueba-Cotiza-2026` (Negocio Demo 1 y 2). Correos de prueba: http://127.0.0.1:56324. En `.env.local` hacen
falta también `INTAKE_RENDER_SECRET` (32+ caracteres), `ANTIBOT_PROVIDER=memory` y `ANTIBOT_ALLOW_MEMORY=1`
(solo desarrollo). `db reset` y `test:db:rollbacks` vacían la base local: después, `npm run db:seed`.

**Aarón pidió:** que se avance solo y se integre a `main` (desde el 2026-10-28, por rama y PR); él revisa **en un bloque grande**, no historia por
historia. Mirar siempre el CI tras cada subida.

**Trampas de Windows:** `npm install` puede borrar de `package-lock.json` las entradas
`node_modules/@emnapi/core` y `@emnapi/runtime` (`npm run lint` lo comprueba). Nunca enlazar `node_modules`
de una copia con un acceso directo a otra carpeta. Playwright no corre con `npm run dev` abierto en la misma
carpeta. Si Supabase no arranca con «ports are not available» o queda sin puertos publicados, Windows reservó
el rango (`netsh interface ipv4 show excludedportrange protocol=tcp`): `net stop winnat` y `net start winnat`
como administrador, y de nuevo `npx supabase start` (pasó el 2026-10-30; no borra datos).

**Repositorio:** `github.com/avronygg/cotiza-prime`, privado, rama `main`.

## Cómo se trabaja cada historia

Según la decisión 013: la sesión principal coordina y no programa directo. Subagentes con
**Sonnet** construyen, 2 o 3 en paralelo en copias aisladas cuando las historias no se tocan entre
sí; los cambios de base de datos, uno solo y en orden. Las historias 🔒 las diseña antes el
subagente `planificador` (Opus) y nunca van en paralelo. El subagente `revisor` (Opus) revisa cada
🔒 por separado y las chicas en lote. Aarón aprueba el sprint de una vez y prueba cada historia en
pantalla al cerrarla. Antes de tocar la base de datos, declarar el entorno (`/entorno`).

## Recordatorio permanente

- `tenant_id` (UUID, columna propia, ese nombre exacto) en **toda** tabla.
- Direcciones de API con `/api/v1/` desde el inicio.
- Validación del pase de sesión en **un solo archivo**.
- Resolución del cliente (de dónde sale el `tenant_id`) en **un solo punto**.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
