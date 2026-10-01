---
document_id: BASE-STACK
title: Base de Stack — cualquier proyecto
version: 1.0
status: ACTIVE
aplica_a: todo proyecto de la agencia
last_updated: 2026-08-13
language: es-CL
---

# Base de Stack

**Qué es este documento.** Con qué se construye, cómo se organiza y cómo se despliega cualquier proyecto de la agencia. Es la parte que **no cambia** entre proyectos: el diseño y las reglas de negocio sí cambian, esto no.

**Por qué existe.** Para que empezar un proyecto nuevo no signifique volver a decidir todo desde cero. Un stack estándar significa que cualquiera del equipo puede entrar a cualquier proyecto y reconocer el terreno.

---

## 1. El stack

| Capa | Estándar | Por qué |
|---|---|---|
| **Lenguaje** | TypeScript, front y back | Un solo lenguaje en todo el stack; los contratos se comparten como tipos |
| **Frontend** | React con **Next.js** | Sirve para sitios con SEO, comercio y paneles con el mismo estándar |
| **Backend** | **Next.js** — route handlers y server actions | Todo en un mismo proyecto; no hace falta backend aparte |
| **Base de datos** | **Supabase** (PostgreSQL) | Postgres por debajo, más autenticación, RLS y APIs listas |
| **Autenticación** | **Supabase Auth**, emite JWT | Hoy por proyecto, mañana centralizado, sin reescribir |
| **Aislamiento de datos** | **RLS** — seguridad a nivel de fila | El filtro lo impone la base, no solo el código |
| **Acceso a datos** | Cliente de Supabase o SQL, con migraciones | Versionadas y reproducibles |
| **Contratos de API** | OpenAPI más tipos TypeScript compartidos | Documentada y tipada |
| **Pruebas** | Vitest, más Playwright para extremo a extremo | Unitarias rápidas, más flujos completos |
| **Carga y estrés** | k6 | Scripts versionados junto al código |
| **Observabilidad** | Logs estructurados, más Sentry | Mismo formato en todos los proyectos |
| **Repositorio** | **GitHub**, organización de la agencia | Un repositorio por proyecto |
| **Despliegue** | **Vercel** | Un proyecto de Vercel por aplicación desplegable |
| **Verificación** | GitHub Actions | Las pruebas corren antes de integrar |

**Salirse del stack requiere decisión registrada.** No está prohibido —hay problemas que este stack no resuelve— pero sí está prohibido hacerlo en silencio. La decisión declara qué se usa, por qué el estándar no servía, y quién mantiene esa pieza.

---

## 2. Forma del repositorio

**Un repositorio por proyecto.** Dentro:

```
docs/          documentación y decisiones del proyecto
packages/      código compartido, si el proyecto tiene varias apps
apps/          la aplicación, o varias si corresponde
```

**Si el proyecto tiene una sola aplicación**, `apps/` puede omitirse y el código va en la raíz.

**Si tiene varias**, cada una se configura en Vercel como proyecto aparte indicando su carpeta raíz. Conservan despliegue, dirección y variables independientes.

**Cuándo separar en repositorios distintos.** Solo si una parte tiene ciclo comercial propio, se entrega a un tercero, o la mantiene un equipo distinto de forma permanente. Sacar algo de un repositorio es sencillo; unir repositorios separados después no lo es. Por eso se empieza junto.

---

## 3. Entornos

**Dos entornos, siempre, desde el primer día:**

| Entorno | Para qué | Datos |
|---|---|---|
| **Pruebas** | Construir, romper, experimentar | Ficticios, generados |
| **Producción** | Uso real | Reales, protegidos por ley |

**Configuración.** Dos proyectos de Supabase. En Vercel, las variables de producción apuntan al primero y las de vista previa y desarrollo al segundo. Se configura una vez.

**Los dos tipos de cambio, que es lo que más se confunde:**

- **Cambio de código** (pantallas, lógica): se publica solo y aplica a ambos entornos.
- **Cambio de estructura** (tablas, columnas): se aplica en cada base por separado, primero pruebas y después producción, mediante migración.

**Regla de la alerta de entorno — obligatoria para agentes de IA.** Antes de cualquier acción sobre una base de datos:

1. **Declarar el entorno** de forma visible: `🟢 PRUEBAS` o `🔴 PRODUCCIÓN`.
2. **Si es producción, detenerse** y advertir qué va a cambiar, qué podría salir mal y si ya se probó en pruebas. Pedir confirmación explícita.
3. **Si no se puede determinar el entorno, no actuar.** Preguntar. Ante la duda, se asume producción.
4. **Nunca copiar datos reales a pruebas.**
5. **Nunca ejecutar una operación destructiva sin confirmación**, ni siquiera en pruebas.

