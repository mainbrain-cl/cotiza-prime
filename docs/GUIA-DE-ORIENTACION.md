# Guía de orientación — cómo está armado Cotiza Prime

> Para quien se suma al proyecto (hoy, José) y necesita entender **qué hay, dónde está y por qué está
> así**, sin leer 15.000 líneas. No reemplaza a los documentos que mandan (`PROYECTO.md`, `00-base/`,
> `DISENO.md`): los resume, los conecta y dice cuál leer para cada duda.
>
> Escrita el 2026-10-28. Si algo del código ya no coincide con lo que dice aquí, manda el código; avisa
> y se corrige la guía.

---

## 1. En cinco líneas

1. Cotiza Prime es una plataforma web (SaaS) donde cada empresa cotiza con su marca y sigue la cotización
   hasta que se paga. **No factura, no procesa pagos, no es CRM** (`PROYECTO.md` §3).
2. Es de **varias empresas a la vez** (cada una es una *organización*, en el código `tenant`). Que una
   empresa **nunca** vea datos de otra es el riesgo número uno del producto.
3. Se construye con **Next.js 16 + React + TypeScript** y **Supabase** (base de datos PostgreSQL, ingreso
   de usuarios y archivos). Todo en un solo proyecto, sin backend aparte.
4. Se trabaja por **historias de usuario (H-001 a H-115)** agrupadas en **12 sprints**. Hay 35 de 92
   construidas.
5. Las reglas de seguridad y de ley (Chile, Ley 21.719) no se relajan sin una decisión escrita en
   `docs/decisiones/`.

---

## 2. Qué leer, en qué orden y para qué

Tiempos aproximados. Los marcados ★ son los que realmente hace falta leer entero.

| # | Documento | Tiempo | Para qué sirve |
|---|---|---|---|
| 1 | ★ `CLAUDE.md` | 10 min | Reglas del proyecto y el estado más reciente. Es lo primero que lee Claude cada vez que abre una sesión |
| 2 | ★ `docs/TRASPASO.md` | 20 min | La guía que dejó Aarón: cómo levantarlo, trampas que ya mordieron, qué decide Aarón, cómo trabaja |
| 3 | ★ `docs/PROYECTO.md` (la «ficha de una página» y §1–§7) | 40 min | Qué es el producto, para quién, perfiles y permisos, el recorrido de una cotización (§6.0) y sus estados (§7). El resto (§8–§14) se consulta cuando una historia lo cite |
| 4 | `docs/00-base/` (4 archivos) | 45 min | Las reglas de la agencia: stack (`STACK.md`), seguridad, legal y proceso. `PROYECTO.md` puede ser *más exigente*, nunca menos |
| 5 | `docs/HISTORIAS.md` | consulta | Las 92 historias con sus criterios de aceptación. Se lee la que se va a construir, no todo |
| 6 | `docs/sprints/001-base-segura.md` | 10 min | La tabla de los 12 sprints y por qué van en ese orden |
| 7 | `docs/arquitectura/modelo-datos.md` | 40 min | **El documento técnico más importante**: cómo se separan las organizaciones, las tablas, el cifrado, la numeración. Léelo antes de tocar la base de datos |
| 8 | `docs/DISENO.md` | 15 min | Colores, tipografía, vidrio, movimiento y las librerías aprobadas |
| 9 | `docs/decisiones/` (19 fichas) | consulta | Cada decisión con su porqué. Las 013 (cómo se trabaja), 015 (vulnerabilidades en herramientas), 017 (enlace del cliente), 018 (React Bits) y 019 (anti-robot) son las que más se citan |
| 10 | `docs/arquitectura/` (otros) | consulta | Un plan por sprint complejo: `cotizaciones-y-calculo.md`, `sprint-3-envio-y-enlace.md`, `sprint-4-formulario-publico.md`, `h-012-aislamiento.md` |

**Dos ideas para no perderse:** `CLAUDE.md` y `TRASPASO.md` dicen *dónde estamos*; `PROYECTO.md` dice
*qué se construye*; `modelo-datos.md` dice *cómo está construido por dentro*.

---

## 3. Cómo está armado, de arriba a abajo

```
  Navegador de quien usa Cotiza Prime            Navegador del cliente final / desconocido
  (miembros de una organización)                 (sin cuenta)
            │                                              │
            ▼                                              ▼
   /o/{tenantId}/...  (páginas)                  /c/{token}   /f/{publicId}   /api/v1/public/...
            │                                              │
   src/proxy.ts  renueva la sesión                src/lib/share/gateway.ts   «portero»
            │                                     src/lib/intake/gateway.ts  del servidor
   src/lib/auth/session.ts  ¿quién eres?                   │
   src/lib/tenant/active-tenant.ts ¿de qué empresa?        │ llave maestra, solo para esto
            │                                              │
            ▼                                              ▼
   Supabase con la sesión del usuario              Supabase con llave maestra (service_role)
   → la BASE aplica RLS (filtro por empresa)       → solo a través de funciones (RPC) acotadas
```

