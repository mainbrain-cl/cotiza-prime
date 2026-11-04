# Plan de construcción: H-025 · Crear una cotización y H-026 🔒 · Ajustar cantidades, precios y descuentos

> Diseñado por el planificador (Opus) el 2026-10-01. Entorno 🟢 PRUEBAS (Supabase local).
> Base: `modelo-datos.md` §6 y §7, `h-012-aislamiento.md`, decisiones 008 a 011, migraciones 1 a 14.
> Preguntas de §10 con su supuesto por defecto: aplicar el supuesto salvo que Aarón diga otra cosa.

## 0. Resumen y tres avisos

**Qué se construye.** Tablas de cotizaciones, líneas e historia; una función de la base que crea la
cotización y le da su número en el mismo paso; un módulo de cálculo en pesos enteros con una copia en
la base que comprueba cada guardado; y la pantalla para armar la cotización.

1. **H-025 y H-026 se construyen seguidas por un solo agente** (para guardar una línea ya hay que
   calcularla): primero el cálculo, después la base, al final las pantallas. Se cierran por
   separado. El revisor revisa el cálculo **antes** de construir las pantallas.
2. **Cotizaciones y líneas no se escriben directo en las tablas**: un pase válido puede llamar a la
   base sin pasar por la app. Solo dos funciones de la base que recalculan todo pueden escribir.
3. El guardado automático es **H-072** (no H-074, que es exportar). El plan lo deja preparado.

## 1. Base de datos

Dos migraciones, un solo agente, en orden, con rollback y fecha posterior a la última existente.

| # | Archivo | Qué trae |
|---|---|---|
| Q1 | `<ts>_quote_calc.sql` | `app.round_half_up_div`, `app.vat_rate_bp()`, `app.quote_calc_v1` (§3.6) |
| Q2 | `<ts>_quotes.sql` | `quotes`, `quote_items`, `quote_events`, índices, disparadores, RLS, permisos, `create_quote`, `save_quote_draft` |

### 1.1 `quotes`

| Columna | Tipo y regla | Historia |
|---|---|---|
| `id` | `uuid` primaria, `default gen_random_uuid()` | |
| `tenant_id` | `uuid not null` → `tenants on update cascade` | P1 |
| `number_seq` | `bigint not null check (> 0)` | H-025 |
| `number_scope` | `text not null` (`'Y2026'` o `'continuous'`) | H-025 |
| `number_display` | `text not null` (`COT-2026-0043`) | H-025 |
| `version` | `smallint not null default 1 check (>= 1)` | H-069 |
| `root_quote_id` | `uuid not null` (= `id` en v1); FK `(tenant_id, root_quote_id)` → `quotes(tenant_id, id)` | H-069 |
| `supersedes_quote_id` | `uuid null`, FK compuesta igual | H-069 |
| `customer_id` | `uuid not null`, FK `(tenant_id, customer_id)` → `customers(tenant_id, id)` | H-025 |
| `status` | `text not null default 'draft'`, lista cerrada: `draft, pending_approval, changes_requested, rejected_internal, sent, viewed, rejected_by_customer, expired, accepted, pending_payment, pending_deposit, deposit_paid, pending_balance, paid, superseded` | §7 |
| `revision` | `integer not null default 1`: contador de guardados para detectar choques entre pestañas (≠ `version`) | H-026, H-072 |
| `last_save_id` | `uuid null`: un guardado repetido no se aplica dos veces | H-072 |
| `creation_key` | `uuid not null`, `unique (tenant_id, created_by, creation_key)`: doble clic no crea dos | H-025 |
| `currency` | `text not null default 'CLP' check (currency = 'CLP')` | M26 |
| `tax_rate_bp` | `integer not null check (between 0 and 10000)`: IVA congelado al crear (1900 = 19%) | H-026 |
| `calc_version` | `text not null default 'quote-calc-v1'` | §13.14 |
| `global_discount_kind` | `text not null default 'none' check (in ('none','percent','amount'))` | H-027 |
| `global_discount_value` | `bigint not null default 0` (puntos base si `percent`, pesos si `amount`) | H-027 |
| `subtotal_taxable_clp`, `subtotal_exempt_clp`, `subtotal_clp`, `line_discounts_clp`, `global_discount_clp`, `global_discount_taxable_clp`, `global_discount_exempt_clp`, `net_taxable_clp`, `net_exempt_clp`, `tax_clp`, `total_clp` | `bigint not null default 0 check (>= 0)` | H-026, H-027 |
| `validity_mode` (`'days'`/`'date'`), `validity_days` (1–365), `valid_until` (`date`) | pueden quedar vacías | H-027, H-034 |
| `observations`, `conditions` | `text` hasta 4.000 caracteres, sin HTML | H-027, H-048b |
| `payment_terms` | `text null check (in ('full','split_50_50'))` | H-052 |
| `sent_at`, `archived_at` | `timestamptz null` | H-029, H-073 |
| `created_by` | `uuid not null` → `auth.users` (autor) | Decisión 009 |
| `updated_by`, `created_at`, `updated_at` | disparador `set_row_meta_by` | |

