# H-040 · Configurar cuándo se exige aprobación (M09) — plan de construcción

> **Estado: diseño del `planificador` (Opus), 2026-11-02. Sin construir.** Es una historia 🔒 delicada (controla
> qué sale al cliente): por la decisión 020 §5 su PR queda abierto hasta que Aarón lo revise. Las decisiones
> D1 a D12 (§11) llevan un supuesto por defecto; las que bloquean la construcción están marcadas. La decisión 15
> (quién puede enviar directo) sigue siendo de Aarón.
>
> **Antes de construir:** las fechas de las migraciones se asignan en ese momento. Cada migración debe tener
> fecha **única** y posterior a la última integrada en `main` (`20261102100000` ya la usa el pendiente m11 de
> H-092).

**En pocas palabras.** Hoy no hay ningún lugar donde se guarde una regla de aprobación, y el envío no revisa
nada: cualquier cotización sale directo. Se proponen cuatro piezas:

1. Una tabla `approval_rules` con historial: cada cambio crea una versión nueva y nunca se edita la anterior.
2. Una sola función que decide si una cotización necesita aprobación, escrita una vez en la base y una vez en
   TypeScript, con una prueba que exige que respondan igual.
3. Una pantalla en Configuración → Aprobaciones.
4. Un control en la base que, al enviar, rechaza la cotización si la regla pide aprobación y anota qué versión
   de la regla regía.

---

## 1. Qué existe hoy y qué falta

- `quotes.status` ya acepta `pending_approval`, `changes_requested` y `rejected_internal`, pero el disparador
  que vigila los cambios de estado solo permite pasar de borrador a enviada
  (`20261006100000_quote_packages_and_links.sql`).
- La matriz tiene `quote.approval.request` y `quote.approve` (sprint 6). **No existe** `approvals.configure`;
  `settings.manage` ya dice «Empresa, marca, numeración, plantillas, textos y reglas».
- `prepare_quote_send` (`20261006120000_quote_send_rpcs.sql`) no revisa ninguna regla de aprobación.
- Los totales ya los guarda la base en `quotes`: `subtotal_clp` (con descuentos de línea ya aplicados),
  `line_discounts_clp`, `global_discount_clp` y `total_clp` (con IVA).
- Reutilizable: `app.round_half_up_div`/`roundHalfUpDiv`, `formatClp`/`parseClp`, `formatPercentBp`/
  `parsePercent`, `app.write_audit`, y el precedente de un disparador «antes de insertar» en `quote_packages`
  (`quote_packages_set_revision`).
- En Configuración, «Tus reglas de aprobación» aparece como «Disponible pronto».

**Tres trampas:**

- `tenants_update` deja a Dueño y Administrador escribir directo en `tenants`: si la regla viviera ahí se
  podría cambiar llamando a la base, sin control de versión.
- `prepareErrorMessage` (`src/lib/quotes/send/actions.ts`) muestra todo CP423 como «ya no está en borrador»:
  un rechazo por falta de aprobación se vería con un mensaje equivocado.
- `tests/db/permissions-parity.test.ts` lee las acciones del archivo `*_role_matrix.sql`: agregar una acción
  redefiniendo `app.role_can` en otra migración rompe esa prueba (por eso se reutiliza `settings.manage`).

## 2. Cómo se guarda la regla

**Tabla propia, solo agregar filas** (no columnas en `tenants`): cada envío apunta a la versión exacta que lo
rigió, dos Administradores no se pisan sin saberlo, y las versiones se conservan mientras exista la
organización (la auditoría se borra a los 24 meses).

`public.approval_rules`: `id uuid`; `tenant_id uuid not null` (→ `tenants`, `on update cascade`);
`version integer not null` (desde 1); `mode` (`never`, `always` o `conditional`); `amount_threshold_clp bigint`
(vacío o entre 1 y 999.999.999.999); `discount_threshold_bp integer` (vacío o entre 0 y 9.999; 1.000 = 10 %);
`created_by uuid` (vacío solo en la versión inicial, creada por el sistema); `created_at`.