### 3.1 Las dos puertas

- **Puerta de los miembros** (`/o/{tenantId}/…`). La organización viaja **en la dirección**, no en una
  cookie ni en el pase de sesión, porque una persona puede estar en varias empresas. En cada petición se
  comprueba que sea miembro activo. Si no lo es, ve «No encontrado» (404), nunca «Prohibido»: no se
  revela que la empresa existe.
- **Puerta pública** (`/c/{token}` para el cliente que responde, `/f/{publicId}` para el formulario
  público y `/api/v1/public/...`). Aquí no hay sesión. Todo pasa por un **portero** en el servidor
  (decisión 017) que usa la llave maestra de la base, pero **solo** para llamar funciones acotadas, con
  límite de intentos y sin devolver nunca datos de otra organización.

### 3.2 Los «puntos únicos» (regla de `CLAUDE.md`)

Cada una de estas decisiones vive en **un solo archivo**, para poder cambiarla algún día sin buscarla en
todo el código. Si te encuentras copiándola en otro lado, es un error.

| Qué | Dónde | Por qué un solo lugar |
|---|---|---|
| Validar el pase de sesión | `src/lib/auth/session.ts` | El día que la identidad venga de un hub de Main Brain, se cambia solo este archivo |
| Resolver la organización activa (`tenant_id`) | `src/lib/tenant/active-tenant.ts` | Es el control que impide ver datos de otra empresa |
| La llave maestra de la base | `src/lib/supabase/admin-client.ts` | Se salta toda la seguridad por fila; una regla del linter limita qué archivos pueden importarla |
| Cifrado de datos personales | `src/lib/crypto/pii.ts` (+ `search-hash.ts` para buscar sin descifrar) | La clave nunca está en la base |
| Cabeceras de seguridad (CSP) | `src/lib/security/csp.ts` | Las usan `next.config.ts` y `src/proxy.ts` |

### 3.3 Qué defiende cada capa (por qué hay tanta repetición)

La misma regla se comprueba en **tres lugares a propósito**: en la pantalla (para no mostrar botones que
no sirven), en el servidor (porque ocultar un botón no es seguridad) y en la base de datos con **RLS**
(*row level security*, seguridad por fila: el filtro lo impone PostgreSQL, así que funciona aunque el
código tenga un error). Si cambias un permiso, cambia los tres.

---

## 4. Mapa de carpetas

```
cotiza-prime/
├─ CLAUDE.md                  Reglas + estado (lo lee Claude al abrir sesión)
├─ README.md                  Cómo levantar el entorno y los comandos
├─ docs/                      Todo lo que se piensa y se decide (ver §2)
│   ├─ 00-base/               Reglas de la agencia (stack, seguridad, legal, proceso)
│   ├─ decisiones/            Una ficha por decisión (001 … 019)
│   ├─ sprints/               Un documento por sprint
│   ├─ arquitectura/          Diseños técnicos por tema o sprint
│   └─ diseno/                Vistas previas HTML de las plantillas del PDF
├─ src/
│   ├─ proxy.ts               Renueva la sesión en cada petición
│   ├─ app/                   Páginas y rutas (App Router de Next.js)
│   │   ├─ (auth)/            Ingresar, registro, recuperar contraseña, aceptar términos
│   │   ├─ o/[tenantId]/      Todo lo de una organización: catálogo, clientes, cotizaciones,
│   │   │                     formularios, solicitudes, configuración
│   │   ├─ c/[token]/         Lo que ve el cliente final de una cotización
│   │   ├─ f/[publicId]/      Formulario público (y /incrustar para pegarlo en otra web)
│   │   └─ api/v1/...         API versionada (pública, de organización y webhook de correo)
│   ├─ lib/                   La lógica, un directorio por tema (ver §5)
│   ├─ components/            Piezas de pantalla: ui/ (base), app-shell/ (menú), intake/, share/, react-bits/
│   ├─ content/legal/         Textos de términos y privacidad
│   └─ test/                  Ayudas para las pruebas (mocks, lector de PDF)
├─ supabase/
│   ├─ migrations/            Los cambios de la base, en orden (35 hoy)
│   ├─ rollbacks/             El «deshacer» de cada migración
│   └─ templates/             Plantillas de los correos de Supabase
├─ tests/                     Pruebas de base de datos (db/) y de aislamiento (isolation/)
├─ e2e/                       Pruebas de punta a punta con navegador (Playwright)
├─ scripts/                   seed.ts (datos ficticios), check-lockfile, check-rollbacks
├─ base-tecnica/              La base de la agencia tal como se copia a un proyecto nuevo (los 4 documentos son idénticos a docs/00-base; el README y los comandos son de la plantilla)
├─ .claude/                   Agentes `planificador` y `revisor`, y comandos /plan /sprint /auditar /entorno /historias
└─ .github/workflows/ci.yml   Verificación automática (hoy no corre: ver §8)
```