**Restricciones de suma** (segunda capa):

```sql
check (subtotal_clp = subtotal_taxable_clp + subtotal_exempt_clp),
check (global_discount_clp = global_discount_taxable_clp + global_discount_exempt_clp),
check (net_taxable_clp = subtotal_taxable_clp - global_discount_taxable_clp),
check (net_exempt_clp  = subtotal_exempt_clp  - global_discount_exempt_clp),
check (total_clp = net_taxable_clp + net_exempt_clp + tax_clp),
check (total_clp <= 1000000000000),
check ((global_discount_kind = 'none' and global_discount_value = 0)
    or (global_discount_kind = 'percent' and global_discount_value between 0 and 10000)
    or (global_discount_kind = 'amount'  and global_discount_value between 0 and subtotal_clp)),
unique (tenant_id, id),
unique (tenant_id, number_display, version),
unique (tenant_id, root_quote_id, version)
```

**Índices** (todos empiezan por `tenant_id`): `(tenant_id, created_at desc)`, `(tenant_id, status,
created_at desc)`, `(tenant_id, customer_id, created_at desc)`, `(tenant_id, created_by, created_at
desc)`, `(tenant_id, valid_until) where valid_until is not null`, `gin (tenant_id, number_display
gin_trgm_ops)` (buscar "43" encuentra `COT-2026-0043`, H-065).

### 1.2 `quote_items`

| Columna | Tipo y regla |
|---|---|
| `id` | `uuid` primaria, generada en el navegador (`crypto.randomUUID()`) para conservar la identidad entre guardados |
| `tenant_id` | `uuid not null` |
| `quote_id` | FK `(tenant_id, quote_id)` → `quotes(tenant_id, id)` |
| `position` | `smallint not null check (between 1 and 200)`, `unique (tenant_id, quote_id, position)` |
| `catalog_item_id` | `uuid null`, FK `(tenant_id, catalog_item_id)` → `catalog_items`. **Solo referencia**: el precio no se lee de ahí |
| `catalog_unit_price_clp` | `bigint null`: precio del catálogo al agregar (H-070, H-041) |
| `name` | `text not null`, 1–150 |
| `description` | `text null`, hasta 2.000 |
| `unit` | misma lista que el catálogo |
| `tax_treatment` | `'taxable'` o `'exempt'` |
| `quantity_milli` | `bigint not null check (between 1 and 1000000000)`: cantidad en **milésimas** (2,5 → 2500) |
| `unit_price_clp` | `bigint not null check (between 0 and 1000000000000)` |
| `discount_kind` | `'none'`, `'percent'`, `'amount'` |
| `discount_value` | `bigint not null` (puntos base o pesos) |
| `gross_clp`, `discount_clp`, `line_total_clp` | `bigint not null`, `check (line_total_clp = gross_clp - discount_clp and discount_clp between 0 and gross_clp)` |
| `unit_cost_clp`, `calc_model`, `calc_model_version`, `calc_inputs jsonb` | pueden quedar vacías (M16) |
| `created_at`, `updated_at` | |

Además: `unique (tenant_id, id)`; `check ((catalog_item_id is null) = (catalog_unit_price_clp is
null))`; índice `(tenant_id, catalog_item_id) where catalog_item_id is not null`.

**Cantidad en milésimas y no `numeric(12,3)`**: la API de Supabase entrega `numeric` como número con
decimales al navegador, que puede perder exactitud. Enteros de punta a punta (P7).

### 1.3 `quote_events` (solo agregar)

`id bigint generated always as identity` primaria; `tenant_id`; `quote_id` con FK compuesta y
`unique (tenant_id, id)`; `occurred_at`; `type text check (type ~ '^[a-z_]+$')` (hoy solo
`created`); `actor_type` (`user`/`system`/`public`); `actor_user_id`; `data jsonb not null default
'{}' check (pg_column_size(data) <= 4096)`, **nunca datos personales**. Índice `(tenant_id, quote_id,
occurred_at)`. Disparadores `forbid_mutation` (update, delete, truncate) y `forbid_tenant_change`. La
FK a `quotes` **no borra en cascada**: H-073 hará borrado suave.

