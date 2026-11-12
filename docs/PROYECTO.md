---
document_id: CP-PROYECTO
title: Cotiza Prime — Plan del proyecto
version: 1.0
status: APROBADO — Compuerta 1 cruzada el 2026-09-30
pais: Chile
last_updated: 2026-09-30
language: es-CL
---

# Cotiza Prime — Plan del proyecto

> **Estado: aprobado** por Aarón el 2026-09-30 (Compuerta 1 de `PROCESO.md`). Si cambia el
> alcance, este documento se actualiza y se vuelve a aprobar.

## Cotiza Prime en una página

*Lo primero que se lee. Si solo hay tiempo para una sección, es esta.*

| | |
|---|---|
| **Nombre** | **Cotiza Prime** |
| **Qué es** | Una plataforma web donde cada empresa crea su organización para cotizar con su marca, sus precios y sus reglas, y seguir cada cotización hasta que se paga |
| **Objetivo** | Que una pyme chilena pase de cotizar a mano —lento, disperso y sin control— a enviar cotizaciones profesionales en minutos, aprobadas por quien corresponde y con seguimiento hasta el pago |
| **Para quién** | Pymes chilenas con más de una persona vendiendo. La plataforma es general; **logística** es el primer rubro especializado |
| **El problema** | Plantillas dispersas, precios desactualizados, descuentos sin control, formularios de contacto que no sirven, y nadie sabe qué se envió ni quién pagó |
| **La promesa** | *"Cotiza en minutos, con tu marca, sin perder el control."* (frase de trabajo, por confirmar) |
| **Cómo se quiere mostrar** | **Profesional, confiable y simple.** Hacia el cliente final, la protagonista es **la marca de cada empresa**: sus cotizaciones tienen que verse serias y hacerla parecer más grande y con más trayectoria —por eso las plantillas cuidadas y la numeración corrida—. Hacia quien la usa, una herramienta clara, en español de Chile y sin jerga técnica. (Tono por confirmar; la identidad visual se define en `DISENO.md`) |
| **Lo que la hace distinta** | Se aprueba el **paquete completo** que recibirá el cliente · cobro por **transferencia con seguimiento, sin comisiones** · **formulario público** con vista previa en vivo de lo que se pide · **modelos de cálculo** por rubro · **varias empresas** en una misma cuenta |
| **Qué no es** | No factura ni se conecta al SII, no procesa pagos, no es un CRM completo ni un sistema de operación logística (§3) |
| **Principios** | 1. La marca del cliente primero. 2. Nada sale sin control. 3. El dinero nunca pasa por nosotros. 4. Nada enviado se borra. 5. Seguridad y ley desde el diseño |
| **País** | Chile — Ley 21.719, RUT, IVA 19%, CLP |
| **Cómo se construye** | En 8 fases, de la preparación al lanzamiento público (§15). Primero lo que sostiene todo, después el recorrido completo de una cotización, y al final lo que la hace cómoda |
| **Estado** | Plan, historias y sprint 1 aprobados. En curso: Fase 4 de `PROCESO.md`, desarrollo del sprint 1 |

## Índice

> **Cómo leer las referencias.** El signo **§** significa **"sección"**: *§9.3* quiere decir "ver la
> sección 9.3 de este documento". Los códigos **M01, M02…** son los módulos de la Parte IV.

**Parte I — Visión**
0. País · 1. Qué es · 2. Qué problema resuelve · 3. Qué no hace · 4. Términos

**Parte II — Cómo funciona**
5. Perfiles y permisos · 6. Flujos · 7. Estados de la cotización · 8. Encontrar, ordenar y seguir ·
9. Calcular: estimación por rubro · 10. Más ayudas para el rubro

**Parte III — Datos, integraciones y seguridad**
11. Datos · 12. Integraciones · 13. Consideraciones técnicas

**Parte IV — Mapa de funcionalidades**
14. Los módulos

**Parte V — Hoja de ruta**
15. Qué se construye primero, qué sigue y por qué

**Parte VI — Decisiones y cumplimiento**
16. Decisiones · 17. Cumplimiento de la base técnica

---

# Parte I — Visión

## 0. País

**Chile.** Declarado explícitamente, no inferido.

| Qué | Definición |
|---|---|
| Ley de datos personales | **Ley 21.719**, en plena vigencia desde el **1 de diciembre de 2026** |
| Identificador de personas y empresas | **RUT**, con validación de dígito verificador |
| Impuesto | **IVA 19%**, configurable por si cambia la tasa, con servicios exentos posibles |
| Moneda | **CLP (peso chileno), sin decimales** |
| Formato de números | Punto como separador de miles: `$1.250.000` |
| Formato de fechas | `dd-mm-aaaa` |

Si Cotiza Prime sale a producción antes del 1 de diciembre de 2026, igual se construye cumpliendo
la ley: agregar cumplimiento con datos reales adentro es el escenario caro.

El producto es de autoservicio, así que podría registrarse una empresa de otro país. La v1 se
declara **solo para Chile** en los términos y condiciones: no se bloquea, pero tampoco se promete
soporte a otras monedas, impuestos ni identificadores.

---

## 1. Qué es

**Cotiza Prime es una herramienta web donde cualquier empresa crea su propia organización para
armar, aprobar y enviar cotizaciones con su marca, sus precios y sus reglas, y hacer seguimiento
hasta que el cliente paga.**

Para quién: **pymes chilenas que hoy cotizan a mano y tienen más de una persona vendiendo.**
La v1 es **general**: sirve a cualquier rubro que cotice servicios o productos, con modelos de
cálculo generales (§9.2). **Logística** —fletes, transporte de carga, mudanzas, distribución— es el
**primer rubro especializado**: su modelo detallado es la primera prioridad después del lanzamiento,
precedido de un estudio de costeo formal (§9.3).

El caso que define el producto: una persona puede tener **varias empresas** en la misma cuenta,
completamente separadas. Negocio 1 con su equipo comercial, Negocio 2 sin dar acceso a nadie.
Ninguno ve nada del otro.

---

## 2. Qué problema resuelve

| El dolor | Cómo se ve en el día a día |
|---|---|
| **Cada vendedor tiene su propia plantilla** | Tres versiones del mismo documento, con el logo viejo |
| **Los precios se desactualizan** | Se cotiza con la lista del año pasado y el margen desaparece |
| **Nadie controla lo que se envía** | El jefe se entera del 30% de descuento cuando el cliente ya aceptó |
| **No hay registro de qué se envió** | "¿Le mandaste la cotización?" "Creo que sí" |
| **El formulario de contacto no sirve** | Llega "Hola, quiero información" y hay que preguntar qué necesita |
| **El cobro se pierde entre correos** | Nadie sabe si el cliente ya pagó el anticipo o si falta el saldo |
| **No se sabe qué pasa después** | Cuántas se enviaron, cuántas se cerraron, cuánto falta por cobrar |

---

## 3. Qué NO hace

**Cotiza Prime no es y no será, salvo decisión registrada:**

- **No es facturación electrónica.** No emite boletas ni facturas ni se conecta al SII. Una
  cotización **no es un documento tributario**.
- **No procesa pagos.** No hay pasarela de pago: cobraría una comisión que no conviene en
  cotizaciones de montos altos y nos convertiría en intermediarios del dinero. Cotiza Prime
  **envía los datos de transferencia y registra si se pagó**, pero el dinero nunca pasa por nosotros.
- **No confirma pagos automáticamente** en la v1. Un administrador marca el pago a mano (§6.6).
- **No es un CRM completo.** Sin embudo de ventas, tareas ni campañas. Guarda clientes e historial.
- **No maneja inventario ni stock.** El catálogo es una lista de precios.
- **No hace firma electrónica avanzada.** Aceptar en línea es un **registro de conformidad**
  —quién, desde dónde, cuándo—, no una firma con validez de firma avanzada.
- **No es contabilidad** ni control de costos o márgenes.
- **No tiene aplicación móvil nativa.** La web funciona bien en teléfono.
- **No hay editor de fórmulas libre.** Los cálculos usan modelos por rubro que define Cotiza Prime;
  cada organización pone sus tarifas, no escribe fórmulas (§9).
- **No es un sistema de operación logística.** No planifica rutas, no despacha, no sigue camiones
  por GPS ni gestiona la flota. Cotiza el flete; lo que pasa después es de otro sistema.
- **No entrega precios de mercado.** Toda estimación sale de los costos que la organización declara.

---

## 4. Términos

Las palabras que se usan **siempre igual**, en la interfaz, en el código y en las conversaciones.

