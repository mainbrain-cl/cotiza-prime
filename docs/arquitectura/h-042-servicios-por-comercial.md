# H-042 · Limitar qué servicios cotiza cada comercial (M02) — plan de construcción

> **Estado: diseño del `planificador` (Opus), 2026-11-05. Sin construir.** Es una historia 🔒 **delicada** (permisos por persona y una
> función con permisos elevados): por la decisión 020 §5 su PR queda abierto hasta que Aarón lo revise. Las decisiones D1 a D13 (§10)
> llevan un supuesto por defecto; **José los aplicó el 2026-11-05** (regla de trabajo: lo corriente y reversible se aplica con la
> opción recomendada y se anota). **Aarón revisó el diseño el 2026-11-05** y fijó D2, D3, D7, D10 y D13 (§10) como «decisión por defecto
> aplicada por Aarón el 2026-11-05». Esta versión incorpora esa revisión.
>
> **Antes de construir:** la fecha de la migración se asigna en ese momento (única y posterior a la última de `main`). H-010 ya tomó
> la suya (`20261105110000`, en el PR #28 abierto), así que la de H-042 debe ser posterior a esa y a la última de `main`.

**Resumen**

1. La regla se guarda en dos tablas nuevas, ambas con `tenant_id`: una dice si la persona tiene «todos los servicios» o «solo los
   elegidos», y la otra guarda los elegidos. Solo se cambian con una función de la base que exige el permiso de equipo (`team.manage`).
2. La regla se hace cumplir en la base, al agregar una **línea nueva** del catálogo en `save_quote_draft`. Las líneas que ya existían
   no se revisan ni se tocan, así se cumple el criterio 3. No va en la función de H-041 (`quote_line_rules_check`), porque esa también
   corre al enviar y bloquearía borradores antiguos.
3. Para no pisar a H-041 ni a H-048b, se recomienda que H-041 deje un «gancho»: una llamada a una función que por ahora siempre
   responde «sí». Así H-042 solo reemplaza esa función pequeña y **nunca reescribe `save_quote_draft`**.
4. Solo afecta al Comercial. Esto se deduce de la matriz sin agregar acciones: limitado = puede cotizar pero no puede manejar el
   catálogo. Por ahora las líneas escritas a mano no se limitan, igual que en el supuesto 18 de H-041. **Con eso, H-042 *ordena* (cada
   Comercial ve una lista más corta) y *no controla*: un Comercial limitado igual puede escribir una línea libre con cualquier nombre y
   precio.** La versión que sí controla se decide junto con la pregunta 18 de H-041, para toda la organización y no por persona (D2).
5. Son unos 3,75 días, no «chico». Es **delicada** porque toca permisos y una función con permisos elevados: va con `revisor` y no se
   mezcla sin Aarón.

---

## 1. Qué existe hoy

**Verificado en el código:**

- **El cotizador lee el catálogo en un solo lugar**: `listQuotableCatalogItems` en `src/lib/quotes/catalog-source.ts`. Su comentario ya
  anticipa H-042.
- **Hay un segundo lector que el comentario no menciona**: `loadActiveCatalog` en `src/lib/intake/convert-lines.ts`. Lo usan
  «convertir solicitud en cotización» y el panel «Solicitud original» del editor (`convert-queries.ts`). Así que H-042 **no** cambia un
  solo archivo.
- **La versión vigente de `save_quote_draft`** está en `supabase/migrations/20261005130000_brand_server_only_logo.sql`. En cada guardado
  borra y vuelve a insertar todas las líneas. Ya distingue la **línea existente** (mismo id ya guardado en esa cotización: conserva su
  servicio) de la **línea nueva del catálogo** (rama `elsif v_cat_id is not null`, que exige un servicio activo). H-042 se engancha ahí.
  También están ahí `catalog_item_changed` (reusar el id de una línea con otro servicio) e `item_id_conflict` (reusar el id de una
  línea de otra cotización).
- **Nadie escribe directo en las líneas**: no hay permisos de escritura directa (`20261005110000_quotes.sql:190`); todo pasa por
  `save_quote_draft`.
- **La conversión de solicitudes (H-090) también guarda por `save_quote_draft`**: `src/lib/intake/convert-lines.ts:99` (llama a `saveQuoteDraftAction`, que a su vez llama a la función de la base).
- **El catálogo nunca se borra**: no hay permiso de borrado, solo se desactiva (`is_active`).
- **La matriz** (`src/lib/permissions/matrix.ts` y su gemela en la base, `app.role_can` de la migración `role_matrix`) no tiene una
  acción para esto. Agregar una acción obliga a redefinir `app.role_can` en otra migración y rompe
  `tests/db/permissions-parity.test.ts`, como ya anotó el diseño de H-040.
- **Guardias que hay que respetar:**
  - Ningún nombre de rol escrito fuera de `src/lib/permissions/` (`guards.test.ts`) ni dentro de funciones nuevas de la base (guardia 14
    de `tests/db/schema-guards.test.ts`).
  - Toda tabla con `tenant_id`, RLS y el disparador `forbid_tenant_change`, y relaciones compuestas (organización + id).
  - Toda acción de servidor llama a `requirePermission(`.
- **«Tu equipo»** (`src/app/o/[tenantId]/equipo/page.tsx`) en `main` lista solo invitaciones. **H-010 ya está construida en el PR #28
  abierto** (rama `feat/h-010-gestionar-miembros`, commit `1bc5e97`): agrega la lista de miembros y `/equipo/[memberId]/page.tsx` con
  una ficha mínima comentada «H-042 le agrega después su sección». Su migración es `20261105110000`. Aunque el diseño del sprint 5 no
  definía la ficha, el PR la trae; H-042 depende de que el PR #28 se mezcle.

**Viene del diseño, no del código:**

- **`app.quote_line_rules_check` no existe todavía en el código.** Que «también corre al enviar» sale del diseño del sprint 5
  (`sprint-5-equipo-y-permisos.md` §5c), no de una función real. Lo que §3 razona sobre ella vale si H-041 se construye como está
  diseñada.
- `docs/arquitectura/modelo-datos.md` §7 esbozaba una tabla `member_catalog_permissions (member_id, catalog_item_id)`. Le falta cómo
  distinguir «todos» de «lista».

---

## 2. Cómo se guarda la regla

### Tablas (una migración, por ejemplo `<fecha>_member_catalog_scope.sql`, con su deshacer)

> **Alternativa considerada y descartada (D13): una sola tabla.** Bastaría `member_catalog_scope_items`, donde no tener filas significa
> «todos los servicios» (D6 prohíbe la lista vacía), y la doble pulsación se cubriría comparando la lista esperada. Se descartó por
> dos razones: (1) la línea «Cambiado por Ana el dd-mm-aaaa» de la ficha no puede salir de la auditoría, porque `audit.read` es solo del
> Dueño y la ficha la ve también el Administrador; (2) la columna `revision` protege mejor contra el doble clic y contra dos
> Administradores que se pisan. Por eso se dejan **dos tablas**, y todo este documento está escrito así.

**`public.member_catalog_scopes`**: una fila por miembro que tiene una regla. Si no hay fila, significa «todos».

| Columna | Qué guarda |
|---|---|
| `tenant_id uuid not null` | Organización (→ `tenants`, `on update cascade`) |
| `member_id uuid not null` | La membresía, **no la persona**: Mixta puede tener reglas distintas en A y en B. Relación compuesta `(tenant_id, member_id)` → `members (tenant_id, id)` |
| `mode text not null` | `all` o `list` (lista cerrada) |
| `revision integer not null default 1` | Para que dos Administradores no se pisen sin saberlo |
| `created_by/at`, `updated_by/at` | Con `app.set_row_meta_by`. La ficha muestra «Cambiado por Ana el dd-mm-aaaa» |

- Llave principal `(tenant_id, member_id)`.
- Disparador `forbid_tenant_change`.

**`public.member_catalog_scope_items`**: la lista.

| Columna | Qué guarda |
|---|---|
| `tenant_id`, `member_id` | Relación compuesta → `member_catalog_scopes`, `on delete cascade` |
| `catalog_item_id` | Relación compuesta `(tenant_id, catalog_item_id)` → `catalog_items (tenant_id, id)`. Así un servicio de otra organización no cabe nunca. `on delete cascade` solo pesa en un futuro borrado de la organización, porque hoy nadie borra servicios |
| `created_at`, `created_by` | |

- Llave principal `(tenant_id, member_id, catalog_item_id)`.
- Índice `(tenant_id, catalog_item_id)`.
- Disparador `forbid_tenant_change`.

**RLS** (reglas de la base que filtran cada fila):

- Leer: `tenant_id = current_tenant_id()` y `app.can('team.manage')`, es decir, solo Dueño y Administrador. El Comercial **no lee estas
  tablas**: sabe lo suyo por funciones que solo hablan de él (ver §3).
- **Sin permisos para crear, editar ni borrar directo.** Así la tabla entra limpia al registro de aislamiento como «business» que leen
  Dueño y Administrador.

**Quién escribe**: una sola función, `public.set_member_catalog_scope(p_member_id, p_mode, p_catalog_item_ids uuid[],
p_expected_revision)`. Es `SECURITY DEFINER` (corre con permisos elevados) con `search_path = ''` y hace esto, en orden:

1. Sesión y `app.can('team.manage')`. Si no, `42501`.
2. Valida los argumentos: el modo; en `list`, entre 1 y `app.member_catalog_scope_max_items()` servicios (supuesto 500), sin vacíos y
   sin repetidos (se deduplican). Si no, `CP422` con `invalid_mode`, `empty_list` o `too_many_items`.
3. Busca y **bloquea** al miembro **dentro de la organización activa**. Si no existe ahí, `CP404`: un id de otra organización da «no
   encontrado». Si está quitado, `CP422 member_removed`.
4. **¿Se le puede limitar?** Solo si su rol puede cotizar y no puede manejar el catálogo: `app.role_can(rol, 'quote.create') and not
   app.role_can(rol, 'catalog.manage')`, sin nombres de rol. Hoy eso es solo Comercial. Si no, `CP422 member_not_limitable`.
5. **Si lo pedido es igual a lo guardado, responde «listo» sin cambiar nada** y sin auditar. Así un doble clic no da error.
6. Compara la versión esperada. Si no coincide, `CP409`.
7. Todos los ids deben ser servicios de esta organización. Si no, `CP422 catalog_item_not_found`, sin decir cuál ni de quién.
8. Guarda: crea o actualiza la fila, reemplaza la lista y sube la versión. Con `all`, la lista se borra.
9. **Historial**: registro `member.catalog_scope_changed` en la auditoría, con el miembro como recurso y en el detalle el modo antes y
   después, la cantidad antes y después, los ids agregados y quitados (hasta 50 de cada uno) y `truncated`. Nunca lleva nombres de
   personas. **Sigue la convención de «persona afectada» de H-010**: el miembro afectado queda como recurso y su nombre se resuelve al
   leer (con `UNKNOWN_SUBJECT` si no se puede), como en `src/lib/audit/labels.ts` del PR #28. Respeta el tope de 8 KB del detalle. No se usa `audit_row_change('diff')`. No hace falta otra tabla de historial: la
   auditoría la ve el Dueño (H-014) y la ficha muestra quién cambió la regla por última vez, leyendo `updated_by/at` de la tabla (no de la auditoría).

### Qué significa cada caso

| Caso | Qué pasa |
|---|---|
| **«Todos los servicios»** | Sin fila, o con fila `all`. Ve y agrega cualquier servicio activo, también los que se creen después |
| **«Solo los que elijas»** | Fila `list` y al menos un servicio. Solo ve y agrega esos |
| **Servicio que se desactiva** | Sigue en la lista, pero nadie lo cotiza (la regla de activo ya existe). Si se reactiva, vuelve a estar disponible para quien lo tenía. En la ficha aparece aparte, como «Desactivado en el catálogo», con opción de quitarlo |
| **Servicio que se «borra»** | Hoy no existe borrar, solo desactivar. Si algún día se borra la organización completa, la lista se borra en cascada |
| **Servicio nuevo** | Quien tiene «lista» **no lo ve** hasta que un Administrador lo agregue: la lista es cerrada y lo no elegido no se cotiza. La ficha lo dice: «Los servicios nuevos no se suman solos». Decisión D3, fijada por Aarón: los servicios nuevos **no** se agregan automáticamente a listas restringidas (lo más seguro) |
| **Comercial quitado del equipo (H-010)** | Pierde el acceso, así que la regla deja de importar. La fila **se conserva**. Si vuelve como Comercial por invitación (H-009 reactiva la misma membresía, `invitation_accept.sql:314`), **la lista vieja vuelve a aplicar**. Es seguro, porque solo restringe, pero sorprende: al invitar de nuevo a alguien que tuvo una regla, la pantalla de invitación avisa (aviso incluido en el PR 2, ver §8) «Esta persona estuvo antes en el equipo con una lista de servicios; volverá a aplicarse. Revísala en su ficha». Decisión D4 |
| **Cambio de rol** | Si pasa a Administrador, la fila se conserva pero no aplica (§4). Si vuelve a Comercial, aplica otra vez. La ficha lo muestra. Decisión D4 |

---

## 3. Dónde se hace cumplir (no solo en la pantalla)

### El predicado único, en la base

- **`app.catalog_scope_limited()`** responde «sí» solo si **no** tengo `catalog.manage` **y** mi membresía activa en la organización
  activa tiene una fila `list`.
- **`app.can_quote_catalog_item(p_catalog_item_id)`** responde «sí» si el servicio es de la organización activa **y**, o bien no tengo
  límite, o bien el servicio está en mi lista.

Las dos son `stable`, `SECURITY DEFINER`, con `search_path = ''`, y no escriben nombres de rol. Este es el predicado que usan
**mostrar** y **guardar**, así lo que se ve y lo que se guarda no pueden diferir.

### Al guardar, en `save_quote_draft`, solo en líneas nuevas

En la rama de línea nueva del catálogo, justo después de comprobar que el servicio existe y está activo:

```sql
if not app.can_quote_catalog_item(v_cat_id) then
  raise exception 'catalog_item_not_allowed@%', <n> using errcode = 'CP422';
end if;
```

El número de línea `<n>` usa la misma convención que defina H-041 para `price_locked@n`.

- **Líneas existentes** (mismo id ya guardado en esa cotización): no se revisan. Así un borrador con un servicio que después salió de
  la lista se sigue guardando y enviando (criterio 3).
- **Los atajos ya están cerrados por lo que existe**:
  - Reusar el id de una línea existente con otro servicio da `catalog_item_changed`.
  - Reusar el id de una línea de otra cotización da `item_id_conflict`.
  - Una línea quitada y vuelta a agregar es nueva, así que se revisa.

### Por qué no en `app.quote_line_rules_check` (la función de H-041)

El diseño del sprint decía «se engancha en la función de H-041», y no conviene así. Esa función la llaman también `prepare_quote_send`
(preparar el envío) y el propio guardado **sobre todas las líneas**, sin saber cuáles son nuevas. Puesta ahí, la regla:

- bloquearía el envío de borradores que ya tenían el servicio, y eso rompe el criterio 3;
- o obligaría a cambiar la firma de la función de H-041 para pasarle «es nueva».

**Para no chocar** (git no avisa si una migración pisa la función de otra):

- **Camino A (recomendado).** H-041, que de todos modos reescribe `save_quote_draft`, deja escritas las tres líneas de arriba y crea
  `app.can_quote_catalog_item` como **función vacía que siempre responde «sí»**, con un comentario que lo explica. Después H-042 solo
  hace `create or replace` de esa función pequeña y de nada más.
  - Orden: … → H-041 (con el gancho) → **H-042 y H-048b, en cualquier orden entre ellas**, porque ya no comparten función.
  - **El deshacer de H-042 debe restaurar la función vacía, nunca borrarla**: `save_quote_draft` la llama y, sin ella, fallaría cada
    guardado.
- **Camino B** (si se quiere H-042 antes que H-041). H-042 reescribe `save_quote_draft`: copia la versión vigente en `main` y agrega las
  tres líneas. Después H-041 y H-048b parten de la versión de H-042. Son tres reescrituras seguidas, nunca en paralelo, cada una con
  fecha posterior también al mezclar (regla de `sprint-5-h-048-textos.md` §13). Cuesta 0,5 día más y suma riesgo.
- **En los dos caminos**: la prueba trampa `tests/db/save-quote-draft-contract.test.ts` la crea quien llegue primero y cada historia le
  suma su caso. H-042 suma: «un Comercial limitado que llama directo a `save_quote_draft` con un servicio fuera de su lista recibe
  `CP422`, y una línea existente con ese servicio se sigue guardando». Antes de mezclar se corren `test:db` y `test:db:rollbacks`
  completos sobre `main` al día.
- **Prueba que vigila el gancho (la entrega H-041).** H-041 entrega además un test que, **dentro de una transacción**, reemplaza la
  función vacía (siempre «sí») por una que responde «no» y espera `CP422` desde `save_quote_draft`. Así, si alguien reescribe
  `save_quote_draft` (por ejemplo H-048b) y pierde la llamada al gancho, un test falla. Sin él, el límite podría desaparecer en
  silencio.

### Al mostrar (el criterio 2)

- **`public.quotable_catalog_items(p_search text default '', p_ids uuid[] default null)`**:
  - Devuelve los servicios activos de la organización activa que pasan el predicado.
  - **Corre con los derechos de quien llama (`security invoker`)** y solo usa el predicado `SECURITY DEFINER` para decidir. Así la RLS
    de `catalog_items` sigue como segunda capa.
  - Con búsqueda, devuelve hasta 20 por nombre parcial. Escapa los comodines `%` y `_` como hoy.
  - Con `p_ids`, devuelve hasta 200, para convertir solicitudes.
  - «¿Tengo límite?» se calcula **una vez por consulta**, con el patrón `(select …)` que ya usan las políticas, y no fila por fila.
  - Se llama con `.rpc()` (POST). **Nunca** se mandan 500 ids en la dirección de un GET.
- **`public.my_catalog_scope()`** devuelve solo dos datos sobre quien llama: si tiene límite y cuántos servicios tiene permitidos.
  **La cuenta incluye solo servicios activos** (uno desactivado en la lista no cuenta), para que «sin servicios permitidos» del editor
  sea verdad. Sirve para el aviso del editor.
- **Cambia `catalog-source.ts`**: llama a `quotable_catalog_items` en vez de leer `catalog_items` directo.
- **Cambia `convert-lines.ts`**: `loadActiveCatalog` usa la misma función con `p_ids`. Un servicio no permitido queda en «no se cargó»,
  en vez de hacer fallar el guardado entero y dejar la cotización vacía. Esto cubre también las líneas que el panel «Solicitud
  original» ofrece cargar.
  - **Carrera conocida:** si la lista cambia justo mientras alguien convierte una solicitud, el catálogo ya leído trae un servicio que
    la base después rechaza. Todo el guardado falla y queda un borrador vacío (comportamiento que ya existe hoy). H-042 no lo
    arregla; queda anotado.

### Caminos futuros (anotar en `HISTORIAS.md`)

H-069 (crear versión) y H-070 (duplicar) van a crear líneas. Si las insertan directo, sin pasar por `save_quote_draft`, **se saltan la
regla**. Nota para esas historias:

- **duplicar** debe consultar `app.can_quote_catalog_item` y omitir con aviso los servicios no permitidos; si no, duplicar la
  cotización de un colega saltaría el límite;
- **la versión nueva** conserva las líneas solo si es **la misma cotización y el mismo autor** (misma negociación). Si la crea otra
  persona, se trata como un duplicado: omite con aviso los servicios no permitidos (decisión D10, fijada por Aarón).

---

## 4. Quién se ve afectado

| Rol | Efecto |
|---|---|
| **Comercial** | El único limitado |
| **Dueño, Administrador** | Nunca limitados: tienen `catalog.manage` y ya manejan el catálogo entero, así que una lista no tiene sentido para ellos. No se les puede crear una regla (`member_not_limitable`) |
| **Aprobador, Observador** | No cotizan (sin `quote.create`). No se les puede crear una regla |

**Por qué no hay acción nueva en la matriz.**

- «Quién fija la regla» reutiliza `team.manage`: la ficha es parte del manejo del equipo.
- «A quién se limita» se deduce de dos acciones que ya existen: puede `quote.create` y no puede `catalog.manage`.
- Una acción nueva redefiniría `app.role_can` en otra migración, rompería `permissions-parity.test.ts` y chocaría con otras historias del
  sprint.
- El costo: si algún día un rol debe manejar el catálogo y aun así estar limitado, recién ahí se agrega una acción propia.
- **En la aplicación**, `roleCanBeLimited(role) = canEver(role, "quote.create") && !can(role, "catalog.manage")` vive en un módulo
  puro, sin escribir nombres de rol. Una prueba de paridad la compara con la expresión de la base para los 5 roles.

**H-004c** (dos pasos obligatorios): un Dueño o Administrador sin el segundo paso actúa como Observador y no cotiza, así que no hay
interacción.

**Líneas libres con precio a mano** (pregunta 18 de H-041). Supuesto que Aarón mantiene por ahora (D2): **no se limitan**, igual que
en H-041, porque `PROYECTO.md` §6.0 las pide para negociar. Dicho sin rodeos: **con este supuesto H-042 ordena y no controla.** Cada
Comercial ve una lista más corta, pero uno limitado a «Fletes» puede escribir a mano «Mudanza» con el precio que quiera. La ficha lo
dice con honestidad: «Las líneas escritas a mano no se limitan». La versión que sí controla (cerrar las líneas escritas a mano para
los Comerciales limitados) se decide **junto con la pregunta 18 de H-041, para toda la organización y no por persona**.

**Línea existente de un servicio que ya no está permitido.** Se puede **renombrar y cambiar de precio**, porque las líneas existentes
no se revisan. Con D2 como está es inofensivo (igual podría escribir una línea libre); si D2 pasa a «controlar», se vuelve un
agujero y habría que revisarlo. Para que no pase inadvertida, el editor avisa en esas líneas (§5).

**La pantalla «Catálogo»** sigue mostrando todo a todos (decisión 009, «ver todo»). El límite es sobre **qué se cotiza**, no sobre qué
se ve.

---

## 5. Pantallas (según `docs/DISENO.md`)

### Ficha del miembro: `/o/[tenantId]/equipo/[memberId]`

La crea H-010 (PR #28, ya construida como ficha mínima; decisión D7). H-042 solo agrega su sección en el lugar que H-010 dejó
comentado. Exige `pagePermission(active, "team.manage")` antes de leer cualquier dato. Un
miembro de otra organización da «No encontrado».

Sección **«Servicios que puede cotizar»**, sobre superficie sólida y sin vidrio (es una pantalla de trabajo):

- **Una frase arriba** con cómo quedó: «Carla puede cotizar todos los servicios» o «Carla puede cotizar 3 servicios: Flete local, …».
- **Dos opciones grandes** (radio de 44 px), cada una con su explicación:
  - «Todos los servicios del catálogo»: «Incluye los que agregues después».
  - «Solo los que elijas»: «Los servicios nuevos no se suman solos».
- **Con «Solo los que elijas»:**
  - buscador (campo de 16 px);
  - lista con casillas: nombre, unidad y precio neto en `$1.250.000`;
  - contador «3 de 42 elegidos»;
  - «Marcar los que se ven» y «Desmarcar todos»;
  - grupo aparte «Desactivados en el catálogo (no se pueden cotizar)»;
  - si el catálogo es largo, la lista va en una caja con desplazamiento.
- **Pie de la sección:**
  - «Las líneas escritas a mano no se limitan» (con el supuesto D2);
  - «Cambiado por Ana el dd-mm-aaaa»;
  - botón «Guardar», que muestra «Guardando…» y queda deshabilitado mientras guarda;
  - aviso breve al guardar (Sonner): «Listo: Carla solo puede cotizar 3 servicios.».
- **Errores**:
  - `CP409`: «Otra persona cambió esta lista mientras la editabas. Recarga para ver la última versión.»;
  - lista vacía: «Elige al menos un servicio. Si esta persona no debe cotizar, cambia su rol a Observador.».
- **Para un rol que no se limita**, en vez de los controles: «Su rol no tiene límite de servicios» (Dueño o Administrador) o «Su rol no
  cotiza» (Aprobador u Observador). Si quedó una lista guardada de antes: «Tiene una lista guardada que se aplicará si vuelve a ser
  Comercial».
- **Los cuatro estados:**
  - cargando: esqueleto en `loading.tsx`;
  - vacío: «Tu catálogo no tiene servicios activos», con enlace a Catálogo, y la opción «Solo los que elijas» deshabilitada;
  - error: «No pudimos cargar los servicios. Recarga la página en unos minutos.», como alerta;
  - sin conexión: el aviso `OfflineNotice` y «Guardar» deshabilitado.
- **Teléfono**: una columna, sin desplazamiento horizontal a 375 px. **Escritorio**: como panel de detalle.
- **Opcional, barato**: en la lista de miembros de H-010, una etiqueta «Cotiza: todos» o «Cotiza: 3 servicios».

### Editor de la cotización (Comercial limitado)

`page.tsx` llama a `my_catalog_scope()` y le pasa `catalogLimited` a `quote-editor.tsx`.

- Sobre el buscador, un aviso con ícono Info de Lucide: «Ves solo los servicios que tu organización te permite cotizar.»
- **Sin servicios permitidos y sin búsqueda**: «No tienes servicios del catálogo para cotizar. Pide a un Administrador que te asigne
  servicios. Puedes agregar una línea libre.» Hoy dice «Tu catálogo no tiene servicios activos», que aquí sería falso.
- **Búsqueda sin resultados**: «Ninguno de tus servicios coincide con ese nombre.»
- **Línea existente cuyo servicio ya no está permitido**: no se bloquea, pero se marca con un aviso junto a la línea, parecido al de
  los servicios desactivados (`queries.ts:188`): «Este servicio ya no está entre los que puedes cotizar. La línea se conserva.»
- **Si el guardado vuelve con `catalog_item_not_allowed`** (le cambiaron la lista con el editor abierto):
  - mensaje junto a la línea: «Ya no puedes cotizar este servicio: un Administrador cambió tu lista. Quita la línea para guardar.»;
  - el editor vuelve a pedir el catálogo;
  - la traducción del error va en `invalidMessage` de `src/lib/quotes/actions.ts`.

### Convertir una solicitud

El texto de «no se cargaron» pasa a decir: «ya no están activos en el catálogo o no están entre los servicios que puedes cotizar».

---

## 6. Dónde puede fallar y cómo se evita

| Riesgo | Cómo se evita |
|---|---|
| **Filtración entre organizaciones** | La organización sale siempre de `current_tenant_id()`, nunca de un parámetro. El miembro se busca dentro de la organización activa. Los servicios están amarrados por la relación compuesta. El predicado exige que el servicio sea de la organización activa. Las dos tablas y las tres funciones públicas van al registro de aislamiento |
| **Permisos saltados** | El límite vive en la base, en `save_quote_draft`, y no solo en la pantalla. Nadie escribe directo en las tablas. Hay que tener `team.manage` en la acción (`requirePermission`) y en la base (`app.can`). Un Comercial no puede cambiar su propia regla. No se usa la llave maestra |
| **Rehacer cotizaciones ya enviadas** | **Nunca.** No hay migración de datos, ni disparador en `quote_items`, y la función de la regla no toca `quotes`. Una enviada ya no se edita (`CP423`) y las líneas existentes no se revisan |
| **Doble clic** | Si lo pedido es igual a lo guardado, se responde «listo» sin cambiar nada, más la versión esperada y el botón deshabilitado mientras guarda |
| **Redondeo** | No aplica: no se calcula ningún monto |
| **Datos personales** | Ninguno nuevo. La auditoría lleva ids, nunca nombres. Los registros del servidor (`serverLog`) solo llevan códigos |
| **Que mostrar y guardar digan cosas distintas** | Usan el mismo predicado de la base. Solo el aviso del editor depende de `roleCanBeLimited` en la aplicación, y lo cubre la prueba de paridad |

---

## 7. Pruebas que deben existir

**Unitarias**
- Esquema zod de la regla.
- `roleCanBeLimited` para los 5 roles.
- La frase de resumen.
- Selección y búsqueda del selector.
- Qué texto vacío elige el editor.
- Traducción de cada código de error.
- La acción con un falso miembro de cada rol: los que no tienen permiso reciben «No tienes permiso para esto» **y la base ni se
  consulta**.

**De base de datos** (`tests/db/member-catalog-scope.test.ts`, con pases reales)
- Dueño y Administrador limitan a un Comercial: funciona. Aprobador, Comercial y Observador no pueden limitar: `42501`. Limitar a un
  Dueño, Administrador, Aprobador u Observador: `member_not_limitable`.
- Un Comercial limitado llama directo a `save_quote_draft` con un servicio fuera de la lista: `CP422`. Con uno permitido: guarda.
- **Línea existente** de un servicio que salió de la lista: se vuelve a guardar sin error.
- Quitar la línea y volver a agregarla (con id nuevo o con el id viejo): rechazada.
- Línea libre con el nombre de un servicio prohibido: aceptada con el supuesto D2.
- Servicio desactivado: no aparece ni se agrega. Reactivado: vuelve.
- Servicio nuevo: no lo ve quien tiene lista; sí lo ve quien tiene «todos».
- Comercial ascendido a Administrador: sin límite. Bajado de nuevo a Comercial: con límite (supuesto D4).
- Dos Administradores guardan a la vez: uno recibe `CP409`. El mismo contenido dos veces: «listo» y un solo registro de auditoría.
- Bordes: 501 servicios, lista vacía, un vacío dentro de la lista, un id de otra organización (`catalog_item_not_found`), un miembro
  quitado.
- Escritura directa en las dos tablas por la API: rechazada.
- Un Comercial no lee filas de estas tablas.
- Paridad de la constante de 500.
- **Prueba de «no se tocó nada»**: la huella de `quotes`, `quote_items` y `quote_packages` antes y después de cambiar una regla es
  idéntica.
- La prueba trampa de `save_quote_draft` (§3).
- El deshacer, en `test:db:rollbacks`: en el Camino A deja la función vacía, no la borra.

**De aislamiento** (`tests/isolation/registry.ts` y sus ataques)
- Registrar las dos tablas (las leen Dueño y Administrador) y `set_member_catalog_scope`, `quotable_catalog_items` y `my_catalog_scope`
  en `RPC_CASES`.
- Ana, en A, limita a un miembro de B: `CP404` y B intacta.
- Mixta, activa en A, apunta a un miembro de B: `CP404`.
- Ex, ya quitada: todo rechazado.
- `quotable_catalog_items` con ids del catálogo de B: vacío, sin el texto canario `CANARIO-B`.
- Ana agrega un servicio de B a la lista de un Comercial de A: rechazado.
- La ruta `/o/A/equipo/{id de un miembro de B}`: «No encontrado».

**De punta a punta** (`e2e/catalog-scope.spec.ts`)
- Ana deja a Carla con un solo servicio; Carla solo ve ese al cotizar. Ana vuelve a «todos» y Carla ve todo al recargar.
- El borrador viejo de Carla, con un servicio que salió de su lista, se guarda solo y se envía. Una cotización ya enviada conserva su
  PDF, con la misma huella.
- Forzar con `page.route` una línea prohibida: mensaje claro y nada guardado.
- Convertir una solicitud con un servicio no permitido: la línea se omite con aviso.
- La ficha de un Administrador y la de un Observador no muestran los controles.
- 375 px, áreas táctiles de 44 px y aviso de sin conexión.
- La nueva ruta va en `APP_ROUTES`, para que `e2e/roles.spec.ts` la recorra por rol.

---

## 8. Pasos de construcción y días (Camino A)

Las migraciones las hace **un solo agente**, declarando el entorno (PRUEBAS), con fecha posterior a la última en `main` al construir y
al mezclar.

**PR 1, la base (unos 1,75 días)**
1. **Migración** `member_catalog_scope` (1,25 días): las dos tablas, RLS, `set_member_catalog_scope`, `app.catalog_scope_limited`,
   `app.can_quote_catalog_item` (reemplaza la vacía de H-041), `quotable_catalog_items`, `my_catalog_scope`, la constante y el
   deshacer. Más las pruebas de base de datos y la prueba trampa.
2. **Aislamiento** (0,5 día).
3. Con este PR solo, nadie tiene regla y nada cambia de comportamiento.

**PR 2, lo que se ve (unos 2 días)**
4. **Aplicación** (0,5 día):
   - `src/lib/quotes/catalog-source.ts`, `src/lib/intake/convert-lines.ts` y `src/lib/quotes/actions.ts` (mensaje);
   - nuevos: `src/lib/team/catalog-scope-model.ts` (puro), `catalog-scope-queries.ts` y `catalog-scope-actions.ts`;
   - la etiqueta de auditoría en `src/lib/audit/labels.ts` y la semilla (Carla con «todos»).
5. **Pantallas** (1 día): `src/components/team/catalog-scope-form.tsx`, la sección en la ficha, el aviso y los vacíos en
   `src/app/o/[tenantId]/cotizaciones/[quoteId]/page.tsx` y `quote-editor.tsx`, y el aviso «estuvo antes en el equipo» en la pantalla
   de invitación de H-009/H-010 (0,25 día; consulta si la membresía quitada tenía una regla, solo a quien tiene `team.manage`).
6. **Punta a punta y revisión del `revisor`** (0,5 día).

**Total**: 1,75 + 2 = unos 3,75 días (la ficha mínima ya la trae H-010 en el PR #28, así que su costo no entra en la suma). Más 0,5 si va por el Camino B. Pasa de los dos días de `PROCESO.md`, por
eso los dos PR.

**Documentos a actualizar al construir:**
- `docs/arquitectura/modelo-datos.md`: la fila `member_catalog_permissions` pasa a las dos tablas nuevas.
- `docs/HISTORIAS.md`: notas en H-069 y H-070 (el candado de H-042 y el tamaño ya quedaron en este PR).
- El documento del sprint 5.

**Hallazgo de paso (ya resuelto)**: la fecha reservada para H-010 (`20261104100000`) quedó por detrás de la de H-048a en `main`
(`20261104110000`). El PR #28 ya lo resolvió: usa `20261105110000`.

---

## 9. ¿Delicada? Criterio punto por punto (decisión 020 §5)

| Criterio | H-042 |
|---|---|
| Permisos o roles | **Sí.** Es un permiso por persona, exigido en una función con permisos elevados |
| Aislamiento | **Sí, riesgo real.** Tablas nuevas y una función que recibe el id de un miembro y una lista de servicios, puertas típicas para apuntar a otra organización |
| Dinero | Indirecto: decide qué servicios con precio se pueden cotizar. No cambia ningún cálculo |
| Superficie pública | No |
| Envío | No: a propósito, no toca `prepare_quote_send` |
| `save_quote_draft` | Con el Camino A no la reescribe (solo la función del gancho). Con el B, sí |

**Conclusión: delicada.** Lleva diseño del `planificador`, revisión del `revisor` (Opus) y **no se mezcla sin Aarón**. Ya quedó marcada
con candado en `HISTORIAS.md`.

---

## 10. Decisiones (supuestos aplicados por José el 2026-11-05; D2, D3, D7, D10 y D13 fijadas por Aarón el mismo día)

| # | Bloquea | Qué decidir | Quién | Supuesto | Costo |
|---|---|---|---|---|---|
| D1 | Construir | Gancho en H-041 (A) o reescribir `save_quote_draft` en H-042 (B) | José | **A**; H-042 después de H-041 | A: unos 15 minutos más en H-041 y una función vacía a la espera. B: +0,5 día y una tercera reescritura de la función más delicada |
| D2 | No | ¿Las líneas escritas a mano se saltan el límite? | Aarón: decisión por defecto aplicada por Aarón el 2026-11-05 | Sí, igual que la pregunta 18 de H-041, con aviso en la ficha. **Se mantiene por ahora: H-042 ordena (lista más corta) y no controla (se puede escribir cualquier línea libre).** La versión que controla se decide junto con la pregunta 18 de H-041, para toda la organización y no por persona | Alternativa por persona (casilla `allow_free_lines`, +0,5 día) descartada: el control se decide para toda la organización. Si H-041 decide «solo desde el catálogo», H-042 lo hereda |
| D3 | No | ¿Los servicios nuevos se suman solos a las listas? | Aarón: decisión por defecto aplicada por Aarón el 2026-11-05 | No (la lista es cerrada; es lo más seguro) | Alternativa: al crear un servicio, elegir a qué Comerciales se suma, +0,5 a 1 día en las pantallas del catálogo. Futuro: limitar por categoría cuando existan |
| D4 | No | Al cambiar de rol o volver al equipo, ¿se conserva la lista? | José | Se conserva y aplica solo mientras sea Comercial; la ficha lo muestra | Alternativa: borrarla con un disparador en `members` (~0,25 día, sin reescribir funciones de H-010). Quien vuelve partiría con «todos», que es menos restrictivo |
| D5 | No | Un borrador con un servicio que salió de la lista, ¿se puede enviar? | José | Sí (criterio 3) | Bloquearlo obliga a tocar `prepare_quote_send`, chocando con H-041 y H-040: +1 día |
| D6 | No | ¿Se permite una lista vacía? | José | No; para que alguien no cotice, se cambia su rol a Observador | Ninguno |
| D7 | Pantalla | ¿Quién crea la ficha `/equipo/[memberId]`? | Aarón: decisión por defecto aplicada por Aarón el 2026-11-05 | **Resuelta:** H-010 ya construye la ficha mínima (PR #28, `/equipo/[memberId]/page.tsx`) | Ninguno: la ficha de H-010 no se cuenta en el total, porque los 0,5 día nunca estuvieron en la base de la suma |
| D8 | Mezclar | Marcar H-042 como delicada y esperar a Aarón | José | Sí | Espera a Aarón |
| D9 | No | ¿Dos PR (base y pantallas)? | José | Sí | Ninguno |
| D10 | No (lo hereda H-069/H-070) | Una versión nueva o un duplicado con servicios no permitidos | Aarón: decisión por defecto aplicada por Aarón el 2026-11-05 | La versión nueva conserva las líneas **solo si es la misma cotización y el mismo autor**; el duplicado omite con aviso los servicios no permitidos (si no, duplicar la cotización de un colega saltaría el límite) | Anotarlo ahora no cuesta nada |
| D11 | No | Tope de servicios por lista | José | 500 | Ninguno |
| D12 | No | ¿Avisar al Comercial cuando cambia su lista? | José | No | Un correo o aviso: +0,5 día, mejor con H-047 |
| D13 | Construir | ¿Una tabla o dos para la regla? | Aarón: decisión por defecto aplicada por Aarón el 2026-11-05 | **Dos tablas** (`member_catalog_scopes` y `member_catalog_scope_items`). El «Cambiado por» no puede salir de la auditoría (`audit.read` es solo del Dueño) y la columna `revision` protege del doble clic | Una tabla: se ahorra una tabla y un disparador, pero se pierde `mode`, `revision` y el «Cambiado por» sin consultar la auditoría |

**Nota sobre D7:** el diseño de H-010 del sprint 5 no definía una ficha por miembro, pero el PR #28 la construyó (mínima), tal como se
recomendaba. H-042 solo agrega su sección.

---

## 11. Qué NO hacer

- No meter la regla en `app.quote_line_rules_check` ni en `prepare_quote_send`: bloquearía borradores antiguos y chocaría con H-041 y
  H-040.
- No filtrar con la RLS de `catalog_items`: rompe «ver todo», y las funciones con permisos elevados no la usan.
- No validar solo en la pantalla ni solo en `catalog-source.ts`.
- No agregar acciones a la matriz ni redefinir `app.role_can`.
- No escribir nombres de rol en el código nuevo ni en las funciones de la base.
- No modificar, «limpiar» ni migrar líneas o cotizaciones existentes.
- No guardar la regla en `members` (H-010 la reescribe) ni en el pase de sesión.
- No dar escritura directa a las tablas ni usar la llave maestra.
- No borrar `app.can_quote_catalog_item` en el deshacer (Camino A).
- No construir H-042 en paralelo con H-041 ni con H-048b si toca `save_quote_draft` (Camino B). No editar migraciones ya aplicadas.
- No mandar listas de ids por la dirección (GET).
- No poner nombres de personas ni de servicios en la auditoría ni en los registros del servidor.
- No sumar servicios nuevos a las listas sin la decisión D3.

---

## 12. Lo que no se pudo verificar

- **H-041 no está construida.** No se sabe si aceptará el gancho, qué convención de número de línea usará (`@n`) ni el formato de error
  por línea que espera el editor. El Camino A depende de eso.
- **H-010 está construida pero no mezclada** (PR #28 abierto): si cambia antes de mezclarse (dirección de la ficha, forma de
  `list_members`, o si `change_member_role` o `remove_member` tocan datos de otras tablas), hay que revisar este diseño. Aquí se leyó
  la rama, no `main`.
- **`app.quote_line_rules_check` no existe en el código** (solo en el diseño del sprint 5 §5c), así que el Camino A también depende de
  cómo se construya H-041.
- **`tests/db/save-quote-draft-contract.test.ts` todavía no existe**: lo crea quien llegue primero.
- **El tamaño real de los catálogos**: no hay tope en `catalog_items`. Se supuso unos cientos. Con miles, el selector necesitaría
  paginación y virtualización.
- **Cómo crearán líneas H-069 y H-070**: solo se dejó la nota.
- **El estado de la semilla y de la fixture después de H-011b**: si ya habrá un segundo Comercial.
- **El rendimiento de `quotable_catalog_items`**: no se midió. Debería usar los índices existentes (`catalog_items_tenant_active_name`
  y el de nombre parcial), pero hay que confirmarlo con el plan de la consulta (`explain`).
- **El estado de la rama**: la «última fecha en `main`» se supuso `20261104110000`; hay una corrección de H-009 (I1) pendiente de
  mezclar con la fecha `20261105100000`.