### 1.4 RLS y permisos

| Tabla | Leer | Escribir |
|---|---|---|
| `quotes` | `tenant_id = (select app.current_tenant_id())`; todos los roles ven todas (decisión 009) | **Sin políticas ni permisos**: solo `create_quote` y `save_quote_draft` |
| `quote_items` | Igual; **permiso de lectura por columnas, sin `unit_cost_clp`** (§9.4) | Solo `save_quote_draft` |
| `quote_events` | Igual | Solo funciones con permisos elevados |

- `grant select on quotes, quote_events to authenticated`; `grant select (todas menos unit_cost_clp) on quote_items to authenticated`. Nada para `anon`. Fuera de Realtime.
- Borrar solo borradores nunca enviados: lo hace H-073 con borrado suave.
- El número nunca se reutiliza.
- **No** conectar `audit_row_change` a estas tablas (cada guardado llenaría la auditoría); las acciones delicadas se auditan en sus historias.

## 2. `public.create_quote(p_customer_id uuid, p_creation_key uuid) returns table (quote_id uuid, number_display text)`

`security definer`, `search_path = ''`; `revoke all ... from public, anon`; `grant execute ... to authenticated`. Pasos:

1. Organización de `app.current_tenant_id()`; **sin `tenant_id` como parámetro**. Vacía → `42501`.
2. `app.has_role('owner','admin','sales')`.
3. Si existe `(tenant_id, auth.uid(), p_creation_key)`, devuelve esa.
4. Cliente de la organización y no anonimizado; si no, `CP404`.
5. `app.allocate_quote_number(v_tenant)` en la misma transacción.
6. Inserta con `root_quote_id = id`, `status 'draft'`, `tax_rate_bp := app.vat_rate_bp()`, `created_by := auth.uid()`.
7. Evento `created` con `{number_display, version: 1}`.

El cliente se elige **antes** de crear (no se gastan números en borradores vacíos).

| Código | Significado |
|---|---|
| `CP404` | No encontrado |
| `CP409` | Choque de revisión (otra pestaña guardó antes) |
| `CP422` | Dato inválido (motivo en `detail`) |
| `CP423` | Ya no se puede editar |
| `CP500` | El cálculo de la app y el de la base no coinciden |
| `42501` | Sin permiso |

## 3. El cálculo (H-026)

### 3.1 Dónde vive

| Pieza | Archivo | Regla |
|---|---|---|
| Redondeo | `src/lib/money/rounding.ts` → `roundHalfUpDiv(n: bigint, d: bigint): bigint = (2n + d) / (2d)` | **Único** redondeo del producto; valores ≥ 0 |
| Cálculo | `src/lib/quotes/calc.ts` → `calculateQuote(input): CalcResult` | Función pura; `BigInt` por dentro; devuelve enteros seguros |
| Casos conocidos | `src/lib/quotes/calc-cases.ts` | Los usan la prueba unitaria y la de paridad con la base |
| Lectura de lo escrito | `src/lib/quotes/parse.ts` → `parseQuantity("2,5") → 2500`, `parsePercent("12,5") → 1250` | Coma decimal; punto solo miles en grupos de 3; `"2.5"` se rechaza ("Usa coma para decimales: 2,5"); >3 decimales en cantidad o >2 en % se rechaza |
| Copia en la base | `app.quote_calc_v1(p_items jsonb, p_global_kind text, p_global_value bigint, p_tax_rate_bp int) returns jsonb` | Mismas reglas en SQL, `numeric` en pasos intermedios |

La pantalla puede importar `calc.ts` para mostrar totales al instante; **lo que se guarda lo calcula
el servidor y lo comprueba la base**.

```ts
export const QUOTE_CALC_VERSION = "quote-calc-v1";
type Discount = { kind: "none" } | { kind: "percent"; bp: number } | { kind: "amount"; clp: number };
type LineInput = { quantityMilli: number; unitPriceClp: number; taxTreatment: "taxable" | "exempt"; discount: Discount };
type CalcInput = { lines: LineInput[]; globalDiscount: Discount; taxRateBp: number };
type CalcResult = { ok: true; totals: QuoteTotals } | { ok: false; issues: CalcIssue[] }; // issues con lineIndex
```

