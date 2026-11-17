---
document_id: CP-ARQ-H041
title: H-041 — Bloquear precios y poner topes de descuento
status: diseño del planificador (Opus), 2026-11-17, sobre `main` en `30a2a72` (54 migraciones). Sin construir
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
4. `app.can_quote_catalog_item(uuid) returns boolean` = `select true` (gancho de H-042; su deshacer lo deja así, nunca lo borra).
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
| J1–J9 | Disparador al enviar; `save_quote_draft` a `app.can`; tope por función con `catalog.manage`; comparar con el precio congelado; no copiar el candado a `quote_items`; `@i` desde 0; `readOnly`; dos PR; no tocar la semilla | — | José |

## 4. Pruebas, pasos y tamaño

- **Unitarias:** bordes (10,00 % vs 10,01 %; $1.005), tope 0 y vacío, candado igual/mayor/menor, línea libre, con permiso de saltar, varios problemas; lectura del error; esquemas; acción del tope con un miembro falso de cada rol (sin consultar la base); `editor-model`; `timeline-text`; `labels`.
- **Base (`tests/db/price-locks.test.ts`, paridad, gancho, deshacer):** Comercial directo a `save_quote_draft` (precio, descuento de línea y general → `CP422`, revisión intacta); borrador guardado antes del candado; Dueño/Administrador cambian precio bloqueado (un evento y una auditoría; sin cambio real, ninguno; misma `save_id`, ninguno); al enviar (tope bajado después, sin paquete/enlace/correo/candado; dos reglas violadas → `line_rules_invalid`, fija el orden; Administrador bajado a Comercial); lo ya enviado no cambia (huella antes/después) y el reenvío funciona; `set_quote_max_discount` (roles, rango, auditoría, repetido no audita); escritura directa de `max_discount_bp` rechazada; guardias 12, 14 y 16.
- **Aislamiento:** `set_quote_max_discount` en `RPC_CASES`; testigo 4.321 pb que nunca aparece desde A; cabecera cruzada; mixta; ex con pase vigente; servicio bloqueado de B desde A da el mismo error que uno no bloqueado.
- **e2e (`e2e/price-locks.spec.ts`):** Ana bloquea y fija 10 %; Carla ve candado y «Máximo 10 %», 15 % da error junto a la línea, 10 % guarda; precio forzado con `page.route`; Ana cambia un precio bloqueado y se ve en la línea de tiempo y la actividad; `/enviar` bloquea un borrador viejo; 375 px, teclado y sin conexión; `roles.spec`; **`chromium` completo con `E2E_PROD=1`** (el disparador toca todos los envíos). La prueba nueva crea su propio servicio.
- **Pasos:** PR 1 base inerte (migración + pruebas de base + aislamiento, 1,5 días) y PR 2 pantallas (línea de reglas, catálogo, `/enviar`, e2e, `test:db:rollbacks`, revisiones, 1,75 días): **≈ 3,25 días**. Migraciones las hace un solo agente, declarando 🟢 PRUEBAS. Nunca en paralelo con H-042 ni H-048b.
- **Documentos a actualizar:** `modelo-datos.md` §3.4 y §9.4; `cotizaciones-y-calculo.md:304` y `:307`; `sprint-5-equipo-y-permisos.md` (registro); `sprint-5-h-040-aprobaciones.md` §12; `h-042-...md` (convención y que `quotable_catalog_items` devuelva `price_locked`); `HISTORIAS.md` (marcar H-041 como 🔒).

## 5. Qué NO hacer
Validar solo en pantalla o en la acción; reescribir `prepare_quote_send`; meter la regla de H-042 en la función de reglas; copiar `price_locked` a `quote_items`; migrar o reevaluar borradores o enviadas; tocar la matriz o usar `has_role`; dar escritura directa a `max_discount_bp`; tomar candado o precio del navegador; decimales flotantes; nombres de línea o datos personales en eventos, auditoría o registros; evaluar la regla en el reenvío o en `confirm_email_dispatch`; editar migraciones aplicadas o borrar el gancho en un deshacer; construir «Solicitar aprobación», excepciones por persona o la regla por margen.

## 6. Sin verificar
Orden alfabético de los disparadores (documentación de PostgreSQL; lo fija una prueba); que `app.can` vea la sesión dentro del disparador en todo camino de envío; `scripts/check-rollbacks.mjs` con la lista congelada que cambia; guardado automático (H-072) deja un evento por guardado intermedio con precio bloqueado distinto (aceptado); `convert-lines.ts` y `[quoteId]/page.tsx` (las líneas que propone una solicitud también necesitan `priceLocked`); la «mejora de uso anotada» de `CLAUDE.md` parece hecha en `quote-editor.tsx:500-509` y `613-617` (confirmar).
