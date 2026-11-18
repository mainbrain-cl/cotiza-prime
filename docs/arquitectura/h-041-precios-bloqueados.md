---
document_id: CP-ARQ-H041
title: H-041 — Bloquear precios y poner topes de descuento
status: diseño del planificador (Opus), 2026-11-17, sobre `main` en `30a2a72` (54 migraciones). Etapa A (base de datos) y etapa B (pantallas) construidas el 2026-11-17, sin mezclar; arreglos de las revisiones Opus (normal y adversarial) aplicados el 2026-11-17 (ver el último registro)
---

# H-041 · Bloquear precios y poner topes de descuento

Reemplaza a `sprint-5-equipo-y-permisos.md` §5c donde difieran. **Delicada** (reescribe `save_quote_draft`, agrega un control al envío,
hace cumplir un permiso en la base y toca precios): revisión Opus normal y adversarial, y **no se mezcla sin Aarón** (decisión 020 §5).
No es una historia de seguridad nueva: es control comercial y entra en el criterio de Aarón del 2026-11-17.

## 1. Qué cambió desde el boceto

- `catalog.price_lock.override` ya existe para Dueño y Administrador (`20261028100000_role_matrix.sql:47`, `matrix.ts:85`): **no se toca la matriz**.
- H-040 **no** reescribió `prepare_quote_send`: puso un disparador antes de insertar en `quote_packages` (`20261110120000_approval_send_gate.sql`).
  H-041 usa un **disparador hermano**; `prepare_quote_send` no se toca.
- `save_quote_draft` vigente: `20261005130000_brand_server_only_logo.sql`. Usa `app.has_role('owner','admin','sales')` y está en la lista congelada de la
  guardia 12 (`tests/db/schema-guards.test.ts`): al reescribirla pasa a `app.can('quote.edit', true)` (mismo resultado) y sale de esa lista.
- El gancho de H-042 va en la rama de **línea nueva del catálogo**, no dentro de la función de reglas (`h-042-servicios-por-comercial.md` §3).
- **No se copia `price_locked` a `quote_items`**: el candado se lee del catálogo de hoy (si se copiara, un desbloqueo no liberaría las líneas viejas).
- Nombre del tope: `tenants.max_discount_bp` (no `sales_max_line_discount_bp`). Sin escritura directa.
- La fórmula `discount_clp × 10.000 ≤ gross × tope` daba falsos rechazos por redondeo ($1.005 al 10 % = $101): se usa `round_half_up(gross × T / 10.000)`.
- Fijar el nombre de las líneas de catálogo **por sí solo no cierra el hueco** de H-040 §12 mientras existan líneas libres (pregunta 18).
- `save_quote_draft` pasa a escribir en `quote_events` **solo** cuando alguien cambia de verdad un precio bloqueado (actualizar `cotizaciones-y-calculo.md:307`).

## 2. Diseño

### 2.1 Migración `20261118100000_price_locks.sql` (+ deshacer). La fecha se revisa al mezclar (posterior a la última en `main`).

1. `set local lock_timeout = '3s'` y su verificación (guardia 15).
2. `catalog_items.price_locked boolean not null default false` + `grant insert, update (price_locked)` (la regla por fila ya exige `catalog.manage`; la auditoría `diff` ya existe).
3. `tenants.max_discount_bp integer check (null or 0..9999)` (puntos base; 1.000 = 10 %). Sin `grant update`; `tenants_audit` ya registra antes y después.
4. `app.can_quote_catalog_item(uuid) returns boolean` = `select true` (gancho de H-042). **«Nunca lo borra» vale para el deshacer de H-042** (lo deja en `select true`); **el deshacer de H-041 sí lo borra**, pero solo después de comprobar que sigue siendo `select true` (si H-042 lo reemplazó, se niega a correr).
5. `app.line_rule_issues(lines jsonb, global jsonb, max_bp int, can_override bool) returns text[]`: pura, `immutable`, sin leer tablas. Gemela de `src/lib/quotes/line-rules.ts`.
6. `app.quote_line_rules_check(tenant, lines, global) returns jsonb {issues, overrides}`: lee tope y candados siempre por `(tenant, id)`;
   `can_override := p_tenant = app.current_tenant_id() and app.can('catalog.price_lock.override')`.
7. `public.set_quote_max_discount(int) returns jsonb`: exige `catalog.manage`; vacío o 0–9999 (`CP422 invalid_max_discount`); si es igual al guardado, `{changed:false}` sin escribir.
8. `app.quote_packages_line_rules_gate()` + disparador `quote_packages_a_line_rules_gate` **antes** de `quote_packages_approval_gate` (orden alfabético: primero el tope duro, después la aprobación; una prueba lo fija).
9. `create or replace public.save_quote_draft(...)`, misma firma.

Los `alter table` pueden ir al final para acortar el bloqueo. Sumar a `modelo-datos.md` §9.4 (aplicar sobre base vacía o ventana tranquila).

### 2.2 La regla (se aplica a quien NO tiene `catalog.price_lock.override`: hoy, el Comercial)

