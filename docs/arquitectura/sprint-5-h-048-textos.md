# H-048 · Tener textos listos para usar (M08) — plan de construcción

> **Estado: diseño del `planificador` (Opus), 2026-11-02, rehecho con las decisiones de José del mismo día. Sin
> construir.** José decidió: (1) exclusiones y notas al pie tendrán **campo propio** en la cotización; (2) las
> **cuatro variables** (`cliente`, `numero`, `remitente`, `organizacion`); (3) **partir H-048** en H-048a y
> H-048b; (4) **no construir hasta que Aarón revise el PR #15** (H-008): **cumplido**, Aarón lo mezcló el 2026-11-02.
>
> **H-048a es una historia normal; H-048b es delicada** (§11): reescribe `save_quote_draft` y cambia lo que ve el
> cliente final, así que no se mezcla sin Aarón (decisión 020 §5). Partir las historias en `docs/HISTORIAS.md` y
> las notas para H-069, H-070 y H-076 (§3.3 y §4) se hacen al empezar a construir.
>
> **Actualización del 2026-11-04.** Se verificaron las premisas contra `main` (sección «Verificación del
> 2026-11-04», al final). José decidió construir **H-048a como una sola historia en dos PR** (§10). La partición
> en `HISTORIAS.md` y las notas de H-069, H-070 y H-076 ya están en el PR #19. Las fechas de migración se
> reasignaron después de la de H-009 (§13).

**En simple.**

- **H-048a** crea la tabla `text_snippets` y las pantallas de Configuración donde el Dueño o un Administrador
  escriben los textos con nombre. Es una tabla nueva con su seguridad y no toca las cotizaciones.
- **H-048b** permite usar esos textos al cotizar y agrega a la cotización **dos campos propios**:
  «Exclusiones» y «Notas al pie», que salen en el PDF y en la página del cliente.

Los dos campos nuevos quedan congelados al enviar **sin tocar `prepare_quote_send`, la tabla `quote_packages` ni
sus disparadores**: el envío ya guarda una copia sellada del documento que arma la aplicación (y el PDF). Basta
con que esa copia incluya los dos campos. Así se evita chocar con H-041 y H-040 en el envío. El único choque real
es `save_quote_draft`, que H-041 también reescribe (§12).

---

## 1. Qué existe hoy

- **No hay tabla de textos.** El texto inicial del correo está escrito en el código (`defaultEmailBody()` en
  `src/lib/quotes/send/content.ts`); se edita en `/enviar`, se valida con `parseBasicFormat` y se congela al
  enviar en `quote_packages.email_body_md`.
- **Condiciones y observaciones** son las columnas `quotes.conditions` y `quotes.observations`: texto simple de
  hasta 4.000 caracteres sin caracteres de control (en la base `c_control_chars`; en la aplicación
  `CONTROL_CHARACTERS` de `schemas.ts`). Se guardan con `save_quote_draft`, cuyo encabezado viaja como JSON: las
  claves que no se envían no cambian y las desconocidas se rechazan.
- **Al enviar se congela:** el PDF (`pdf_sha256`), la copia del documento `document_snapshot` (JSON que arma
  `buildDocumentSnapshot`) y el sello del contenido completo `content_sha256`. `attach_quote_package_document`
  solo revisa que la copia sea un objeto de 256 KB o menos y que la cotización siga en la misma revisión (B1 del
  sprint 3).
- **La página del cliente** (`/c/[token]`) dibuja esa copia congelada y la valida con `documentSnapshotSchema`
  (`src/lib/share/read-model.ts`), que hoy espera observaciones, condiciones y forma de pago.
- **El PDF (plantilla 1)** arma bloques de notas (`Summary`): OBSERVACIONES, CONDICIONES y FORMA DE PAGO.
- No existen aún duplicar (H-070) ni crear versión (H-069). `create_quote` y `convert_intake_request` crean
  cotizaciones con los textos vacíos.

---

## 2. H-048a · la tabla de textos (unos 4 días)

**Migración** `20261104110000_text_snippets.sql` y su deshacer (fecha reservada: ver §13).

`public.text_snippets`: `id` (lo genera la aplicación), `tenant_id`, `kind` (`email_body`, `conditions`,
`exclusions`, `footer_note`), `name` (1 a 80), `body` (1 a 4.000), `is_default` (solo `email_body`; uno por
organización), `revision`, y quién creó/cambió y cuándo (`app.set_row_meta_by`).

- Índices: `unique (tenant_id, id)`, `(tenant_id, kind, lower(name))` y `(tenant_id) where is_default`; disparador
  `forbid_tenant_change`. **No** se usa `audit_row_change('diff')` (guardaría el texto completo y el detalle de la
  auditoría tiene un tope de 8 KB: el propio guardado podría fallar).
- RLS: todo miembro lee los textos de su organización activa; **nadie escribe directo**.
- Escriben tres funciones `SECURITY DEFINER` con `search_path = ''` (`create_text_snippet`, `update_text_snippet`,
  `delete_text_snippet`): la organización sale de `current_tenant_id()`, deciden con `app.can('settings.manage')`
  (nunca `has_role`), toman un candado por organización (el tope no se salta con dos clics y marcar un texto
  inicial desmarca el anterior en el mismo paso), validan variables (solo en `email_body`, solo las cuatro de la
  lista, hasta 10 por texto) y caracteres invisibles (`app.intake_text_unsafe(p, true)`), y auditan
  `text_snippet.created/updated/deleted` con tipo, nombre y campos cambiados, **sin el texto**. Códigos:
  `42501`, `CP404`, `CP409`, `CP422` + motivo (`name_taken`, `too_many_snippets`, `unknown_variable`,
  `variables_not_allowed`, `default_only_email`…).