**Señal visible.** Toda aplicación muestra una franja superior con el texto `PRUEBAS` cuando corre contra ese entorno. En producción no aparece.

---

## 4. Datos

- **Un esquema por aplicación.** Ninguna aplicación lee ni escribe el esquema de otra.
- **Migraciones versionadas**, en el repositorio, reversibles.
- **Nunca cambios manuales en producción.** Todo pasa por migración.
- **Índices desde el diseño**, no cuando ya está lento.
- **Respaldos automáticos con restauración probada.** Un respaldo que nunca se restauró no es un respaldo, es una suposición.
- **`tenant_id` en toda tabla, siempre.** Con ese nombre exacto, como columna propia, y con **identificador universal (UUID), nunca correlativo**. Aunque el proyecto tenga un solo cliente. Ver §5b.
- **Si el sistema es multi-cliente:** RLS activo sobre ese identificador. Lo emite un único punto, nunca cada aplicación por su cuenta.

---

## 5. Comunicación entre aplicaciones

Cuando el proyecto tiene más de una aplicación desplegable, todas cumplen el mismo contrato:

| Punto de entrada | Qué responde |
|---|---|
| `GET /health` | Si está viva: estado, versión, tiempo en marcha |
| `GET /meta` | Cómo se describe a sí misma: qué expone, qué eventos emite |
| `GET /api/v1/...` | Su funcionalidad real, siempre versionada |

**Dos formas de hablarse, y ninguna más:**

- **API** cuando se necesita un dato ahora y se espera respuesta.
- **Eventos** cuando se avisa que algo pasó, sin esperar respuesta.

**Nunca** una aplicación toca la base de datos de otra.

**Degradación elegante.** Si una dependencia no responde, se oculta esa función y se sigue trabajando. Nunca se cae todo por una pieza.

---

## 5b. Dejar el proyecto listo para acoplarse después

Un proyecto puede nacer suelto y años después convertirse en módulo de una plataforma mayor. **Eso es fácil o carísimo según tres decisiones que se toman el primer día.**

La regla que las separa: **lo que toca la forma de los datos se decide al inicio; lo que solo agrega código puede esperar.**

### Desde el día uno, sin discusión

**1. `tenant_id` en toda tabla, aunque haya un solo cliente.**

Es el único punto que de verdad importa. Agregarlo después obliga a **migrar datos que ya existen**, y esa es la parte cara. Mientras el proyecto sea de un solo cliente, la columna lleva siempre el mismo valor y no molesta a nadie.

Tres condiciones, y las tres importan:

| Condición | Por qué |
|---|---|
| **Se llama `tenant_id`**, con ese nombre exacto, en todas las tablas | Si en una tabla se llama `cliente_id`, en otra `empresa` y en otra está metido dentro de un texto, la migración deja de ser mecánica y pasa a ser arqueología |
| **Es un identificador universal** (UUID), nunca un correlativo | Con números 1, 2, 3 la colisión con otro sistema está **garantizada**. Con UUID es prácticamente imposible |
| **Es una columna propia**, no parte de otro campo | Permite indexarla, filtrarla y actualizarla de una vez |

> **El correlativo es el error caro.** Si tu app tiene al cliente `1` y el hub también tiene un cliente `1` que es otra empresa, al unirlos los datos se mezclan. Con UUID eso no ocurre.

**2. Las direcciones de la API con versión desde el principio: `/api/v1/`.**

No porque haga falta hoy, sino porque si se empieza sin versión y se agrega después, hay que cambiar todas las direcciones que ya estaban en uso. Escribir `v1` desde el inicio son cuatro caracteres.

**3. La validación del pase de sesión en un solo archivo.**

Nunca repartida por el código. El día que la identidad deje de venir del propio proyecto y pase a venir de un hub, se cambia ese archivo y nada más.

**4. La resolución del cliente en un solo punto.**

De dónde sale el `tenant_id` —de la sesión, de una variable fija, de un subdominio— se decide en un lugar. Igual que el punto anterior: un cambio, un archivo.


### Qué pasa cuando llega el momento de acoplarse

El escenario real no es que dos identificadores choquen, sino que **el mismo cliente tenga dos identificadores distintos**: uno en tu app y otro en el hub. Es lo normal cuando dos sistemas nacieron separados.

**El procedimiento:**

