---
document_id: CP-HISTORIAS
title: Cotiza Prime — Historias de usuario
version: 1.1
status: APROBADO — Compuerta 2 cruzada el 2026-09-30 · v1.1: ajuste de dependencias de H-020 y H-022 al armar los sprints
basado_en: PROYECTO.md v1.0
pais: Chile
last_updated: 2026-09-30
language: es-CL
---

# Cotiza Prime — Historias de usuario

> **Estado: aprobado** por Aarón el 2026-09-30 (Compuerta 2 de `PROCESO.md`). Si aparece algo no
> previsto durante el desarrollo, se agrega como historia nueva y se aprueba.

## Cómo leer este documento

- Las historias están **ordenadas por fase de la hoja de ruta** (`PROYECTO.md` §15), para que armar
  los sprints sea directo. Al final hay un **índice por prioridad**.
- Cada historia indica su **módulo** (M01…M19, `PROYECTO.md` §14) junto al título.
- Los números dejan huecos entre fases (H-001, H-020, H-040…) para poder agregar historias sin
  renumerar.
- **Tamaño:** *chico* = medio día o menos · *mediano* = alrededor de un día · *grande* = hasta dos
  días. Nada pasa de dos días; lo que pasaba, se partió.
- **Datos personales: sí** activa los controles de `LEGAL.md`: cifrado, minimización, auditoría y
  plazos de conservación.
- **Roles:** *Visitante* (sin cuenta), *Usuario* (con cuenta), *Dueño*, *Administrador*,
  *Aprobador*, *Comercial*, *Observador*, *Miembro* (cualquiera de los cinco) y *Cliente final*
  (recibe la cotización, sin cuenta).
- **Chile:** RUT con dígito verificador, IVA 19%, pesos sin decimales (`$1.250.000`), fechas
  `dd-mm-aaaa`.

## Lo que no son historias

Hay trabajo necesario que no se cuenta desde un usuario. Va aquí para que no se pierda:

**Fase 0 — Preparación**
- [ ] Resolver las decisiones pendientes 1 a 4 de `PROYECTO.md` §16.2 (dominio, diseño de plantillas, `DISENO.md`, estudio logístico)
- [ ] Completar `DISENO.md` y diseñar las tres plantillas de PDF
- [ ] Repositorio en GitHub, dos proyectos de Supabase (pruebas y producción), Vercel, Sentry
- [ ] Dominio de correo con SPF, DKIM y DMARC verificados
- [ ] Diseño del modelo de datos y de las reglas RLS, revisado antes de construir
- [ ] Borradores de términos, política de privacidad y acuerdo de tratamiento enviados al abogado
- [ ] Inicio del estudio de costeo logístico (en paralelo)

**Antes del piloto privado**
- [ ] Decisiones pendientes 7, 8 y 9 resueltas (plazos de conservación, responsable de incidentes, revisión del abogado)
- [ ] Respaldo restaurado al menos una vez, con el tiempo anotado

**Antes del lanzamiento público**
- [ ] Listas de verificación de `SEGURIDAD.md` §11 y `LEGAL.md` §6 completas
- [ ] Prueba de rendimiento con una organización ficticia de 50.000 cotizaciones
- [ ] Decisiones pendientes 12 y 13 resueltas (modo de cobro y tope de uso)

**Módulos posteriores (M20 a M28):** sus historias se escriben cuando les toque, antes de su sprint.

---

# Fase 1 — Cimientos

### H-001 · Registrarme con mi correo · M01

**Como** visitante
**quiero** crear una cuenta con mi correo y una contraseña
**para** empezar a usar Cotiza Prime.

**Criterios de aceptación**
- [ ] Puedo registrarme con nombre, correo y contraseña
- [ ] Antes de registrarme veo y acepto los términos y la política de privacidad
- [ ] Me llega un correo para verificar mi dirección, y el enlace caduca
- [ ] Mientras no verifique mi correo no puedo crear una organización
- [ ] Si el correo ya existe, se me ofrece iniciar sesión o recuperar la contraseña, sin revelar si la cuenta existe
- [ ] La contraseña exige un largo mínimo y se me dice cuál es

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-110 (versión preliminar de los textos)
**Datos personales:** sí — nombre y correo
**Notas técnicas:** Supabase Auth. Se guarda la versión de la política aceptada y la fecha. La validación del pase de sesión vive en un solo archivo (`STACK.md` §5b)

---

### H-002 · Iniciar y cerrar sesión · M01

**Como** usuario
**quiero** entrar y salir de mi cuenta de forma segura
**para** que nadie más use mi sesión.

**Criterios de aceptación**
- [ ] Entro con correo y contraseña
- [ ] Tras varios intentos fallidos seguidos, se bloquean los intentos por un tiempo y se me avisa
- [ ] Al cerrar sesión, la sesión queda invalidada: si vuelvo atrás en el navegador, no veo datos
- [ ] Si mi sesión expira, se me pide entrar de nuevo sin perder lo que estaba escribiendo en un borrador

**Prioridad:** núcleo
**Tamaño:** chico
**Depende de:** H-001
**Datos personales:** sí — registro de ingresos
**Notas técnicas:** pases de vida corta que se renuevan solos; cookies `HttpOnly`, `Secure`, `SameSite`

---

### H-003 · Recuperar mi contraseña · M01

**Como** usuario
**quiero** restablecer mi contraseña si la olvido
**para** no perder el acceso a mi cuenta.

**Criterios de aceptación**
- [ ] Pido el restablecimiento con mi correo y recibo un enlace que caduca
- [ ] El mensaje en pantalla es el mismo exista o no la cuenta
- [ ] Al cambiar la contraseña se cierran mis otras sesiones abiertas
- [ ] Me llega un aviso de que mi contraseña cambió

**Prioridad:** núcleo
**Tamaño:** chico
**Depende de:** H-001
**Datos personales:** sí — correo

---

### H-004a · Activar la verificación en dos pasos · M01

**Como** Dueño o Administrador
**quiero** proteger mi cuenta con un segundo paso al ingresar
**para** que nadie cambie la cuenta bancaria ni configure mi empresa con solo robar mi contraseña.

**Criterios de aceptación**
- [ ] Activo la verificación con una aplicación de códigos, escaneando un código QR
- [ ] Al ingresar, después de la contraseña, se me pide el código de la aplicación
- [ ] Cualquier otro miembro puede activarla de forma voluntaria

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-002
**Datos personales:** no
**Notas técnicas:** H-004 se partió en tres (2026-11-02, según el diseño del sprint 5, `docs/arquitectura/sprint-5-equipo-y-permisos.md` §5b y §7). Esta es la primera: activar y pedir el código al ingresar.

---

### H-004b · Códigos de respaldo y desactivar la verificación · M01

**Como** Dueño o Administrador
**quiero** tener códigos de respaldo y poder desactivar la verificación de forma segura
**para** no quedar fuera de mi cuenta si pierdo el teléfono, sin que otra persona pueda apagarla.

**Criterios de aceptación**
- [ ] Recibo códigos de respaldo para guardar, y se me pide confirmar que los guardé
- [ ] Puedo entrar con un código de respaldo, que sirve una sola vez
- [ ] Desactivarla exige ingresar un código válido

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-004a
**Datos personales:** no

---

### H-004c · Dos pasos obligatorios para Dueño y Administrador · M01

**Como** Dueño de una organización
**quiero** que quien controla el dinero y la configuración tenga activada la verificación en dos pasos
**para** que la cuenta bancaria y las reglas no dependan solo de una contraseña.

**Criterios de aceptación**
- [ ] Si soy Dueño o Administrador, no puedo usar las funciones de mi rol hasta activarla
- [ ] Mientras no la active, entro como Observador (veo todo, no cambio nada) y se me explica cómo activarla
- [ ] Si la desactivo, vuelvo a quedar como Observador hasta activarla de nuevo

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-004a, H-004b, H-011
**Datos personales:** no
**Notas técnicas:** 🔒 cambia el pase de sesión de las cuentas de prueba en todas las pruebas, por eso va sola y al final del sprint 5. Requisito heredado de H-092 m11: `active.role` debe ser el rol efectivo, o la aplicación y la base discrepan (el editor del formulario ya tolera el `42501` del tope). Los supuestos 1 a 3 del diseño (queda como Observador; también obligatoria en pruebas; puede desactivarla) están en `sprint-5-equipo-y-permisos.md` §8.

---

### H-005 · Crear mi organización · M01, M03

**Como** usuario con correo verificado
**quiero** crear la organización de mi empresa
**para** tener mi propio espacio de cotizaciones, separado de cualquier otro.

**Criterios de aceptación**
- [ ] Ingreso nombre, RUT de la empresa, rubro y datos de contacto
- [ ] El RUT se valida con su dígito verificador y se muestra con formato (`76.123.456-7`)
- [ ] Al crearla quedo como **Dueño**, y es el único Dueño
- [ ] Llego al inicio de mi organización, vacío y con un mensaje que me dice cómo empezar
- [ ] Puedo crear más de una organización con la misma cuenta

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-001
**Datos personales:** no — son datos de la empresa
**Notas técnicas:** toda tabla lleva `tenant_id` UUID desde esta historia

---

### H-006 · Cambiar entre mis organizaciones · M01

**Como** usuario que pertenece a varias organizaciones
**quiero** pasar de una a otra con un selector
**para** manejar cada negocio por separado sin cerrar sesión.

**Criterios de aceptación**
- [ ] Arriba veo en qué organización estoy, con su nombre y logo
- [ ] El selector muestra solo las organizaciones a las que pertenezco, con mi rol en cada una
- [ ] Al cambiar, todo lo que veo pasa a ser de la organización elegida
- [ ] Si me quitan de una organización, desaparece del selector y no puedo volver a entrar a ella

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-005
**Datos personales:** no
**Notas técnicas:** la resolución de la organización activa vive en **un solo punto**, y el servidor verifica la membresía en cada petición (`PROYECTO.md` §13.1)

---

### H-007 · Cargar el logo y los colores de mi empresa · M03

**Como** Administrador
**quiero** subir el logo y elegir los colores de mi empresa
**para** que todo lo que reciban mis clientes lleve mi marca.