- Constantes: `SNIPPETS_MAX_PER_TENANT` 50, `SNIPPET_NAME_MAX_LENGTH` 80, `SNIPPET_BODY_MAX_LENGTH` 4.000
  (= `QUOTE_TEXT_MAX_LENGTH`), `SNIPPET_MAX_VARIABLES` 10, `SNIPPET_VARIABLE_VALUE_MAX_LENGTH` 100. La cuenta:
  4.000 + 10 × 100 = 5.000, el máximo del correo, así que un texto al máximo con sus variables siempre cabe.
- **Borrar es de verdad**, con confirmación: nada apunta a un texto guardado (cada cotización guarda su copia).

---

## 3. H-048b · campos propios en la cotización (unos 4,5 días)

### 3.1 Columnas nuevas en `quotes` (migración `20261104130000_quote_text_fields.sql`)

`exclusions` y `footer_note`: `text null`, con `check (… is null or char_length(…) <= app.quote_text_max_length())`
(función nueva que devuelve 4.000; una prueba de paridad la compara con `QUOTE_TEXT_MAX_LENGTH`). Mismas reglas
de caracteres que `conditions` y `observations`; se guardan sin espacios a los lados y vacío = `null`. Los
permisos de la tabla no cambian (se escribe solo por `save_quote_draft`). Sin índice.

### 3.2 `save_quote_draft`

La firma no cambia (`create or replace`). Tres cambios y nada más: las claves permitidas suman `exclusions` y
`footer_note`; se leen como `conditions` (si no vienen no cambian, `null` borra, hasta 4.000 sin caracteres de
control; si no cumplen, `CP422 invalid_exclusions` / `invalid_footer_note`); el `update` escribe las dos
columnas. **El resto se copia tal cual**, incluida `app.has_role('owner','admin','sales')` (pasarla a `app.can`
sería tocar permisos). Compatibilidad: una llamada sin las claves nuevas las deja como estaban; los borradores
existentes tienen `null`; no se migran datos.

En la aplicación: `saveQuotePayloadSchema` suma `exclusions` y `footerNote` (obligatorios, pueden ser nulos, para
que el compilador obligue a cada llamada a decidir; la que se olvida con más facilidad es
`src/lib/intake/convert-lines.ts`), `payload.ts` los manda, `actions.ts` traduce los dos códigos de error.

### 3.3 Crear, convertir, duplicar y crear versión

`create_quote` y `convert_intake_request` no cambian. Se anota en H-069 y H-070 que **copian los cuatro textos**
(observaciones, condiciones, exclusiones y notas al pie).

### 3.4 Cómo se congelan al enviar

| Opción | Qué toca | Veredicto |
|---|---|---|
| **A. Por la copia del documento que ya existe** | Solo código de la aplicación: `QuoteDocumentData`, `buildQuoteDocumentData`, `buildDocumentSnapshot` y el lector de la página del cliente | **Elegida** |
| B. Columnas en `quote_packages` con un disparador | Tabla, disparador y guardián de solo agregar | Redundante: condiciones y observaciones tampoco tienen columna ahí |
| C. Reescribir `prepare_quote_send` | La función de envío | Choca con H-041; descartada |

`contentSha256` ya sella la copia completa, así que la aprobación del sprint 6 (amarrada a ese sello) cubre los
campos nuevos sin hacer nada; el PDF congelado los trae impresos; si alguien guarda un cambio a mitad de camino
el envío cae con `CP409`; y una cotización enviada ya no se edita (`CP423`). Cero cambios en la base para el
envío y el reenvío.

### 3.5 Choques con H-041 y H-040

- **H-041** reescribe `save_quote_draft` y `prepare_quote_send` (llama a `app.quote_line_rules_check`) y cambia
  `quote-editor.tsx`. **Choca en `save_quote_draft`**: son archivos de migración distintos, así que **git no
  avisa** y la migración con fecha posterior borra en silencio el cambio de la otra. Mitigación: se construyen
  una después de la otra, nunca en paralelo; la segunda parte de la definición vigente en `main`; antes de
  mezclar se corre `test:db` completo sobre `main` actualizado; y una prueba trampa
  (`tests/db/save-quote-draft-contract.test.ts`) comprueba que siguen vivos tanto el bloqueo de precio de H-041
  como las claves `exclusions` y `footer_note`.
- **H-040** agrega un disparador en `quote_packages`; H-048b no lo toca. Hay que confirmar que ese disparador no
  valide las claves de `document_snapshot` (no se pudo ver: no está en `main`).

---

## 4. PDF

- Se agregan **dos bloques sin rediseñar**, con el mismo mecanismo (`Summary`), estilos (`noteBlock`,
  `noteTitle`) y regla de título junto a su texto. Orden: OBSERVACIONES, CONDICIONES, **EXCLUSIONES**, FORMA DE
  PAGO, **NOTAS**. Las notas van al final de la lista, **no** en el pie fijo de cada página (alto fijo, se repite
  en todas las hojas: 4.000 caracteres no caben).
- Si Aarón cambia la plantilla 1, la lista de bloques se mueve con ella.
- Más texto sube la estimación de líneas (umbral de 22): el modo «totales arriba y notas debajo» aparecerá más
  seguido. Las pruebas existentes («40 líneas», «1 página») no cambian porque su ejemplo no trae los textos
  nuevos; se agregan pruebas propias (40 líneas más los cuatro textos largos: ninguna fila cortada, números de
  página coherentes, el total una sola vez).
- Para la revisión de Aarón se genera una segunda muestra con todos los textos
  (`tmp/ejemplo-cotizacion-textos.pdf`). Plantillas 2 y 3 (H-076, sin diseño): `QuoteDocumentData` ya trae los
  cinco textos; se agrega a los criterios de H-076 que las tres los muestran.

## 5. Página del cliente, correo y reenvío

- `quote-view.tsx` suma «Exclusiones» después de «Condiciones» y «Notas» al final, como texto simple.
- En `read-model.ts` los campos **`exclusions` y `footerNote` son opcionales** (vacíos si faltan): si fueran
  obligatorios, toda cotización ya enviada dejaría de abrir para su cliente. `share_link_read` no cambia.