- En `conditional` debe haber al menos un umbral; en `never` y `always`, ninguno.
- `unique (tenant_id, version)` (sirve de índice para leer la última) y `unique (tenant_id, id)`.
- **Solo agregar:** `app.forbid_mutation` impide editar, borrar o vaciar, ni siquiera con la llave maestra;
  más `forbid_tenant_change`.
- RLS: lectura para todo miembro de la organización activa (el Comercial necesita saber por qué su cotización
  está bloqueada); **ningún permiso de escribir** para `authenticated`.
- **Regla inicial:** la migración crea la versión 1 `never` para cada organización existente, y un disparador
  en `tenants` (después de insertar, solo `kind = 'organization'`) la crea para las nuevas, sin reescribir
  `create_tenant`. `never` mantiene el comportamiento de hoy.

**Quién escribe:** solo `public.set_approval_rule(p_expected_version, p_mode, p_amount_threshold_clp,
p_discount_threshold_bp) returns jsonb` (`SECURITY DEFINER`, `search_path = ''`), en este orden: organización
desde `app.current_tenant_id()` y `app.can('settings.manage')` (nunca `has_role` ni nombres de rol: las
guardias 12 y 13 de `tests/db/schema-guards.test.ts` lo prohíben) → validar (`invalid_mode`,
`amount_out_of_range`, `discount_out_of_range`, `missing_condition`, `unexpected_threshold`) → candado
`pg_advisory_xact_lock(hashtextextended('approval_rule:'||tenant, 0))` → si el contenido es igual al vigente no
hace nada (`changed:false`; absorbe el doble clic) → si la versión esperada no coincide, CP409 `rule_changed` →
inserta la versión siguiente → `app.write_audit('approval_rule.updated', … {old, new, version})`.

**Desde cuándo vale.** La regla se evalúa **al congelar el paquete**, dentro de la transacción de
`prepare_quote_send`. Las ya enviadas no se reevalúan; un reenvío (`prepare_quote_resend`) no se evalúa. Una
columna nueva `quote_packages.approval_rule_id` (relación `(tenant_id, approval_rule_id)`) registra la versión
que regía; para los paquetes antiguos se rellena con la versión 1, apagando `quote_packages_guard` solo durante
la migración (como en la migración 26), y después queda obligatoria e inmutable.

**Deshacer:** quita, en orden, el disparador del envío, la columna, el disparador de `tenants`, las funciones y
la tabla; **se niega** si existen versiones creadas por personas (`created_by` no vacío), porque borrarlas
eliminaría la prueba de qué regla regía cada envío.

## 3. La función que decide (una sola definición)

SQL manda (la función de envío se puede llamar directo por la API con el pase de un Comercial); TypeScript sirve
a la pantalla (frase, bloqueo del botón y, en el sprint 6, el motivo de H-043). Prueba de paridad entre ambas.

- `grossClp = subtotalClp + lineDiscountsClp` (antes de todo descuento, sin IVA, incluye líneas exentas).
- `discountClp = lineDiscountsClp + globalDiscountClp`.
- `discountBp = grossClp === 0 ? 0 : roundHalfUpDiv(discountClp × 10.000, grossClp)` (centésimas de punto,
  mitad hacia arriba; en TypeScript con `BigInt`, porque 10¹² × 10⁴ pasa el entero seguro de JavaScript).
- Motivo `amount` si `totalClp > umbral` (estrictamente mayor; el total **incluye IVA**). Motivo `discount`: si
  el umbral es 0, cuando `discountClp > 0`; si no, cuando `discountBp > umbral`. Motivo `always` si el modo es
  `always`. Basta un motivo: monto **o** descuento.