**Criterios de aceptación**
- [ ] Subo un logo en PNG, JPG o SVG, con un tamaño máximo que se me indica
- [ ] Si el archivo no es una imagen válida o pesa demasiado, se me dice por qué
- [ ] Elijo un color principal y uno secundario, y veo una muestra al instante
- [ ] Si el color elegido no se lee bien sobre blanco, se me advierte
- [ ] Puedo editar nombre, RUT y datos de contacto de la organización

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-005
**Datos personales:** no
**Notas técnicas:** validar el tipo real del archivo, no solo la extensión; limpiar SVG de código

---

### H-008 · Invitar a un miembro con su rol · M02

**Como** Administrador
**quiero** invitar a una persona por correo y asignarle un rol
**para** que mi equipo trabaje en la organización con los permisos que yo decido.

**Criterios de aceptación**
- [ ] Ingreso el correo y elijo el rol: Administrador, Aprobador, Comercial u Observador
- [ ] Veo en una frase qué puede hacer cada rol antes de elegirlo
- [ ] La invitación queda en una lista como "pendiente", y puedo reenviarla o cancelarla
- [ ] El enlace de invitación caduca en un plazo que se indica
- [ ] Queda registrado quién invitó a quién y cuándo

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-005
**Datos personales:** sí — correo del invitado

---

### H-009 · Aceptar una invitación · M02

**Como** persona invitada
**quiero** unirme a la organización desde el correo que recibí
**para** empezar a trabajar con mi equipo.

**Criterios de aceptación**
- [ ] Si ya tengo cuenta, al aceptar la organización se suma a mi selector
- [ ] Si no tengo cuenta, me registro y quedo unido al terminar
- [ ] Si el enlace caducó o fue cancelado, se me dice con claridad y a quién pedir otro
- [ ] Solo puede aceptarse con el mismo correo al que se envió

**Prioridad:** núcleo
**Tamaño:** chico
**Depende de:** H-008, H-001
**Datos personales:** sí — correo

---

### H-010 · Cambiar el rol de un miembro o quitarlo · M02

**Como** Administrador
**quiero** cambiar el rol de alguien o sacarlo de la organización
**para** que los accesos reflejen quién trabaja hoy conmigo.

**Criterios de aceptación**
- [ ] Veo la lista de miembros con su rol y la fecha en que entraron
- [ ] Puedo cambiar el rol, y el cambio aplica de inmediato
- [ ] Al quitar a alguien, pierde el acceso al instante, aunque tenga la sesión abierta
- [ ] Nadie puede quitar ni cambiar el rol del Dueño
- [ ] Las cotizaciones de quien se fue siguen existiendo y muestran su nombre como autor

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-008
**Datos personales:** sí
**Notas técnicas:** cada cambio va al registro de auditoría

---

### H-011 · Que cada rol haga solo lo que le corresponde · M02

**Como** Dueño
**quiero** que cada miembro pueda hacer solo lo que su rol permite
**para** tener control real sobre mi empresa.

**Criterios de aceptación**
- [ ] Cada rol ve solo los menús y botones de lo que puede hacer (matriz de `PROYECTO.md` §5.2)
- [ ] Si alguien entra por dirección directa a una pantalla que no le corresponde, ve "No tienes permiso para esto" y no ve datos
- [ ] Un Comercial puede ver las cotizaciones de sus compañeros, pero no editarlas
- [ ] Un Observador puede ver todo y no puede cambiar nada

**Prioridad:** núcleo
**Tamaño:** grande
**Depende de:** H-008
**Datos personales:** no
**Notas técnicas:** el permiso se verifica en el servidor en cada petición; ocultar el botón no basta. Pruebas automáticas por rol. Aplica la matriz a **todas las pantallas construidas antes** (catálogo, clientes, cotizaciones), que hasta entonces solo usaba el Dueño

---

### H-012 · Que ninguna otra organización vea mis datos · M01, M19

**Como** Dueño de Negocio 1
**quiero** la certeza de que nadie de otra organización puede ver ni tocar mis datos
**para** confiar mi información comercial a la plataforma.

**Criterios de aceptación**
- [ ] Un miembro de otra organización que intenta abrir una dirección de la mía ve "No encontrado"
- [ ] Mis búsquedas, listas y exportaciones nunca muestran datos de otra organización
- [ ] Una persona que está en mis dos organizaciones nunca ve datos de una mientras trabaja en la otra
- [ ] Existe una prueba automática de aislamiento que corre en cada integración y está en verde

**Prioridad:** núcleo
**Tamaño:** grande
**Depende de:** H-006
**Datos personales:** no
**Notas técnicas:** RLS en toda tabla. La prueba intenta leer por todos los caminos (pantallas, API, búsqueda, archivos). Es el riesgo número uno del producto

---

### H-013 · Saber cuándo estoy en el entorno de pruebas · M19

**Como** miembro del equipo de Cotiza Prime
**quiero** ver una franja visible cuando la aplicación corre contra el entorno de pruebas
**para** no confundir datos ficticios con reales.

**Criterios de aceptación**
- [ ] En pruebas aparece arriba una franja con el texto `PRUEBAS` en todas las pantallas
- [ ] En producción la franja no aparece
- [ ] La franja también aparece en el enlace del cliente y en el formulario público de pruebas

**Prioridad:** núcleo
**Tamaño:** chico
**Depende de:** —
**Datos personales:** no

---

### H-014 · Ver el registro de actividad sensible · M18

**Como** Dueño
**quiero** ver quién hizo cada acción sensible en mi organización
**para** saber qué pasó si algo sale mal.

**Criterios de aceptación**
- [ ] Veo una lista con fecha y hora, quién lo hizo, qué hizo y sobre qué
- [ ] Aparecen como mínimo: ingresos de miembros, cambios de rol, invitaciones, cambios de configuración y (cuando existan) aprobaciones, datos bancarios y pagos
- [ ] Puedo filtrar por persona y por tipo de acción
- [ ] Nadie puede editar ni borrar el registro, tampoco yo

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-005
**Datos personales:** sí — quién hizo qué, y desde dónde
**Notas técnicas:** campos de `SEGURIDAD.md` §9. Las historias siguientes agregan sus acciones a este registro

---

# Fase 2 — Primera cotización de punta a punta

### H-020 · Cargar servicios en el catálogo · M04

**Como** Administrador
**quiero** registrar mis servicios y productos con su precio
**para** que el equipo cotice con precios correctos sin escribirlos cada vez.

**Criterios de aceptación**
- [ ] Ingreso nombre, descripción, unidad (servicio, hora, km, m², día, unidad), precio neto y si lleva IVA o es exento
- [ ] Los precios se muestran en pesos con punto de miles y sin decimales
- [ ] Veo el catálogo como lista, con buscador por nombre
- [ ] Si la lista está vacía, se me explica qué es el catálogo y cómo agregar el primero

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-005
**Datos personales:** no
**Notas técnicas:** montos en enteros, nunca decimales flotantes

---

### H-021 · Editar o desactivar un servicio · M04

**Como** Administrador
**quiero** cambiar el precio de un servicio o dejar de ofrecerlo
**para** mantener el catálogo al día sin romper lo que ya envié.

**Criterios de aceptación**
- [ ] Puedo editar cualquier campo del servicio
- [ ] Un cambio de precio **no altera** las cotizaciones ya creadas: esas conservan su precio
- [ ] Puedo desactivar un servicio: deja de aparecer al cotizar pero no se borra
- [ ] Puedo reactivarlo

**Prioridad:** núcleo
**Tamaño:** chico
**Depende de:** H-020
**Datos personales:** no

---

### H-022 · Registrar un cliente · M05

**Como** Comercial
**quiero** guardar los datos de un cliente
**para** cotizarle sin volver a escribirlos.

**Criterios de aceptación**
- [ ] Indico si es persona o empresa, e ingreso nombre o razón social, correo, teléfono, dirección y RUT
- [ ] El RUT es opcional al registrar, se valida con su dígito verificador y se muestra con formato
- [ ] El correo se valida antes de guardar
- [ ] Si ya existe un cliente con el mismo RUT o correo en mi organización, se me avisa y se me ofrece abrirlo

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-005
**Datos personales:** sí — nombre, correo, teléfono, dirección, RUT
**Notas técnicas:** correo, teléfono, RUT y dirección cifrados en reposo. Para detectar duplicados por RUT o correo se usa una "huella" buscable (`PROYECTO.md` §13.11)

---

### H-023 · Ver y editar mis clientes · M05

**Como** Comercial
**quiero** una lista de clientes donde buscar y corregir datos
**para** encontrar rápido a quién cotizar.

**Criterios de aceptación**
- [ ] Veo la lista de clientes de mi organización, ordenada por nombre
- [ ] Busco por nombre (también por parte del nombre), o por RUT o correo completos
- [ ] Puedo editar los datos de un cliente, y queda registrado quién los cambió
- [ ] En teléfono, la lista se ve como tarjetas, no como tabla comprimida

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-022
**Datos personales:** sí

---

### H-024 · Configurar la numeración de mis cotizaciones · M06

**Como** Administrador
**quiero** definir cómo se numeran mis cotizaciones
**para** que se vean como las de mi empresa y reflejen su trayectoria.

**Criterios de aceptación**
- [ ] Elijo el prefijo (`COT`, `PRES`, `PPTO` u otro)
- [ ] Elijo si el correlativo se reinicia cada año (`COT-2026-0043`) o es corrido (`COT-2043`)
- [ ] Elijo desde qué número parte (por ejemplo, 2.001)
- [ ] Veo un ejemplo de cómo se verá la próxima cotización
- [ ] Si cambio el formato después, el próximo número nunca es menor que el último usado

**Prioridad:** núcleo
**Tamaño:** chico
**Depende de:** H-005
**Datos personales:** no
**Notas técnicas:** el número lo asigna la base de datos, sin repetirse aunque dos personas creen a la vez

---

### H-025 · Crear una cotización con servicios del catálogo · M06

**Como** Comercial
**quiero** armar una cotización eligiendo un cliente y agregando servicios del catálogo
**para** no escribir precios a mano.