- El correo no los muestra (igual que las condiciones hoy); el reenvío usa el PDF y el texto congelados.
- La pantalla interna de solo lectura (`quote-read-only.tsx`) muestra los dos bloques.

## 6. Variables (las cuatro)

| Variable | Se completa con | Si falta |
|---|---|---|
| `{{cliente}}` | Nombre del cliente | «cliente», como hoy |
| `{{numero}}` | Número con versión (`formatQuoteNumber`) | No pasa |
| `{{remitente}}` | Nombre de quien envía | Queda vacío |
| `{{organizacion}}` | Nombre de la organización | No pasa |

Solo en `email_body`. **Se completan al insertar, no al enviar**: el servidor completa el texto inicial al abrir
`/enviar`; si el Comercial cambia de texto, lo completa el navegador con datos que la página ya muestra. Lo
guardado y congelado siempre es texto final, y el servidor vuelve a validarlo (`parseBasicFormat`). El valor de
cada variable se limpia antes de insertarlo (`sanitizeVariableValue`): quita caracteres de control, invisibles y
saltos de línea; `**` pasa a `*` y `](` a `] (` (para que un nombre no se vuelva enlace); separa las llaves; corta
a 100. Un solo paso de reemplazo (un cliente llamado `{{numero}}` no se reexpande). `sendQuoteInputSchema`
rechaza un correo que todavía contenga `{{variable}}`. Sin librería de plantillas (Mustache, Handlebars).

## 7. Permisos

Administrar textos: **`settings.manage`** (Dueño y Administrador) en tres capas (`pagePermission`,
`requirePermission`, `app.can`). Usarlos al cotizar: sin acción nueva (leer = `org.view`; guardar lo insertado
pasa por `quote.edit`/`quote.send`, propias). Los campos nuevos se protegen con la revisión de rol y de autor que
ya tiene `save_quote_draft`, sin tocarla. No se cambia `matrix.ts` ni `role_matrix.sql`.

## 8. Pantallas

Siguen `docs/DISENO.md` (tokens, Lucide, campos a 16 px, 44 px táctiles, sin desplazamiento horizontal a 375 px y
los cuatro estados).

- **H-048a, Configuración (Dueño y Administrador):** tarjeta «Textos listos» en `/configuracion`;
  `/configuracion/textos` (lista por tipo); `/configuracion/textos/nuevo` y `/configuracion/textos/[snippetId]`
  con tipo, nombre y texto con contador; para el correo, botones que insertan las cuatro variables, vista previa
  con datos de ejemplo y la casilla «Usar como texto inicial del correo»; eliminar con `ConfirmAction`.
  Formulario reutilizable `src/components/snippets/snippet-form.tsx` (lo usará el onboarding, H-101).
- **H-048b, editor de la cotización:** «Condiciones de la oferta» queda con la vigencia y cuatro campos en el orden
  del PDF: Observaciones (como hoy), Condiciones comerciales (pista «Plazos y forma de pago. Solo texto.»),
  **Exclusiones** («Lo que no incluye la cotización, por ejemplo «No incluye embalaje». Solo texto.») y **Notas al
  pie** («Aparecen al final del documento. Solo texto.»), cada uno opcional, con contador «x / 4.000» y el botón
  **«Insertar texto guardado»** (menú de `@base-ui/react/menu`, ya usado en el selector de organización; agrega
  al final separado por una línea en blanco; «Ya agregado» deshabilitado; «No cabe: quedaría con 4.312
  caracteres (máximo 4.000)»; «Aún no hay textos guardados» con enlace a Configuración para quien puede). Sin
  botones en solo lectura.
- **H-048b, `/enviar`:** el cuerpo parte con el texto inicial completado (si no hay, el de hoy); selector «Usar
  un texto guardado» (pide confirmar si el texto fue editado); aviso y botón Enviar deshabilitado si queda una
  variable sin completar.
- Las cotizaciones ya enviadas no cambian nunca.

## 9. Pruebas y ataques (resumen)

- **H-048a:** unitarias (variables, esquemas, la cuenta de 5.000 caracteres, acciones con un falso miembro de
  cada rol sin consultar la base); base de datos (por rol, escritura directa rechazada, el texto 51, dos
  creaciones simultáneas, nombre repetido, `CP409`, texto inicial único, variables inválidas, caracteres
  invisibles, auditoría sin el texto, paridad de constantes, deshacer); aislamiento (tabla y funciones en el
  registro, texto de B con `CANARIO-B`, ataques de Ana, Mixta y Ex, `/o/A/configuracion/textos/{id de B}` →
  «No encontrado»); e2e (crear, editar, eliminar, Carla sin permiso, 375 px).
- **H-048b:** unitarias de esquemas, `payload`, modelo del documento, copia del documento (el sello cambia si
  cambian las exclusiones), `read-model` (una copia antigua sin las claves sigue siendo válida; una nueva las
  trae; más de 5.000 caracteres se rechaza), `quote-view`, render del PDF y la guardia de variables sin
  completar; base de datos (con y sin las claves nuevas, `null` borra, 4.001 → `CP422`, caracteres de control,
  clave desconocida, no autor → `42501`, enviada → `CP423`, escribir directo rechazado, la copia enviada trae los
  dos campos, deshacer y **la prueba trampa** de `save_quote_draft`); aislamiento (`CANARIO-B` en exclusiones y
  notas de B: Ana llama a `save_quote_draft` con el id de B → `CP404` y B intacta; el PDF y la página del
  cliente de A no lo contienen); e2e (Ana guarda textos, Carla los inserta, el PDF trae «EXCLUSIONES» y «NOTAS»,
  `/enviar` sin `{{` en Mailpit, `/c/[token]` muestra los bloques y una cotización enviada antes sigue abriendo,
  un cliente `[Paga aquí](https://malo.ejemplo)` no genera enlace, 375 px, el Observador sin botones).