Contrato TypeScript (`src/lib/approvals/rule.ts`, sin `server-only`): `ApprovalRule`, `ApprovalReason`,
`approvalMetrics`, `approvalReasons`, `requiresApproval`. Contrato SQL (esquema `app`, sin permiso de ejecución
para nadie con sesión): `app.approval_discount_bp`, `app.approval_rule_reasons` (inmutables) y
`app.quote_approval_check(p_tenant, p_quote_id) returns jsonb` → `{required, reasons, rule_id, rule_version}`,
**el único punto** que decide a quién se le aplica la regla (§5) y que usará también el sprint 6.

**Casos de borde** (tabla compartida `src/lib/approvals/rule-cases.ts`, usada por la prueba unitaria y la de
paridad):

| Caso | Resultado |
|---|---|
| Umbral $2.000.000, total exactamente $2.000.000 | No pide |
| Total $2.000.001 | Pide |
| Neto $1.680.672 → total $2.000.000 / neto $1.680.673 → total $2.000.001 | No pide / Pide |
| Descuento 10 % exacto, umbral 10 % / 10,01 % | No pide / Pide |
| Solo descuento general de 15 % | Pide |
| Línea 6 % más general 5 % (efectivo 10,7 %) | **Pide**, aunque ninguno pase solo |
| Línea de $1.005 con 10 % (redondea a $101 = 10,05 %) | **Pide** (conocido en montos chicos) |
| Línea de $2.000.005 con 10 % (10,0000 %) | No pide |
| Bruto $0; umbral 0 con descuento de $1; descuento de 100 % | Descuento 0; Pide; Siempre pide |
| `always` con total $0; `never` | Pide; Nunca pide |
| Regla combinada | `["amount"]`, `["discount"]` o ambos, siempre en ese orden |
| Montos en el máximo (10¹² − 1) | Sin desborde |

## 4. La frase

`describeApprovalRule(rule)` (`src/lib/approvals/describe.ts`, pura; la pantalla la recalcula al escribir):
«No se pide aprobación: las cotizaciones se envían directo.» · «Se pide aprobación para todas las
cotizaciones.» · «Se pide aprobación si el total supera $2.000.000.» · «…si el descuento supera 10%.» (con
decimales «12,5%»; umbral 0: «…si la cotización tiene cualquier descuento.») · «…si el total supera
$2.000.000 o el descuento supera 10%.» Texto de ayuda fijo: «El total incluye IVA. El descuento suma los
descuentos de cada línea y el descuento general, sobre el valor antes de descuentos.» Para H-043 queda lista
`describeApprovalReasons(reasons, metrics)`.

## 5. Decisión 15: quién puede enviar directo

Supuesto: **por organización, con excepción por persona**. La excepción no se construye ahora; para no cerrarle
el paso, la tabla de la regla **no tiene columnas de rol ni de persona** y todo pasa por
`app.quote_approval_check`, que conoce al autor. La excepción futura sería una tabla aparte
`approval_rule_exemptions (tenant_id, member_id, …)` más una columna en `quote_packages` que registre la
excepción usada. Hoy la regla aplica a **toda persona que envía, incluidos Dueño y Administrador** (§5.2:
«si la regla lo permite»).

Si eligen otra opción: por rol igual para todas las organizaciones → una acción nueva en la matriz y una línea
en `quote_approval_check` con `app.can(...)`; por rol distinto en cada organización → columna `exempt_roles`
como versión nueva; solo por organización → nada. En los tres casos solo cambia el aviso de la pantalla (§7).

## 6. Permisos