### 3.2 Reglas exactas, en orden

RMA = redondeo **medio peso hacia arriba**. Solo **4 lugares** redondean (①②③④).

| Paso | Fórmula |
|---|---|
| 1. Bruto de línea | ① `gross = RMA(quantity_milli × unit_price / 1000)` |
| 2. Descuento de línea | % → ② `RMA(gross × bp / 10000)`; $ → exacto, **por el total de la línea**, ≤ `gross` |
| 3. Neto de línea | `line_total = gross − descuento` |
| 4. Subtotales | `S_t` = Σ afectas; `S_e` = Σ exentas; `S = S_t + S_e` |
| 5. Descuento global | % → ② `D = RMA(S × bp / 10000)`; $ → exacto, `D ≤ S` |
| 6. Reparto | ③ `D_t = S == 0 ? 0 : RMA(D × S_t / S)`; `D_e = D − D_t` (0 ≤ D_t ≤ S_t, 0 ≤ D_e ≤ S_e) |
| 7. Netos | `N_t = S_t − D_t`; `N_e = S_e − D_e` |
| 8. IVA | ④ `IVA = RMA(N_t × tax_rate_bp / 10000)`, solo afecto |
| 9. Total | `total = N_t + N_e + IVA` |

El descuento global se **reparte en proporción** entre afecto y exento para que el IVA sea correcto.

**Lo que se muestra (cuadra al peso):**

```
Subtotal (Σ totales de línea)      S
Descuento global                  −D
Neto afecto                       N_t
Exento                            N_e      (solo si > 0)
IVA 19%                           IVA      (etiqueta desde tax_rate_bp)
Total                             total
Descuentos aplicados (informativo): Σ descuentos de línea + D
```

`S − D = N_t + N_e` y `N_t + N_e + IVA = total`, siempre. Un descuento con medio peso exacto sube a
favor del cliente (máx. $0,5 por línea); el IVA al peso más cercano. Declarado en el código.

### 3.3 Límites (constantes en `calc.ts`)

| Constante | Valor | Error |
|---|---|---|
| `QUOTE_MAX_LINES` | 200 | `too_many_lines` |
| `QUANTITY_MIN_MILLI` / `QUANTITY_MAX_MILLI` | 1 (0,001) / 1.000.000.000 | `invalid_quantity` (0 no se acepta) |
| `UNIT_PRICE_MAX_CLP` | `MAX_CLP` de `clp.ts` ($1.000.000.000.000) | `invalid_price` |
| Descuento % | 0–10.000 pb | `invalid_discount` |
| Descuento $ de línea | 0–bruto | `line_discount_exceeds_gross` |
| Bruto de línea | ≤ `MAX_CLP` | `line_gross_too_large` |
| Descuento global $ | 0–subtotal | `global_discount_exceeds_subtotal` (**se rechaza, no se recorta**) |
| Total | ≤ `MAX_CLP` | `total_too_large` |

Cantidad × precio puede llegar a 10^21: se multiplica con `BigInt`.

### 3.4 Casos conocidos (`calc-cases.ts`)

A = afecto, E = exento, pb = puntos base. Tasa 1900 pb salvo indicación. S = subtotal, DG = descuento
global, NA/NE = neto afecto/exento.