- `price_locked@i`: línea de catálogo cuyo servicio tiene `price_locked = true` **hoy** (aunque esté desactivado) y `unit_price_clp ≠ catalog_unit_price_clp` (el congelado en la línea). Subirlo tampoco vale.
- `discount_over_cap@i`: porcentaje `> T`, o pesos `> round_half_up(gross_clp × T / 10.000)`.
- `global_discount_over_cap`: igual, sobre el subtotal ya con descuentos de línea (pregunta 17, opción A).
- Un precio bloqueado **sí** admite descuento hasta el tope (pregunta 19).
- Quien puede saltarla: sin problemas; `overrides` lista las líneas con candado cuyo precio difiere.
- Error: `CP422` `line_rules_invalid: price_locked@0,discount_over_cap@2,global_discount_over_cap,catalog_item_not_allowed@1`. Índice desde 0 (igual que la calculadora). Mismo formato al guardar y al enviar; lo hereda H-042.

### 2.3 `save_quote_draft`
Línea existente: guarda el precio anterior. Línea nueva del catálogo: llama `app.can_quote_catalog_item` (si es falso suma `catalog_item_not_allowed@i`). Tras calcular y comparar, y **antes de escribir**,
llama `app.quote_line_rules_check`; si hay problemas, lanza el error y no escribe nada. Tras reinsertar líneas, si hubo `overrides` con **cambio real** (línea nueva o precio distinto del anterior), escribe un
evento `locked_price_overridden` (línea de tiempo) y una auditoría `quote.locked_price_overridden`, con a lo más 20 líneas (`position`, `catalog_item_id`, precios), sin nombres de línea. Un guardado repetido con la misma `save_id` vuelve antes y no duplica.

### 2.4 Al enviar
El disparador arma las líneas desde `quote_items` (por `position`) y el descuento general desde `quotes`, llama a la misma función y, si hay problemas, lanza `line_rules_invalid` dentro de la transacción de `prepare_quote_send`
(no queda paquete, enlace, correo ni candado). Si la cotización no existe en esa organización, deja pasar para que la relación compuesta la rechace (como H-040). No corre en el reenvío ni en `confirm_email_dispatch`.
Cubre: tope bajado o precio bloqueado después de guardar, carrera, y un Administrador que pasa a Comercial entre guardar y enviar. **Nota sprint 6:** el paquete se congela con la sesión del autor; si algún día lo inserta el Aprobador, el disparador deberá evaluar al autor.

### 2.5 Gancho de H-042 y su prueba
`tests/db/save-quote-draft-contract.test.ts` (nuevo; H-048b le suma casos): en una transacción reemplaza el gancho por `select false`, como Comercial guarda una línea **nueva** del catálogo y espera `CP422` con `catalog_item_not_allowed@0`;
una línea **existente** del mismo servicio sigue guardándose. Vigila también que sigan vivos `price_locked@`, `discount_over_cap@` y `global_discount_over_cap`.

### 2.6 Permisos
Bloquear/desbloquear precios y fijar el tope: `catalog.manage` (Dueño, Administrador), en la acción y en la base. Saltarse candado y tope: `catalog.price_lock.override`. Todo miembro puede leer el tope (como el umbral de H-040). Ampliar el comentario de `matrix.ts:84`.

### 2.7 `src/lib/quotes/line-rules.ts` (pura, `BigInt`)
`lineRuleIssues`, `lockedPriceOverrides`, `maxDiscountClp`, `parseLineRulesError`, `lineRuleFieldErrors`. Casos compartidos en `line-rules-cases.ts`; paridad en `tests/db/line-rules-parity.test.ts` (tabla fija + ~2.000 casos con semilla fija contra `app.line_rule_issues`).
Campos: `price_locked@i` → `items.i.price`; `discount_over_cap@i` → `items.i.discount`; `global_discount_over_cap` → `globalDiscount`; `catalog_item_not_allowed@i` → `items.i.name`; desconocido → `form`.

### 2.8 Pantallas (superficies sólidas, 375 px, 44 px táctiles)
- **Catálogo:** casilla «Bloquear el precio» (con ayuda), ícono `Lock` junto al precio en la lista (texto para lectores «Precio bloqueado»), tarjeta «Descuento máximo de los Comerciales» (`discount-cap-form.tsx`, `discount-cap-actions.ts`; vacío = «Sin tope»; solo lectura para quien no maneja el catálogo).
- **Editor:** el Comercial ve el precio bloqueado en `readOnly` con candado y, si el guardado difiere, «Usar el precio del catálogo ($…)»; Dueño/Administrador lo editan con la ayuda «quedará registrado». «Máximo 10 %» junto a cada descuento y al general (tope 0: «Tu organización no permite descuentos»). Mezclar `fieldErrors` del servidor con `view.errors`. `mapSaveError` reconoce `line_rules_invalid`.
- **`/enviar`:** bloqueo calculado con `line-rules.ts` antes del de aprobación; si no puede leer tope o candados, no deja enviar. `prepareErrorMessage` reconoce `line_rules_invalid`.
- **Línea de tiempo y actividad:** «Se cambió un precio bloqueado (línea 2: $10.000 → $8.000)»; etiquetas `price_locked` y `max_discount_bp`.

### 2.9 Deshacer
`supabase/rollbacks/20261118100000_price_locks.down.sql`: `lock_timeout`; **se niega** si el md5 de `save_quote_draft` no es el de esta migración (p. ej. H-048b) o si el gancho no es `select true` (H-042). Si pasa: quita disparador y funciones, devuelve `save_quote_draft` a la versión de `20261005130000` (con `has_role`), quita las dos columnas. Se pierde solo configuración; eventos y auditoría se conservan. Prueba: `tests/db/price-locks-rollback.test.ts`.