Se reutiliza **`settings.manage`** (Dueño y Administrador). Una acción propia obligaría a redefinir
`app.role_can` en otra migración, a cambiar `permissions-parity.test.ts` y chocaría con otras migraciones del
sprint; se puede separar después (D9). Se exige en la pantalla (`pagePermission` antes de leer datos), en la
acción (`requirePermission` antes de tocar la base) y en la base (`app.can`). Aprobador, Comercial y Observador
no ven la pantalla («No tienes permiso para esto»), pero la base les deja leer la regla. Cero nombres de rol
fuera de `src/lib/permissions/` (el aviso «nadie más puede aprobar» usa `rolesThatCanEver("quote.approve")`).
Con H-004c, un Dueño o Administrador sin dos pasos actúa como Observador y no puede cambiarla (se hereda por
`app.can`).

## 7. Pantalla y qué pasa hoy al enviar

**Ruta** `/o/[tenantId]/configuracion/aprobaciones`: `page.tsx`, `approval-rule-form.tsx`, `loading.tsx`;
`src/lib/approvals/` con `queries.ts`, `actions.ts`, `schemas.ts` (zod con `parseClp` y `parsePercent`) y
`form-state.ts`; en `configuracion/page.tsx` la sección «Aprobaciones» (ícono `ShieldCheck`) reemplaza a
«Disponible pronto».

**Formulario** (patrón de `numbering-form.tsx`, superficies sólidas): tres tarjetas «Nunca», «Siempre» y
«Según el monto o el descuento»; en la tercera, «Si el total supera» (`$`, `inputMode="numeric"`) y «Si el
descuento supera» (`%`, hasta dos decimales), al menos una; recuadro «Así quedará» con la frase en vivo
(`aria-live="polite"`); «El cambio aplica a las cotizaciones que se envíen desde ahora; las ya enviadas no
cambian.»; «Último cambio: dd-mm-aaaa hh:mm por Nombre»; campo oculto `expectedVersion`; botón «Guardar regla»
deshabilitado mientras guarda. Cuatro estados: cargando (esqueleto), error (`FormAlert`), vacío (no puede
ocurrir: siempre hay versión 1; si falta, error y log), sin conexión (`OfflineNotice`); conflicto CP409:
«Otra persona cambió la regla mientras la editabas. Recarga para ver la vigente.» A 375 px una columna, áreas
táctiles de 44 px, campos de 16 px. Aviso si pueden aprobar menos de dos miembros: «Hoy solo tú puedes
aprobar; tus cotizaciones que cumplan la regla no podrán salir hasta que invites a otra persona.»

**Envío mientras no exista «Solicitar aprobación» (D1, supuesto: el servidor rechaza desde ya).** Disparador
nuevo `quote_packages_approval_gate` (antes de insertar en `quote_packages`): toma el candado compartido de
§2, llama a `app.quote_approval_check` (totales desde `quotes`, nunca del navegador), y si pide aprobación
rechaza con `raise 'approval_required'` (CP423) sin dejar paquete, enlace, correo ni candado a medias; si falta
la regla, rechaza igual; si no, completa `approval_rule_id`. Un disparador y no reescribir `prepare_quote_send`
evita chocar con H-041, que reescribe esa función, y cubre cualquier camino futuro. El sprint 6 debe cambiarlo
para dejar pasar el paquete de una solicitud de aprobación (dejarlo escrito en la migración). No se evalúa en
`confirm_email_dispatch` (el correo ya salió). En `/enviar`, un bloqueo calculado con la función de
TypeScript: «Esta cotización necesita aprobación: el total ($2.350.000) supera $2.000.000. La solicitud de
aprobación todavía no está disponible; ajusta la cotización o pide a quien administra la organización que
revise la regla.» `prepareErrorMessage` revisa `approval_required` **antes** del CP423 genérico.

## 8. Relación con H-041 y la regla por margen

H-041 es un tope **duro** por línea (no deja guardar; CP422; vive en `tenants.sales_max_line_discount_bp` y
`price_locked`); H-040 es un umbral **blando** de toda la cotización (deja guardar, pide visto bueno; CP423;
`approval_rules`). No se mezclan columnas ni funciones; al enviar, primero el tope de H-041 y después la
compuerta de H-040. Hueco conocido: bajar el precio a mano no cuenta como descuento (lo cubren el bloqueo de
H-041 y la regla por margen, PROYECTO §9.4). La regla por margen (sprint 10) será una tercera condición:
columna opcional `margin_floor_bp` como versión nueva, y `ApprovalMetrics` gana `marginBp`.