| # | Líneas | Global | S | DG (A/E) | NA | NE | IVA | Total |
|---|---|---|---|---|---|---|---|---|
| K01 | sin líneas | — | 0 | 0 | 0 | 0 | 0 | 0 |
| K02 | 1 × 100.000 A | — | 100.000 | 0 | 100.000 | 0 | 19.000 | 119.000 |
| K03 | 1 × 0 A | — | 0 | 0 | 0 | 0 | 0 | 0 |
| K04 | 2,5 × 18.000 A | — | 45.000 | 0 | 45.000 | 0 | 8.550 | 53.550 |
| K05 | 0,333 × 1.000 A | — | 333 | 0 | 333 | 0 | 63 | 396 |
| K06 | 1,5 × 1.001 A (1.501,5 → 1.502) | — | 1.502 | 0 | 1.502 | 0 | 285 | 1.787 |
| K07 | 0,001 × 500 A (0,5 → 1) | — | 1 | 0 | 1 | 0 | 0 | 1 |
| K08 | 0,001 × 499 A (0,499 → 0) | — | 0 | 0 | 0 | 0 | 0 | 0 |
| K09 | 1 × 50 A (IVA 9,5 → 10) | — | 50 | 0 | 50 | 0 | 10 | 60 |
| K10 | 3 × 50 A (IVA 28,5 → 29) | — | 150 | 0 | 150 | 0 | 29 | 179 |
| K11 | 3 líneas de 0,5 × 1.001 A (501 c/u) | — | 1.503 | 0 | 1.503 | 0 | 286 | 1.789 |
| K12 | 1 × 100.000 A, 10% | — | 90.000 | 0 | 90.000 | 0 | 17.100 | 107.100 |
| K13 | 1 × 1.005 A, 10% (100,5 → 101) | — | 904 | 0 | 904 | 0 | 172 | 1.076 |
| K14 | 1 × 1.000 A, 12,5% | — | 875 | 0 | 875 | 0 | 166 | 1.041 |
| K15 | 1 × 1 A, 50% (0,5 → 1) | — | 0 | 0 | 0 | 0 | 0 | 0 |
| K16 | 2 × 30.000 A, $5.000 | — | 55.000 | 0 | 55.000 | 0 | 10.450 | 65.450 |
| K17 | 1 × 20.000 A, $20.000 | — | 0 | 0 | 0 | 0 | 0 | 0 |
| K18 | 1 × 20.000 A, 100% | — | 0 | 0 | 0 | 0 | 0 | 0 |
| K19 | 1 × 20.000 A, $20.001 | — | error `line_discount_exceeds_gross` | | | | | |
| K20 | 1 × 50.000 E | — | 50.000 | 0 | 0 | 50.000 | 0 | 50.000 |
| K21 | 1 × 100.000 A + 1 × 50.000 E | — | 150.000 | 0 | 100.000 | 50.000 | 19.000 | 169.000 |
| K22 | igual que K21 | 10% | 150.000 | 15.000 (10.000/5.000) | 90.000 | 45.000 | 17.100 | 152.100 |
| K23 | 1 × 10.000 A + 1 × 5.001 E | $1.000 | 15.001 | 1.000 (667/333) | 9.333 | 4.668 | 1.773 | 15.774 |
| K24 | 1 × 1 A + 1 × 1 E | $1 | 2 | 1 (1/0) | 0 | 1 | 0 | 1 |
| K25 | 1 × 1.005 A | 10% (100,5 → 101) | 1.005 | 101 | 904 | 0 | 172 | 1.076 |
| K26 | 3 × 10.000 A 10% + 1 × 5.000 A | 5% | 32.000 | 1.600 | 30.400 | 0 | 5.776 | 36.176 |
| K27 | 1 × 10.000 A | $10.000 | 10.000 | 10.000 | 0 | 0 | 0 | 0 |
| K28 | 1 × 10.000 A | $10.001 | error `global_discount_exceeds_subtotal` | | | | | |
| K29 | sin líneas | $1 | error `global_discount_exceeds_subtotal` | | | | | |
| K30 | 1 × 10.000 E | 10% | 10.000 | 1.000 (0/1.000) | 0 | 9.000 | 0 | 9.000 |
| K31 | 1 × 800.000.000.000 A | — | 800.000.000.000 | 0 | 800.000.000.000 | 0 | 152.000.000.000 | 952.000.000.000 |
| K32 | 1.000.000 × 1.000.000 E | — | 1.000.000.000.000 | 0 | 0 | 1.000.000.000.000 | 0 | 1.000.000.000.000 |
| K33 | 1 × 900.000.000.000 A | — | error `total_too_large` | | | | | |
| K34 | 1.000.000 × 1.000.000.000.000 A | — | error `line_gross_too_large` | | | | | |
| K35 | 0 × 1.000 A | — | error `invalid_quantity` | | | | | |
| K36 | 1 × 1.000 A, 10.001 pb | — | error `invalid_discount` | | | | | |
| K37 | 1 × 1.005 A, tasa 1.000 pb (IVA 100,5 → 101) | — | 1.005 | 0 | 1.005 | 0 | 101 | 1.106 |
| K38 | 201 líneas | — | error `too_many_lines` | | | | | |
| K39 | K21 con líneas en orden inverso | — | igual que K21 | | | | | |

Cada caso guarda también lo esperado por línea (bruto, descuento, total).

### 3.5 Propiedades al azar