## 10. Orden de construcción y tamaño

**H-048a (unos 4 días), una historia en dos PR (decisión de José, 2026-11-04):**

- **PR 1, la base (unos 2 días):** módulo puro `src/lib/snippets/` con pruebas (0,5) → migración `text_snippets`,
  deshacer y pruebas de base (1) → aislamiento (0,5). Deja la tabla y las tres funciones sin ninguna pantalla:
  nadie escribe directo, así que es seguro mezclarla sola, con el `revisor` y verificación local.
- **PR 2, lo que se ve (unos 2 días):** consultas, acciones, etiquetas de auditoría y semilla (0,5) → pantallas de
  Configuración (1) → Playwright y `revisor` (0,5). La historia se da por terminada, y se prueba mirando la
  pantalla, solo al mezclar este segundo PR.

**H-048b (unos 4,5 días):** migración `quote_text_fields`, deshacer, pruebas y prueba trampa (1) → recorrido en la
aplicación (`QuoteRow`, consultas, esquemas, `payload.ts`, `editor-model.ts`, `convert-lines.ts`, solo lectura y
campos en el editor) (0,5) → PDF y muestra para Aarón (0,5) → copia del documento, `read-model.ts`,
`quote-view.tsx` (0,5) → menú «Insertar texto guardado» (0,5) → `/enviar` (0,75) → Playwright, aislamiento y
`revisor` (0,75).

**Total ~8,5 días**; cada parte sigue pasando de los dos días de `PROCESO.md`.

## 11. ¿Delicada? Criterio punto por punto (decisión 020 §5)

| Criterio | H-048a | H-048b |
|---|---|---|
| Permisos o roles | No: reutiliza `settings.manage` | No: copia la revisión de rol de `save_quote_draft` sin tocarla |
| Aislamiento | Tabla estándar cubierta por el registro de aislamiento (la 020 la nombra como ejemplo de lo **no** delicado) | **Riesgo:** reescribe una función con permisos elevados que contiene las revisiones de organización y autor |
| Dinero | No | Indirecto: la misma función recalcula y compara totales (no se cambia esa lógica) |
| Superficie pública | No | **Sí:** cambia lo que se valida y dibuja en `/c/[token]` y el PDF del cliente |
| Flujo de envío | No | Toca la copia del documento y su sello (no `prepare_quote_send`) |

**H-048a es normal** (se mezcla con el `revisor` y verificación local). **H-048b es delicada**: diseño del
`planificador`, revisión del `revisor` (Opus) y **no se mezcla sin Aarón**.

## 12. Dependencias y orden para evitar choques