| Término (interfaz) | Nombre en el código | Qué es |
|---|---|---|
| **Organización** | `tenant` / `tenant_id` | La empresa dentro de Cotiza Prime. La caja que separa todo de todo |
| **Miembro** | `member` | Persona con acceso a una organización |
| **Rol** | `role` | El conjunto de permisos de un miembro dentro de una organización |
| **Cliente** | `customer` | A quién se le cotiza. Persona o empresa |
| **Cotización** | `quote` | El documento con sus ítems, totales, condiciones y estado |
| **Ítem** | `quote_item` | Cada línea de la cotización: servicio, cantidad, precio |
| **Catálogo** | `catalog_item` | La lista de servicios con sus precios base |
| **Plantilla** | `template` | El diseño visual del PDF |
| **Paquete de envío** | `quote_package` | Todo lo que recibirá el cliente: PDF, texto del correo y condiciones de pago |
| **Aprobación** | `approval` | El visto bueno interno sobre el paquete de envío completo |
| **Condición de pago** | `payment_terms` | Cómo se paga: 100% al aceptar, o 50% al aceptar y 50% al final |
| **Hito de pago** | `payment_milestone` | Cada uno de los pagos esperados (anticipo, saldo), con su monto y estado |
| **Datos de transferencia** | `bank_account` | La cuenta bancaria de la organización donde el cliente paga |
| **Formulario público** | `intake_form` | El enlace donde un desconocido pide una cotización |
| **Solicitud** | `request` | Lo que llega por el formulario público, antes de ser cotización |
| **Campo bloqueado** | `locked` | Valor que el comercial no puede modificar |
| **Enlace del cliente** | `share_link` | La dirección única donde el cliente ve y acepta su cotización |

**No confundir:** *Cliente* es a quién le cotiza la empresa. La empresa que usa Cotiza Prime es la
**Organización**. Nunca "cliente" para las dos cosas.

---

# Parte II — Cómo funciona

## 5. Perfiles y permisos

### 5.1 Los perfiles

| Perfil | Quién es | Rol en una frase |
|---|---|---|
| **Dueño** | Quien creó la organización. Es único | Todo, más eliminar la organización, transferirla y manejar el plan |
| **Administrador** | Socio o jefe comercial | Configura, aprueba, maneja datos bancarios y confirma pagos |
| **Aprobador** | Jefatura que da el visto bueno | Aprueba o rechaza paquetes de envío. No configura ni toca pagos |
| **Comercial** | El vendedor | Arma y envía **sus** cotizaciones; pide el segundo pago |
| **Observador** | Contabilidad, gerencia | Ve todo. No cambia nada |

**El cliente final no tiene cuenta.** Entra solo por el enlace que se le envía.

### 5.2 Qué puede cada uno

| Acción | Dueño | Admin | Aprobador | Comercial | Observador |
|---|:---:|:---:|:---:|:---:|:---:|
| Ver todas las cotizaciones y clientes de la organización | ✅ | ✅ | ✅ | ✅ | ✅ |
| Crear y editar cotizaciones propias | ✅ | ✅ | — | ✅ | — |
| Solicitar aprobación | ✅ | ✅ | — | ✅ | — |
| Aprobar, rechazar o pedir cambios | ✅ | ✅ | ✅ | — | — |
| Enviar sin aprobación *(si la regla lo permite)* | ✅ | ✅ | — | ✅ | — |
| Solicitar el segundo pago | ✅ | ✅ | — | ✅ *(las suyas)* | — |
| **Marcar un pago como recibido** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Ver y editar datos de transferencia** | ✅ | ✅ | ❌ | ❌ | ❌ |
| Editar catálogo, precios y campos bloqueados | ✅ | ✅ | — | — | — |
| Editar plantillas, logo y textos base de correo | ✅ | ✅ | — | — | — |
| Configurar reglas de aprobación | ✅ | ✅ | — | — | — |
| Invitar y quitar miembros | ✅ | ✅ | — | — | — |
| Manejar el plan de pago de Cotiza Prime | ✅ | — | — | — | — |
| Eliminar la organización | ✅ | — | — | — | — |

**Ver no es editar.** Todos ven todo dentro de su organización, pero cada comercial solo edita y
envía las suyas. Entre organizaciones no se ve nada (§13.1).

**Regla no negociable:** cada permiso se verifica **en el servidor, en cada petición**. Que la
pantalla oculte un botón no es seguridad.

### 5.3 Reglas de aprobación

El administrador decide si su organización exige aprobación, y cuándo:

- **Siempre**, para toda cotización.
- **Por monto**: sobre cierto total (ej. más de $2.000.000).
- **Por descuento**: sobre cierto porcentaje (ej. más de 10%).
- **Nunca**: el comercial envía directo.

Además puede limitar, por comercial, qué servicios del catálogo puede cotizar.

---

## 6. Flujos

### 6.0 El recorrido completo de una cotización

> Indicado por Aarón el 2026-10-06. **Es el mapa de cómo se manejan las cotizaciones**: Cotiza
> Prime no es solo crear una cotización y descargarla. Cada paso se detalla en §6.2 a §6.8; si
> algo de abajo contradice esas secciones, manda este mapa y se ajustan.

**1. Formulario público y solicitud.**
- La organización comparte un **enlace público** a su formulario **y** puede **incrustarlo** (código
  para pegar) en su sitio web. Ambas opciones desde la v1.
- El formulario es **muy profesional**: mientras la persona escribe sus datos, ve **en tiempo real
  lo que está solicitando y cómo lo solicita**, como un desglose **sin precios**. Quien solicita
  una cotización no ve ningún monto (§9.5).
- Al enviarlo, la solicitud **llega directo a la organización dueña del enlace** y queda disponible
  para el equipo con acceso a cotizaciones.

**2. Armado de la cotización.**
El equipo toma la solicitud y arma la cotización, con servicios preestablecidos **o con precios
ingresados a mano** para poder negociar. Al armarla:
- **(a) Diseño:** elige la plantilla. Si ya hay una predefinida, queda lista sola, con el logo
  subido antes y los datos del solicitante y de la empresa emisora.
- **(b) Correo:** redacta el texto al cliente, partiendo de una **plantilla de correo** para no
  escribir todo a mano cada vez.