## 3. Decisiones

| # | Pregunta | Supuesto con que se construye | Alternativa y costo | Quién |
|---|---|---|---|---|
| 16 | ¿Tope por organización o por servicio? ¿Vacío? | Uno por organización; vacío = sin tope; 0 = sin descuentos; máx. 99,99 % | Por servicio: +0,5 día, se suma después sin romper nada | Aarón |
| 17 | ¿El tope limita el descuento general? | Sí, medido solo (A): con 10 % se puede llegar a 19 % sumado; la regla de aprobación de H-040 sí lo ve sumado | B: suma de líneas + general sobre lista (+0,5 día) | Aarón |
| 18 | Líneas libres a mano y nombre de líneas de catálogo | Se dejan como están y se documenta el hueco (A); ya está pendiente de aceptar desde H-040 | B: opción de la organización «solo cotizan desde el catálogo» (+0,75–1 día, mejor como H-041b); con B, H-042 controlaría de verdad | Aarón |
| 19 | ¿Qué cuenta contra el tope? | Solo los campos de descuento; el precio lo controla el candado | Que bajar el precio de una línea sin candado también cuente, como en H-040 (+0,5 día) | Aarón |
| 20 | ¿Contra qué precio compara el candado? | Contra el precio **congelado en la línea** al agregarla (el de catálogo de ese momento), no contra el de hoy. Un borrador viejo sale al precio anterior aunque el catálogo suba y se bloquee después (incluso cambiando el cliente) | A: aceptar ambos, el congelado o el de hoy (~0,5 día); B: exigir el de hoy (~0,5 día; obliga a reevaluar borradores viejos y a decidir qué pasa con los ya enviados); C: dejarlo como está, con textos honestos (ya hecho: el botón dice «Usar el precio con que se agregó» y avisa cuando el catálogo hoy dice otra cosa) | Aarón |
| J1–J9 | Disparador al enviar; `save_quote_draft` a `app.can`; tope por función con `catalog.manage`; comparar con el precio congelado; no copiar el candado a `quote_items`; `@i` desde 0; `readOnly`; dos PR; no tocar la semilla | — | José |

## 4. Pruebas, pasos y tamaño

- **Unitarias:** bordes (10,00 % vs 10,01 %; $1.005), tope 0 y vacío, candado igual/mayor/menor, línea libre, con permiso de saltar, varios problemas; lectura del error; esquemas; acción del tope con un miembro falso de cada rol (sin consultar la base); `editor-model`; `timeline-text`; `labels`.
- **Base (`tests/db/price-locks.test.ts`, paridad, gancho, deshacer):** Comercial directo a `save_quote_draft` (precio, descuento de línea y general → `CP422`, revisión intacta); borrador guardado antes del candado; Dueño/Administrador cambian precio bloqueado (un evento y una auditoría; sin cambio real, ninguno; misma `save_id`, ninguno); al enviar (tope bajado después, sin paquete/enlace/correo/candado; dos reglas violadas → `line_rules_invalid`, fija el orden; Administrador bajado a Comercial); lo ya enviado no cambia (huella antes/después) y el reenvío funciona; `set_quote_max_discount` (roles, rango, auditoría, repetido no audita); escritura directa de `max_discount_bp` rechazada; guardias 12, 14 y 16.
- **Aislamiento:** `set_quote_max_discount` en `RPC_CASES`; testigo 4.321 pb que nunca aparece desde A; cabecera cruzada; mixta; ex con pase vigente; servicio bloqueado de B desde A da el mismo error que uno no bloqueado.
- **e2e (`e2e/price-locks.spec.ts`):** Ana bloquea y fija 10 %; Carla ve candado y «Máximo 10 %», 15 % da error junto a la línea, 10 % guarda; precio forzado con `page.route`; Ana cambia un precio bloqueado y se ve en la línea de tiempo y la actividad; `/enviar` bloquea un borrador viejo; 375 px, teclado y sin conexión; `roles.spec`; **`chromium` completo con `E2E_PROD=1`** (el disparador toca todos los envíos). La prueba nueva crea su propio servicio.
- **Pasos:** PR 1 base inerte (migración + pruebas de base + aislamiento, 1,5 días) y PR 2 pantallas (línea de reglas, catálogo, `/enviar`, e2e, `test:db:rollbacks`, revisiones, 1,75 días): **≈ 3,25 días**. Migraciones las hace un solo agente, declarando 🟢 PRUEBAS. Nunca en paralelo con H-042 ni H-048b.
- **Documentos a actualizar:** `modelo-datos.md` §3.4 y §9.4; `cotizaciones-y-calculo.md:304` y `:307`; `sprint-5-equipo-y-permisos.md` (registro); `sprint-5-h-040-aprobaciones.md` §12; `h-042-...md` (convención y que `quotable_catalog_items` devuelva `price_locked`); `HISTORIAS.md` (marcar H-041 como 🔒).