| Depende de | Tipo | Qué hacer |
|---|---|---|
| Aprobación de la plantilla 1 por Aarón | Blanda | Que vea la muestra con todos los textos en la misma revisión; si rediseña, solo se ajusta la lista de bloques |
| H-076 | Al revés | H-076 debe incluir los dos campos (nota en `HISTORIAS.md`) |
| **H-041** | **Dura, por archivos** (`save_quote_draft`, `quote-editor.tsx`) | H-048b **después** de H-041 en `main`; si Aarón libera H-048b primero, H-041 parte de la versión de H-048b |
| H-040 | Ninguna, salvo lo de §3.5 | Revisarlo cuando se construya |
| H-048a | Solo para el menú de inserción y el correo inicial | Los campos propios (pasos 1 a 4 de H-048b) no dependen de H-048a |
| H-008 (PR #15) | Choques chicos en `configuracion/page.tsx`, `labels.ts`, `registry.ts`, `fixture.ts` | H-048a parte sobre `main` con H-008 ya mezclado |

**Orden:** H-008 mezclado → H-048a → H-041 → H-048b (partiendo de la versión de `save_quote_draft` que dejó
H-041). **Nunca H-041 y H-048b en paralelo.**

## 13. Migraciones: fechas y la regla

| Historia | Archivo |
|---|---|
| H-048a | `supabase/migrations/20261104110000_text_snippets.sql` (+ deshacer) |
| H-048b | `supabase/migrations/20261104130000_quote_text_fields.sql` (+ deshacer que restaura la definición vigente de `save_quote_draft`, borra las columnas y la función de la constante; se pierde lo escrito en esos campos, solo en local) |

Actualización del 2026-11-04: las fechas reservadas el 2026-11-02 (`…110000`, `…120000`, `…130000`) quedaron por
detrás de la de H-009 (`20261103100000`, PR #20). Nuevas reservas: H-048a `20261104110000`, H-040
`20261104120000`, H-048b `20261104130000`, dejando `20261104100000` libre para H-010. Siguen siendo reservas:
rige la regla de abajo, y H-048b debe quedar con fecha posterior a la de H-041.

Choque anotado: el pendiente m11 de H-092 (`20261102100000_intake_daily_cap_column.sql`) y la propuesta de
H-040 usaban la misma fecha `20261102100000`; para H-040 se sugiere `20261104120000`.

**Regla (se escribe en `README.md` o en el diseño del sprint al empezar a construir):**

1. Cada migración tiene fecha **única** y **posterior a la última integrada en `main` en el momento de
   construirse**. Las de este plan son reservas: si al construir ya hay algo posterior en `main`, se corre la fecha.
2. Si la migración **reemplaza una función existente** (`create or replace`), la fecha debe seguir siendo la más
   reciente **también al mezclar**; si no, se renombra antes de mezclar y se comprueba que su función incluya lo
   que trajeron las anteriores.
3. Antes de mezclar se corren `test:db`, `test:isolation` y `test:db:rollbacks` completos sobre `main` actualizado.

## 14. Decisiones pendientes (por cuáles bloquean)

| # | Bloquea | Qué decidir | Quién | Supuesto |
|---|---|---|---|---|
| 1 | Mezclar H-048b | ¿H-048b se marca delicada en `HISTORIAS.md` y espera a Aarón? | José | Sí |
| 2 | Construir H-048b | ¿H-041 antes que H-048b? | José | Sí |
| 3 | El PDF de H-048b | Títulos y lugar en el PDF y la página del cliente | Aarón (marca y plantilla); José puede aplicar el supuesto | «EXCLUSIONES» después de condiciones y «NOTAS» al final de la lista de bloques, no en el pie de cada página |
| 4 | El esquema de H-048a | ¿Hay un correo marcado como «texto inicial»? | José | Sí, uno por organización (`PROYECTO.md` §6.3) |
| 5 | Construir H-040 o m11 | Choque de fecha `20261102100000` | José | H-040 pasa a `20261104120000` |
| 6 | No bloquea | ¿Partir más (H-048b en «campos propios» y «usar textos guardados»)? | José | No; partirla no sacaría lo delicado de ninguna mitad |
| 7 | No bloquea | Endurecer los cuatro textos contra caracteres invisibles y de dirección invertida (hoy solo se rechazan los de control) | José | Fuera de H-048, historia chica aparte; José pidió las mismas reglas que hoy |
| 8 | No bloquea | H-069 y H-070 copian los cuatro textos | José | Sí, anotado en esas historias |
| 9 | No bloquea | ¿Condiciones por defecto cargadas solas en cada cotización nueva? | José | No: un clic (obligaría a cambiar `create_quote`) |
| 10 | No bloquea | ¿Textos guardados también para el asunto del correo? | José | No |

## 15. Riesgos y qué NO hacer

**Riesgos.** Que una migración borre en silencio el cambio de otra en `save_quote_draft` (el más serio: lo cubren
el orden de §12, la regla de §13 y la prueba trampa); que la página del cliente deje de abrir cotizaciones ya
enviadas (campos opcionales y prueba con una copia antigua); PDF con más texto (modo «notas debajo» más seguido;
pruebas de §9); choques de archivos con H-008 y H-041.

**No hacer:** tocar `prepare_quote_send`, `quote_packages` o sus disparadores · cambiar la revisión de rol de
`save_quote_draft` mientras se la reescribe · editar migraciones ya aplicadas · poner las notas en el pie fijo
del PDF · meter estos textos en el cuerpo del correo · `dangerouslySetInnerHTML` en la página del cliente ·
completar variables al enviar o guardar `{{…}}` en una cotización o paquete · apuntar desde la cotización al
texto guardado (`snippet_id`) · librerías de plantillas o variables recursivas · `audit_row_change('diff')` en
`text_snippets` · permisos de escritura directa o llave maestra · agregar acciones a la matriz · construir H-041
y H-048b en paralelo.

## Lo que el diseño no pudo verificar

El diseño real de H-040 y su disparador en `quote_packages`; la implementación real de H-041 (solo su diseño);
el nombre y la fecha de la migración de H-008; cómo pagina de verdad la plantilla 1 con cinco bloques largos
(hay que confirmarlo con las pruebas de render); que guardar el texto completo en la auditoría pase el tope de
8 KB (probable, hay que probarlo); el teclado y el lector de pantalla del menú de `@base-ui/react`; si otra
parte del código lee `document_snapshot` con una forma estricta además de `read-model.ts` (no se encontró otra);
y si la muestra `tmp/ejemplo-cotizacion.pdf` es la que Aarón revisa para aprobar la plantilla 1.

---

## Registro de construcción del PR 1 (2026-11-04)

**Qué se construyó (solo la base de H-048a):** el módulo puro `src/lib/snippets/` (`model.ts`, `schemas.ts` y sus
pruebas), la migración `20261104110000_text_snippets.sql` con su deshacer, las pruebas de base de datos
(`tests/db/text-snippets.test.ts`) y el aislamiento (`tests/isolation/registry.ts`, `fixture.ts` y
`tests/isolation/text-snippets.test.ts`). Sin pantallas, acciones de servidor, consultas ni semilla (PR 2). La
fecha de la migración dejó de ser la reservada en §13 (`20261102110000`) y pasó a `20261104110000`, posterior a
la última integrada en `main`.

**Firmas finales** (la organización sale siempre de `app.current_tenant_id()`, nunca de un argumento):

| Función | Respuesta |
|---|---|
| `create_text_snippet(p_snippet_id uuid, p_kind text, p_name text, p_body text, p_is_default boolean)` | `{result: 'created', id, revision: 1}`; repetir el mismo id en la misma organización devuelve `{result: 'exists', id, revision}` sin cambiar nada |
| `update_text_snippet(p_snippet_id uuid, p_expected_revision integer, p_name text, p_body text, p_is_default boolean)` | `{result: 'updated', id, revision}` (sube en 1) o `{result: 'unchanged', id, revision}` si no cambia nada (sin auditoría) |
| `delete_text_snippet(p_snippet_id uuid)` | `{result: 'deleted'}` |

**Códigos de error** (el motivo viaja en el mensaje): `CP404` `not_found` (sin organización activa propia, también
si la cabecera nombra otra) y `snippet_not_found`; `42501` `forbidden`; `CP409` `revision_conflict`; `CP422`
`invalid_arguments`, `invalid_kind`, `invalid_name`, `invalid_body`, `default_only_email`, `variables_not_allowed`,
`unknown_variable`, `too_many_variables`, `too_many_snippets`, `name_taken`, `id_in_use`. Orden de revisiones:
`create_text_snippet`: organización → permiso → forma de los argumentos **y reglas del texto** (nombre, texto,
variables, texto inicial; todo ANTES del candado) → candado → id repetido → tope y nombre repetido.
`update_text_snippet`: organización → permiso → forma de los argumentos → candado → existencia (`CP404`) y revisión
(`CP409`) → reglas del texto y nombre repetido. `delete_text_snippet`: organización → permiso → argumento → candado →
existencia.

**Decisiones donde el diseño no decía (todas las más conservadoras):**

1. **El tipo no se cambia nunca.** `update_text_snippet` no recibe `p_kind`; para otro tipo se crea un texto nuevo.
   El cambio es completo (nombre, texto y «texto inicial» siempre vienen).
2. **Variables, regla exacta** (igual en la base `app.snippet_variables_problem` y en `checkSnippetVariables`): en
   `email_body` solo valen las cuatro, escritas exactas (`{{cliente}}`; no `{{ cliente }}` ni mayúsculas), hasta 10
   contando repetidas, y **no puede quedar ninguna llave suelta** fuera de una variable completa (así lo que se
   inserte después no puede formar una variable nueva). En los otros tres tipos se rechaza cualquier `{{` o `}}`;
   una llave simple (`{A}`) sí vale.
3. **Caracteres no permitidos:** los mismos de `app.intake_text_unsafe` (control, invisibles, ancho cero, marcas de
   dirección), más estrictos que las observaciones y condiciones de la cotización. No se reutilizó el
   `CONTROL_CHARACTERS` de `schemas.ts` porque no se exporta y es menos estricto; una prueba compara, carácter por
   carácter en todo Unicode, la base contra el módulo puro (el carácter nulo no puede existir en la base y el
   módulo lo rechaza igual).
4. **Normalización:** el nombre y el texto pasan a forma **NFC** (una tilde separada de su letra queda unida, así
   «Condición» no convive con «Condición» escrita con la tilde aparte), se quitan espacios, tabuladores y saltos de
   línea de los bordes (`btrim` con ese juego, igual en JavaScript) y los saltos de Windows (`\r\n`, `\r`) pasan a
   `\n`; el largo se cuenta por carácter, no por unidad de UTF-16.
5. **`sanitizeVariableValue` protege también los bordes del valor**, porque dos variables pueden quedar pegadas
   (`{{organizacion}}{{cliente}}`). Cada `{` queda con un espacio después y cada `}` con uno antes
   (`{{numero}}` queda `{ { numero } }`); si el valor empieza con `(` o `*` se le antepone un espacio, y si termina
   en `]` o `*` se le agrega uno al final (así `[Org]` + `(https://...)` no forma un enlace ni `Ana*` + `*Juan` una
   negrita). El corte a 100 cuenta esos espacios, quita una `{` o un espacio que queden colgando al final del corte y
   nunca deja el valor sobre 100. La base no replica esta limpieza (la hace solo la aplicación).
6. **Idempotencia:** el mismo id en la misma organización devuelve `exists` (doble clic); el id de otra organización
   da `id_in_use` (mismo criterio que `create_intake_form`).
7. **Marcar un texto inicial** desmarca el anterior en el mismo paso: el anterior sube su revisión y queda en la
   auditoría (`text_snippet.updated`, `changed: ['is_default']`).
8. **Borrar** no pide revisión y un segundo borrado da `CP404` (la acción del PR 2 puede tratarlo como éxito).
9. **Auditoría:** `created` guarda `{kind, name, is_default}`; `updated` guarda `{kind, name, changed[]}`;
   `deleted` guarda `{kind, name, was_default}`. Nunca el texto.
10. **Deshacer:** no tiene la protección «se niega si hay datos» de otras migraciones (son textos de configuración,
    no datos personales de terceros). Pierde los textos y deja la auditoría.
11. **Esquema de cambiar sin tipo:** `updateSnippetSchema` no recibe `kind` (el tipo nunca cambia y la base usa el de
    la fila). Las variables y el «texto inicial» se revisan con `checkKindRules(kind, { body, isDefault })`, y **el
    PR 2 debe llamarla con el tipo guardado en la fila, no con uno que mande el navegador**. La constante
    `SNIPPET_REVISION_MAX` (2.147.483.647, un entero de 32 bits de la base) reemplaza al número escrito a mano.
12. **Etiquetas de auditoría:** las guardias de aislamiento y de pruebas unitarias no las exigen; se dejan para el PR 2
    (`src/lib/audit/labels.ts` muestra el código mientras tanto).

**Pruebas de paridad** (fallan si una de las dos partes cambia sola): constantes (`app.snippet*` contra el módulo),
lista de tipos y de variables, caracteres no permitidos (todo Unicode), revisión de variables (unos 30 textos × 4 tipos)
y normalización.

**Límites conocidos:**

- **Desfase de emojis (ya existía, es de otra historia):** un texto de correo con 1.000 emojis o más cabe en la base
  (cuenta por carácter) pero `parseBasicFormat` mide con `.length` (un emoji vale 2), así que puede pasar el
  máximo de 5.000 del correo.
- **U+2065** (carácter sin asignar) lo acepta el texto guardado y lo rechaza el correo; viene de
  `app.intake_text_unsafe`, que no lo incluye.
- Un nombre o texto formado solo por espacios Unicode raros (por ejemplo `U+00A0`) pasa la regla de «no vacío»; la
  base y el módulo puro coinciden en eso. No se endureció para no separar las dos partes.
- `sanitizeVariableValue` no puede impedir que el *texto de la plantilla* escrito por el administrador forme un
  enlace o una negrita junto al valor insertado (por ejemplo `[{{cliente}}](...)`): el administrador es de confianza.
- El deshacer se probó dentro de una transacción (deshacer, reaplicar y verificar), pero **no** con
  `npm run test:db:rollbacks` (vacía la base local; no se corrió).
- `.next/types/validator.ts` de esta carpeta apunta a rutas de otra rama (`/invitacion`) y `tsc` lo marca; es ajeno a
  este PR (se regenera con `next typegen`).
- La base local tenía aplicada `20261103100000_invitation_accept.sql` (de otro PR): `supabase migration up --local`
  se niega por eso («Remote migration versions not found in local migrations directory»). Esta migración se aplicó
  ejecutando el archivo y registrando su versión en `supabase_migrations.schema_migrations`, que es lo mismo que
  hace `migration up`. Con esa migración ajena, la guardia G3 del aislamiento lista `accept_invitation` e
  `invitation_preview` como funciones sin registrar: falla hasta que ese PR agregue sus entradas al registro.

---

## Registro de construcción del PR 2 (2026-11-04)

**Qué se construyó (lo que se ve de H-048a):** la capa de datos de la aplicación, las pantallas de «Textos listos»
en Configuración, las etiquetas de auditoría, la semilla y las pruebas. Sin cambios en la base de datos (ninguna
migración nueva).

**Rutas y archivos**

| Qué | Dónde |
|---|---|
| Lista agrupada por tipo (con estado vacío, de error y esqueleto) | `/o/[tenantId]/configuracion/textos` (`page.tsx`, `loading.tsx`) |
| Nuevo texto | `/o/[tenantId]/configuracion/textos/nuevo` |
| Editar y eliminar | `/o/[tenantId]/configuracion/textos/[snippetId]` |
| Tarjeta «Textos listos» | `configuracion/page.tsx` (lista `SECTIONS`, ícono `FileText`) |
| Formulario reutilizable (lo usará H-101) | `src/components/snippets/snippet-form.tsx` |
| Lista de tarjetas | `src/components/snippets/snippet-list.tsx` |
| Acciones de servidor | `src/lib/snippets/actions.ts` (`createSnippetAction`, `updateSnippetAction`, `deleteSnippetAction`) |
| Llamadas a la base (solo las tres funciones) | `src/lib/snippets/service.ts` |
| Traducción de errores | `src/lib/snippets/errors.ts` |
| Lecturas (agrupadas y ordenadas; uno por id) | `src/lib/snippets/queries.ts`, `groups.ts` |
| Datos de ejemplo de la vista previa | `src/lib/snippets/preview.ts` |
| Etiquetas de auditoría | `src/lib/audit/labels.ts` (`text_snippet.created/updated/deleted`, recurso «Texto guardado», campos «texto» y «texto inicial») |
| Semilla | `scripts/seed.ts` (`seedSnippets`) |
| Pruebas | `src/lib/snippets/*.test.ts`, `src/components/snippets/snippet-form.test.tsx`, `tests/isolation/` (registro de rutas y guardia estática 12), `e2e/text-snippets.spec.ts`, `e2e/isolation.spec.ts` (P30) |

**Decisiones donde el diseño no decía (las más conservadoras)**

1. **Las acciones reciben datos simples, no un formulario**, y la pantalla las llama dentro de un `try/catch` (no con
   `useActionState`): un fallo de red se muestra como aviso en la misma pantalla y lo escrito no se pierde (lección
   de H-009). El identificador del texto nuevo lo genera la página al abrirse (`crypto.randomUUID()` en el servidor).
2. **Cambiar un texto lee antes el tipo guardado** (`text_snippets.kind` con el pase de la persona) y valida las
   variables y el «texto inicial» con `checkKindRules(tipo_guardado, …)`. Un texto que no está (o es de otra
   organización) responde «No encontramos este texto…» sin llamar a la función. El esquema es estricto: un `kind` que
   mande el navegador se rechaza.
3. **Borrar un texto que ya no existe es éxito** (`CP404` con motivo `snippet_not_found`); `CP404 not_found`
   (sin organización) no se disfraza de éxito. Crear con un identificador repetido (`exists`) también es éxito.
4. **Validación doble:** la pantalla revisa nombre, texto y variables con los mismos esquemas del módulo (así no hay
   reglas duplicadas) antes de ir al servidor; el servidor y la base las vuelven a exigir.
5. **Vista previa:** sin `dangerouslySetInnerHTML`. Se completan las variables con datos de ejemplo (`Ana Pérez`,
   `COT-2026-0001`, `Juan Soto`, `Tu Empresa SpA`) y se muestra la versión en texto del lector del formato básico
   (`parseBasicFormat(...).text`): negritas sin asteriscos y enlaces como «texto (dirección)». Si el texto no se
   podría enviar (enlace engañoso, demasiados enlaces) la vista previa lo avisa; guardar no se bloquea por eso.
6. **Auditoría:** la base guarda tipo, nombre y campos cambiados (nunca el texto). El visor solo nombra los campos
   que cambiaron; no muestra el nombre ni el texto.
7. **Tope de 50:** al llegar al máximo se oculta el botón «Nuevo texto» y la lista lo explica; la base lo vuelve a
   exigir.
8. **Contador «x / 4.000»** sin anuncio en cada tecla para lectores de pantalla; solo se anuncia al pasar el máximo.
9. **Semilla:** entra como el Dueño de cada organización de demostración (`ana`, `beto`) y llama a
   `create_text_snippet`, porque ni siquiera la llave maestra puede insertar directo (las restricciones de la tabla
   llaman funciones sin permiso para ese rol). Cuatro textos por organización (correo inicial, condiciones,
   exclusiones, nota al pie).

**Mensajes de error por código** (en `errors.ts`; el motivo viaja en el mensaje de la base)

| Código · motivo | Mensaje |
|---|---|
| `42501` | «No tienes permiso para esto.» |
| `CP404` (`snippet_not_found`, `not_found`) | «No encontramos este texto. Puede que otra persona lo haya eliminado.» (al borrar `snippet_not_found` es éxito) |
| `CP409` `revision_conflict` | «Otra persona cambió este texto mientras lo editabas. Recarga para ver la versión actual.» (con botón «Recargar la versión actual») |
| `CP422` `name_taken` | «Ya tienes un texto con ese nombre en este tipo. Elige otro nombre.» (bajo el nombre) |
| `CP422` `too_many_snippets` | «Llegaste al máximo de 50 textos guardados. Elimina alguno para crear otro.» |
| `CP422` `unknown_variable`, `variables_not_allowed`, `too_many_variables` | Los mensajes de `SNIPPET_VARIABLE_PROBLEM_MESSAGES` (bajo el texto) |
| `CP422` `default_only_email` | «Solo un texto del correo puede ser el texto inicial.» |
| `CP422` `invalid_name`, `invalid_body` | Piden revisar largo y caracteres (bajo el campo) |
| `CP422` `invalid_kind`, `invalid_arguments`, `id_in_use`, otros | Mensaje genérico; en el log solo queda el código |

**Límites conocidos**

- La vista previa no dibuja negritas ni enlaces con formato (sería HTML); muestra la versión en texto.
- Una pestaña que quedó abierta sobre un texto que otra persona eliminó: al guardar recibe «No encontramos este texto…».
- Tras guardar una edición, la pantalla se vuelve a cargar (la clave del formulario incluye la revisión), así que se
  reinicia con lo guardado; lo que se haya escrito mientras se guardaba se pierde.
- No se probó con lector de pantalla, Safari ni Firefox (solo Chromium con Playwright y jsdom).
- El caso «Comercial sin permiso» del aislamiento de pantalla se prueba en `e2e/text-snippets.spec.ts` (hay un
  Comercial real); en la fixture de aislamiento no hay un miembro sin permiso con navegador, y lo de base de datos (Dante,
  Observador) ya lo cubre `tests/isolation/text-snippets.test.ts`.

**Correcciones de la ronda 1 de revisión (PR 2)**

- **Textos que prometían de más.** Usar los textos al cotizar y que el correo parta con el texto inicial llegan con H-048b.
  Hasta entonces la pantalla lo dice con honestidad («Pronto podrás usarlos al cotizar», «el correo podrá partir con
  este texto») en la lista, el estado vacío, «Nuevo texto», el recuadro de variables, la casilla del texto inicial y las
  ayudas de tipo. La vista previa con datos de ejemplo no cambió.
- **Un correo que no se podría enviar ya no se guarda.** `checkSnippetEmailFormat` (en `preview.ts`) prueba el texto como
  lo haría el envío (variables de ejemplo y lector del formato básico). Quedó dentro de `checkKindRules`, el punto único
  que usan crear (esquema), cambiar (servicio), la pantalla y la semilla: para el tipo correo, un enlace engañoso o más de
  20 enlaces se rechazan en el servidor con el mensaje de `BASIC_FORMAT_ERROR_MESSAGES` (sin repetir lo escrito, nada
  nuevo en logs ni auditoría); los otros tres tipos no pasan por esa revisión. La pantalla lo anticipa con el mismo
  chequeo. Esto reemplaza lo dicho en la decisión 5 («guardar no se bloquea por eso»).
- **375 px.** La lista usa `grid-cols-1` y `min-w-0` en cada tarjeta: un nombre de 40 letras sin espacios ya no estira la
  página (el caso e2e falló con 68 px de más sin la corrección).
- **Semilla.** `signOut({ scope: "local" })` (ya no cierra las sesiones de Ana y Beto en otros navegadores) y los correos
  de los Dueños salen de `PEOPLE`. No se corrió la semilla.
- **Accesibilidad.** La tarjeta de la lista ya no pisa su contenido con un `aria-label` (se oye nombre, «Texto inicial» y
  extracto); el contador «x / 4.000» está en el `aria-describedby` del campo; el error de «Usar como texto inicial» queda
  conectado a la casilla (`aria-describedby` y `aria-invalid`).
- **«Ya existía».** La respuesta `exists` ahora dice «Este texto ya estaba guardado; revisa que quedó como querías.» y,
  al crear, lleva a la pantalla de ese texto en vez de a la lista.
- **Etiqueta de auditoría** `is_default` pasó a «predeterminado» (era «texto inicial» para todo el sistema).
- **Detalles.** `KIND_REQUIRED_MESSAGE` se exporta desde `schemas.ts`; el caso e2e de «No encontrado» se renombró a lo que
  prueba (identificador al azar o roto); y `/textos/nuevo` con el tope de 50 muestra el aviso arriba en vez de dejar
  escribir.
## Verificación del 2026-11-04

Contrastado con `origin/main` (última migración `20261102100000`; H-009 trae `20261103100000` en el PR #20):

- **Existen** los archivos y piezas que el diseño nombra: `defaultEmailBody` (`src/lib/quotes/send/content.ts`),
  `parseBasicFormat` (`src/lib/email/basic-format.ts`), `ConfirmAction`, `documentSnapshotSchema`
  (`src/lib/share/read-model.ts`), `app.intake_text_unsafe`, `app.set_row_meta_by`, `app.forbid_tenant_change`,
  `app.audit_row_change`, `settings.manage`, y las fixtures y el registro de aislamiento.
- **`save_quote_draft` tiene una sola definición vigente** (`20261005130000_brand_server_only_logo.sql`), con las
  claves permitidas `customer_id`, `global_discount`, `validity`, `observations` y `conditions`, y la revisión de
  rol con `app.has_role('owner','admin','sales')`: es justo lo que H-048b debe copiar sin tocar.
- **`app.quote_text_max_length` no existe** (la crea H-048b), y `text_snippets` tampoco (la crea H-048a).
- **H-008 ya está en `main`**: `configuracion/page.tsx` ya tiene «Tu equipo», `labels.ts` tiene `invitation.*` y
  `src/lib/team/` es el patrón más reciente de acciones, errores y esquemas para H-048a. Los choques de §12 con
  H-008 desaparecen; los de H-009 (PR #20) son los mismos archivos (`labels.ts`, `registry.ts`, `fixture.ts`) y
  se resuelven con un `git merge` de `main` al empezar.
- **Sigue sin poder verificarse:** H-041 y H-040 (no construidas) y cómo pagina la plantilla 1 con cinco bloques
  largos (lo dirán las pruebas de render).