**Criterios de aceptación**
- [ ] Elijo un cliente existente o lo creo sin salir de la cotización
- [ ] Busco servicios del catálogo y los agrego; el precio se carga solo
- [ ] Puedo agregar una línea libre que no está en el catálogo
- [ ] La cotización recibe su número apenas se crea, y queda como **Borrador**
- [ ] Si el catálogo cambia después, las líneas de mi cotización conservan su precio

**Prioridad:** núcleo
**Tamaño:** grande
**Depende de:** H-020, H-022, H-024
**Datos personales:** sí — vincula al cliente
**Notas técnicas:** el precio se **copia** a la línea (precio congelado, `PROYECTO.md` §13.7)

---

### H-026 · Ajustar cantidades, precios y descuentos · M06

**Como** Comercial
**quiero** cambiar cantidades, precios y descuentos de cada línea y ver los totales al instante
**para** llegar al valor que corresponde.

**Criterios de aceptación**
- [ ] Cambio la cantidad, el precio unitario y el descuento (en % o en pesos) de cada línea
- [ ] Veo neto, descuentos, IVA 19% y total, que se actualizan al escribir
- [ ] Las líneas exentas no suman IVA, y el total lo muestra por separado
- [ ] Los montos se redondean siempre de la misma forma y el total cuadra al peso con la suma de las líneas
- [ ] Puedo reordenar y eliminar líneas

**Prioridad:** núcleo
**Tamaño:** grande
**Depende de:** H-025
**Datos personales:** no
**Notas técnicas:** orden fijo: descuento de línea → subtotal → descuento global → IVA sobre el neto. El cálculo final lo hace el servidor. Pruebas con una tabla de casos conocidos

---

### H-027 · Descuento global, vigencia y observaciones · M06

**Como** Comercial
**quiero** aplicar un descuento a toda la cotización, fijar hasta cuándo vale y agregar observaciones
**para** dejar claras las condiciones de la oferta.

**Criterios de aceptación**
- [ ] Aplico un descuento global en % o en pesos, y los totales lo reflejan
- [ ] Fijo la vigencia en días o con una fecha; por defecto usa la de la organización
- [ ] Escribo observaciones y condiciones que aparecerán en el documento
- [ ] Veo la fecha exacta de vencimiento antes de enviar

**Prioridad:** núcleo
**Tamaño:** chico
**Depende de:** H-026
**Datos personales:** no

---

### H-028 · Ver la cotización como la verá el cliente · M07

**Como** Comercial
**quiero** una vista previa del PDF antes de enviar
**para** revisar que todo esté bien.

**Criterios de aceptación**
- [ ] Veo el PDF con el logo, los colores y los datos de mi organización
- [ ] Aparecen número, fecha, vigencia, cliente, líneas, totales, IVA y observaciones
- [ ] Una cotización con muchas líneas pasa a una segunda página sin cortar filas por la mitad
- [ ] Se ve bien impresa en tamaño carta y en A4
- [ ] Puedo descargarlo desde la vista previa

**Prioridad:** núcleo
**Tamaño:** grande
**Depende de:** H-027, H-007
**Datos personales:** sí — el PDF contiene datos del cliente
**Notas técnicas:** generado en el servidor con la plantilla 1, desde variables cerradas, sin HTML libre

---

### H-029 · Enviar la cotización por correo · M08

**Como** Comercial
**quiero** enviar la cotización al correo de mi cliente, con el PDF adjunto y un botón para revisarla
**para** que la reciba en segundos con mi marca.

**Criterios de aceptación**
- [ ] Escribo o ajusto el texto del correo, con negrita, listas y enlaces, y veo cómo quedará
- [ ] El correo lleva el PDF adjunto y un botón **"Revisar y aceptar la cotización"**
- [ ] El remitente muestra el nombre de mi organización
- [ ] Al enviar, la cotización pasa a **Enviada** y el PDF enviado queda guardado tal cual
- [ ] Si el envío falla, se me dice en pantalla y la cotización no cambia de estado

**Prioridad:** núcleo
**Tamaño:** grande
**Depende de:** H-028
**Datos personales:** sí — correo del cliente y contenido del mensaje
**Notas técnicas:** texto con formato básico, nunca HTML libre. Dominio verificado. Se guarda cada correo enviado y su estado de entrega

---

### H-030 · Ver mi cotización desde el enlace · M10

**Como** cliente final
**quiero** abrir la cotización desde el botón del correo
**para** revisarla con calma en el computador o en el teléfono.

**Criterios de aceptación**
- [ ] Veo la cotización con la marca de la organización que me la envió
- [ ] Se ve bien en un teléfono de 375 px de ancho, sin desplazamiento horizontal
- [ ] Puedo descargar el PDF
- [ ] Si el enlace caducó o fue revocado, veo un mensaje claro y a quién contactar
- [ ] Queda registrado cuándo la abrí, y la cotización pasa a **Vista** la primera vez

**Prioridad:** núcleo
**Tamaño:** grande
**Depende de:** H-029
**Datos personales:** sí — apertura con IP y navegador
**Notas técnicas:** token aleatorio largo, nunca el número correlativo. Límite de tasa. Sin datos bancarios en esta etapa

---

### H-031 · Aceptar o rechazar la cotización · M10

**Como** cliente final
**quiero** aceptar o rechazar la cotización desde el enlace
**para** responder sin tener que escribir un correo.

**Criterios de aceptación**
- [ ] Veo dos botones claros: **Aceptar** y **Rechazar**
- [ ] Al aceptar, ingreso mi nombre y confirmo; queda registrado quién aceptó, cuándo y desde dónde
- [ ] Al rechazar, **tengo que indicar el motivo** (precio demasiado alto, no está en el presupuesto, ya acepté la cotización de otra empresa, plazo, ya no lo necesito, otro con texto breve); sin motivo no se registra el rechazo
- [ ] Después de responder veo una confirmación y ya no puedo cambiar la respuesta desde el enlace
- [ ] No puedo aceptar una cotización vencida, revocada o reemplazada

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-030
**Datos personales:** sí — nombre de quien acepta, IP
**Notas técnicas:** la aceptación es un registro de conformidad, no una firma electrónica avanzada

---

### H-032 · Ver mis cotizaciones y su estado · M12

**Como** Comercial
**quiero** una lista de cotizaciones con su estado
**para** saber en qué va cada una.

**Criterios de aceptación**
- [ ] Veo número, cliente, total, fecha, autor y estado
- [ ] Cada estado tiene nombre y color, y el estado nunca se comunica solo con el color
- [ ] Puedo filtrar rápido entre "mías" y "todas"
- [ ] Al tocar una cotización, la abro
- [ ] En teléfono, la lista se ve como tarjetas

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-025
**Datos personales:** sí — nombre del cliente

---

### H-033 · Enterarme si mi correo no llegó · M08

**Como** Comercial
**quiero** ver en la cotización si el correo rebotó
**para** corregir la dirección en vez de suponer que llegó.

**Criterios de aceptación**
- [ ] En la cotización veo el estado de entrega: enviado, entregado o rebotado
- [ ] Si rebotó, veo un aviso visible en la cotización y en la lista
- [ ] Puedo corregir el correo del cliente y volver a enviar desde ahí

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-029
**Datos personales:** sí — correo

---

### H-034 · Que las cotizaciones venzan solas · M06

**Como** Comercial
**quiero** que una cotización sin respuesta pase a **Vencida** al terminar su vigencia
**para** no tener ofertas viejas dando vueltas como si siguieran vigentes.

**Criterios de aceptación**
- [ ] Al pasar la fecha de vigencia sin respuesta, la cotización queda **Vencida**
- [ ] El enlace del cliente muestra que la oferta venció y ya no permite aceptar
- [ ] Las cotizaciones aceptadas o rechazadas no vencen

**Prioridad:** núcleo
**Tamaño:** chico
**Depende de:** H-031
**Datos personales:** no

---

### H-035 · Revocar un enlace enviado · M10

**Como** Comercial
**quiero** anular el enlace de una cotización que envié por error
**para** que el cliente no pueda aceptarla.

**Criterios de aceptación**
- [ ] En la cotización enviada tengo la opción "Revocar enlace", con confirmación
- [ ] Desde ese momento el enlace muestra que la cotización ya no está disponible
- [ ] Queda registrado quién lo revocó y cuándo

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-030
**Datos personales:** no

---

# Fase 3 — Control

### H-040 · Configurar cuándo se exige aprobación · M09

**Como** Administrador
**quiero** decidir qué cotizaciones necesitan mi visto bueno antes de salir
**para** controlar lo que se ofrece sin revisar todo.

**Criterios de aceptación**
- [ ] Elijo una opción: siempre, nunca, sobre cierto monto total, o sobre cierto porcentaje de descuento
- [ ] Puedo combinar monto y descuento (basta con que se cumpla una)
- [ ] Veo en una frase cómo quedó la regla ("Se pide aprobación si el total supera $2.000.000 o el descuento supera 10%")
- [ ] El cambio aplica a las cotizaciones que se envíen desde ahora

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-011
**Datos personales:** no
**Notas técnicas:** 🔒 controla qué sale al cliente; no se mezcla sin Aarón. Diseño en `docs/arquitectura/sprint-5-h-040-aprobaciones.md`: tabla `approval_rules` con historial, una función única que decide si se pide aprobación y un control en el envío; unos 3,5 días. Se propone partirla en H-040a (regla, función y pantalla) y H-040b (control en el envío), que entran juntas a `main`; pendiente de decidir (D12). Bloquea su construcción la decisión 15 (quién puede enviar sin aprobación, de Aarón) y D1, D3 y D4.

---

### H-041 · Bloquear precios y poner topes de descuento · M04

**Como** Administrador
**quiero** marcar precios como bloqueados y fijar un descuento máximo
**para** que nadie cotice bajo lo que corresponde.