## 5. Qué NO hacer
Validar solo en pantalla o en la acción; reescribir `prepare_quote_send`; meter la regla de H-042 en la función de reglas; copiar `price_locked` a `quote_items`; migrar o reevaluar borradores o enviadas; tocar la matriz o usar `has_role`; dar escritura directa a `max_discount_bp`; tomar candado o precio del navegador; decimales flotantes; nombres de línea o datos personales en eventos, auditoría o registros; evaluar la regla en el reenvío o en `confirm_email_dispatch`; editar migraciones aplicadas; **borrar el gancho en el deshacer de H-042** (el de H-041 sí lo borra, pero solo si sigue siendo `select true`); construir «Solicitar aprobación», excepciones por persona o la regla por margen.

## 6. Sin verificar
Orden alfabético de los disparadores (documentación de PostgreSQL; lo fija una prueba); que `app.can` vea la sesión dentro del disparador en todo camino de envío; `scripts/check-rollbacks.mjs` con la lista congelada que cambia; guardado automático (H-072) deja un evento por guardado intermedio con precio bloqueado distinto (aceptado); `convert-lines.ts` y `[quoteId]/page.tsx` (las líneas que propone una solicitud también necesitan `priceLocked`); la «mejora de uso anotada» de `CLAUDE.md` parece hecha en `quote-editor.tsx:500-509` y `613-617` (confirmar).

## Registro de construcción — etapa A (base de datos y reglas, sin pantallas)

Construida el 2026-11-17 sobre `main` en `30a2a72`, rama `feat/h-041-precios-bloqueados`. 🟢 PRUEBAS (Supabase local). **Qué entra:** migración `20261118100000_price_locks.sql` y su deshacer; `src/lib/quotes/line-rules.ts` (+ casos compartidos y pruebas); pruebas de base (`price-locks`, `line-rules-parity`, `save-quote-draft-contract`, `price-locks-rollback`) y de aislamiento (`tests/isolation/price-locks.test.ts`, `set_quote_max_discount` en `RPC_CASES`, el testigo de 4.321 pb y un servicio bloqueado en B en la fixture). **Qué NO entra** (etapa B): catálogo, editor, `/enviar`, acciones de servidor, línea de tiempo y actividad en pantalla, e2e.

**Supuestos de las preguntas 16 a 19:** los recomendados (tope único por organización; vacío = sin tope; 0 = sin descuentos; máximo 9.999 pb; el tope limita también el descuento general, medido solo; líneas libres sin límite de precio; solo cuentan los campos de descuento).

### Desviaciones y decisiones de construcción

1. **Funciones auxiliares que el diseño no nombraba** (todas internas, sin permiso para `authenticated`; el deshacer las quita todas): `app.line_price_lock_broken(jsonb)`, `app.discount_over_cap(text, numeric, numeric, integer)` y `app.locked_price_override_lines(jsonb)`. Con ellas la condición «candado roto» y el borde del tope viven en un solo lugar y `lockedPriceOverrides` tiene su gemela en SQL con prueba de paridad. Con ellas son ocho funciones nuevas (las cinco del diseño: el gancho, `line_rule_issues`, `quote_line_rules_check`, `set_quote_max_discount` y la del disparador; más estas tres), además de `save_quote_draft` reescrita: la lista está en el encabezado del deshacer.
2. **Forma de lo que mira la regla** (jsonb, claves en inglés): línea `{price_locked, catalog_unit_price_clp, unit_price_clp, discount_kind, discount_value, gross_clp}`; descuento general `{kind, value, base_clp}` con `base_clp` = `quotes.subtotal_clp` (ya con los descuentos de línea). `app.quote_line_rules_check` recibe las líneas SIN `price_locked` (lo agrega leyendo `catalog_items` por `(tenant, id)`, nunca del navegador).
3. **Orden de los problemas:** por línea, `price_locked@i` y luego `discount_over_cap@i`; al final `global_discount_over_cap`; después de todos, los `catalog_item_not_allowed@i` del gancho de H-042 (los suma `save_quote_draft`; el disparador de envío no los evalúa, ver 6). El TypeScript hace lo mismo y la paridad lo exige.
4. **El evento `locked_price_overridden` lleva `{count, lines: [{position, catalog_item_id, old_price_clp, new_price_clp}]}`.** `position` es 1..n (el de `quote_items`; los problemas `@i` son desde 0). `old_price_clp` es `null` en una línea nueva. **No lleva el precio de catálogo** (el diseño decía «precios»): con 20 líneas de montos de 12 cifras el evento medía 3.968 de los 4.096 bytes que permite su restricción (demasiado justo: un guardado se habría caído con un error 500); sin él mide ~3.250. La auditoría `quote.locked_price_overridden` lleva exactamente los mismos datos. Una prueba (20 líneas, montos de 12 cifras) vigila el margen.
5. **`save_quote_draft` no se vuelve más permisiva ni más estricta fuera de H-041:** mismo orden de errores (el cálculo que no coincide, `CP500`, sigue antes que la regla) y misma firma. La regla corre **después** del cálculo y de la comparación, y antes de escribir; por eso un descuento sobre el tope con totales mal calculados da `CP500`, no `CP422`.
6. **El gancho de H-042 solo lo consulta `save_quote_draft`.** Quien se salta el candado (Dueño, Administrador) también queda sujeto al gancho: son reglas distintas (lo prueba `save-quote-draft-contract`). El disparador del envío evalúa solo candado y tope, no el gancho (una línea nueva ya pasó por él al guardarse; H-042 decide si necesita algo más al enviar).
7. **Guardar de nuevo un borrador viejo con el precio ya distinto del catálogo (candado puesto después) se rechaza aunque la persona no lo haya tocado** (`price_locked@i` compara contra el precio de catálogo congelado, no contra el guardado). Es la lectura literal del §2.2 y la más conservadora; en la etapa B el botón «Usar el precio del catálogo» (§2.8) es lo que lo arregla. Lo mismo vale al enviar.
8. **`app.quote_line_rules_check` solo deja saltar la regla si la organización que se pregunta es la activa de la sesión Y el rol tiene `catalog.price_lock.override`.** Un envío sin sesión de persona (por ejemplo un `insert` hecho como dueño de la base) queda sujeto a la regla, como cualquiera. Ojo con las pruebas: `actAsPostgres` solo hace `reset role` y deja puestos los pases de la última persona; para simular «sin sesión» hay que vaciar los ajustes (`withoutSession` en `price-locks.test.ts`).
9. **El deshacer se niega también si OTRA función nombra lo que quita** (la regla, el gancho o las columnas `price_locked` / `max_discount_bp`), igual que el de `mfa_recovery_codes`, además de las dos negativas del §2.9 (md5 de `save_quote_draft`, gancho distinto de `select true`). Va ANTES que el deshacer de `20261116100000` en el orden inverso, como cualquiera.
10. **La fixture de aislamiento ahora fija el tope de B en 4.321 pb y bloquea el primer servicio de B** (`OrgData.maxDiscountBp`, `OrgData.lockedCatalogId`, ambos `null` en A y C), por el camino legítimo (Beto con su pase). La fixture también la usa `e2e/isolation.setup.ts`: no se corrió e2e en esta etapa.
11. **El `catalog_items.price_locked` se puede escribir también al crear** (`grant insert (price_locked)`): un servicio nuevo puede nacer bloqueado.