- **(c) Vista previa completa:** a un lado, el correo tal como lo leerá el cliente ("Estimado tal,
  se le hace envío de la cotización correspondiente a su solicitud…"); al otro, el **PDF adjunto**
  ya armado con toda la información.

**3. Roles y aprobación.**
- **(a)** Los usuarios con permiso de **enviar directo** despachan la cotización sin autorización.
- **(b)** Los que **requieren aprobación** solicitan la revisión. El administrador ve exactamente
  cómo quedó: la cotización, el correo y el PDF. **Al aprobar, el correo final sale solo**, con el
  resumen redactado y el PDF adjunto.

**4. Respuesta del cliente.**
- **(a) Acepta:** la confirmación se refleja en la plataforma.
- **(b) Rechaza:** **el motivo es obligatorio** y se elige de una lista (precio demasiado alto, no
  está en el presupuesto, ya aceptó la cotización de otra empresa…, §8.11). Con eso se cierra el
  ciclo.

**Enviar es siempre desde la plataforma**, en un clic: nadie descarga el PDF, arma el correo a mano
ni lo manda por fuera. Esa es la razón de ser del producto.

| Paso | Detalle en |
|---|---|
| 1. Formulario y solicitud | §6.7, §13.5 |
| 2. Armado | §6.3, §9 |
| 3. Roles y aprobación | §5, §6.4 |
| 4. Respuesta del cliente | §6.5, §8.11 |

### 6.1 Registro y onboarding

1. Alguien se registra con su correo y lo verifica. *(Sin verificación no se crea nada.)*
2. Crea su organización y queda como **Dueño**.
3. Activa la **verificación en dos pasos**, obligatoria para el Dueño (§13.2).
4. Entra al **onboarding**: un recorrido guiado que deja configurada casi toda la plataforma antes
   de la primera cotización.

**Los pasos del onboarding:**

| # | Paso | Qué deja listo |
|---|---|---|
| 1 | **Tu empresa** | Nombre, RUT, rubro, datos de contacto |
| 2 | **Tu marca** | Logo y colores, con vista previa en vivo del PDF |
| 3 | **Tu rubro** | Elige los modelos de cálculo que usará (§9.2) y ofrece categorías de ejemplo, que se pueden borrar |
| 4 | **Tus tarifas y márgenes** | Tarifas de los modelos elegidos, costos si los conoce, y margen mínimo deseado |
| 5 | **Tu catálogo** | Los primeros servicios con su precio |
| 6 | **Tu numeración** | Prefijo, si el correlativo se reinicia cada año o es corrido, y desde qué número parte (§8.1) |
| 7 | **Cómo te pagan** | Datos de transferencia y condición de pago por defecto (100% o 50/50) |
| 8 | **Tus textos** | Texto base del correo, condiciones comerciales y exclusiones |
| 9 | **Tu plantilla** | Elige una de las tres plantillas de PDF, viendo cómo queda con sus datos |
| 10 | **Tus reglas** | Si exige aprobación, y cuándo: siempre, por monto, por descuento o por margen |
| 11 | **Tu equipo** | Invita a sus miembros con rol |
| 12 | **Tu formulario** | Publica el formulario público y descarga su código QR |

**Reglas del onboarding:**

- **Se puede saltar pasos y volver después.** Queda una lista de configuración con el avance
  ("7 de 12 listos") en el inicio, hasta completarla.
- **Lo mínimo para enviar la primera cotización:** empresa, marca, al menos un servicio o un
  modelo de cálculo configurado, y datos de transferencia. Todo lo demás tiene un valor por defecto
  razonable.
- **Al terminar, ofrece crear una cotización de prueba** dirigida al propio correo del Dueño, para
  que vea exactamente lo que recibirá su cliente.

Si luego crea **Negocio 2**, es otra organización, independiente, con su propio onboarding. Se cambia
con un selector. **Nada se comparte:** clientes, catálogo, plantillas, miembros, cotizaciones ni
datos bancarios.

### 6.2 Invitar al equipo

1. El administrador invita por correo, con rol.
2. El invitado recibe un enlace que caduca.
3. Si ya tiene cuenta, la organización se suma a su selector. Si no, se registra.
4. Queda registrado quién invitó a quién y cuándo.

### 6.3 Armar la cotización y su paquete de envío

El comercial arma **todo lo que va a recibir el cliente**, no solo la cotización:

1. **Cliente:** lo elige o lo crea.
2. **Ítems:** los agrega desde el catálogo. Los precios se cargan solos; puede ajustar cantidad,
   precio y descuento **salvo lo bloqueado**.
3. **Totales:** el sistema calcula neto, descuentos, IVA y total.
4. **Plantilla:** elige una de las tres plantillas de PDF.
5. **Condición de pago:** **100% al aceptar** o **50% al aceptar y 50% al final**.
6. **Vigencia** de la oferta.
7. **Texto del correo:** parte de un texto base que definió el administrador y lo ajusta.
8. **Vista previa:** ve el correo y el PDF exactamente como los recibirá el cliente.

### 6.4 Aprobación interna

Si la regla de la organización lo exige, el botón no dice "Enviar", dice **"Solicitar aprobación"**.

1. Al solicitarla, **el paquete se congela**: correo, PDF y condiciones de pago quedan fijos.
2. El aprobador recibe el aviso y revisa **el paquete completo**, tal cual lo verá el cliente.
3. Tiene tres opciones:
   - **Aprobar** → el correo sale **automáticamente** al cliente (§6.5).
   - **Pedir cambios**, con comentario → vuelve al comercial como borrador.
   - **Rechazar**, con motivo → queda cerrada.
4. **Si el comercial cambia cualquier cosa después de solicitar la aprobación** —una coma del
   correo, un precio—, la solicitud se anula y tiene que pedirla de nuevo. Lo aprobado es
   exactamente lo que se envía, nunca otra cosa.

Si no se exige aprobación, el comercial envía directo desde la vista previa.

### 6.5 El envío y la respuesta del cliente

**Correo 1 — la cotización.** Sale al aprobarse, o al enviar directo. Lleva:

- El texto redactado por el comercial.
- El PDF adjunto.
- Un botón **"Revisar y aceptar la cotización"**, que abre el enlace del cliente.

En el enlace el cliente ve la cotización con la marca de la organización, puede descargar el PDF
y **acepta o rechaza**. Queda registrado cuándo la abrió y qué respondió. Quien creó la cotización
recibe un aviso en ambos casos.

Los datos de transferencia **no aparecen en el correo 1 ni en el enlace antes de aceptar**.

### 6.6 El cobro

**Correo 2 — primer pago.** Sale **automáticamente al aceptar**. Lleva los datos de transferencia
y el monto a pagar: el **100%** o el **50%**, según la condición de pago. Los mismos datos quedan
visibles en el enlace del cliente, ya aceptado.

**Confirmar el pago — siempre manual.**

1. El cliente transfiere.
2. Un **Administrador o el Dueño** ve el depósito en su banco y marca el pago como recibido en
   Cotiza Prime: fecha, monto y nota opcional.
3. Queda registrado quién lo marcó y cuándo.
4. Si se marcó por error, un Administrador o el Dueño puede revertirlo **indicando el motivo**. El
   registro original no se borra.

**Si la condición es 50/50, el segundo pago:**

1. Cuando el trabajo está listo según el trato, el comercial (o un administrador) presiona
   **"Solicitar segundo pago"**. No se dispara solo: solo la organización sabe cuándo terminó.
2. Sale el **correo 3**, con los datos de transferencia y el saldo.
3. Un Administrador o el Dueño lo marca como recibido, igual que el primero.
4. La cotización queda **Pagada**.

### 6.7 El formulario público

1. El administrador arma un formulario con los campos y los servicios que se pueden pedir.
2. Publica el enlace en su web, Instagram o firma de correo.
3. Alguien lo llena y **acepta la política de privacidad** antes de enviar.
4. Llega como **solicitud**, con los servicios elegidos y los datos del trabajo, **sin precio**
   (§9.5). Mientras la llena, la persona ve en vivo un resumen de lo que está pidiendo.
5. El comercial la convierte en cotización con un clic y sigue desde §6.3.

### 6.8 Una cotización que se renegocia

El cliente pide rebaja. El comercial crea la **versión 2** desde la 1. La 1 queda en el historial
como **Reemplazada**, y su enlace deja de permitir aceptar. La versión 2 vuelve a pasar por las
reglas de aprobación.

---

## 7. Estados de la cotización

```
                                       ┌── Cambios solicitados ──┐
                                       │                         ↓
Borrador ──→ Pendiente de aprobación ──┼── Rechazada internamente   (vuelve a Borrador)
    │                                  │
    └──── (sin aprobación) ────────────┴──→ Enviada ──→ Vista ──┬──→ Rechazada por el cliente
                                                                ├──→ Vencida
                                                                └──→ Aceptada
                                                                        │
                                              ┌─────────────────────────┤
                                              ↓ (100%)                  ↓ (50/50)
                                      Pendiente de pago         Pendiente de anticipo
                                              │                         │
                                              │                   Anticipo pagado
                                              │                         │  (botón "Solicitar segundo pago")
                                              │                   Pendiente de saldo
                                              ↓                         ↓
                                           Pagada  ←────────────────────┘

En cualquier punto antes de Aceptada: → Reemplazada (existe una versión nueva)
```

| Estado | Qué significa | Quién lo provoca |
|---|---|---|
| Borrador | Se está armando | Comercial |
| Pendiente de aprobación | Paquete congelado, esperando visto bueno | Comercial |
| Cambios solicitados | El aprobador pidió ajustes | Aprobador |
| Rechazada internamente | El aprobador la descartó | Aprobador |
| Enviada | Correo 1 enviado | El sistema, al aprobar o al enviar directo |
| Vista | El cliente abrió el enlace | El cliente |
| Rechazada por el cliente | El cliente dijo que no | El cliente |
| Vencida | Pasó la vigencia sin respuesta | El sistema |
| Aceptada | El cliente dijo que sí; sale el correo 2 | El cliente |
| Pendiente de pago / de anticipo | Esperando la transferencia | El sistema |
| Anticipo pagado | Primer 50% confirmado | Administrador o Dueño |
| Pendiente de saldo | Se pidió el segundo pago; salió el correo 3 | Comercial o Administrador |
| Pagada | Todo el monto confirmado | Administrador o Dueño |
| Reemplazada | Hay una versión nueva | Comercial |

---

## 8. Encontrar, ordenar y seguir

La pregunta que más se repite en una empresa que cotiza es **"¿en qué quedó esa cotización?"**.
Cotiza Prime tiene que responderla en segundos, sin preguntarle a nadie.

### 8.1 Numeración

- Cada cotización recibe al crearse un **número correlativo propio de la organización**.
- **La organización elige el formato** en el onboarding:

  | Opción | Ejemplo | Para quién |
  |---|---|---|
  | **Anual** — se reinicia cada año | `COT-2026-0043`, luego `COT-2027-0001` | Quien ordena por año |
  | **Corrido** — nunca se reinicia | `COT-2043` | Quien quiere que se vea su trayectoria |

- **Número de partida configurable.** Una empresa que ya lleva, por ejemplo, 2.000 cotizaciones
  hechas a mano puede partir en la 2.001 y mantener su secuencia.
- El prefijo (`COT`, `PRES`, `PPTO`…) también lo elige la organización.
- **El formato se puede cambiar más adelante, pero el número nunca retrocede:** el siguiente siempre
  es mayor que el último usado, para que no se repita un número ya enviado a un cliente.
- **Las versiones conservan el número:** `COT-2026-0043 v2`. Así se sabe de inmediato que es la
  misma negociación.
- **Un número nunca se reutiliza**, aunque se elimine el borrador. Puede haber saltos, y está bien:
  una cotización no es documento tributario.
- El número lo asigna la base de datos, de modo que **dos personas creando a la vez nunca reciben el
  mismo**.

### 8.2 Búsqueda

Una **barra de búsqueda siempre visible** (también con el atajo `Ctrl + K`) que encuentra mientras
se escribe, por:

- **Número** de cotización, completo o parcial (`43` encuentra `COT-2026-0043`)
- **Cliente**: nombre, RUT o correo
- **Servicio** cotizado
- **Comercial** que la creó

Cada resultado muestra de un vistazo: número, cliente, total, fecha y **estado con su color**.

### 8.3 Filtros y orden

El listado de cotizaciones se filtra por **estado, fecha, comercial, cliente, categoría,
etiqueta, rango de monto y condición de pago**, más dos atajos: **"Por vencer"** y **"Con pago
pendiente"**. Se ordena por fecha, monto o vencimiento, y los filtros se combinan.

### 8.4 Categorías y etiquetas

| | Cuántas por cotización | Quién las define | Ejemplo |
|---|---|---|---|
| **Categoría** | Una | El administrador, en una lista cerrada | "Mudanzas", "Fletes", "Eventos" |
| **Etiquetas** | Varias | Cualquier miembro, libres | "urgente", "cliente frecuente", "licitación" |

La categoría ordena y, más adelante, permite medir ("¿cuánto vendimos en fletes?"). Las etiquetas
son para el día a día. El **catálogo** también se ordena en categorías.

### 8.5 La línea de tiempo de cada cotización

Cada cotización guarda **su historia completa, en orden, sin que nadie la escriba a mano**:

```
03-10  09:12  Creada por Juan
03-10  09:40  Aprobación solicitada por Juan
03-10  11:05  Aprobada por Aarón · correo enviado a contacto@cliente.cl
04-10  18:22  Abierta por el cliente (3 veces)
05-10  10:03  Aceptada · se envió el correo con datos para el anticipo
08-10  16:45  Anticipo de $625.000 confirmado por Aarón
```

Incluye versiones anteriores, notas internas, cambios de vigencia y correos rebotados. **Es de solo
lectura: nadie puede editar ni borrar la historia.**

### 8.6 Notas internas

Comentarios del equipo dentro de la cotización ("pidió que lo llamen el lunes", "ojo, paga tarde").
**El cliente nunca los ve**, ni en el enlace ni en el PDF.

### 8.7 La ficha del cliente

Todas las cotizaciones de ese cliente, con un resumen arriba:

| Cotizado | Aceptado | Pagado | Por cobrar |
|---|---|---|---|
| $8.400.000 | $5.100.000 | $3.200.000 | $1.900.000 |

Desde la ficha se crea una cotización nueva con el cliente ya cargado.

### 8.8 El inicio: "Lo que requiere mi atención"

Al entrar, cada miembro ve primero **lo que depende de él**, según su rol:

| Rol | Ve primero |
|---|---|
| **Aprobador, Administrador** | Aprobaciones pendientes |
| **Administrador, Dueño** | Pagos por confirmar; cambios recientes en datos bancarios |
| **Comercial** | Sus cotizaciones por vencer, vistas sin respuesta, rechazadas, correos rebotados y solicitudes nuevas del formulario |

Debajo, un **resumen por estado**, con cantidad y monto: borradores, enviadas, aceptadas, por cobrar.
Cada número se puede tocar y lleva al listado ya filtrado.

### 8.9 Alertas internas

Avisos **al equipo**, nunca al cliente en la v1:

- La cotización **vence en X días** y no hay respuesta.
- El cliente **la abrió pero no respondió** en X días.
- Un **pago lleva X días pendiente**.
- Un **correo rebotó**.

Cada organización define sus X.

### 8.10 Acciones que ahorran tiempo

- **Duplicar** una cotización, para otro cliente o para una parecida.
- **Textos predefinidos**: condiciones comerciales, notas al pie y textos de correo. El administrador
  los escribe una vez y todos los usan.
- **Extender la vigencia** de una cotización vencida sin rehacerla. Queda en la línea de tiempo.
- **Reenviar** el correo al cliente, o a otro correo del mismo cliente.
- **Guardado automático** del borrador: nada se pierde si se cierra la ventana.

### 8.11 Motivo de rechazo

Cuando el cliente rechaza, **tiene que indicar el motivo** (decisión de Aarón, 2026-10-06; antes
era opcional). Elige uno de una lista: **precio demasiado alto, no está en el presupuesto, ya
acepté la cotización de otra empresa, plazo, ya no lo necesito, otro** (con un texto breve). Cuesta
un clic y es la información más valiosa para vender mejor. Sin motivo, el rechazo no se registra.

### 8.12 Nada se borra

- Una cotización que **salió hacia un cliente nunca se borra**: se **archiva**. Deja de aparecer en
  el listado normal, pero se encuentra si se busca.
- Solo se puede **eliminar un borrador que nunca se envió**.
- **Excepción legal:** si una persona pide la supresión de sus datos (Ley 21.719), sus datos
  personales se **anonimizan** en las cotizaciones, pero el número, los servicios y los montos quedan
  para el historial de la organización.

### 8.13 Exportar

El listado, con los filtros aplicados, se descarga a Excel. Cada exportación **queda en auditoría**,
porque sale del sistema con datos personales.

---

## 9. Calcular: estimación por rubro

### 9.1 La idea

Nadie debería armar un precio desde cero cada vez. Cotiza Prime trae **modelos de cálculo**:
Cotiza Prime define **qué datos se piden y cómo se combinan**, y cada organización pone **sus
propias tarifas y costos**, una sola vez. Al cotizar, el comercial ingresa los datos del trabajo
—cantidad, horas, metros— y el sistema propone los ítems con su precio.

Todo lo que propone sigue siendo **editable**, salvo lo que el administrador haya bloqueado.

| Pieza | Quién la define | Ejemplo |
|---|---|---|
| **Modelo** | Cotiza Prime | "Servicio por tiempo" |
| **Tarifas y costos** | La organización, una vez | Técnico $18.000 la hora, costo $11.000 |
| **Datos del trabajo** | El comercial, o el cliente en el formulario público | 6 horas, 2 técnicos, materiales $40.000 |

**Por qué modelos y no un editor de fórmulas libre.** Un editor libre es un lenguaje de
programación pequeño: difícil de usar para una pyme, riesgoso en seguridad y caro de construir.
Los modelos cerrados dan la mayor parte del valor con una fracción del riesgo.

### 9.2 Los modelos generales de la v1

Tres modelos que cubren a la mayoría de los rubros:

| Modelo | Cómo calcula | Sirve para |
|---|---|---|
| **Por unidad** | Cantidad × tarifa por unidad (km, m², kg, día, unidad), con **tramos opcionales** (más barato sobre cierta cantidad), **tarifa mínima** y **recargos en porcentaje** (urgencia, fin de semana) | Flete simple por km, arriendos por día, pintura por m², impresión por unidad |
| **Servicio por tiempo** | Horas × personas × tarifa por perfil (técnico, ayudante, profesional) + materiales + traslado | Mantenciones, servicios técnicos, instalaciones, servicios profesionales |
| **Productos** | Costo + margen, o precio fijo; **descuento por volumen**; despacho aparte | Venta de productos, insumos, equipos |

Una organización puede usar **varios modelos a la vez** y siempre puede agregar ítems sueltos del
catálogo.

**Logística ya puede cotizar en la v1** con el modelo "por unidad": km × tarifa, con tramos, mínimo
y recargos. No es el cálculo fino —ese llega con §9.3—, pero no parte de cero.

### 9.3 Logística: el primer rubro especializado

Un buen modelo de flete no se inventa: necesita un **estudio de costeo** antes de programarse. Si la
fórmula está mal, la organización cotiza bajo su costo sin darse cuenta.

**El estudio tiene que cubrir, al menos:**

| Tema | Qué hay que levantar |
|---|---|
| **Costo por km según camión** | Combustible y rendimiento, neumáticos, mantención, por tipo de vehículo |
| **Costos fijos** | Sueldos, seguros, permiso de circulación, revisión técnica, depreciación, prorrateados por km o por día |
| **Tramos de distancia** | Cómo cambia el costo en viajes cortos, medios y largos |
| **Retorno vacío** | Cuándo se cobra la vuelta y cuánto |
| **Peajes y TAG** | Según ruta, y cómo se estiman |
| **Tiempos** | Carga, descarga y espera |
| **Peso y volumen** | Peso volumétrico y el factor que usa el mercado |
| **Variación del combustible** | Cómo se protege el margen si el diésel sube durante la vigencia |

**Cómo se valida:** con **dos o tres empresas de logística reales**, comparando lo que el modelo
calcula contra lo que ellas efectivamente cobraron. Solo se usan montos, distancias y cargas, nunca
datos de sus clientes. El estudio queda escrito en `docs/estudios/costeo-logistica.md` antes de
tocar código.

**Lo que traerá el modelo de logística:**

- Flete con **vehículos**: la flota de la organización con capacidad en kg y m³ y tarifas propias; el
  sistema **sugiere el camión donde cabe la carga**.
- **Peso cobrable**: el mayor entre el peso real y el peso volumétrico.
- Tramos, retorno vacío, ayudantes, espera, peajes, recargos, seguro de carga y tarifa mínima.
- **Asistente de costos logísticos**: preguntas simples ("¿cuánto pagas el diésel?", "¿cuánto rinde
  el camión?", "¿cuánto le pagas al chofer?") que calculan el costo por km y por hora y proponen una
  tarifa con margen.
- **Distancia automática** desde las direcciones, con un servicio de mapas (§13.15).
- **Datos del servicio** en el PDF: origen, destino, fecha, ventana horaria y tipo de carga.

**Cotiza Prime nunca sugiere "precios de mercado".** Toda tarifa sale de los costos que declara la
propia organización.

### 9.4 Costo y margen, solo para el equipo

Cada ítem —del catálogo o calculado— puede guardar **costo y precio**. El equipo ve el margen; **el
cliente nunca**.

- El administrador decide si el comercial ve los costos o solo un **semáforo de margen**
  (verde, amarillo, rojo). Por defecto: solo el semáforo.
- **Regla de aprobación por margen mínimo.** Si una cotización queda bajo el margen que fijó el
  administrador (ej. 15%), exige aprobación. Protege mejor que la regla por descuento, porque un
  precio mal puesto a mano también baja el margen.

### 9.5 El mismo cálculo en el formulario público

El formulario público **no muestra precios** (decisión de Aarón, 2026-10-06): quien lo llena está
*solicitando* una cotización, y darle el precio sería cotizarle sin que el equipo intervenga. Lo
que ve, en tiempo real, es **lo que está pidiendo y cómo lo está pidiendo**: el desglose de su
solicitud (servicios, cantidades, datos del trabajo), **sin ningún monto**. Los datos que ingresa
sirven para que el equipo calcule después con los modelos de §9.2, en el servidor y con sus
tarifas, que nunca llegan al navegador.

### 9.6 Los modelos y sus módulos

| Modelo | Módulo |
|---|---|
| Por unidad, servicio por tiempo, productos | M16 |
| **Logística detallada**, con estudio de costeo previo | M20 |
| Proyectos por partidas (construcción, eventos) | M24 |
| Otros rubros especializados | M28 — solo con demanda real |
| Editor de fórmulas libre | M28 — solo si aparecen casos reales que ningún modelo cubra |

El orden en que se construyen está en la hoja de ruta (§15).

---

## 10. Más ayudas para el rubro

Mejoras pensadas para quien cotiza todos los días, sin salirse de cotizar.

| Mejora | Qué resuelve | Módulo |
|---|---|---|
| **Compartir por WhatsApp** | Un botón abre WhatsApp con un mensaje y el enlace de la cotización. En Chile muchos clientes responden más por ahí que por correo. Sin integración paga: usa el enlace estándar de WhatsApp | M14 |
| **Código QR del formulario público** | Para imprimir en camiones, tarjetas o el local | M15 |
| **Asignar solicitudes** | Cada solicitud del formulario queda a cargo de un comercial; ninguna queda sin dueño | M15 |
| **Condiciones y exclusiones estándar** | "No incluye embalaje", "carga y descarga a pie de camión": evita discusiones después | M08 |
| **Datos del servicio en la cotización** | Origen, destino, fecha, ventana horaria y tipo de carga quedan escritos en el PDF: se sabe exactamente qué se cotizó | M20 |
| **Cláusula de reajuste por combustible** | Si el diésel sube durante la vigencia, queda previsto cómo se ajusta | M20 |
| **Ítems opcionales** | El cliente marca en su enlace lo que quiere sumar (seguro, embalaje) y el total se actualiza | M23 |
| **Alternativas A / B / C** | "Camión 3/4 o camión grande": el cliente elige una en su enlace | M23 |
| **Precios especiales por cliente** | Tarifas preferentes para clientes frecuentes | M23 |
| **Fotos en el formulario público** | El cliente sube una foto de la carga y se cotiza sin visita | M23 |
| **Adjuntos extra en el correo** | Fichas técnicas, fotos, certificados | M23 |
| **Formulario público dentro de la web** de la organización | Se pega (código incrustable) en su sitio sin que el cliente salga. **Entra en la v1**, junto con el enlace (decisión 2026-10-06) | M15 |
| **Peajes automáticos** según la ruta | Hoy se ingresan a mano | M26 |
| **Cotizaciones recurrentes** | El mismo flete cada semana, sin rehacerlo | M26 |
| **Tiempo de respuesta a solicitudes** | Cuánto se demora el equipo en cotizar lo que llega | M25 |

---

# Parte III — Datos, integraciones y seguridad

## 11. Datos

### 11.1 Las entidades principales

| Entidad | Guarda | ¿Datos personales? |
|---|---|---|
| `tenants` | Organizaciones: nombre, RUT, logo, colores, configuración | De la empresa |
| `users` | Cuentas: correo, nombre | **Sí** |
| `members` | Quién pertenece a qué organización y con qué rol | **Sí** |
| `customers` | Clientes: nombre, RUT, correo, teléfono, dirección | **Sí, de terceros** |
| `catalog_items` | Servicios con precio, unidad e impuesto | No |
| `quotes` | Cotizaciones: estado, totales, vigencia, versión, autor | Indirectamente |
| `quote_items` | Líneas **con el precio congelado** | No |
| `quote_packages` | Copia congelada de lo que se envía: texto del correo, PDF, condiciones | **Sí** |
| `approvals` | Quién aprobó qué paquete, cuándo y con qué comentario | **Sí** |
| `payment_milestones` | Cada pago esperado: porcentaje, monto, estado, quién lo confirmó y cuándo | **Sí** |
| `bank_accounts` | Datos de transferencia de la organización | **Financieros — cifrado obligatorio** |
| `email_messages` | Cada correo enviado y si fue entregado o rebotó | **Sí** |
| `templates` | Plantillas de PDF y textos base de correo | No |
| `intake_forms` / `requests` | Formularios públicos y lo que llega por ellos | **Sí, de desconocidos** |
| `share_links` | Enlaces enviados, con registro de aperturas | **Sí** (IP y navegador) |
| `audit_log` | Quién hizo qué, cuándo y sobre qué (seguridad) | **Sí** |
| `quote_events` | La línea de tiempo de cada cotización (historia del negocio) | **Sí** |
| `quote_notes` | Notas internas del equipo | Posiblemente |
| `categories` / `tags` | Categorías y etiquetas de cotizaciones y catálogo | No |
| `text_snippets` | Textos predefinidos: condiciones, notas, correos | No |
| `numbering_sequences` | El último número usado por organización y año | No |
| `vehicles` | Flota de la organización: capacidad y tarifas *(M20)* | No |
| `rate_configs` | Tarifas de cada modelo de cálculo, por organización | No |
| `cost_profiles` | Respuestas del asistente de costos *(M20)* | No, pero es **información comercial sensible** |

**Toda tabla lleva `tenant_id`.** Con ese nombre exacto, como columna propia y en formato UUID
(identificador universal, nunca un correlativo 1, 2, 3). Sin excepciones.

**Los modelos de cálculo viven en el código**, no en una tabla: son de Cotiza Prime e iguales para
todos. Lo que es de cada organización —tarifas, vehículos, costos— vive en tablas con `tenant_id`.
Cada línea calculada guarda **los datos que se ingresaron, el costo y la versión del modelo**, para
que el cálculo se pueda explicar meses después aunque el modelo o las tarifas hayan cambiado.

**`audit_log` y `quote_events` no son lo mismo.** El primero responde "¿quién hizo algo sensible?"
y sirve a la seguridad y a la ley. El segundo responde "¿en qué quedó esta cotización?" y es lo
que ve el equipo. Algunas acciones quedan en los dos.

**Los pagos se guardan como hitos, no como un campo.** Aunque la v1 solo ofrece 100% o 50/50, cada
pago esperado es una fila propia. Así, si mañana se quiere 30/70 o tres cuotas, es **agregar una
opción en la pantalla, no rehacer la base de datos**. Es una decisión gratis hoy y cara después.

### 11.2 Datos personales — Ley 21.719

**Dos relaciones legales distintas:**

| Datos | Quién responde | Qué implica |
|---|---|---|
| Los de las **cuentas** de quienes usan Cotiza Prime | **Main Brain es responsable** | Política de privacidad propia, derechos del titular, consentimiento registrado |
| Los de los **clientes finales** que carga cada organización | **La organización es responsable; Main Brain es encargado** | Acuerdo de tratamiento dentro de los términos del servicio |

**Los cinco derechos:** para una persona identificada, el sistema debe poder dar acceso a sus
datos, rectificarlos, suprimirlos, exportarlos en formato estándar y registrar su oposición.

**Minimización.** El formulario público pide solo lo necesario para cotizar. El RUT se pide al
emitir la cotización formal, no en el formulario.

**Consentimiento en el formulario público**, con fecha y versión de la política aceptada.

**Cifrado en reposo** de correo, teléfono, RUT, dirección y **datos bancarios**.

**Plazos de conservación** (propuesta, por confirmar):

| Dato | Plazo propuesto |
|---|---|
| Solicitudes nunca convertidas en cotización | 12 meses |
| Aperturas del enlace (IP, navegador) | 12 meses |
| Cotizaciones, pagos y clientes de una organización activa | Mientras la organización esté activa |
| Datos de una organización cancelada | 90 días archivados; después se borran o anonimizan |
| Invitaciones no aceptadas (correo del invitado) | 30 días después de vencer o cancelarse; el correo se vacía al aceptar *(supuesto 7 del sprint 5, por confirmar)* |
| Registro de auditoría | 24 meses |

**Nunca datos reales en el entorno de pruebas.**

---

## 12. Integraciones

| Con qué | Para qué | Nota |
|---|---|---|
| **Supabase** | Base de datos, identidad y archivos (logos, PDF) | Estándar de la base técnica |
| **Correo transaccional** | Invitaciones, avisos internos y los tres correos al cliente | Dominio con SPF, DKIM y DMARC; registro de entrega y rebote |
| **Generación de PDF** | El documento del cliente | En el servidor, nunca en el navegador (§13.6) |
| **Protección anti-robot** | El formulario público | Turnstile o equivalente |
| **Servicio de mapas** | Autocompletar direcciones y calcular km | **M20, logística.** Proveedor por decidir. Cobra por consulta y recibe direcciones: requiere acuerdo de tratamiento |
| **Sentry** | Errores en producción | Estándar de la base |

**Sin pasarela de pago, sin conexión bancaria, sin SII.** Ninguna en la v1 (§3).

---

## 13. Consideraciones técnicas — las trampas

En orden de gravedad.

### 13.1 Aislamiento entre organizaciones — el riesgo número uno

Si una organización ve datos de otra, el producto se muere ese día.

- **RLS activo en toda tabla** (seguridad a nivel de fila: el filtro lo impone la base de datos,
  así funciona aunque el código tenga un error).
- **Una persona pertenece a varias organizaciones**, así que el `tenant_id` **no sale del pase de
  sesión**: sale de la organización activa elegida, y el servidor verifica en cada petición que el
  usuario sea miembro. Esa resolución vive en **un solo archivo**.
- **Una prueba automática dedicada**: un usuario de la organización A intenta, por todos los
  caminos, leer datos de la B. Corre en cada integración.

### 13.2 Fraude por cambio de cuenta bancaria

Un correo con datos de transferencia es el blanco clásico de estafa: alguien entra a una cuenta,
cambia el número de cuenta y desvía los pagos. Controles:

- Solo **Dueño y Administrador** ven y cambian datos bancarios.
- **Cada cambio queda en auditoría** —quién, cuándo, valor anterior y nuevo— y **avisa por correo a
  todos los administradores y al Dueño**.
- **Verificación en dos pasos obligatoria** para Dueños y Administradores, porque son quienes
  controlan hacia dónde va el dinero.
- **Los datos bancarios se congelan en cada cotización**, igual que los precios. Si se cambian
  mañana, un correo de segundo pago de una cotización antigua usa los datos con que se aceptó, y
  se avisa al administrador de la diferencia.
- Los datos bancarios **no se muestran antes de aceptar** la cotización.

### 13.3 El paquete aprobado es el paquete enviado

La aprobación se amarra a una **copia congelada** del paquete. Si algo cambia, la aprobación deja
de valer. Y el servidor rechaza cualquier envío que requiera aprobación y no la tenga, aunque la
petición llegue directo, sin pasar por la pantalla.

### 13.4 Marcar un pago es una acción sensible

Solo Dueño y Administrador. Queda en auditoría. Revertir exige motivo y no borra el registro
original. El comercial nunca marca pagos, ni los suyos.

### 13.5 El formulario público es una puerta abierta a internet

- Límite de tasa por IP y por formulario, más protección anti-robot.
- Validación estricta en el servidor.
- **Nunca expone precios ni tarifas**: el formulario no muestra ningún monto (§9.5).
- Tope de solicitudes por organización.

### 13.6 El enlace del cliente

- Token aleatorio largo e imposible de adivinar, nunca `cotizacion/1`, `/2`, `/3`.
- Caduca con la vigencia; se puede revocar.
- Registra aperturas, que son datos personales.

### 13.7 Precios, dinero y PDF

- **Precios congelados:** la línea copia el precio del catálogo, no apunta a él.
- **Nunca decimales flotantes.** En CLP se trabaja con enteros y un redondeo declarado.
- **Precios guardados netos**, con el IVA calculado aparte.
- **Orden de cálculo fijo:** descuento de línea → subtotal → descuento global → IVA sobre el neto.
- **El 50/50 se calcula una vez y se guarda.** Si el total es impar, el peso sobrante va a un hito
  definido (propuesta: al segundo pago) y la suma de los hitos es siempre igual al total.
- **PDF generado en el servidor**, desde plantillas cerradas con variables. Nadie escribe HTML ni
  código libre. El archivo se guarda para que reenviar entregue el mismo documento.

### 13.8 El texto del correo

El comercial redacta, pero **en texto con formato básico** (negrita, listas, enlaces), nunca HTML
libre. Un correo con HTML libre es una puerta para insertar enlaces falsos o código.

### 13.9 Correo que no llega

Un correo en spam es una venta perdida. Dominio verificado desde el inicio, y **si un correo rebota,
el comercial lo ve en la pantalla** de la cotización.

### 13.10 Numeración

El cliente ve `COT-2026-0043`, correlativo por organización. Es el número visible; el
identificador interno es UUID y nunca aparece en una dirección pública.


### 13.11 Buscar datos que están cifrados

El correo, el teléfono y el RUT van cifrados en la base de datos (§11.2), y **un dato cifrado no se
puede buscar directamente**. Para encontrar un cliente por RUT o correo hace falta guardar, además,
una **huella** del dato (un índice de búsqueda especial) que permite hallar coincidencias exactas
sin descifrar nada. Se decide al diseñar la base de datos, no después.

**Consecuencia práctica:** el RUT y el correo se buscan **completos**. El nombre, que no va
cifrado, sí se busca por partes.

### 13.12 Que la búsqueda siga rápida con miles de cotizaciones

Índices desde el diseño en número, cliente, estado, fecha, comercial y categoría, **siempre
combinados con `tenant_id`**. Objetivo de `STACK.md`: respuesta bajo 500 ms. Se prueba con una
organización ficticia de 50.000 cotizaciones antes de salir a producción.

### 13.13 La línea de tiempo no se edita

`quote_events` solo acepta agregar, nunca modificar ni borrar. Si la historia se pudiera editar,
dejaría de servir como prueba de qué pasó.


### 13.14 El cálculo se hace en el servidor y se puede reproducir

El cálculo corre **siempre en el servidor**, nunca en el navegador: si no, las tarifas quedan a la
vista y cualquiera podría alterar el resultado. Se guardan los datos ingresados y la versión del
modelo, así que la misma cotización da siempre el mismo número. Cada modelo se prueba contra una
**tabla de casos conocidos** (tal distancia y tal peso deben dar tal precio) antes de publicarse.

### 13.15 El servicio de mapas puede fallar, cobrar o equivocarse (M20)

- **Si no responde, se ingresan los km a mano** y se sigue trabajando. La cotización no depende de él.
- **Los km siempre se pueden corregir**, y la corrección queda en la línea de tiempo.
- **Los km usados se congelan** en la cotización, como los precios.
- **Cobra por consulta:** se calcula solo cuando cambia el origen o el destino, no con cada tecla,
  y el formulario público tiene límite de consultas para que nadie lo use gratis a nuestra costa.
- **La clave del servicio es un secreto**: vive en variables de entorno y nunca llega al navegador
  sin restricciones.

### 13.16 Los costos de la organización son información sensible

El asistente de costos guarda cuánto gana y cuánto gasta una empresa. No son datos personales, pero
si se filtran a la competencia el daño es real. Solo el Dueño y el Administrador los ven, y quedan
bajo el mismo aislamiento que todo lo demás.

---

# Parte IV — Mapa de funcionalidades

## 14. Los módulos

Todo lo que Cotiza Prime hace, agrupado en módulos. Cada módulo tiene un código que se usa en las
historias de usuario, en los sprints y en la hoja de ruta.

### 14.1 Módulos del lanzamiento

| Código | Módulo | Incluye | Detalle |
|---|---|---|---|
| **M01** | Cuentas y organizaciones | Registro, verificación de correo, verificación en dos pasos, varias organizaciones por cuenta, selector | §6.1 |
| **M02** | Miembros y roles | Invitaciones que caducan, cinco roles, matriz de permisos, límite de servicios por comercial | §5, §6.2 |
| **M03** | Identidad de la organización | Nombre, RUT, rubro, contacto, logo y colores | §6.1 |
| **M04** | Catálogo | Servicios y productos con precio, unidad, IVA o exento; categorías; activar y desactivar; campos bloqueados | §4, §8.4 |
| **M05** | Clientes | Base con RUT validado; ficha con historial y resumen de cotizado, aceptado, pagado y por cobrar | §8.7 |
| **M06** | Cotizador | Ítems, orden de cálculo, descuentos, IVA, precios congelados, vigencia, numeración configurable, versiones | §6.3, §6.8, §8.1, §13.7 |
| **M07** | PDF y plantillas | Generación en el servidor, tres plantillas, vista previa | §6.3, §13.7 |
| **M08** | Correos y paquete de envío | Texto del correo con formato básico, textos predefinidos, condiciones y exclusiones, los tres correos al cliente, rebotes, reenviar | §6.3, §6.5, §13.8, §13.9 |
| **M09** | Aprobaciones | Reglas (siempre, monto, descuento, margen, nunca), paquete congelado, aprobar / pedir cambios / rechazar, envío automático | §5.3, §6.4, §13.3 |
| **M10** | Enlace del cliente | Ver, descargar PDF, aceptar o rechazar, motivo de rechazo, registro de aperturas, caducidad y revocación | §6.5, §8.11, §13.6 |
| **M11** | Cobro por transferencia | Datos bancarios con controles antifraude, condición 100% o 50/50, hitos de pago, correo de datos de transferencia, confirmación manual, segundo pago | §6.6, §13.2, §13.4 |
| **M12** | Seguimiento | Estados, línea de tiempo, notas internas, inicio "Lo que requiere mi atención", resumen por estado, avisos y alertas internas | §7, §8.5, §8.6, §8.8, §8.9 |
| **M13** | Orden y búsqueda | Búsqueda con `Ctrl + K`, filtros y orden, categorías y etiquetas, archivar, exportar a Excel | §8.2–§8.4, §8.12, §8.13 |
| **M14** | Productividad | Duplicar, extender vigencia, guardado automático, compartir por WhatsApp | §8.10, §10 |
| **M15** | Formulario público | Campos y servicios configurables, consentimiento, protección anti-robot, límites, previsualización en vivo de lo solicitado (sin precios), enlace público y código incrustable, código QR, asignación de solicitudes | §6.7, §10, §13.5 |
| **M16** | Modelos de cálculo generales | Por unidad, servicio por tiempo, productos; costo, margen y semáforo | §9.1, §9.2, §9.4, §9.5 |
| **M17** | Onboarding | Doce pasos guiados, lista de avance, cotización de prueba | §6.1 |
| **M18** | Cumplimiento | Registro de auditoría, los cinco derechos del titular, retención y borrado automático, consentimiento, política de privacidad y términos | §11.2, §13 |
| **M19** | Plataforma | Dos entornos, franja `PRUEBAS`, errores en Sentry, respaldos con restauración probada, tope de uso | §13, `STACK.md` |

### 14.2 Módulos posteriores

| Código | Módulo | Incluye | Detalle |
|---|---|---|---|
| **M20** | Logística detallada | Estudio de costeo, flota, peso volumétrico, tramos, retorno vacío, peajes manuales, asistente de costos logísticos, distancia automática, datos del servicio en el PDF, reajuste por combustible | §9.3 |
| **M21** | Comprobante de pago | El cliente sube el comprobante en su enlace y el administrador lo revisa antes de marcar pagado | §6.6 |
| **M22** | Productividad avanzada | Importar clientes y catálogo desde Excel, paquetes de ítems frecuentes, vistas guardadas, tablero por estado, historial de precios del catálogo | §8 |
| **M23** | Experiencia del cliente | Ítems opcionales, alternativas A/B/C, precios especiales por cliente, preguntas desde el enlace, fotos en el formulario, adjuntos | §10 |
| **M24** | Plantillas y pagos avanzados | Más plantillas y editor visual, otros esquemas de pago (30/70, cuotas), modelo de proyectos por partidas | §9.6, §11.1 |
| **M25** | Métricas | Conversión, ranking de vendedores, monto por cobrar, motivos de rechazo, servicios más cotizados, ventas por categoría, tiempo de respuesta | §8 |
| **M26** | Automatizaciones y ampliaciones | Recordatorios automáticos al cliente, cotización en UF, base de clientes externa, peajes automáticos, cotizaciones recurrentes | §10 |
| **M27** | Nuevos canales | Aplicación móvil, API pública, firma electrónica avanzada | §3 |
| **M28** | Condicionales | Confirmación bancaria automática, editor de fórmulas libre, otros rubros especializados. Solo con demanda real y costos revisados | §9.6 |

---

# Parte V — Hoja de ruta

## 15. Qué se construye primero, qué sigue y por qué

### 15.1 Cómo se decidió el orden

Con los criterios de `PROCESO.md`, en este orden de importancia:

1. **El recorrido más delgado que funcione de punta a punta**, antes que el módulo más completo.
2. **Dependencias:** lo que otras piezas necesitan va antes.
3. **Riesgo:** lo que puede salir mal se construye temprano, cuando corregir es barato.
4. **Comodidad al final:** lo que mejora la experiencia pero no bloquea nada.

**Lanzamiento (versión 1.0) = fases 0 a 7.** Cuando este documento dice "la v1", se refiere a eso.

### 15.2 Reglas que se cumplen desde el primer día, en todas las fases

No son una fase: son condiciones de cualquier cosa que se construya.

- `tenant_id` en toda tabla y **RLS** activo (§13.1)
- Direcciones de API con `/api/v1/`
- **Cifrado** de datos personales y bancarios
- **Registro de auditoría** de acciones sensibles
- **Línea de tiempo**: los eventos se registran desde la primera cotización, aunque su pantalla llegue en la fase 5
- **Precios congelados** y **pagos guardados como hitos**
- **Índices** desde el diseño
- **Dos entornos** y nunca datos reales en pruebas

### 15.3 Las fases hasta el lanzamiento

| Fase | Nombre | Módulos | Qué se puede mostrar al cerrar | Por qué va aquí |
|---|---|---|---|---|
| **0** | **Preparación** | Decisiones que bloquean (§16.2), `DISENO.md` y diseño de las tres plantillas, infraestructura (repositorio, dos Supabase, Vercel, dominio de correo con SPF, DKIM y DMARC, Sentry), diseño del modelo de datos y de RLS, borradores legales al abogado. **En paralelo: parte el estudio de costeo logístico** | Documentos, diseño y cuentas listas | Todo lo demás depende de esto. El estudio logístico y la revisión del abogado tardan: conviene partirlos al principio |
| **1** | **Cimientos** | M01, M02, M03, M19, auditoría base | Dos organizaciones separadas, un miembro invitado con su rol, y la prueba automática de aislamiento en verde | El aislamiento entre organizaciones es el riesgo número uno; todo se construye encima |
| **2** | **Primera cotización de punta a punta** | M04 (básico), M05 (básico), M06, M07 con una plantilla, M08 (correo 1), M10 | Un comercial arma una cotización, la envía y el cliente la acepta desde su enlace | Valida lo más riesgoso del producto: PDF, entrega del correo y enlace público |
| **2b** | **Formulario público** *(adelantada el 2026-10-06)* | M15 | Un desconocido pide una cotización por enlace, QR o formulario incrustado en una web, ve en vivo lo que pide (sin precios), y el comercial la convierte en cotización | Es el paso 1 del recorrido (§6.0). Se construye tras el primer recorrido de punta a punta, con la protección de superficie pública (§13.5) |
| **3** | **Control** | M09, campos bloqueados, avisos internos | Juan pide aprobación, Aarón la revisa y el correo sale solo | Es la pieza que diferencia el producto y depende del envío de la fase 2 |
| **4** | **Cobro** | M11, verificación en dos pasos obligatoria para Dueño y Administrador | El ciclo completo hasta **Pagada**, en 100% y en 50/50 | Cierra el valor completo: cotizar, aprobar, enviar, aceptar, cobrar |
| ⭐ | **Hito: piloto privado** | — | Una a tres empresas reales usando la plataforma, sin registro abierto al público | Aprender con uso real antes de pulir. **Requisito:** política de privacidad, acuerdo de tratamiento, cifrado, auditoría, plazos de conservación y responsable de incidentes ya definidos |
| **5** | **Seguimiento y orden** | M12, M13, M14, M05 (ficha completa), plantillas 2 y 3 | "¿En qué quedó esa cotización?" se responde en segundos | Tiene sentido cuando ya hay cotizaciones reales; los datos se vienen registrando desde la fase 2 |
| **6** | **Cálculo** | M16 | El comercial ingresa horas o km y el sistema propone los ítems con su precio | Los modelos de cálculo se construyen cuando la base ya está firme |
| **7** | **Autoservicio y lanzamiento** | M17, M18 completo, tope de uso, revisión del abogado, listas de salida a producción de `SEGURIDAD.md` y `LEGAL.md`, prueba con 50.000 cotizaciones | **Lanzamiento público** | El onboarding configura todo lo anterior, así que solo se puede construir al final. Nada sale al público sin las listas de verificación |

**Al lanzar, se puede mostrar esto de punta a punta:** una empresa se registra y el onboarding la deja
lista con su logo, precios y cuenta bancaria. Invita a un vendedor. El vendedor arma una cotización
50/50 con su correo y pide aprobación; el jefe la aprueba y sale sola. El cliente acepta y recibe los
datos para el anticipo. El administrador marca el anticipo como pagado, el vendedor pide el saldo y
la cotización termina en **Pagada**. En paralelo, un desconocido llena el formulario público y su
solicitud se convierte en cotización.

### 15.4 Después del lanzamiento

| Orden | Módulo | Por qué en este lugar |
|---|---|---|
| **2.1** | **M20 — Logística detallada** | Prioridad definida por el usuario. El estudio de costeo ya estará hecho desde la fase 0 |
| **2.2** | M21 — Comprobante de pago | Decidido: después de la confirmación manual |
| **2.3** | M22 — Productividad avanzada | Mejora el uso diario una vez que hay clientes trabajando |
| **2.4** | M23 — Experiencia del cliente | Sube la conversión: el cliente elige y pregunta sin salir del enlace |
| **2.5** | M24 — Plantillas y pagos avanzados | La base de datos ya queda preparada para otros esquemas de pago |
| **3** | M25 — Métricas · M26 — Automatizaciones | Necesitan volumen de datos para ser útiles |
| **4** | M27 — Nuevos canales | Grandes y opcionales |
| **Si se justifica** | M28 — Condicionales | Solo con demanda real y costos revisados |

Las historias de usuario (Fase 2 de `PROCESO.md`) y los sprints (Fase 3) se arman siguiendo este
orden, fase por fase.

---

# Parte VI — Decisiones y cumplimiento

## 16. Decisiones

### 16.1 Tomadas

Las marcadas con 📄 tienen su ficha en `docs/decisiones/`.

| Qué | Decisión | Fecha |
|---|---|---|
| 📄 País | Solo Chile | 2026-09-28 |
| 📄 Modelo de cuentas | SaaS de autoservicio | 2026-09-28 |
| 📄 Cálculo | Modelos cerrados por rubro, no editor de fórmulas libre. En la v1: por unidad, servicio por tiempo y productos | 2026-09-30 |
| 📄 Logística | Primer rubro especializado: **primera prioridad después del lanzamiento**, precedido de un estudio de costeo formal | 2026-09-30 |
| 📄 Numeración | La organización elige: anual o corrida, con prefijo y número de partida propios | 2026-09-30 |
| Onboarding | Recorrido guiado al crear la organización, que deja configurada casi toda la plataforma | 2026-09-30 |
| Plantillas de PDF en la v1 | Tres | 2026-09-30 |
| 📄 Visibilidad | Todos ven todo dentro de su organización; cada comercial edita solo las suyas | 2026-09-30 |
| 📄 Qué se aprueba | El **paquete completo**: correo, PDF y condición de pago | 2026-09-30 |
| Al aprobar | El correo al cliente sale **automáticamente** | 2026-09-30 |
| 📄 Pasarela de pago | **No.** Se cobra por transferencia; Cotiza Prime no toca el dinero | 2026-09-30 |
| Condiciones de pago v1 | 100% al aceptar, o 50% al aceptar y 50% al final | 2026-09-30 |
| Al aceptar | Cambia el estado, se avisa al autor y sale el correo con datos de transferencia | 2026-09-30 |
| Segundo pago | Se solicita con un botón, manual, cuando el trato lo indique | 2026-09-30 |
| 📄 Confirmación de pago v1 | **Manual**, solo Administrador o Dueño | 2026-09-30 |
| Comprobante de pago | Después de la confirmación manual (M21) | 2026-09-30 |
| Conexión bancaria | Solo si más adelante se necesita | 2026-09-30 |
| Datos bancarios | Solo Administrador o Dueño los cambian; todo cambio queda registrado | 2026-09-30 |
| Encontrar y seguir | Numeración, búsqueda, categorías, etiquetas, línea de tiempo, inicio con pendientes y alertas internas entran en la v1 | 2026-09-30 |
| 📄 Borrado | Lo enviado se archiva, nunca se borra; solo se eliminan borradores nunca enviados | 2026-09-30 |
| 📄 Pagos como hitos | Cada pago esperado es una fila propia, aunque la v1 solo ofrezca 100% y 50/50 | 2026-09-30 |
| 📄 Orden de construcción | Ocho fases hasta el lanzamiento, con piloto privado tras la fase 4 (§15) | 2026-09-30 |
| 📄 Forma de desarrollo | Subagentes: Sonnet construye, Opus planifica lo delicado y revisa; paralelo en copias aisladas; aprobación por sprint; base de datos local para partir | 2026-10-01 |
| Dirección visual | Moderno y minimalista, Liquid Glass estilo iOS, animaciones con medida, escritorio a todo el ancho y móvil propio (`DISENO.md`) | 2026-10-01 |

### 16.2 Pendientes

Cada una indica **antes de qué fase** tiene que estar resuelta.

| # | Qué falta decidir | Supuesto actual | Se necesita antes de |
|---|---|---|---|
| 1 | **Dominio y marca** (¿`cotizaprime.cl`? ¿bajo Main Brain o marca propia?) | — | Fase 0 |
| 2 | **Quién diseña las tres plantillas de PDF** | — | Fase 0 |
| 3 | **`DISENO.md`**: identidad visual de Cotiza Prime, incluida la frase de promesa y el tono | Esqueleto | Fase 0 |
| 4 | **Quién hace el estudio de costeo logístico** y con qué empresas se valida | — | Fase 0 (corre en paralelo) |
| 5 | **Canal de los avisos internos**: dentro de la app, por correo, o ambos | Ambos | Fase 3 |
| 6 | **¿Más de una cuenta bancaria** por organización, a elegir por cotización? | Una sola | Fase 4 |
| 7 | **Plazos de conservación** de §11.2 | Los propuestos | Piloto privado |
| 8 | ✅ **Quién responde un incidente de seguridad**, y en qué horario (`SEGURIDAD.md` §10) | **Resuelta por Aarón el 2026-11-12:** Aarón (Main Brain), en días hábiles de 9 a 19 h; fuera de ese horario, al siguiente día hábil. También verifica la identidad antes de quitar un segundo factor (`docs/decisiones/021-limite-de-intentos-del-segundo-paso.md`) | Piloto privado |
| 9 | **Revisión de abogado**: términos, privacidad y acuerdo de tratamiento | — | Piloto privado, y de nuevo antes del lanzamiento |
| 10 | **¿El comercial ve los costos** o solo el semáforo de margen? | Solo el semáforo; el administrador puede cambiarlo | Fase 6 |
| 11 | **Categorías de ejemplo por rubro** en el onboarding | Se ofrecen y se pueden borrar | Fase 7 |
| 12 | **Modo de cobro de Cotiza Prime** (planes, precios) | Sin cobro hasta decidirlo | Fase 7. Puede exigir una migración: mientras antes, mejor |
| 13 | **Tope de uso mínimo** para el registro abierto | — | Fase 7 |
| 14 | **Proveedor de mapas** para la distancia automática | — | M20 |
| 15 | **Quién puede enviar directo**: ¿se define por rol, por persona o por regla de la organización? (§5.3 es por organización). Enviar siempre es desde la plataforma, en un clic: nunca descargar el PDF ni armar el correo a mano | Por organización, con excepción por persona | Fase 3 |
| 16 | **Orden de construcción:** el formulario público (paso 1 del recorrido) hoy va en la fase 6 | Sin cambio hasta que Aarón decida adelantarlo | Antes de armar el sprint 4 |
| 17 | **Cómo se programa en producción la tarea de avisos al Dueño por invitaciones** (H-008, `docs/arquitectura/sprint-5-equipo-y-permisos.md`). Probablemente exige una ruta HTTP protegida con secreto que hoy no existe a propósito; no depende de la decisión 016 (proveedor de correo) | ✅ **Decidida por Aarón el 2026-11-12:** una ruta HTTP protegida con un secreto, llamada por el programador de tareas del hosting de producción. Falta construirla; mientras tanto el aviso al Dueño es de mejor esfuerzo (solo el intento inmediato) | Piloto privado |

---

## 17. Cumplimiento de la base técnica

| Exigencia de `STACK.md` §5b | En este plan |
|---|---|
| `tenant_id` en toda tabla, con ese nombre exacto | ✅ §11.1 |
| En formato UUID, nunca correlativo | ✅ §11.1 y §13.10 |
| Como columna propia, indexable | ✅ §11.1 |
| Direcciones de API con `/api/v1/` | ✅ Se adopta |
| Validación del pase de sesión en un solo archivo | ✅ §13.1 |
| Resolución de la organización en un solo punto | ✅ §13.1 — crítico, porque una persona pertenece a varias |
| Dos entornos desde el día uno y franja de `PRUEBAS` | ✅ Se adopta |

**Ninguna regla de la base se relaja.** Este proyecto es **más exigente** en cuatro puntos: la
prueba automática de aislamiento (§13.1), los controles antifraude de datos bancarios (§13.2), el
paquete congelado para la aprobación (§13.3) y el formulario público tratado como superficie
hostil (§13.5).

---

> ### ✅ COMPUERTA 1 — cruzada
> Plan aprobado por escrito por Aarón el 2026-09-30.