---

## 5. Qué hay dentro de `src/lib/`

| Directorio | Qué hace |
|---|---|
| `auth/`, `tenant/` | Sesión y organización activa (los dos puntos críticos) + acciones de ingreso, registro y crear organización |
| `supabase/` | Los clientes de la base: servidor, navegador, cookies endurecidas y la llave maestra |
| `quotes/` | El corazón: cotizar, calcular, versionar, enviar. El cálculo es en enteros (CLP sin decimales) y en el servidor |
| `money/`, `chile/`, `rut/`, `normalize/` | Dinero, formatos chilenos (`$1.250.000`, `dd-mm-aaaa`), validación de RUT |
| `numbering/` | Número correlativo por organización (`COT-2026-0043`), asignado por la base |
| `pdf/` | Generación del PDF en el servidor con `@react-pdf/renderer` (plantilla 1 hoy) |
| `email/` | Capa de correo: formato básico seguro, adaptadores por proveedor, rebotes. En local sale a Mailpit |
| `share/` | Enlace del cliente: token, portero, aceptar o rechazar (con motivo obligatorio), aperturas |
| `intake/` | Formulario público: constructor, solicitudes, QR, incrustado, límites y topes diarios |
| `antibot/` | Verificación anti-robot del formulario público |
| `brand/` | Logo y colores de cada organización (lo que ve el cliente final) |
| `customers/`, `catalog/` | Clientes (con datos cifrados) y catálogo de servicios |
| `crypto/`, `security/` | Cifrado, huellas buscables, límite de intentos de ingreso, CSP |
| `audit/` | Registro de auditoría (quién hizo qué) y su pantalla «Actividad» |
| `legal/` | Aceptación de términos y consentimiento |
| `log/`, `env/`, `http/` | Registros sin datos personales, lectura validada de variables de entorno, ayudas HTTP |

Cada archivo `.ts` suele tener al lado su `.test.ts`: la prueba unitaria vive junto al código.

---

## 6. La base de datos

**35 migraciones**, cada una con su «deshacer» en `supabase/rollbacks/`. Regla: **toda tabla lleva
`tenant_id`** (UUID, ese nombre exacto, columna propia).

| Grupo | Tablas | Sprint |
|---|---|---|
| Cuentas y organizaciones | `tenants`, `profiles`, `members` | 1 |
| Negocio base | `catalog_items`, `customers`, `numbering_settings`, `numbering_sequences` | 1–2 |
| Seguridad y ley | `audit_log`, `auth_rate_limits`, `legal_documents`, `legal_acceptances` | 1 |
| Cotizar | `quotes`, `quote_items`, `quote_packages`, `quote_events` | 2–3 |
| Enviar y responder | `email_messages`, `share_links`, `share_link_views`, `quote_responses` | 3 |
| Formulario público | `intake_forms`, `intake_form_items`, `intake_requests`, `intake_daily_counters` | 4 |

Cosas que conviene saber:

- **Los precios se copian, no se enlazan** (si el catálogo cambia, una cotización ya hecha no cambia).
- **Los datos personales van cifrados** (correo, teléfono, RUT, dirección). Para buscar sin descifrar se
  guarda además una *huella* (HMAC): por eso el RUT y el correo se buscan **completos** y el nombre por
  partes.
- **La línea de tiempo y la auditoría solo se agregan**, nunca se editan ni se borran.
- **Nada enviado se borra**: se archiva (decisión 010).
- **Datos de prueba:** `npm run db:seed` crea 5 personas y 2 organizaciones ficticias. Nunca datos reales.
- Antes de tocar la base, declara el entorno (`/entorno`): `🟢 PRUEBAS` o `🔴 PRODUCCIÓN`. Hoy solo existe
  el local, en Docker.

---

## 7. El recorrido de una cotización, y dónde vive cada paso

Resumen de `PROYECTO.md` §6.0, con los lugares del código:

| Paso | Qué pasa | Dónde |
|---|---|---|
| 1 | Un desconocido llena el formulario público y ve, en vivo, lo que pide (**sin precios**) | `app/f/[publicId]`, `lib/intake/` |
| 2 | La solicitud llega al equipo y se convierte en cotización | `app/o/…/solicitudes`, `lib/intake/` |
| 3 | El comercial arma la cotización: ítems, descuentos, IVA, vigencia | `app/o/…/cotizaciones`, `lib/quotes/` |
| 4 | Ve la vista previa del correo y del PDF | `lib/pdf/`, `lib/email/` |
| 5 | **(Sprint 6, aún no)** Si la regla lo exige, un aprobador revisa el paquete congelado | — |
| 6 | Se envía desde la plataforma, en un clic | `app/o/…/cotizaciones/[id]/enviar`, `lib/quotes/send/` |
| 7 | El cliente la abre sin cuenta, la acepta o la rechaza con motivo | `app/c/[token]`, `lib/share/` |
| 8 | **(Sprints 6–7, aún no)** Datos de transferencia, cobro y marcar pagado | — |

Hoy el recorrido funciona hasta el paso 7. Lo que sigue (aprobación y cobro) depende de los roles del
sprint 5.

---

## 8. Cómo se prueba (cinco redes de seguridad)

| Prueba | Comando | Qué asegura | Necesita Docker |
|---|---|---|---|
| Tipos y estilo | `npm run typecheck`, `npm run lint`, `npm run format:check` | Que compile y esté ordenado | No |
| Unitarias | `npm test` | La lógica sola: dinero, formatos, validaciones | No |
| De base de datos | `npm run test:db` | Tablas, RLS, funciones (RPC) y restricciones | Sí |
| **De aislamiento** | `npm run test:isolation` | Que una empresa **no pueda leer ni tocar** datos de otra (más de mil comprobaciones y ataques automáticos) | Sí |
| De punta a punta | `npx playwright test` | Recorridos reales en el navegador. Con `E2E_PROD=1` prueba la app ya compilada, más estable | Sí |
| Deshacer migraciones | `npm run test:db:rollbacks` | Que cada migración se pueda revertir (**vacía** la base local) | Sí |

**Regla del proyecto:** antes de integrar se corre **todo**. El CI de GitHub (`.github/workflows/ci.yml`)
hoy no corre porque la facturación de la cuenta de Aarón falló; hasta que se arregle, las pruebas locales
son la única red.

Trampas que ya conocemos: Playwright no corre con el servidor de desarrollo abierto en la misma carpeta;
`db reset` y `test:db:rollbacks` vacían la base (volver a correr `npm run db:seed`); con poca memoria las
pruebas de punta a punta fallan por tiempo, no por errores (ver `TRASPASO.md` §8).

---

## 9. Cómo se trabaja (proceso)

- **Compuertas** (`docs/00-base/PROCESO.md`): plan aprobado → historias aprobadas → **sprint confirmado**
  → recién ahí se programa. Nadie las cruza sin aprobación escrita.
- **Forma de desarrollo (decisión 013):** la sesión principal coordina; subagentes con **Sonnet**
  construyen; el subagente `planificador` (**Opus**) diseña antes las historias delicadas 🔒 (separación
  entre empresas, permisos, dinero, superficie pública); el `revisor` (Opus) las revisa después.
- **Ramas y revisión:** cada cambio en su rama, se sube a GitHub y se revisa por **Pull Request** hacia
  `main`. `main` queda siempre verificada.
- **Una historia = un ciclo:** diseñar (si es 🔒) → construir con pruebas → revisar → correr todo →
  integrar → mostrar.
- **Si algo no estaba previsto**, no se agrega en silencio: se vuelve historia (`PROCESO.md`).

---

## 10. Glosario mínimo

| Palabra | Significa |
|---|---|
| **Organización / tenant** | La empresa dentro de Cotiza Prime; la «caja» que separa todo de todo |
| **RLS** | Seguridad por fila: reglas dentro de la base de datos que filtran por empresa |
| **RPC** | Una función guardada en la base que la aplicación llama (más acotada que leer tablas) |
| **Migración** | Un archivo que cambia la estructura de la base, versionado y reversible |
| **Server action / route handler** | Código que corre en el servidor cuando se envía un formulario o se llama a `/api/v1/...` |
| **Portero (gateway)** | Código del servidor que atiende lo público y es el único que usa la llave maestra |
| **service_role** | La llave maestra de la base: se salta la seguridad por fila. Uso mínimo y vigilado |
| **Huella** | Dato derivado que permite buscar un valor cifrado sin descifrarlo |
| **Paquete de envío** | La copia congelada de lo que recibe el cliente: correo, PDF y condición de pago |
| **Seed** | Los datos ficticios de la base local |
| **e2e** | Prueba de punta a punta con un navegador real |
| **Compuerta** | Punto del proceso donde no se avanza sin aprobación de una persona |

---

## 11. Qué puedes pedirme

Para entender algo concreto, dime el tema y te lo explico con el código real a la vista, por ejemplo:
«cómo se asegura que Juan no vea lo de otra empresa», «qué pasa desde que el cliente hace clic en
Aceptar», «cómo funciona el cálculo del IVA» o «para qué sirve cada migración».