### Hallazgos

- **Orden alfabético de los disparadores, verificado** (queda en «Sin verificar» como resuelto): `quote_packages_a_line_rules_gate` va primero y `quote_packages_approval_gate` segundo; la prueba lo lee de `pg_trigger` y además comprueba que con las dos reglas violadas gana `line_rules_invalid`.
- **`app.can` ve la sesión dentro del disparador** en el camino de `prepare_quote_send` (probado con Dueño, Administrador y Administrador bajado a Comercial entre guardar y enviar).
- **`scripts/check-rollbacks.mjs` funciona sin cambios** con la lista congelada que cambia: el deshacer de esta migración se prueba solo (deshacer la última, reaplicarla, deshacer todo en orden inverso, reaplicar todo).
- **La guardia 12 baja de 19 a 18 funciones** (`public.save_quote_draft` sale de `FROZEN_HAS_ROLE_FUNCTIONS`); las guardias 14, 15 y 16 siguen verdes sin cambios (los cuerpos nuevos no escriben roles entre comillas ni llaman a `has_role`).
- **La paridad SQL / TypeScript** cubre 29 casos fijos y 2.000 al azar (semilla fija; la mitad de los descuentos cae justo en el borde del tope), con comprobación de que el generador produce los tres problemas y casos limpios.

### Verificación (2026-11-17, local, base reconstruida con `supabase db reset` + `npm run db:seed` antes de `test:db`)

`npx tsc --noEmit` y `npm run lint` limpios; `prettier --check` limpio sobre lo tocado; `npm test` 2.837 pasan (1 omitida, 176 archivos); `npm run test:db` 1.442 de 1.442 (65 archivos); `npm run test:isolation` 1.423 pasan (3 pendientes, 24 archivos); `npm run test:db:rollbacks` OK; la base local queda reconstruida con la semilla. **Sin e2e** (es la etapa B; el `chromium` completo con `E2E_PROD=1` se corre al final de la etapa B, porque el disparador toca todos los envíos).

### Para la etapa B

`mapSaveError` y `prepareErrorMessage` deben reconocer `line_rules_invalid` (el mensaje exacto es `line_rules_invalid: <lista>` con código `CP422`; `parseLineRulesError` ya lo lee); `quotable_catalog_items` (H-042) y el editor deben traer `price_locked` desde `catalog_items` (el candado NO está en `quote_items`) y `max_discount_bp` desde `tenants`; el evento nuevo se lee con `data.lines[].{position, old_price_clp, new_price_clp}` (`old_price_clp` puede ser `null`); la etiqueta de actividad es `quote.locked_price_overridden`. `lineRuleFieldErrors` ya devuelve las llaves del editor (`items.i.price`, `items.i.discount`, `globalDiscount`, `items.i.name`, `form`).

## Registro de construcción — etapa B (pantallas y acciones de servidor)

Construida el 2026-11-17 sobre la etapa A, misma rama. 🟢 PRUEBAS (Supabase local). No toca migraciones ni la base. **Qué entra:** casilla «Bloquear el precio» y candado en el catálogo; tarjeta «Descuento máximo de los Comerciales»; editor de cotizaciones con candado, «Máximo 10 %» y errores por línea; bloqueo de `/enviar`; línea de tiempo y registro de actividad; pruebas unitarias y e2e; documentos.

### Archivos