**Criterios de aceptación**
- [ ] En cada servicio del catálogo puedo marcar el precio como bloqueado
- [ ] Un Comercial ve el precio bloqueado con un candado y no puede cambiarlo
- [ ] Puedo fijar un descuento máximo por línea para los comerciales
- [ ] Si un Comercial intenta pasar el tope, se le explica el límite y no puede guardar
- [ ] Administrador y Dueño sí pueden cambiar un valor bloqueado, y queda registrado

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-021, H-026
**Datos personales:** no
**Notas técnicas:** el servidor rechaza el cambio aunque llegue sin pasar por la pantalla. Debe dejar el gancho `app.can_quote_catalog_item` (por ahora siempre responde «sí») llamado desde `save_quote_draft` para H-042, más el test que lo vigila: dentro de una transacción, reemplaza el gancho por uno que responde «no» y espera `CP422` desde `save_quote_draft`. Ver `docs/arquitectura/h-042-servicios-por-comercial.md` §3.

---

### H-042 · Limitar qué servicios cotiza cada comercial · M02

**Como** Administrador
**quiero** definir qué servicios del catálogo puede ofrecer cada comercial
**para** que cada uno cotice solo lo que le corresponde.

**Criterios de aceptación**
- [ ] En la ficha de un Comercial elijo "todos los servicios" o una lista
- [ ] Al cotizar, ese Comercial solo ve los servicios permitidos
- [ ] Las cotizaciones que ya tenía no se modifican

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-010, H-020, H-041
**Datos personales:** no
**Notas técnicas:** 🔒 delicada (permisos por persona y una función con permisos elevados); no se mezcla sin Aarón (decisión 020 §5). Unos 3,75 días en dos PR. D2: ordena (cada Comercial ve una lista más corta) y no controla (las líneas escritas a mano no se limitan). Diseño en `docs/arquitectura/h-042-servicios-por-comercial.md`.

---

### H-043 · Solicitar aprobación del paquete de envío · M09

**Como** Comercial
**quiero** pedir aprobación enviando exactamente lo que recibirá el cliente
**para** que mi jefe apruebe con toda la información.

**Criterios de aceptación**
- [ ] Si la regla lo exige, el botón dice **"Solicitar aprobación"** en vez de "Enviar"
- [ ] Se me muestra por qué necesita aprobación ("el total supera $2.000.000")
- [ ] Al solicitarla, el paquete queda congelado: texto del correo, PDF y (cuando exista) condición de pago
- [ ] La cotización pasa a **Pendiente de aprobación**
- [ ] Si la regla no lo exige, puedo enviar directo

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-040, H-029
**Datos personales:** sí — el paquete contiene datos del cliente
**Notas técnicas:** se guarda una copia congelada del paquete (`quote_packages`)

---

### H-044 · Revisar y aprobar un paquete · M09

**Como** Aprobador
**quiero** ver el paquete completo y aprobarlo
**para** que salga al cliente sin más trámite.

**Criterios de aceptación**
- [ ] Veo una lista de cotizaciones pendientes de mi aprobación
- [ ] Veo el correo y el PDF exactamente como los recibirá el cliente, y el motivo de la aprobación
- [ ] Al aprobar, **el correo sale solo** al cliente y la cotización pasa a **Enviada**
- [ ] El autor ve que fue aprobada y por quién
- [ ] Queda registrado quién aprobó, cuándo y con qué comentario

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-043
**Datos personales:** sí
**Notas técnicas:** el servidor rechaza cualquier envío que requiera aprobación y no la tenga (`PROYECTO.md` §13.3)

---

### H-045 · Pedir cambios o rechazar un paquete · M09

**Como** Aprobador
**quiero** devolver una cotización con comentarios o rechazarla
**para** corregir lo que no está bien antes de que llegue al cliente.

**Criterios de aceptación**
- [ ] Puedo elegir **Pedir cambios**, con un comentario obligatorio: la cotización vuelve a Borrador
- [ ] Puedo elegir **Rechazar**, con motivo obligatorio: la cotización queda **Rechazada internamente**
- [ ] El autor ve el comentario o el motivo en la cotización
- [ ] Una cotización rechazada internamente no puede enviarse; sí puede duplicarse

**Prioridad:** núcleo
**Tamaño:** chico
**Depende de:** H-044
**Datos personales:** no

---

### H-046 · Que un cambio anule la aprobación · M09

**Como** Administrador
**quiero** que cualquier cambio posterior a la solicitud anule la aprobación
**para** que lo que se envía sea exactamente lo que aprobé.

**Criterios de aceptación**
- [ ] Si el Comercial edita una cotización pendiente o aprobada y no enviada, se le advierte que anulará la solicitud
- [ ] Si confirma, la cotización vuelve a Borrador y hay que solicitar aprobación de nuevo
- [ ] Queda registrado que la solicitud se anuló por un cambio

**Prioridad:** núcleo
**Tamaño:** chico
**Depende de:** H-043
**Datos personales:** no

---

### H-047 · Recibir avisos de lo que me toca · M12

**Como** miembro
**quiero** recibir avisos cuando algo depende de mí o cambia en mis cotizaciones
**para** actuar a tiempo sin estar revisando todo.

**Criterios de aceptación**
- [ ] Veo avisos dentro de la aplicación, con un contador de no leídos
- [ ] Además recibo los avisos por correo, y puedo apagar los de correo
- [ ] El Aprobador recibe aviso de aprobaciones pendientes
- [ ] El autor recibe aviso cuando su cotización es aprobada, devuelta, rechazada, aceptada o rechazada por el cliente, y cuando un correo rebota
- [ ] Cada aviso lleva directo a la cotización

**Prioridad:** núcleo
**Tamaño:** grande
**Depende de:** H-044, H-031, H-033
**Datos personales:** no
**Notas técnicas:** canal "ambos" es el supuesto de la decisión pendiente 5; confirmar antes de esta fase

---

### H-048a · Administrar los textos listos para usar · M08

**Como** Administrador
**quiero** escribir una vez el texto base del correo, las condiciones comerciales, las exclusiones y las notas al pie
**para** que todo el equipo los use igual.

**Criterios de aceptación**
- [ ] Guardo varios textos con nombre: correo base, condiciones, exclusiones, notas al pie
- [ ] Marco un correo base como texto inicial de los correos de mi organización
- [ ] En el texto del correo puedo usar el nombre del cliente, el número de la cotización, quien envía y mi organización, que se completan solos, y veo una vista previa con datos de ejemplo
- [ ] Solo el Dueño y los Administradores los crean, editan y borran

**Prioridad:** usable
**Tamaño:** grande
**Depende de:** H-029
**Datos personales:** no
**Notas técnicas:** H-048 se partió en dos (2026-11-02, decisión de José). Diseño en `docs/arquitectura/sprint-5-h-048-textos.md`: tabla `text_snippets`, permiso `settings.manage`, unos 4 días. Es una historia normal; el `revisor` la revisa.

---

### H-048b · Usar los textos al cotizar, con exclusiones y notas al pie propias · M08

**Como** Comercial
**quiero** insertar con un clic los textos guardados de mi organización y tener campos propios para exclusiones y notas al pie
**para** cotizar rápido y que el cliente vea siempre lo que incluye y lo que no.

**Criterios de aceptación**
- [ ] La cotización tiene dos campos propios, «Exclusiones» y «Notas al pie», que salen en el PDF y en la página del cliente
- [ ] Al cotizar inserto con un clic un texto guardado en el campo que corresponde, y puedo ajustarlo
- [ ] Al enviar, el correo parte con el texto inicial de mi organización, con el nombre del cliente y el número ya completados, y se me avisa si queda algo sin completar
- [ ] Las cotizaciones ya enviadas no cambian si después se edita o borra un texto guardado

**Prioridad:** usable
**Tamaño:** grande
**Depende de:** H-048a, H-041
**Datos personales:** no
**Notas técnicas:** 🔒 reescribe `save_quote_draft` y cambia lo que ve el cliente final (PDF y página del enlace); no se mezcla sin Aarón (decisión 020 §5). Se construye después de H-041 y nunca en paralelo con ella, porque las dos reescriben `save_quote_draft` y git no avisa si una migración pisa a la otra. Los campos nuevos se congelan en la copia sellada del documento, sin tocar `prepare_quote_send`. Unos 4,5 días. Ver `sprint-5-h-048-textos.md` §3 a §5 y §12.

---

# Fase 4 — Cobro

### H-050 · Registrar mis datos de transferencia · M11

**Como** Dueño o Administrador
**quiero** registrar la cuenta bancaria donde me pagan
**para** que mis clientes reciban los datos correctos al aceptar.

**Criterios de aceptación**
- [ ] Ingreso banco (de una lista), tipo de cuenta, número, titular, RUT del titular y correo de confirmación
- [ ] El RUT del titular se valida
- [ ] Solo el Dueño y los Administradores ven y editan estos datos; los demás roles no los ven
- [ ] Debo tener activa la verificación en dos pasos para guardarlos
- [ ] Sin datos de transferencia no puedo enviar una cotización con condición de pago

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-004c, H-011
**Datos personales:** sí — datos financieros
**Notas técnicas:** cifrado obligatorio. Una sola cuenta por organización (supuesto de la decisión pendiente 6)

---

### H-051 · Enterarme de cualquier cambio en la cuenta bancaria · M11

**Como** Dueño
**quiero** que se me avise cada vez que alguien cambie los datos de transferencia
**para** detectar a tiempo un intento de desviar mis pagos.

**Criterios de aceptación**
- [ ] Cada cambio envía un correo al Dueño y a todos los Administradores, con quién lo hizo y cuándo
- [ ] El registro de actividad muestra el valor anterior y el nuevo (con el número parcialmente oculto)
- [ ] En el inicio aparece un aviso de "cambio reciente en datos bancarios" durante unos días

**Prioridad:** núcleo
**Tamaño:** chico
**Depende de:** H-050, H-014
**Datos personales:** sí — datos financieros

---

### H-052 · Elegir la condición de pago en la cotización · M11

**Como** Comercial
**quiero** indicar si se paga el 100% al aceptar o 50% al aceptar y 50% al final
**para** que el cliente sepa desde el principio cómo pagará.

