# 023 · MVP, infraestructura y forma de trabajo

- **Fecha:** 2026-11-26
- **Decide:** Aarón
- **Estado:** vigente. Es **regla del proyecto**: manda sobre lo que la contradiga en `PROYECTO.md`, `PROCESO.md`, los
  sprints y los traspasos.
- **Relacionada con:** 020 (decisiones mientras Aarón no está), 022 (avance rápido), `docs/00-base/*`

## Contexto

Cotiza Prime lleva dos meses de desarrollo y todavía no lo ha usado nadie. Lo que se construyó está bien hecho, pero se
aplicaron controles pensados para el lanzamiento público a un producto que aún no tiene usuarios. José ya lo vio y escribió
la decisión 022. Esta decisión la **ratifica** y define lo que faltaba: qué es el MVP, dónde se aloja, qué pasa con el
abogado y con el CI, y cómo trabajamos de aquí en adelante.

**El objetivo es avanzar rápido y tener un producto que funcione.**

## 1. La 022 queda ratificada

Lo que decidió José el 2026-11-25 se mantiene. Hay un solo ajuste, en el alcance (punto 2): el cobro sale del MVP.

## 2. Qué es el MVP

El MVP es **lo más básico que necesita una aplicación de cotizaciones**: armar una cotización, enviarla al cliente y
**dejar registro de cada una**, es decir, su estado y su historia.

- Casi todo ya está construido (sprints 2, 3 y 4, más el equipo del sprint 5). Lo que falta es **ponerlo en línea** y
  arreglar lo que impida usarlo.
- **La meta es presentárselo a JC y a Aarón** para recoger sus comentarios y hacer cambios a partir de ellos. La fecha la
  fijan Aarón y JC, y la idea es que sea pronto.
- **Queda para después de esa presentación** todo lo que no sea el recorrido básico:
  - aprobaciones (H-043 a H-047) y cobro (H-050 a H-057);
  - las plantillas 2 y 3 (H-076);
  - los dos pasos obligatorios (H-004c), H-114, H-117, H-119, H-120, H-041b y H-042b;
  - los menores pendientes de las revisiones.

  Nada de eso se pierde: queda en `HISTORIAS.md` y en `docs/seguridad-pendiente.md`, y se ordena con lo que salga de la
  presentación.
- **No entran historias nuevas antes de la presentación**, salvo arreglos que impidan usar el recorrido básico.

## 3. Infraestructura

| Qué | Regla |
|---|---|
| **GitHub** | **Siempre en la organización de la agencia** (`mainbrain-cl`). Ningún proyecto queda en una cuenta personal. |
| **Vercel** | **Siempre en el equipo de la agencia** (`mb`). |
| **Supabase** | **Plan gratis**, con los dos proyectos que permite: **uno de pruebas y uno de producción**. No se paga Pro mientras el proyecto esté en sus primeras fases. Se evalúa pasar a Pro **solo al final**, cuando la aplicación sea pública y la usen clientes finales. Región: São Paulo (`sa-east-1`). |
| **Cuenta del proyecto** | Cada proyecto tiene **su propio correo**: un alias de un correo de Main Brain, un Gmail o lo que sirva. Con ese correo se crean sus cuentas (Supabase, Resend, etc.). **La persona responsable del proyecto guarda ese acceso de forma segura.** En Cotiza Prime, el responsable es José. |
| **Correo** | Resend, plan gratis. El dominio de envío se verifica con SPF, DKIM y DMARC, y el seguimiento de aperturas y clics queda apagado. |
| **Dominio** | **Se le pregunta a JC** si quiere un dominio propio para la aplicación. Si no, se usa un **subdominio de mainbrain.cl** (por ejemplo `cotizaprime.mainbrain.cl` para producción y `pruebas.cotizaprime.mainbrain.cl` para pruebas). |
| **Claves** | Nunca en el repositorio ni en el historial de la terminal. Se cargan en Vercel, en el entorno que corresponde y marcadas *Sensitive*. Cada entorno tiene sus propias claves. |
| **Anti-robot del formulario público** | Cloudflare Turnstile, gratis (cierra la decisión 019). |
| **Sentry** | No es requisito para el MVP. Se agrega cuando haya uso real. |

**Lo que implica el plan gratis, y cómo se cubre:**
- **Un proyecto se pausa tras 7 días sin uso.** Antes de una demo o de un periodo de uso, conviene revisar que esté
  activo; si se pausó, se reactiva desde el panel.