10.000 cotizaciones con generador de semilla fija (sin librería; si se usa `fast-check`, MIT, se
verifica la licencia). Para todo resultado válido: enteros seguros ≥ 0 (**el total nunca es
negativo**); `S = Σ line_total`; `S − D = N_t + N_e`; `total = N_t + N_e + IVA`; `D_t ≤ S_t` y
`D_e ≤ S_e`; reordenar líneas no cambia totales; sin descuentos, `total = Σ gross + RMA(Σ gross
afecto × tasa)`.

### 3.6 La copia en la base

`save_quote_draft` recalcula con `app.quote_calc_v1` y compara el resultado **completo** con
`p_expected_totals`. Si no coinciden: `CP500`, no guarda nada, la app lo registra como error grave
sin datos personales. `app.quote_calc_v1` no se expone por la API.

## 4. `public.save_quote_draft(p_quote_id uuid, p_expected_revision integer, p_save_id uuid, p_header jsonb, p_items jsonb, p_expected_totals jsonb) returns jsonb`

`p_header` es JSON (`{customer_id, global_discount:{kind,value}}`) para que H-027 y H-052 agreguen
claves sin cambiar la firma; claves desconocidas → `CP422`. Pasos:

1. Organización activa y rol `owner`/`admin`/`sales`; si no, `42501`.
2. `select ... for update where tenant_id = v_tenant and id = p_quote_id`; si no existe, `CP404`.
3. **Solo el autor edita**: `created_by <> auth.uid()` → `42501` (decisión 009; §10 pregunta 1).
4. `last_save_id = p_save_id` → devuelve el estado actual sin reaplicar.
5. `status not in ('draft','changes_requested')` → `CP423`.
6. `revision <> p_expected_revision` → `CP409`.
7. Valida cliente (de la organización, no anonimizado), máximo 200 líneas, tipos y rangos.
8. **Líneas del catálogo** (contra datos alterados):
   - **Nueva** con `catalog_item_id`: el servicio debe existir en la organización y estar activo (si no, `CP422 catalog_item_unavailable`); `catalog_unit_price_clp` se copia **del catálogo**; `unit` y `tax_treatment` enviados deben coincidir con el catálogo (si no, `CP422 catalog_item_changed`) — impide marcar exento un servicio afecto.
   - **Existente**: conserva `catalog_item_id`, `catalog_unit_price_clp`, `unit`, `tax_treatment`; otros valores → `CP422`.
   - **Libre**: sin `catalog_item_id`; unidad y trato los elige la persona.
   - `name`, `description`, `quantity_milli`, `unit_price_clp` y el descuento siempre editables (H-041 agregará el bloqueo).
9. `app.quote_calc_v1(...)` ≠ `p_expected_totals` → `CP500`.
10. Actualiza `quotes` (encabezado, totales, `revision + 1`, `last_save_id`); borra y reinserta las líneas con sus mismos `id` y `position` 1..n según el orden del arreglo (así se reordena). Un `id` de otra cotización choca con la clave primaria → `CP422` genérico. Ninguna tabla futura apunta con FK a líneas de un borrador: las copias congeladas **copian**.
11. Devuelve `{revision, totals}`. **No escribe en `quote_events`.**

**Acciones del servidor** (`src/lib/quotes/actions.ts`): `saveQuoteDraftAction(tenantId, quoteId,
payload)` → `requireActiveTenant` → zod (`schemas.ts`) → `calculateQuote` (errores por campo) →
`active.supabase.rpc` → estados `saved`/`conflict`/`not_editable`/`invalid`/`error`.
`createQuoteAction(tenantId, customerId, creationKey)` llama a `create_quote` y redirige al editor.

## 5. Precio congelado

- La línea **copia** nombre, descripción, unidad, precio y trato tributario. El cálculo nunca lee del catálogo.
- Cambio de precio en el catálogo: las líneas existentes no cambian; las nuevas traen el precio nuevo.
- Servicio desactivado: deja de aparecer en el buscador; una línea nueva con él se rechaza; las existentes quedan intactas ("Ya no está en el catálogo", informativo).
- Cambio entre agregar y guardar: precio → se conserva el que vio el Comercial; trato o unidad → "El servicio cambió en el catálogo; vuelve a agregarlo".
- Buscador del catálogo en un solo lugar: `src/lib/quotes/catalog-source.ts` → `listQuotableCatalogItems(active, term)` (activos, máx. 20, índice de nombre parcial). H-042 cambiará solo ese archivo.

## 6. Guardado y doble pestaña