**Criterios de aceptación**
- [ ] Elijo "100% al aceptar" o "50% al aceptar y 50% al final"; por defecto viene la de la organización
- [ ] Veo el monto de cada pago; si el total es impar, el peso sobrante va al segundo pago y la suma es exacta
- [ ] La condición aparece en el PDF y en el enlace del cliente
- [ ] La condición forma parte del paquete que se aprueba

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-027, H-050
**Datos personales:** no
**Notas técnicas:** cada pago se guarda como un hito propio (decisión 011)

---

### H-053 · Recibir los datos para pagar al aceptar · M11

**Como** cliente final
**quiero** recibir los datos de transferencia apenas acepto
**para** pagar sin tener que pedirlos.

**Criterios de aceptación**
- [ ] Al aceptar, me llega un correo con los datos de transferencia y el monto a pagar (100% o 50%)
- [ ] Los mismos datos aparecen en el enlace, que ahora muestra la cotización aceptada
- [ ] Antes de aceptar, los datos bancarios no aparecen en ninguna parte
- [ ] La cotización pasa a **Pendiente de pago** o **Pendiente de anticipo**

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-031, H-052
**Datos personales:** sí — datos financieros de la organización y correo del cliente
**Notas técnicas:** los datos bancarios se congelan en la cotización al enviarla (`PROYECTO.md` §13.2)

---

### H-054 · Marcar un pago como recibido · M11

**Como** Administrador o Dueño
**quiero** registrar que llegó una transferencia
**para** que todos sepan que ese cliente ya pagó.

**Criterios de aceptación**
- [ ] En la cotización veo los pagos esperados y marco uno como recibido, con fecha, monto y nota opcional
- [ ] Si el monto no coincide con el esperado, se me advierte antes de confirmar
- [ ] Con el anticipo, la cotización pasa a **Anticipo pagado**; con el último pago, a **Pagada**
- [ ] Un Comercial, un Aprobador o un Observador no ven la opción
- [ ] Queda registrado quién lo marcó y cuándo

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-053
**Datos personales:** no

---

### H-055 · Deshacer un pago marcado por error · M11

**Como** Administrador o Dueño
**quiero** revertir un pago que marqué por equivocación
**para** que el estado refleje la realidad.

**Criterios de aceptación**
- [ ] Puedo revertir un pago indicando un motivo obligatorio
- [ ] La cotización vuelve al estado anterior
- [ ] El registro original no se borra: se ven el pago, la reversión y el motivo

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-054
**Datos personales:** no

---

### H-056 · Pedir el segundo pago · M11

**Como** Comercial
**quiero** avisar al cliente que corresponde pagar el saldo cuando el trabajo está listo
**para** cobrar sin redactar un correo cada vez.

**Criterios de aceptación**
- [ ] En una cotización con anticipo pagado veo el botón **"Solicitar segundo pago"**
- [ ] Veo una vista previa del correo con los datos de transferencia y el saldo antes de enviar
- [ ] Al enviar, la cotización pasa a **Pendiente de saldo**
- [ ] También pueden hacerlo el Administrador y el Dueño
- [ ] Si los datos bancarios cambiaron desde que se envió la cotización, se usan los originales y se avisa al Administrador

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-054
**Datos personales:** sí — correo del cliente

---

### H-057 · Ver qué falta por cobrar · M11

**Como** Administrador
**quiero** ver las cotizaciones con pagos pendientes
**para** saber cuánto me deben y a quién.

**Criterios de aceptación**
- [ ] Veo una lista de cotizaciones pendientes de pago, de anticipo o de saldo, con monto pendiente y días de espera
- [ ] Veo el total por cobrar sumado arriba
- [ ] Desde la lista puedo abrir la cotización y marcar el pago

**Prioridad:** núcleo
**Tamaño:** chico
**Depende de:** H-054
**Datos personales:** sí — nombre del cliente

---

# Fase 5 — Seguimiento y orden

### H-060 · Ver la historia completa de una cotización · M12

**Como** miembro
**quiero** ver todo lo que pasó con una cotización, en orden
**para** saber en qué quedó sin preguntarle a nadie.

**Criterios de aceptación**
- [ ] Veo cada evento con fecha, hora y quién: creada, aprobación, envío, aperturas, respuesta, pagos, rebotes, cambios de vigencia, versiones
- [ ] Las aperturas repetidas se agrupan ("abierta 3 veces")
- [ ] Nadie puede editar ni borrar la historia
- [ ] Aparecen también los eventos anteriores a esta historia (se venían registrando desde la fase 2)

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-054
**Datos personales:** sí
**Notas técnicas:** `quote_events` solo admite agregar

---

### H-061 · Dejar notas internas · M12

**Como** miembro
**quiero** escribir notas en una cotización que el cliente nunca ve
**para** que el equipo sepa lo conversado.

**Criterios de aceptación**
- [ ] Escribo una nota y queda con mi nombre y la hora en la historia de la cotización
- [ ] Las notas no aparecen en el PDF, en el correo ni en el enlace del cliente
- [ ] Puedo borrar mis notas, pero no las de otros
- [ ] El Observador puede leerlas y no puede escribirlas

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-060
**Datos personales:** posiblemente — texto libre

---

### H-062 · Ver primero lo que requiere mi atención · M12

**Como** miembro
**quiero** que al entrar se me muestre lo que depende de mí
**para** empezar el día por lo importante.

**Criterios de aceptación**
- [ ] El Aprobador ve sus aprobaciones pendientes
- [ ] El Administrador y el Dueño ven los pagos por confirmar y los cambios recientes en datos bancarios
- [ ] El Comercial ve sus cotizaciones por vencer, vistas sin respuesta, rechazadas y con correo rebotado
- [ ] Si no hay nada pendiente, se me dice con un mensaje amable, no con una pantalla vacía

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-047, H-057
**Datos personales:** sí — nombres de clientes

---

### H-063 · Ver el resumen por estado · M12

**Como** Administrador
**quiero** ver cuántas cotizaciones hay en cada estado y por cuánto dinero
**para** entender cómo va el negocio de un vistazo.

**Criterios de aceptación**
- [ ] Veo cantidad y monto de: borradores, pendientes de aprobación, enviadas, aceptadas y por cobrar
- [ ] Al tocar un número, voy al listado ya filtrado
- [ ] Puedo ver el resumen del mes actual o de todo el período

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-062
**Datos personales:** no

---

### H-064 · Recibir alertas cuando algo se queda estancado · M12

**Como** Comercial
**quiero** que se me avise cuando una cotización está por vencer, fue vista sin respuesta o tiene un pago atrasado
**para** hacer seguimiento a tiempo.

**Criterios de aceptación**
- [ ] El Administrador define los días para cada alerta (por vencer, vista sin respuesta, pago atrasado)
- [ ] Recibo la alerta en la aplicación (y por correo, según mi preferencia)
- [ ] Cada alerta llega una sola vez por cotización y situación
- [ ] Las alertas son solo para el equipo: el cliente no recibe nada

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-047
**Datos personales:** no

---

### H-065 · Buscar cualquier cotización al instante · M13

**Como** miembro
**quiero** una búsqueda siempre visible
**para** encontrar una cotización en segundos.

**Criterios de aceptación**
- [ ] La barra de búsqueda está en todas las pantallas y se abre con `Ctrl + K`
- [ ] Encuentra por número (completo o parcial: `43` encuentra `COT-2026-0043`), nombre del cliente, RUT o correo completos, servicio y comercial
- [ ] Los resultados aparecen mientras escribo, con número, cliente, total, fecha y estado
- [ ] Solo muestra resultados de la organización activa

**Prioridad:** usable
**Tamaño:** grande
**Depende de:** H-032
**Datos personales:** sí
**Notas técnicas:** RUT y correo se buscan por huella (`PROYECTO.md` §13.11). Índices combinados con `tenant_id`; respuesta bajo 500 ms

---

### H-066 · Filtrar y ordenar el listado · M13

**Como** miembro
**quiero** filtrar y ordenar las cotizaciones
**para** ver exactamente el grupo que necesito.

**Criterios de aceptación**
- [ ] Filtro por estado, rango de fechas, comercial, cliente, categoría, etiqueta, rango de monto y condición de pago
- [ ] Tengo atajos "Por vencer" y "Con pago pendiente"
- [ ] Combino filtros y veo cuántos resultados hay
- [ ] Ordeno por fecha, monto o vencimiento
- [ ] Limpio todos los filtros con un clic

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-032
**Datos personales:** no

---

### H-067 · Ordenar con categorías y etiquetas · M13, M04

**Como** miembro
**quiero** clasificar cotizaciones y servicios
**para** ordenar mi trabajo y después medir por tipo de negocio.

**Criterios de aceptación**
- [ ] El Administrador crea, renombra y elimina categorías; cada cotización tiene una
- [ ] Cualquier miembro agrega etiquetas libres a una cotización (varias)
- [ ] El catálogo también se ordena por categorías
- [ ] Al eliminar una categoría en uso, se me pide a cuál mover sus cotizaciones

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-066
**Datos personales:** no

---

### H-068 · Ver la ficha completa de un cliente · M05

**Como** Comercial
**quiero** ver todo lo de un cliente en un solo lugar
**para** saber cómo es la relación antes de cotizarle de nuevo.

**Criterios de aceptación**
- [ ] Veo sus datos y todas sus cotizaciones con estado
- [ ] Arriba veo cuánto se le ha cotizado, cuánto aceptó, cuánto pagó y cuánto debe
- [ ] Desde la ficha creo una cotización nueva con el cliente ya cargado

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-057, H-023
**Datos personales:** sí

---

### H-069 · Crear una versión nueva de una cotización · M06

**Como** Comercial
**quiero** hacer una versión 2 cuando el cliente pide cambios
**para** renegociar sin perder la versión anterior.

**Criterios de aceptación**
- [ ] Desde una cotización enviada o vista, elijo "Nueva versión"
- [ ] La nueva conserva el número con su versión (`COT-2026-0043 v2`) y parte con los datos de la anterior
- [ ] La anterior queda **Reemplazada** y su enlace ya no permite aceptar
- [ ] La nueva vuelve a pasar por las reglas de aprobación
- [ ] En la cotización veo todas sus versiones y puedo abrir cada una

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-044
**Datos personales:** no
**Notas técnicas:** la nueva versión copia los cuatro textos de la cotización: observaciones, condiciones, exclusiones y notas al pie (campos de H-048b).