- **Catálogo:** `catalog-fields.tsx` (casilla), `[itemId]/edit-forms.tsx` y `[itemId]/page.tsx` (`priceLocked` en la ficha), `page.tsx` (ícono `Lock` con texto `sr-only` junto al precio, tarjeta del tope arriba de la lista), `discount-cap-form.tsx` (nuevo), `src/lib/catalog/schemas.ts` (`priceLocked`: `""` o `"1"`, cualquier otro valor se rechaza), `actions.ts` (manda `price_locked`), `discount-cap-actions.ts` y `discount-cap-messages.ts` (nuevos; `saveDiscountCapAction(tenantId, bp|null)` llama a `set_quote_max_discount` con `requirePermission(…, 'catalog.manage')` ANTES de tocar la base).
- **Reglas en lo puro:** `src/lib/quotes/discount-cap.ts` (leer el texto del tope, frase en vivo, «Máximo 10 %»), `line-rules-block.ts` (el bloqueo de `/enviar` y el texto del error de la base), `line-rules-queries.ts` (lee el tope y los candados de HOY con el pase de la persona; `null` si falla), `save-error.ts` (todo el mapa de errores de `save_quote_draft`, ahora puro y probado), `send/prepare-error.ts` (idem para `prepare_quote_send`), `locked-price-text.ts` (la frase del evento).
- **Editor:** `editor-model.ts` (`EditorLine.priceLocked`, `EditorContext.rules`, `catalogPriceToRestore`, `evaluateEditor` suma `lineRuleIssues`), `catalog-source.ts` y `convert-lines.ts`/`convert-model.ts` (`priceLocked` desde `catalog_items`), `queries.ts` (`lockedCatalogIds`: el candado se lee del catálogo de hoy, no de la línea), `page.tsx` (pasa `rules`), `quote-editor.tsx`, `use-quote-saver.ts` (`failedKey`).
- **Otros:** `send/actions.ts` (usa `prepare-error.ts`; el rechazo por reglas de precio ya no se registra como advertencia del servidor), `enviar/page.tsx`, `timeline-text.ts`, `src/lib/audit/labels.ts`, comentario de `matrix.ts` (sin acciones nuevas).

### Desviaciones y decisiones de construcción

1. **Dos funciones sacadas de los archivos `use server`:** `mapSaveError` y `prepareErrorMessage` eran privadas de archivos `use server`, que solo pueden exportar funciones asíncronas: no se podían probar. `mapSaveRpcError` (pura, devuelve `{result, log}`) vive en `save-error.ts` y `prepareErrorMessage` + `isExpectedPrepareError` en `send/prepare-error.ts`; las acciones solo registran y devuelven. Los mensajes y los códigos no cambiaron (salvo lo de H-041).
2. **El error por línea del servidor vale mientras no se cambie nada.** El guardado del editor (`useQuoteSaver`) recuerda la clave del contenido que el servidor rechazó (`failedKey`); los errores por campo se muestran solo si el contenido actual es el mismo. La clave `form` no se repite (ya sale como aviso del guardado). Mezcla: `{...errores del servidor, ...errores de la pantalla}`.
3. **Con un error de reglas la pantalla igual muestra los totales** (`evaluateEditor` devuelve `totals` y `content: null`): se ve cuánto sale, pero no se puede guardar.
4. **«Mejora de uso anotada» (CLAUDE.md): ya existía** y no se duplicó: el aviso «Bajo el precio de catálogo (…): cuenta como descuento al enviar» (`priceBelowCatalog`, `quote-editor.tsx`) y la ayuda «Elige un tipo de descuento para escribir un valor.» bajo el campo del descuento apagado. Con candado, el Comercial no ve el primero (su precio no se puede bajar); el Dueño y el Administrador sí.
5. **El bloqueo de `/enviar` usa el catálogo de HOY** (como la base): `loadMaxDiscountBp` y `loadLockedCatalogIds` se leen con el pase de la persona; si alguna falla se dice «No pudimos revisar los precios y descuentos de esta cotización» y no se deja enviar. Quien se salta la regla (`catalog.price_lock.override`) no lee nada y nunca queda bloqueado. Va ANTES del bloqueo de aprobación, igual que los disparadores. Si la base rechaza el envío con `line_rules_invalid`, `prepareErrorMessage` lee la lista y dice qué líneas (sin la cifra del tope, que no viaja en el error).
6. **«Usar el precio del catálogo» vuelve al precio que la LÍNEA congeló** (el que compara la regla), no al de hoy del catálogo: si el catálogo cambió después de agregar la línea, la línea vale lo que costaba al agregarse (decisión 7 de la etapa A). El botón solo aparece si el precio escrito es otro.
7. **`lineFromSaved(row, inactive, priceLocked = false)`:** tercer argumento opcional (los tests y otros usos no cambian); una línea libre nunca tiene candado.
8. **La tarjeta del tope va en la lista del catálogo, no en Configuración:** es lo que el diseño pedía («catálogo») y el Comercial la puede leer (el tope es público dentro de la organización). Quien no maneja el catálogo la ve en solo lectura, sin botón.
9. **La prueba e2e usa una organización propia por corrida** (Ana Dueña y Carla Comercial ficticias, creadas en la prueba, con el servicio bloqueado creado por la interfaz) en vez de la semilla `ana@ejemplo.test` / `carla@ejemplo.test`: así no deja el tope ni candados en Negocio Demo 1 y no choca con otros e2e. `roles.spec.ts` (proyecto `isolation`) gana dos controles: «Guardar el descuento máximo» y la casilla «Bloquear el precio», solo para Dueño y Administrador.
10. **Los textos nuevos de usuario no tienen jerga:** «Precio bloqueado por tu organización», «Usar el precio del catálogo ($10.000)», «Máximo 10 %», «Tu organización no permite descuentos», «Tu organización cambió sus reglas de precio. Recarga para ver las vigentes.» (CP422 de reglas), «Se cambió un precio bloqueado (línea 2: $10.000 → $8.000)» y, en el registro de actividad, «Se cambió un precio bloqueado en una cotización» con «Cambió: línea 2: $10.000 → $8.000».