| Situación | Qué pasa |
|---|---|
| Guardar a mano | Botón deshabilitado mientras guarda; `useQuoteSaver` (`src/app/o/[tenantId]/cotizaciones/[quoteId]/use-quote-saver.ts`): un guardado a la vez, se envía solo el último estado |
| Dos pestañas | La segunda recibe `CP409`: "Esta cotización cambió en otra pestaña. Recarga para ver la última versión". Nunca sobrescribe en silencio |
| Reintento por mala conexión | Mismo `p_save_id` no se aplica dos veces |
| Doble clic al crear | `creation_key` devuelve la misma cotización |
| H-072 (después) | Solo agrega temporizador y aviso de conexión sobre `useQuoteSaver` |

## 7. Pantallas

| Dirección | Qué hace |
|---|---|
| `/o/[tenantId]/cotizaciones` | "Nueva cotización" y lista mínima de las últimas 50 (número, cliente, total, estado, autor). Filtros y tarjetas en teléfono son H-032 (declarado) |
| `/o/[tenantId]/cotizaciones/nueva` | Elegir cliente (búsqueda de H-023) o **crearlo en un diálogo sin salir**: se extrae de `customers/actions.ts` un núcleo `createCustomer(active, data) → id` compartido (no duplicar cifrado ni aviso de duplicados) |
| `/o/[tenantId]/cotizaciones/[quoteId]` | Editor: número y estado "Borrador"; líneas con cantidad, precio, descuento (% o $), total de línea, subir/bajar (también con teclado) y eliminar; buscador del catálogo; "Agregar línea libre"; totales (§3.2). **Solo lectura** para quien no es el autor, Aprobador y Observador |

375 px: líneas como tarjetas, sin desplazamiento horizontal. Número con `formatQuoteNumber(display,
version)` (`src/lib/quotes/format.ts`, agrega `" v2"`). Cantidad con coma; montos con `formatClp`.
Correo del cliente enmascarado con `customers/mask.ts`.

**H-028 (PDF)** lee **solo lo guardado** (líneas, totales, `tax_rate_bp` para la etiqueta); **nunca
recalcula**. **H-052 (50/50)**: primer pago `floor(total / 2)`, segundo `total − primero` (decisión 011).

## 8. Pruebas

**Unitarias:** `rounding.test.ts` (0,5; 0,49; 0,51; cero; grandes); `calc.test.ts` (K01–K39 con
resultados por línea + propiedades §3.5); `parse.test.ts` (`"2,5"`, `"1.000,25"`, `"2.5"` rechazado,
`"0,0001"` rechazado, `"12,5"` como %, `"100,01"` rechazado, vacío, negativo); `schemas.test.ts`.

**Base de datos:**
- `quote-calc-parity.test.ts`: K01–K39 y 500 casos al azar con la misma semilla, `app.quote_calc_v1` contra `calculateQuote`: mismo JSON y mismos errores.
- `quotes.test.ts`: número con el formato de la organización, `draft` y evento `created`; mismo `creation_key` → misma cotización; Aprobador y Observador no crean; cliente anonimizado o ajeno rechazado; `save_quote_draft` (revisión vieja `CP409`, `save_id` repetido sin efecto, no autor `42501`, estado no editable `CP423`, totales alterados `CP500` sin cambios, trato tributario alterado `CP422`, servicio desactivado rechazado en línea nueva y conservado en la existente, cambio de precio de catálogo no altera la línea, reordenamiento guardado); restricciones de suma rechazan un `update` incoherente como `postgres`; `quote_events` rechaza update/delete/truncate incluso como `postgres`; escritura directa por la API rechazada.
- `quotes-concurrency.test.ts`: 50 `create_quote` en paralelo → 50 números distintos y seguidos.

**Aislamiento (registro de H-012):** `quotes`, `quote_items`, `quote_events` como `business` con
`ownWriteAccepted: false`; `RPC_CASES` suma `create_quote` y `save_quote_draft`
(`writesActiveTenant: true`); `APP_ROUTES` suma las tres direcciones (`concretePath` reemplaza
`[quoteId]`). Fixture: cotización con líneas en A y en B (textos de B con `CANARIO-B-<runId>`).
Ataques: Ana con A guarda la de B → `CP404` y B idéntica (huella `pg`); Ana crea con un cliente de B
→ rechazo; Mixta con A guarda una de B → `CP404`; pedir `unit_cost_clp` → error de permiso; G4 en
verde. e2e: Ana abre `/o/A/cotizaciones/{id de B}` → "No encontrado" + `tenant.access_denied`.