---

### H-070 · Duplicar una cotización · M14

**Como** Comercial
**quiero** copiar una cotización existente
**para** armar una parecida en segundos.

**Criterios de aceptación**
- [ ] Desde cualquier cotización elijo "Duplicar"
- [ ] Se crea un borrador nuevo, con número nuevo, las mismas líneas y el mismo cliente, que puedo cambiar
- [ ] Los precios de las líneas se actualizan al catálogo vigente, y se me avisa si alguno cambió

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-025
**Datos personales:** no
**Notas técnicas:** el borrador nuevo copia los cuatro textos de la cotización: observaciones, condiciones, exclusiones y notas al pie (campos de H-048b).

---

### H-071 · Extender la vigencia y reenviar · M14, M08

**Como** Comercial
**quiero** dar más plazo a una cotización o volver a enviarla
**para** no rehacerla cuando el cliente se atrasa o perdió el correo.

**Criterios de aceptación**
- [ ] En una cotización vencida o por vencer puedo extender la vigencia a una fecha nueva; el enlace vuelve a funcionar
- [ ] Puedo reenviar el correo al mismo cliente o a otro correo que ingrese
- [ ] Ambas acciones quedan en la historia de la cotización
- [ ] Si la organización exige aprobación por monto, extender la vigencia no la exige de nuevo

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-034, H-029
**Datos personales:** sí — correo

---

### H-072 · Que el borrador se guarde solo · M14

**Como** Comercial
**quiero** que mi borrador se guarde mientras escribo
**para** no perder trabajo si se cierra la ventana.

**Criterios de aceptación**
- [ ] Los cambios se guardan solos a los pocos segundos
- [ ] Veo "Guardado" o "Guardando…"
- [ ] Si pierdo la conexión, se me avisa y los cambios se guardan al volver

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-025
**Datos personales:** no

---

### H-073 · Archivar cotizaciones y eliminar borradores · M13

**Como** Comercial
**quiero** sacar de la vista lo que ya no me sirve
**para** trabajar con un listado limpio.

**Criterios de aceptación**
- [ ] Puedo archivar una cotización enviada: sale del listado normal y aparece si busco o filtro "archivadas"
- [ ] Puedo desarchivarla
- [ ] Solo puedo eliminar un borrador que nunca se envió, con confirmación
- [ ] Una cotización enviada no tiene opción de eliminar

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-066
**Datos personales:** no

---

### H-074 · Exportar el listado a Excel · M13

**Como** Administrador
**quiero** descargar el listado filtrado
**para** trabajarlo en una planilla.

**Criterios de aceptación**
- [ ] Descargo un Excel con las cotizaciones del filtro actual: número, fecha, cliente, comercial, estado, montos y pagos
- [ ] Los montos salen como números, no como texto
- [ ] Solo pueden exportar el Dueño, los Administradores y los Observadores
- [ ] Cada exportación queda en el registro de actividad

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-066
**Datos personales:** sí — sale del sistema con datos de clientes

---

### H-075 · Compartir la cotización por WhatsApp · M14

**Como** Comercial
**quiero** mandar el enlace de la cotización por WhatsApp
**para** llegar al cliente por donde más responde.

**Criterios de aceptación**
- [ ] En una cotización enviada veo el botón "Compartir por WhatsApp"
- [ ] Se abre WhatsApp con un mensaje ya escrito, con el enlace, y con el teléfono del cliente si lo tengo
- [ ] Queda en la historia que se compartió por WhatsApp
- [ ] Funciona en teléfono y en computador

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-029
**Datos personales:** sí — teléfono del cliente
**Notas técnicas:** enlace estándar de WhatsApp, sin integración paga

---

### H-076 · Elegir entre tres plantillas de PDF · M07

**Como** Administrador
**quiero** elegir el diseño con que salen mis cotizaciones
**para** que se vean como mi empresa quiere mostrarse.

**Criterios de aceptación**
- [ ] Veo las tres plantillas con mis datos reales antes de elegir
- [ ] Elijo una como predeterminada para la organización
- [ ] El Comercial puede cambiarla en una cotización específica
- [ ] Las tres cumplen lo mismo que la primera: carta y A4, sin filas cortadas

**Prioridad:** usable
**Tamaño:** grande
**Depende de:** H-028
**Datos personales:** no
**Notas técnicas:** las tres plantillas muestran las observaciones, las condiciones, las exclusiones, la forma de pago y las notas al pie (campos de H-048b; la prueba de H-048b recorre las tres cuando existan). Adelantada al sprint 3 (2026-10-06, pedido de Aarón). Las plantillas 2 y 3 las propone la sesión principal con vista previa que Aarón aprueba antes de construirlas, igual que la 1. Todas salen con el logo, los colores y los datos de la organización ya cargados (H-007), listas para cotizar. Agregar plantillas después no debe tocar la estructura: cada plantilla es un módulo en `src/lib/pdf/templates/`

---

# Fase 6 — Captación y cálculo

### H-080 · Configurar el modelo "por unidad" · M16

**Como** Administrador
**quiero** configurar un cálculo por unidad con tarifa, tramos, mínimo y recargos
**para** que el sistema proponga el precio sin partir de cero.

**Criterios de aceptación**
- [ ] Creo un cálculo con nombre, unidad (km, m², kg, día, unidad) y tarifa por unidad
- [ ] Agrego tramos opcionales (ej. sobre 300 km, otra tarifa)
- [ ] Fijo una tarifa mínima y recargos en % (urgencia, fin de semana, nocturno)
- [ ] Pruebo el cálculo con un ejemplo y veo el resultado paso a paso

**Prioridad:** usable
**Tamaño:** grande
**Depende de:** H-020
**Datos personales:** no
**Notas técnicas:** el modelo vive en el código; las tarifas por organización en tablas con `tenant_id`

---

### H-081 · Configurar el modelo "servicio por tiempo" · M16

**Como** Administrador
**quiero** definir perfiles con tarifa por hora, materiales y traslado
**para** cotizar trabajos por tiempo con un cálculo consistente.

**Criterios de aceptación**
- [ ] Creo perfiles (técnico, ayudante, profesional) con tarifa por hora y, si quiero, su costo
- [ ] Defino si se cobra traslado y cómo (monto fijo o por km)
- [ ] Pruebo el cálculo con horas, personas y materiales de ejemplo

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-080
**Datos personales:** no

---

### H-082 · Configurar el modelo "productos" · M16

**Como** Administrador
**quiero** calcular el precio de productos desde su costo y margen
**para** vender con el margen que definí.

**Criterios de aceptación**
- [ ] Para cada producto defino costo y margen, o un precio fijo
- [ ] Agrego descuentos por volumen (ej. 10% sobre 50 unidades)
- [ ] Defino si el despacho se cobra aparte y cuánto

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-080
**Datos personales:** no

---

### H-083 · Usar un cálculo al cotizar · M16

**Como** Comercial
**quiero** ingresar los datos del trabajo y que se propongan las líneas con su precio
**para** cotizar rápido y bien.

**Criterios de aceptación**
- [ ] En la cotización elijo "Calcular" y el modelo que corresponde
- [ ] Ingreso solo los datos del trabajo (cantidad, horas, personas, materiales)
- [ ] Se agregan las líneas con su detalle ("87 km × $1.100") y el total
- [ ] Puedo editar lo propuesto, salvo lo bloqueado
- [ ] Los datos que ingresé quedan guardados en la cotización

**Prioridad:** usable
**Tamaño:** grande
**Depende de:** H-080, H-081, H-082
**Datos personales:** no
**Notas técnicas:** el cálculo corre en el servidor; se guardan datos ingresados, costo y versión del modelo

---

### H-084 · Ver el margen de una cotización · M16

**Como** Administrador
**quiero** ver cuánto gano en cada cotización
**para** no vender bajo mi costo.

**Criterios de aceptación**
- [ ] En cada línea con costo y en el total veo el margen en pesos y en %
- [ ] Veo un semáforo: verde, amarillo o rojo según los márgenes que definí; el color siempre va con un texto
- [ ] Decido si los comerciales ven los costos o solo el semáforo (por defecto, solo el semáforo)
- [ ] El cliente nunca ve costos ni márgenes: no están en el PDF, el correo ni el enlace

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-083
**Datos personales:** no

---

### H-085 · Exigir aprobación bajo cierto margen · M09

**Como** Administrador
**quiero** que una cotización con margen bajo necesite mi visto bueno
**para** protegerme también de precios mal puestos a mano.

**Criterios de aceptación**
- [ ] En las reglas de aprobación agrego "margen menor a X%"
- [ ] Si una cotización queda bajo ese margen, pide aprobación y muestra el motivo
- [ ] Las cotizaciones sin costos cargados no activan esta regla, y se indica

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-084, H-040
**Datos personales:** no

---

### H-086 · Crear mi formulario público · M15

**Como** Administrador
**quiero** armar un formulario para que cualquiera me pida una cotización
**para** recibir solicitudes completas y no "quiero información".

**Criterios de aceptación**
- [ ] Elijo qué servicios o cálculos se pueden pedir
- [ ] Elijo qué datos pido al solicitante; el sistema me sugiere lo mínimo; no se puede pedir RUT y se explica por qué
- [ ] Veo cómo queda con mi marca antes de publicarlo
- [ ] Al publicarlo obtengo su enlace, y puedo pausarlo
- [ ] Puedo tener más de un formulario

**Prioridad:** usable
**Tamaño:** grande
**Depende de:** H-020, H-007
**Datos personales:** no — configura, no recoge
**Notas técnicas:** minimización de datos (`LEGAL.md` §1.3)

---

### H-087 · Pedir una cotización por el formulario · M15

**Como** visitante
**quiero** llenar el formulario de una empresa
**para** pedirle una cotización sin llamar ni escribir.