### Hallazgos

- **Línea nueva con precio distinto al de catálogo:** el evento dice «línea N: agregada a $X» (la etapa A guarda `old_price_clp = null`): se probó con el texto y queda en la línea de tiempo como tal.
- **El «Guardar cotización» del Dueño con un precio bloqueado cambiado deja UN evento por guardado con cambio real** (cada guardado intermedio con otro precio suma un evento: el guardado automático de H-072 lo tendrá que tener en cuenta, ya anotado en «Sin verificar»).
- **`SaveQuoteResult` ya no se define en `actions.ts`:** vive en `save-error.ts` y `actions.ts` lo reexporta como tipo (el editor y el hook lo importan de ahí sin cambios).
- **Sin fallos en `line-rules.ts`:** no se tocó.

### Verificación (2026-11-17, local, base reconstruida con `supabase db reset` + `npm run db:seed` antes de `test:db`)

`npx tsc --noEmit`, `npm run lint` y `prettier --check` de lo tocado: limpios. `npm test`: 2.972 pasan (1 omitida, 185 archivos; eran 2.837 tras la etapa A). `npm run test:db`: 1.442 de 1.442 (65 archivos). `npm run test:isolation`: 1.423 pasan (3 pendientes, 24 archivos). e2e con la app compilada (`E2E_PROD=1`, `--workers=1`): `price-locks.spec.ts` 7 de 7; proyecto `chromium` con `catalog`, `catalog-edit`, `quotes`, `quote-send`, `quote-pdf`, `approval-rules`, `audit-log`, `intake-convert` y `price-locks`: 42 de 42; proyecto `isolation` completo (`isolation.spec.ts` y `roles.spec.ts`, con los controles nuevos): 48 de 48. **Sin correr:** `test:db:rollbacks` (no se tocaron migraciones) ni el `chromium` completo (lo corre quien integra). **No probado:** iPhone real, Firefox, Safari ni lector de pantalla. La base local queda reconstruida con la semilla.

### Para quien integre (puntos a confirmar con Aarón)

- **Supuesto por confirmar:** que el Dueño y el Administrador sigan sin tope de descuento (aquí no lo tienen); si se quisiera un tope para ellos, es otra regla.
- **La tarjeta del tope vive en el Catálogo** (arriba de la lista). Si Aarón la prefiere en Configuración, es mover un componente.
- **El hueco de la pregunta 18 sigue abierto** (líneas libres, renombrar una línea de catálogo, bajar la cantidad): H-041 no lo cierra; ver `sprint-5-h-040-aprobaciones.md` §12.

## Registro de la ronda de revisiones Opus (normal y adversarial, 2026-11-17)

Arreglos aplicados sobre la misma rama. La migración `20261118100000_price_locks.sql` todavía no está en `main`, así que se editó EN SU LUGAR (no hay otra) junto con su deshacer y la prueba del deshacer. 🟢 PRUEBAS (Supabase local). **No se cambió ninguna regla de negocio:** el candado sigue comparando contra el precio congelado en la línea.

### Qué cambió