**Pantalla (`e2e/quotes.spec.ts`):** crear con cliente existente (número y "Borrador"); crear
cliente sin salir; 3 servicios + línea libre, cantidad 2,5, 10% en una línea, $5.000 en otra, una
exenta, totales iguales a los casos equivalentes; reordenar con teclado y eliminar, recargar y todo
igual; cambiar precio en el catálogo y la línea conserva su precio; dos pestañas → aviso de conflicto;
375 px con tarjetas; Observador solo lectura (si la fixture lo tiene).

## 9. Riesgos y qué NO hacer

| Riesgo | Cómo se evita |
|---|---|
| Filtración entre organizaciones | RLS de lectura por `current_tenant_id()`, FK compuestas, funciones sin `tenant_id`, pruebas §8 |
| Total inventado por la API directa | Sin permisos de escritura; la base recalcula y compara |
| El total no cuadra | 4 redondeos declarados, sumas de enteros, restricciones de suma, casos conocidos, paridad |
| Exento falso para no cobrar IVA | El trato de líneas del catálogo lo fija la base |
| Pérdida de exactitud | `BigInt`, cantidad en milésimas, topes en `MAX_CLP` |
| Doble envío | `creation_key`, `save_id`, botón deshabilitado, un guardado a la vez |
| Sobrescribir otra pestaña | `revision` con conflicto visible |
| Datos personales expuestos | `quote_events` y logs sin nombre, correo ni RUT |
| Un Comercial ve costos | Lectura por columnas sin `unit_cost_clp` |
| Números quemados | Cliente antes de crear + `creation_key`; saltos permitidos |

**No:** `float`, `Number` con decimales, `toFixed`, `Math.round` sobre productos con decimales ni
`numeric` con decimales para pesos · redondear fuera de `roundHalfUpDiv` y su copia SQL · IVA por
línea sumado o redondear solo el total · dar `insert`/`update`/`delete` sobre `quotes`/`quote_items`
a `authenticated` · confiar en totales, trato tributario o precio de catálogo del navegador · leer el
catálogo al calcular o en el PDF · usar la llave maestra para guardar cotizaciones · `max() + 1` ·
escribir cada guardado en `quote_events` o conectar `audit_row_change` · recortar en silencio un
descuento demasiado grande · recalcular en el PDF · borrar cotizaciones físicamente.

## 10. Preguntas para Aarón (con supuesto por defecto)

1. ¿Dueño o Administrador pueden editar el borrador de un Comercial? **Supuesto: no**, solo el autor (decisión 009). Consecuencia: si se saca a un Comercial, sus borradores quedan sin editor hasta que exista reasignación.
2. Descuento global mayor que el subtotal: **se rechaza con mensaje**.
3. Topes: 200 líneas, cantidad hasta 1.000.000 con 3 decimales, % con 2 decimales, total hasta $1.000.000.000.000.
4. Vigencia en días (H-027): **se cuenta desde el envío**, no desde el borrador.

## 11. Orden de construcción (un solo agente)

1. `rounding.ts`, `calc.ts`, `calc-cases.ts`, `parse.ts` y pruebas.
2. Migración Q1 y prueba de paridad → **el revisor revisa el cálculo aquí**.
3. Migración Q2 y `tests/db/quotes*`.
4. Registro y fixture de aislamiento.
5. Acciones del servidor, `catalog-source.ts`, extracción de `createCustomer`.
6. Pantallas de H-025 → Aarón la prueba y se cierra H-025.
7. Pantallas de H-026 y Playwright → revisor, Aarón, se cierra H-026.

## 12. Cuándo está terminado

**H-025:** Borrador con número al elegir cliente (existente o creado en el diálogo), 50 creaciones en
paralelo → 50 números distintos · servicios con precio cargado solo y línea libre · cambiar o
desactivar un servicio no altera líneas existentes (base y pantalla) · escritura directa por la API
rechazada; registro de aislamiento con 3 tablas, 2 funciones y 3 direcciones; `test:isolation` verde
· Aarón lo ve en pantalla.

**H-026 🔒:** K01–K39 y propiedades en verde en TypeScript **y** SQL (paridad) · totales al escribir,
exento aparte, lo guardado coincide al peso con lo mostrado (Subtotal − Descuento global + IVA =
Total) · reordenar y eliminar guardado; choque entre pestañas avisado sin sobrescribir · prueba de
mutación: cambiar una regla de redondeo en SQL rompe la paridad (anotado en el cierre) · revisor sin
bloqueantes y Aarón en pantalla.