**Criterios de aceptación**
- [ ] Veo el formulario con la marca de la empresa, y se ve bien en el teléfono
- [ ] Elijo los servicios e ingreso los datos que se me piden
- [ ] Antes de enviar veo quién recibirá mis datos y para qué, y lo acepto de forma explícita
- [ ] Al enviar veo una confirmación de que la solicitud llegó
- [ ] Si algo falta o está mal, se me indica en el mismo campo

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-086
**Datos personales:** sí — datos de un desconocido
**Notas técnicas:** se guarda el consentimiento con fecha y versión de la política. Protección anti-robot, límite de tasa por IP y por formulario, validación en el servidor

---

### H-088 · Ver en vivo lo que estoy pidiendo · M15

**Como** visitante
**quiero** ver, mientras lleno el formulario, cómo va quedando lo que estoy solicitando
**para** confirmar que pedí lo correcto antes de enviarlo.

**Criterios de aceptación**
- [ ] A medida que elijo servicios e ingreso datos, veo al lado un resumen que se actualiza solo: qué pedí, cantidades y datos del trabajo
- [ ] El resumen se ve como un desglose, **sin ningún precio ni estimado**
- [ ] En el teléfono el resumen se ve debajo o en una hoja que puedo abrir, sin perder lo escrito
- [ ] Lo que veo es exactamente lo que recibirá la empresa

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-087
**Datos personales:** no (la vista previa no se guarda hasta enviar)
**Notas técnicas:** reemplaza al estimado del plan original (decisión de Aarón, 2026-10-06): quien solicita no ve precios. Ningún monto ni tarifa llega al navegador

---

### H-089 · Recibir y asignar solicitudes · M15

**Como** Administrador
**quiero** ver las solicitudes que llegan y asignarlas a un comercial
**para** que ninguna quede sin respuesta.

**Criterios de aceptación**
- [ ] Veo la lista de solicitudes con fecha, solicitante y servicios pedidos
- [ ] Asigno cada una a un comercial, que recibe un aviso
- [ ] Veo cuáles siguen sin asignar o sin convertir, y hace cuánto llegaron
- [ ] Puedo descartar una solicitud (basura, duplicada) indicando el motivo

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-087
**Datos personales:** sí

---

### H-090 · Convertir una solicitud en cotización · M15

**Como** Comercial
**quiero** transformar una solicitud en cotización con un clic
**para** no volver a escribir lo que el cliente ya me dijo.

**Criterios de aceptación**
- [ ] Desde la solicitud elijo "Crear cotización"
- [ ] Se crea un borrador con el cliente (nuevo o existente) y los servicios o el cálculo ya cargados
- [ ] La solicitud queda marcada como convertida, con enlace a su cotización
- [ ] Sigo el flujo normal: ajusto, pido aprobación si corresponde y envío

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-089, H-025
**Datos personales:** sí

---

### H-091 · Descargar el código QR del formulario · M15

**Como** Administrador
**quiero** un código QR de mi formulario
**para** ponerlo en mis camiones, tarjetas o en el local.

**Criterios de aceptación**
- [ ] Descargo el QR en PNG de buena resolución y en SVG
- [ ] Al escanearlo con un teléfono se abre el formulario
- [ ] Si pauso el formulario, el QR muestra un mensaje de que no está disponible

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-086
**Datos personales:** no

---

### H-092 · Que el formulario no se llene de basura · M15

**Como** Dueño
**quiero** que mi formulario público resista abusos
**para** no recibir cientos de solicitudes falsas.

**Criterios de aceptación**
- [ ] Un robot no puede enviar solicitudes (se bloquea antes de guardar)
- [ ] Hay un máximo de envíos seguidos desde una misma conexión; al pasarlo, se muestra un mensaje de esperar
- [ ] Hay un tope diario de solicitudes por formulario; al llegar, se me avisa
- [ ] Veo cuántos envíos fueron bloqueados

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-087
**Datos personales:** sí — IP de quien envía
**Notas técnicas:** `PROYECTO.md` §13.5

---

### H-093 · Poner el formulario en mi sitio web · M15

**Como** Administrador
**quiero** un código para pegar mi formulario dentro de mi propia web
**para** que mis clientes pidan cotización sin salir de mi sitio.

**Criterios de aceptación**
- [ ] Desde el formulario copio un código para incrustarlo, junto con su enlace público
- [ ] Pegado en una página de prueba, el formulario se ve con mi marca y funciona igual que el enlace
- [ ] Se ajusta al ancho de la página y se ve bien en el teléfono
- [ ] Solo se puede incrustar donde yo lo autorice (lista de sitios permitidos); en otros sitios no carga
- [ ] Si pauso el formulario, el incrustado muestra un mensaje de que no está disponible

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-086, H-087
**Datos personales:** no
**Notas técnicas:** 🔒 superficie pública. Cabeceras de seguridad con lista blanca de sitios (`frame-ancestors`), mismos límites y protecciones de H-092. Decisión de Aarón, 2026-10-06: entra en la v1 (antes M23)

---


# Fase 7 — Autoservicio y lanzamiento

### H-100 · Onboarding: empresa, marca, rubro y tarifas · M17

**Como** Dueño recién registrado
**quiero** que un recorrido guiado me ayude a configurar lo básico
**para** tener mi organización lista sin buscar dónde está cada cosa.

**Criterios de aceptación**
- [ ] Al crear la organización empieza el recorrido, con los pasos 1 a 4: empresa, marca, rubro y tarifas
- [ ] En el paso de marca veo una vista previa en vivo del PDF
- [ ] En el paso de rubro elijo los modelos de cálculo que usaré
- [ ] Veo en qué paso voy y cuántos quedan
- [ ] Puedo saltar un paso y seguir

**Prioridad:** usable
**Tamaño:** grande
**Depende de:** H-005, H-007, H-080
**Datos personales:** no

---

### H-101 · Onboarding: catálogo, numeración, pagos y textos · M17

**Como** Dueño
**quiero** configurar en el recorrido mi catálogo, numeración, cuenta bancaria y textos
**para** dejar lista la forma en que cotizo y cobro.

**Criterios de aceptación**
- [ ] Los pasos 5 a 8 reutilizan las mismas pantallas que ya existen, en formato guiado
- [ ] En el paso de pagos se me pide activar la verificación en dos pasos si aún no la tengo
- [ ] Puedo saltar cualquier paso

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-100, H-024, H-050, H-048a
**Datos personales:** sí — datos bancarios

---

### H-102 · Onboarding: plantilla, reglas, equipo y formulario · M17

**Como** Dueño
**quiero** terminar el recorrido eligiendo plantilla, reglas de aprobación, equipo y formulario
**para** dejar todo funcionando.

**Criterios de aceptación**
- [ ] Los pasos 9 a 12 cubren plantilla, reglas de aprobación, invitar al equipo y publicar el formulario con su QR
- [ ] Al terminar veo un resumen de lo configurado y lo que quedó pendiente

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-101, H-076, H-040, H-008, H-086
**Datos personales:** sí — correos de los invitados

---

### H-103 · Ver cuánto me falta configurar · M17

**Como** Dueño
**quiero** ver en el inicio qué pasos me faltan
**para** completar la configuración cuando tenga tiempo.

**Criterios de aceptación**
- [ ] En el inicio veo "7 de 12 listos" y la lista de lo pendiente
- [ ] Cada pendiente lleva a su paso
- [ ] Veo claramente lo mínimo para enviar la primera cotización: empresa, marca, un servicio o cálculo, y datos de transferencia
- [ ] Al completar todo, la lista desaparece

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-102
**Datos personales:** no

---

### H-104 · Enviarme una cotización de prueba · M17

**Como** Dueño
**quiero** recibir una cotización de prueba en mi propio correo
**para** ver exactamente lo que recibirán mis clientes.

**Criterios de aceptación**
- [ ] Al terminar el recorrido se me ofrece "Enviarme una cotización de prueba"
- [ ] Recibo el correo, el PDF y el enlace como los recibiría un cliente, marcados como prueba
- [ ] La cotización de prueba no consume un número de mi correlativo ni aparece en mis listados

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-102
**Datos personales:** no

---

### H-105 · Partir con categorías de ejemplo según mi rubro · M17

**Como** Dueño
**quiero** que el recorrido me sugiera categorías según mi rubro
**para** no partir con todo vacío.

**Criterios de aceptación**
- [ ] En el paso de rubro se me ofrecen categorías de ejemplo
- [ ] Puedo aceptarlas, quitar las que no me sirven o no usar ninguna

**Prioridad:** extra
**Tamaño:** chico
**Depende de:** H-100, H-067
**Datos personales:** no
**Notas técnicas:** supuesto de la decisión pendiente 11

---

### H-106 · Entregar a una persona los datos que tengo de ella · M18

**Como** Administrador
**quiero** encontrar todo lo que mi organización guarda de una persona y exportarlo
**para** responder su solicitud de acceso o de portabilidad como exige la ley.

**Criterios de aceptación**
- [ ] Busco a la persona por RUT o correo
- [ ] Veo todo lo que hay de ella: ficha de cliente, cotizaciones, solicitudes, aperturas del enlace
- [ ] Descargo sus datos en un formato estándar (JSON o CSV)
- [ ] La solicitud queda registrada con fecha y quién la atendió

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-068
**Datos personales:** sí
**Notas técnicas:** derechos de acceso y portabilidad, Ley 21.719

---

### H-107 · Corregir o suprimir los datos de una persona · M18

**Como** Administrador
**quiero** corregir o eliminar los datos de una persona que lo pide
**para** cumplir sus derechos sin romper mi historial.

**Criterios de aceptación**
- [ ] Puedo corregir sus datos, y queda registrado
- [ ] Al suprimir, sus datos personales se reemplazan por "Titular eliminado" en todas partes
- [ ] Las cotizaciones siguen existiendo con su número, servicios y montos
- [ ] La supresión exige confirmación y no se puede deshacer
- [ ] Puedo registrar que la persona se opone a cierto uso de sus datos

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-106
**Datos personales:** sí
**Notas técnicas:** rectificación, supresión (anonimización) y oposición

---

### H-108 · Que los datos viejos se borren solos · M18