## 9. Pruebas

- **Unitarias:** `rule.test.ts` (tabla de §3), `describe.test.ts` (cada frase exacta), `schemas.test.ts`
  (acepta «2.000.000», «$ 2.000.000», «10», «10,5»; rechaza «0», «-1», «2.000,5», 10¹², «100», «10,005» y modo
  condicional sin condiciones), `actions.test.ts` (un falso miembro de cada rol: Aprobador, Comercial y
  Observador reciben «No tienes permiso» **sin consultar la base**; mapeo de CP409, CP422 y 42501) y el
  mapeo de `approval_required`.
- **Base de datos** (`approval-rules.test.ts`, `approval-rule-parity.test.ts`, `approval-send-gate.test.ts`):
  versión 1 `never` para cada organización existente y nueva; Dueño y Administrador suben la versión con
  auditoría (anterior y nuevo), guardar lo mismo no crea versión; los otros tres roles reciben 42501; cada
  valor fuera de rango, CP422; versión esperada vieja, CP409; **dos Administradores a la vez: gana uno**;
  escribir, editar o borrar directo rechazado, también con la llave maestra; compuerta (`always` → CP423 sin
  paquete, enlace, correo ni candado; umbral exacto pasa y un peso más se bloquea; `never` deja el
  `approval_rule_id`; el reenvío sigue funcionando tras cambiar a `always`); la regla cambia justo antes de
  enviar (los dos órdenes del candado); paridad SQL/TypeScript con la tabla de casos y casos al azar con
  semilla fija; guardias de esquema; y el deshacer en `test:db:rollbacks`.
- **Aislamiento:** registrar `approval_rules` (`ISOLATION_TABLES`), `set_approval_rule` (`RPC_CASES`) y la ruta
  (`APP_ROUTES`); Ana con la cabecera de B (canario: B con umbral 1.234.567 que nunca aparece desde A); Mixta
  cambia A sin tocar B y la auditoría queda con el `tenant_id` de A; Ex con su pase vigente; B en `always` no
  bloquea los envíos de A.
- **Punta a punta** (`e2e/approval-rules.spec.ts`): Ana configura $2.000.000 o 10 %, ve la frase, guarda y
  recarga; Carla ve «No tienes permiso» por URL directa; la Comercial con una cotización sobre el umbral ve el
  bloqueo y, si fuerza la acción, queda rechazada; dos pestañas de Administrador (conflicto); 375 px, sin
  conexión y teclado. **Se corre la batería completa**: el disparador toca todos los envíos existentes.

## 10. Datos personales, orden y tamaño

Sin datos personales (la auditoría guarda montos, porcentajes y el identificador del actor). Orden, con **un
solo agente** para la migración y declarando el entorno (PRUEBAS):

| Paso | Qué | Días |
|---|---|---|
| 1 | Migración (tabla, versión 1, disparador de `tenants`, `set_approval_rule`, funciones puras, `quote_approval_check`), su deshacer y pruebas de base | 1 |
| 2 | `rule.ts`, `rule-cases.ts`, `describe.ts`, `schemas.ts` y prueba de paridad | 0,5 |
| 3 | Pantalla, acción, sección en Configuración, etiqueta de auditoría (`src/lib/audit/labels.ts`) y e2e de la pantalla | 1 |
| 4 | Compuerta: columna en el paquete, disparador, bloqueo en `/enviar`, mapeo del error, concurrencia y aislamiento | 1 |