1. **Botón del teléfono.** «Usar el precio …» salía de la media columna del precio y desbordaba a 375 px. Ahora va a todo el ancho de la línea, debajo de la grilla (`col-span-2`, alto mínimo de 44 px, el texto puede partirse en dos líneas). El e2e de 375 px suma un caso con el botón visible (una línea bloqueada cuyo precio quedó distinto, dejada así por la base) y comprueba que no hay desplazamiento horizontal, que mide 44 px o más y que cabe en el ancho.
2. **Textos honestos.** El botón dice «Usar el precio con que se agregó ($10.000)»; si el precio de hoy del catálogo es otro, una frase debajo dice «El catálogo hoy dice $12.000.». El dato de hoy sale de la **misma consulta** del catálogo que `getQuote` ya hacía (se le sumó la columna `unit_price_clp`; ninguna consulta nueva) y llega a la línea como `catalogPriceTodayClp`. Los mensajes de `line-rules.ts` («Usa el precio con que se agregó a la cotización.») y de `line-rules-block.ts` («…distinto al precio con que se agregó. Vuelve a la cotización y usa ese precio.») cambiaron igual.
3. **Precio bloqueado sin tope.** La ayuda de la casilla dice ahora que los Comerciales sí pueden darle descuento hasta el descuento máximo («hoy: 10 %», «hoy: sin tope», «hoy: ningún descuento»; sin el valor si no se pudo leer). La tarjeta del tope muestra «Hay servicios con precio bloqueado y no hay tope: los Comerciales pueden darles cualquier descuento.» cuando corresponde. Para saberlo, la página del catálogo hace UNA consulta ligera (solo cuenta, `head: true`) y solo cuando no hay tope; si falla, no se muestra el aviso y la página sigue. La ayuda en la ficha del servicio lee el tope con `loadMaxDiscountBp` (solo para quien edita; si falla, la ayuda no afirma el valor).
4. **Accesibilidad de la casilla.** La ayuda salió de la etiqueta (ya no se leía dos veces) y usa `useId` en lugar del id fijo `price-locked-help`. La caja con borde sigue envolviendo a las dos; la etiqueta (44 px) es solo el cuadro y el título.
5. **Registro de actividad.** «Descuento máximo: Sin tope → 10 %» y «Bloqueó el precio» / «Quitó el bloqueo del precio» (como H-040), con lo demás que haya cambiado en el mismo registro («· Cambió: precio»). Un valor ilegible cae en la frase general.
6. **Base de datos.** (a) `set_quote_max_discount` toma la fila de la organización con `for no key update` (no bloquea las llaves foráneas que apuntan a `tenants`). (b) El evento y la auditoría de `locked_price_overridden` guardan el precio nuevo normalizado (`((p_items -> v_idx) ->> 'unit_price_clp')::numeric::bigint`), no el JSON crudo: con `8000.0000` el evento guardaba esos ceros. (c) Nuevo md5 de `save_quote_draft` en el deshacer (`103579dac268fc9032bf33896d36b6a9`); `PL2` lo recalcula del archivo. Pruebas nuevas: precio con ceros decimales (`8000.0000`) y el peor caso de tamaño ahora mide `octet_length(data::text)` con 20 servicios y 20 posiciones distintas (antes `pg_column_size` con un solo servicio, que comprimía y mostraba un número menor al real).
7. **Mensajes del guardado.** `mapSaveRpcError` elige el mensaje según qué regla se rompió: solo precios bloqueados, solo descuentos sobre el máximo, solo servicios no permitidos (texto genérico propio), varias clases a la vez (aviso neutro «Revisa los precios y descuentos marcados en la cotización.») o un código desconocido (el mensaje de siempre, «Tu organización cambió sus reglas de precio. Recarga para ver las vigentes.»). **Tope ilegible en el editor:** se eligió la opción más simple: la página pasa `maxDiscountUnknown` y el editor dice, junto al descuento general, «No pudimos leer el descuento máximo de tu organización. Lo revisamos igual al guardar.» en vez de callar como si no hubiera tope (no se muestra ningún «Máximo»; la base y el servidor siguen decidiendo).
8. **Repetición.** `percentText` desaparece (usa `formatPercentBp`); el catálogo usa `loadMaxDiscountBp` en lugar de su consulta propia; el editor no lee el tope para quien se salta la regla (Dueño y Administrador); `/enviar` ya no vuelve a leer los candados: usa los de `getQuote` (que ahora también devuelve `catalogStatesUnreadable`, `true` si no pudo leer el catálogo, y `/enviar` NO deja enviar con eso: el comportamiento ante fallos no cambió). `loadLockedCatalogIds` se eliminó.
9. **Ícono.** El candado se queda como está (Lucide, 16 px); `DISENO.md` anota la desviación de la norma de íconos (18 px en escritorio, 20 a 24 en móvil) y por qué.

### Riesgos aceptados nuevos

- **Desbloquear, cambiar el precio y volver a bloquear.** Un Administrador puede quitar el candado de un servicio, cambiar el precio y volver a bloquearlo sin que quede un evento en ninguna cotización (los eventos solo se escriben cuando alguien guarda una cotización con un precio bloqueado distinto). Queda solo en la auditoría del catálogo («Quitó el bloqueo del precio», «Cambió el precio de un servicio», «Bloqueó el precio»). Es coherente con que el Administrador puede cambiar precios y datos bancarios sin aviso al Dueño hasta los correos de aviso (decisión nº 17 y proveedor de correo, decisión 016).
- **El disparador de envío no toma el candado de la organización como el de H-040.** Si se cambia el tope en el mismo instante en que alguien envía, hay una ventana de milisegundos en que el envío puede pasar con el tope anterior. H-040 la cierra tomando el candado de la organización antes de decidir; aquí se dejó sin él para no serializar todos los envíos de una organización por una regla que cambia rara vez. El efecto es acotado: el paquete que sale cumplía el tope vigente un instante antes.

### Pregunta 20 para Aarón: ¿contra qué precio compara el candado?

**Cómo está hoy (supuesto con que se construyó):** compara el precio de la línea contra el **precio de catálogo congelado en la línea** al agregarla, no contra el de hoy. Consecuencia: un borrador viejo sale al precio anterior aunque el catálogo suba y el servicio se bloquee después, y aunque la persona cambie el cliente; y al revés, si el catálogo baja, la línea vieja exige el precio más alto con que se agregó (el botón lo dice con honestidad desde esta ronda).

| Opción | Qué hace | Costo |
|---|---|---|
| **A** | Aceptar ambos: vale el precio congelado **o** el de hoy | ~0,5 día |
| **B** | Exigir siempre el precio de hoy del catálogo | ~0,5 día, más decidir qué pasa con los borradores viejos |
| **C** | Dejarlo como está, con los textos honestos (hecho en esta ronda) | 0 |

**Supuesto vigente:** C. Si Aarón prefiere que nadie pueda vender a un precio distinto del de hoy, B. Aplica al guardado y al envío de borradores.