1. **El `tenant_id` del hub gana siempre.** La app que se acopla adopta el del hub, no al revés. El hub es la única fuente de identidad.
2. **Se arma una tabla de equivalencia:** el cliente X de mi app es el cliente Y del hub.
3. **Se revisa a mano.** Los nombres pueden estar escritos distinto —"Vicky Escents" y "Vicky Escents SpA"— y eso ningún programa lo resuelve solo.
4. **Se actualiza todo en una sola migración**, probada primero en el entorno de pruebas.
5. **La tabla de equivalencia se conserva**, no se borra. Es el rastro de qué se unió con qué.

**Si el `tenant_id` está bien puesto** —mismo nombre, columna propia, UUID— este procedimiento es un recorrido mecánico de un día. **Si no lo está**, es rehacer la base de datos con datos reales adentro.

### Cuando de verdad se conecte

Esto cuesta lo mismo hoy que en un año, así que **no hay que adelantarlo**:

- Los puntos de entrada `GET /health` y `GET /meta`
- Cambiar el origen de la identidad al hub
- Emitir y escuchar eventos
- El aprovisionamiento automático al activar

### Por qué esta distinción importa

Las primeras cuatro decisiones son **gratis al inicio y caras después**: tocan la estructura de los datos y el lugar donde vive la lógica. Las segundas son **código nuevo que se suma sin tocar lo existente**.

Adelantar lo segundo es complejidad sin ganancia. Postergar lo primero es rehacer la base de datos con datos reales adentro.

---

## 6. Rendimiento

Objetivos mínimos, medidos en producción:

| Métrica | Objetivo |
|---|---|
| Carga inicial percibida | Menos de 3 segundos |
| Respuesta de API | Menos de 500 ms en el percentil 95 |
| Consultas a base de datos | Con índice, sin recorridos completos de tabla |
| Imágenes | Optimizadas, en formato moderno, con carga diferida |
| Puntaje de rendimiento móvil | Sobre 80 |

**El rendimiento se diseña, no se arregla.** Una consulta sin índice o una imagen sin optimizar cuestan mucho más de corregir después.

---

## 6b. Caché

Qué se guarda en memoria para no volver a pedirlo, y por cuánto tiempo.

| Capa | Qué guarda | Cuánto |
|---|---|---|
| **Navegador** | Archivos estáticos: imágenes, fuentes, código | Largo, con nombre versionado |
| **Red de distribución** | Páginas que no cambian por usuario | Minutos a horas |
| **Servidor** | Consultas costosas y repetidas | Segundos a minutos |
| **Cliente de datos** | Respuestas ya pedidas en la sesión | Mientras dure la vista |

**Reglas:**

- **Nunca se guarda en caché contenido que depende del usuario** sin marcarlo como privado. Es la forma más rápida de mostrarle a alguien los datos de otro.
- **Todo lo cacheado tiene forma de invalidarse.** Si un dato cambia y la caché no se entera, el sistema miente.
- **Los archivos estáticos llevan versión en el nombre**, para poder guardarlos mucho tiempo sin riesgo.
- **No se cachea nada con datos personales** fuera del navegador del propio usuario.
- **Primero se mide, después se cachea.** Cachear lo que no era el problema agrega complejidad sin ganancia.

---

## 7. Observabilidad

- **Logs estructurados** en formato uniforme, con identificador de correlación por petición.
- **Sin datos personales en los logs** sin enmascarar.
- **Errores capturados** y agrupados en Sentry o equivalente.
- **Alertas** cuando algo se degrada, no cuando ya se cayó.
- **Registro de auditoría** de acciones sensibles: quién, qué, cuándo, sobre qué recurso, con qué resultado.

---

## 8. Integración y despliegue

- **Toda integración pasa por verificación automática:** tipos, linter, pruebas.
- **No se integra con pruebas en rojo.**
- **No se integra con vulnerabilidades de severidad alta o crítica abiertas.**
- **Vista previa por rama**, para revisar antes de publicar.
- **Despliegue reversible**: volver a la versión anterior debe ser inmediato.

---

## 9. Convenciones

- **Idioma del código:** inglés para nombres de variables, funciones y tablas. Español para la documentación y los textos de interfaz.
- **Formato automático.** El linter y el formateador deciden, nadie discute estilo.
- **Nombres descriptivos** por sobre comentarios que expliquen nombres malos.
- **Sin valores mágicos.** Todo valor fijo se declara con nombre.
- **Sin secretos en el código.** Nunca, bajo ninguna circunstancia.