- **No hay respaldos automáticos descargables.** Antes de aplicar migraciones en producción se saca un **respaldo
  manual** (`pg_dump`), que se guarda fuera del repositorio.

Esto reemplaza, mientras dure el MVP, a «respaldos automáticos con restauración probada» de `SEGURIDAD.md` y a Sentry de
`STACK.md`.

## 4. Abogado y datos reales

**La revisión del abogado no detiene el avance.** El piloto puede usar datos reales antes de esa revisión; el abogado
revisa en paralelo. Esta decisión responde el riesgo que la 022 dejó declarado y relaja, durante el piloto, el
«*requiere abogado* antes de producción» de `LEGAL.md`.

Se mantiene lo que ya está construido: los términos y la política de privacidad, su aceptación, el cifrado y la
auditoría.

## 5. CI (GitHub Actions)

- **Se acabaron los minutos de este mes** y ya se gastó bastante presupuesto. **No se piden minutos extra por ahora.**
  Aarón lo conversará con JC si hace falta.
- Se espera a que el cupo se reinicie con el ciclo de facturación mensual. La fecha exacta está en la configuración de
  facturación de la organización.
- Mientras tanto, y también cuando vuelva el CI: **antes de subir, se corre en local lo que el cambio afecta**, como dice
  la 022. Cuando el CI vuelva, se usa con medida: no se gastan minutos en cambios que solo tocan documentos.

## 6. Cómo trabajamos siempre

Esta sección vale para Cotiza Prime y es la forma de trabajar de la agencia.

1. **Todo proyecto parte de la base de Main Brain** (`docs/00-base/`) y de un plan que dan JC o Aarón.
2. **La base se aplica con criterio, no al pie de la letra.** Trae mucha seguridad, porque está pensada para el caso más
   exigente. Hay que saber distinguir:
   - **Siempre:** seguridad base en la **base de datos** (`tenant_id`, RLS y aislamiento entre organizaciones), en el
     **ingreso** y en la **autenticación**; permisos verificados en el servidor; nada de secretos en el repositorio y
     nada de datos reales en pruebas.
   - **Según el riesgo:** el resto se pondera según la dificultad de la aplicación y qué tan delicados son sus datos.
     Una aplicación sencilla que no guarda datos peligrosos no necesita el blindaje de un sistema bancario. En la
     duda, se aplica lo mínimo que protege y se anota el resto como pendiente.
3. **Subagentes en paralelo** en todo lo que no choca: cada frente en su rama o copia aislada y sin tocar los mismos
   archivos. **El número de subagentes se ajusta a la capacidad del PC de cada uno**: un PC potente puede llevar
   muchos a la vez y uno más justo, menos. Lo que se busca es aprovechar al máximo el tiempo según cada PC. Los
   cambios de base de datos se hacen de a uno y en orden.
4. **Cada tarea, al modelo que corresponde:**
   - **Sonnet** para lo mecánico y lo ya especificado.
   - **Opus** para la seguridad, el diseño técnico y los errores difíciles.
   - Lo muy chico se hace directo, sin agente.
5. **Revisiones con límite:**
   - **Una revisión Opus por lote**, hecha por un agente que no escribió ese código.
   - **Revisión adversarial solo** para lo que toca la base de datos, los permisos o la seguridad.
   - **Una sola vuelta de correcciones:** antes de mezclar se arregla solo lo crítico o alto, y lo demás queda anotado.
   - **No se abren PR de «menores de los menores».**
   - Si no hay nada grave, se mezcla de inmediato.
6. **Aarón ve los avances pronto.** Su revisión visual no espera a que terminen las pruebas.

## Lo que NO se relaja

Lo mismo que la 022: `tenant_id` y RLS en toda tabla, permisos en el servidor, aislamiento probado, cada migración con su
deshacer, nada de datos reales en pruebas y nada de secretos en el repositorio.

## Consecuencias

- Cotiza Prime puede quedar en línea en días, no en semanas.
- Habrá errores chicos en producción; se corrigen rápido.
- Antes del **lanzamiento público** se vuelve a mirar lo que aquí se pospuso: el plan Pro de Supabase, la revisión del
  abogado, los dos pasos obligatorios, Sentry y las listas de salida de `SEGURIDAD.md` y `LEGAL.md`.