**Como** Dueño
**quiero** que los datos que ya no se necesitan se eliminen automáticamente
**para** cumplir la ley sin tener que acordarme.

**Criterios de aceptación**
- [ ] Las solicitudes nunca convertidas se eliminan al cumplir el plazo definido
- [ ] El registro de aperturas del enlace (IP y navegador) se elimina al cumplir su plazo
- [ ] Veo en la configuración qué se borra y cuándo
- [ ] Cada borrado automático queda registrado

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-089, H-030
**Datos personales:** sí
**Notas técnicas:** plazos de la decisión pendiente 7

---

### H-109 · Gestionar mis propios datos como usuario · M18

**Como** usuario
**quiero** ver, descargar y eliminar los datos de mi cuenta
**para** ejercer mis derechos frente a Cotiza Prime.

**Criterios de aceptación**
- [ ] Edito mi nombre y mi correo (el correo nuevo se verifica)
- [ ] Descargo mis datos
- [ ] Puedo eliminar mi cuenta; si soy Dueño de una organización, primero debo transferirla o eliminarla

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-001
**Datos personales:** sí
**Notas técnicas:** si algún día se borra la fila de `auth.users`, antes hay que resolver todas las columnas que la referencian (por ejemplo `members.invited_by`, `members.invitation_created_by`, `members.removed_by`, `invitations.resent_by`); listarlas con `grep "references auth.users" supabase/migrations`.

---

### H-110 · Leer los términos y la política de privacidad · M18

**Como** visitante
**quiero** leer los términos y la política de privacidad antes de registrarme
**para** saber qué se hace con mis datos.

**Criterios de aceptación**
- [ ] Las páginas son públicas y se llega a ellas desde el pie de cualquier página
- [ ] Dicen quién es el responsable, qué datos se recogen, para qué, por cuánto tiempo y cómo ejercer los derechos
- [ ] Cada versión tiene fecha; si cambia, se me pide aceptar la nueva al entrar
- [ ] Indican que el servicio es para Chile

**Prioridad:** núcleo
**Tamaño:** chico
**Depende de:** —
**Datos personales:** no
**Notas técnicas:** textos revisados por el abogado (decisión pendiente 9). Si se usan cookies no esenciales, aviso de consentimiento previo

---

### H-111 · Transferir mi organización · M01

**Como** Dueño
**quiero** traspasar la propiedad a otro Administrador
**para** que el negocio siga si yo dejo de estar a cargo.

**Criterios de aceptación**
- [ ] Elijo a un Administrador de la organización y confirmo con mi verificación en dos pasos
- [ ] El otro debe aceptar el traspaso
- [ ] Al aceptar, él pasa a ser Dueño y yo quedo como Administrador
- [ ] Queda registrado

**Prioridad:** usable
**Tamaño:** chico
**Depende de:** H-010, H-004c
**Datos personales:** no
**Notas técnicas:** al traspasar, en la misma operación hay que cancelar las invitaciones pendientes a roles que manejan el equipo (Administrador) creadas o reenviadas por el Dueño saliente: con la regla de H-010 (corrección del 2026-11-06) ya no se pueden aceptar, pero seguirían apareciendo como pendientes y bloquearían invitar de nuevo al mismo correo. Conviene una cancelación acotada a esa organización, no `app.reconcile_invitation_senders()`, que bloquea toda la tabla de invitaciones.

---

### H-112 · Eliminar mi organización · M01, M18

**Como** Dueño
**quiero** cerrar mi organización
**para** dejar de usar Cotiza Prime con ese negocio.

**Criterios de aceptación**
- [ ] Antes de eliminar, se me ofrece descargar mis datos
- [ ] Confirmo escribiendo el nombre de la organización y con mi verificación en dos pasos
- [ ] Los miembros pierden el acceso de inmediato y los enlaces enviados dejan de funcionar
- [ ] Los datos quedan archivados durante el plazo definido y después se borran o anonimizan
- [ ] Durante ese plazo puedo pedir restaurarla

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-111
**Datos personales:** sí

---

### H-113 · Ver mi uso y sus límites · M19

**Como** Dueño
**quiero** ver cuánto estoy usando la plataforma y cuáles son mis límites
**para** no llevarme sorpresas.

**Criterios de aceptación**
- [ ] Veo mis cotizaciones del mes, miembros, organizaciones y solicitudes del formulario, frente a sus límites
- [ ] Recibo un aviso al acercarme a un límite
- [ ] Al llegar, se me explica qué pasa y qué hacer

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-005
**Datos personales:** no
**Notas técnicas:** los valores dependen de las decisiones pendientes 12 y 13 (modo de cobro y tope de uso)

---

### H-114 · Que la dirección de origen en la auditoría sea confiable · M18

**Como** Dueño
**quiero** que el registro de actividad guarde desde dónde se hizo cada acción sin que nadie pueda falsearlo
**para** poder confiar en él ante un incidente o una solicitud de un titular.

**Criterios de aceptación**
- [ ] Una persona con sesión que llama directo a la base de datos no puede elegir la dirección IP que queda en la auditoría ni en la aceptación de términos
- [ ] La IP que se guarda es la que vio el servidor de Cotiza Prime
- [ ] Si la IP no se puede confirmar, queda vacía, nunca inventada
- [ ] Existe una prueba automática que intenta falsearla y falla

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-012
**Datos personales:** sí — la IP es un dato personal
**Notas técnicas:** surgió de la revisión de H-012 (2026-10-01). Hoy la base toma la IP de la cabecera
`x-cp-client-ip`, que el navegador puede enviar con su propio pase. Opciones: que el servidor firme la
cabecera con un secreto que la base verifique, o que la IP la escriba solo el servidor. Debe estar
antes del piloto, porque la aceptación de términos es prueba de consentimiento.

---

### H-115 · Que la aplicación se sienta pulida y moderna · M19

**Como** miembro de una organización
**quiero** que la aplicación responda con transiciones suaves, esqueletos de carga y componentes modernos
**para** que trabajar en ella sea agradable y se sienta profesional.

**Criterios de aceptación**
- [ ] Las listas y pantallas muestran esqueletos de carga con la forma del contenido, no pantallas en blanco
- [ ] Cambiar de pantalla, abrir menús y paneles tiene transiciones suaves y cortas, según los tokens de movimiento de `DISENO.md`
- [ ] Los avisos de éxito o error entran y salen con animación, sin tapar acciones
- [ ] Con "reducir movimiento" activado no hay animaciones decorativas
- [ ] El puntaje de rendimiento móvil sigue sobre 80
- [ ] Cada librería nueva tiene licencia verificada y queda en la tabla de `DISENO.md`

**Prioridad:** usable
**Tamaño:** mediano
**Depende de:** H-006
**Datos personales:** no
**Notas técnicas:** pedido de Aarón al cerrar el sprint 1 (2026-10-01). Candidatas ya verificadas en
`DISENO.md`: Motion, Sonner, cmdk, Embla. Se repite como pasada de pulido al final de cada sprint
sobre las pantallas nuevas. Pendiente de la revisión de H-028: si la generación del PDF falla, la
pestaña nueva que abre el botón hoy muestra un texto plano ("No pudimos generar el PDF."); debe
mostrar una página amable, con la marca de la aplicación y un botón para reintentar o volver.

---

# Índice por prioridad

> H-004 y H-048 se partieron el 2026-11-02 (H-004a, H-004b y H-004c; H-048a y H-048b). Los conteos de abajo y las «92 historias» se mantienen con la numeración original.

**Núcleo — sin esto el producto no tiene sentido (44)**
H-001 · H-002 · H-003 · H-004 · H-005 · H-006 · H-007 · H-008 · H-009 · H-010 · H-011 · H-012 ·
H-013 · H-014 · H-020 · H-021 · H-022 · H-023 · H-024 · H-025 · H-026 · H-027 · H-028 · H-029 ·
H-030 · H-031 · H-032 · H-033 · H-034 · H-040 · H-041 · H-043 · H-044 · H-045 · H-046 · H-047 ·
H-050 · H-051 · H-052 · H-053 · H-054 · H-056 · H-057 · H-110

**Usable — lo que lo hace funcional en el día a día (48)**
H-035 · H-042 · H-048 · H-055 · H-060 · H-061 · H-062 · H-063 · H-064 · H-065 · H-066 · H-067 ·
H-068 · H-069 · H-070 · H-071 · H-072 · H-073 · H-074 · H-075 · H-076 · H-080 · H-081 · H-082 ·
H-083 · H-084 · H-085 · H-086 · H-087 · H-088 · H-089 · H-090 · H-091 · H-092 · H-100 · H-101 ·
H-102 · H-103 · H-104 · H-106 · H-107 · H-108 · H-109 · H-111 · H-112 · H-113 · H-114 · H-115

**Extra — suma valor pero no es esencial (1)**
H-105

# Resumen por fase

| Fase | Historias | Qué se puede mostrar al cerrar |
|---|---|---|
| 1 · Cimientos | H-001 a H-014 (14) | Dos organizaciones separadas, un miembro invitado, aislamiento probado |
| 2 · Primera cotización | H-020 a H-035 (16) | Se cotiza, se envía y el cliente acepta |
| 3 · Control | H-040 a H-048 (9) | Aprobación del paquete con envío automático |
| 4 · Cobro | H-050 a H-057 (8) | Ciclo completo hasta Pagada |
| ⭐ Piloto privado | — | Uso real con 1 a 3 empresas |
| 5 · Seguimiento | H-060 a H-076 (17) | "¿En qué quedó?" en segundos |
| 6 · Captación y cálculo | H-080 a H-092 (13) | Formulario con estimado que se convierte en cotización |
| 7 · Lanzamiento | H-100 a H-113 (14) | Onboarding completo y cumplimiento legal: lanzamiento público |

**H-110** (términos y privacidad) es núcleo aunque esté en la fase 7: una versión preliminar es
requisito del piloto privado y del registro de H-001. La versión revisada por el abogado se
publica antes del lanzamiento.

---

> ### ✅ COMPUERTA 2 — cruzada
> Historias aprobadas por escrito por Aarón el 2026-09-30.