**Unos 3,5 días**, más de los 2 que permite PROCESO: partir en **H-040a** (pasos 1 a 3) y **H-040b** (paso 4),
**pero las dos entran juntas a `main`**, para que nunca exista una pantalla que guarda una regla que nadie
aplica. PR delicado: queda abierto hasta que Aarón lo revise; después, el `revisor`.

## 11. Decisiones

**Bloquean la construcción:**

1. **D1 · ¿Se aplica la regla al enviar desde ya, aunque «Solicitar aprobación» llegue en el sprint 6?**
   Supuesto: sí. Lo que cumple la regla no sale; como parte en «Nunca», nada cambia si nadie la toca. La
   alternativa (guardar sin aplicar) da una falsa sensación de control. Bloquea el paso 4.
2. **D2 · ¿A quién aplica?** (decisión 15, de Aarón). Supuesto: a todos los que envían, incluidos Dueño y
   Administrador, con el aviso de «nadie más puede aprobar».
3. **D3 · ¿El monto se compara con el total con IVA o con el neto?** Supuesto: total con IVA.
4. **D4 · ¿Qué cuenta como descuento?** Supuesto: descuentos de línea más el general, sobre el valor antes de
   descuentos y sin IVA (no las rebajas de precio respecto del catálogo).

**No bloquean (se construye con el supuesto):** D5 umbral de 0 % = «cualquier descuento» (permitido) · D6
redondear el porcentaje a dos decimales antes de comparar (sí) · D7 regla de las organizaciones nuevas:
«Nunca» (el paso 10 del onboarding la cambiará) · D8 aviso por correo al Dueño cuando un Administrador cambia
la regla (no por ahora; llega con H-047) · D9 permiso propio (no; `settings.manage`) · D10 los demás roles ven
la regla (no tienen pantalla; el Comercial ve el motivo al enviar) · D11 para el sprint 6: autoaprobación (no) y
solicitud pendiente si la regla se relaja (se mantiene) · D12 partir H-040 en a y b en `HISTORIAS.md` (sí).

## 12. Riesgos y qué NO hacer

Riesgos aceptados: partir una cotización en dos para quedar bajo el monto (fuera de alcance); bajar el precio
a mano en vez de dar descuento (lo cubren H-041 y el margen); una organización de una sola persona con
«Siempre» queda sin poder enviar (aviso en pantalla, depende de D2); la lógica del disparador queda «escondida»
(se documenta en la cabecera de la migración y en el plan del sprint 6).

**No hacer:** guardar la regla como columnas editables de `tenants` ni dar permisos de edición a
`authenticated` · permitir editar o borrar versiones ni «para corregir» · evaluar solo en la pantalla o solo en
TypeScript · usar totales del navegador · evaluar en `confirm_email_dispatch` · decimales flotantes para el
porcentaje (`BigInt` en TypeScript y `numeric` en SQL) · `has_role`, nombres de rol entre comillas o la llave
maestra en lo nuevo · reevaluar o cambiar el estado de cotizaciones ya enviadas · construir ahora las
excepciones por persona o la regla por margen · dejar que «requiere aprobación» caiga en «ya no está en
borrador» · poner la regla en memoria entre peticiones (`"use cache"`) · usar «Siempre» como regla inicial.

## Lo que el diseño no pudo verificar

El contenido y las fechas de las migraciones del PR #15 (H-008) y de las otras historias del sprint 5 que no
están en `main` (H-041 no está construida: su reescritura de `prepare_quote_send` sale solo de su diseño); si
`scripts/check-rollbacks.mjs` vacía la base antes del primer paso (importa porque el deshacer se niega si hay
versiones creadas por personas); el comportamiento por dentro de `useResultToast`, `SubmitButton` y
`OfflineNotice`; y si las fixtures que insertan paquetes con `pg` (`tests/db/send-helpers.ts`,
`tests/db/quote-packages.test.ts`, `tests/isolation/fixture.ts`, `check-rollbacks.mjs`) crean sus
organizaciones de forma que el disparador de `tenants` las cubra.
