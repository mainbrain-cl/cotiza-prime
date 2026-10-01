---
document_id: BASE-LEGAL
title: Base Legal — cualquier proyecto
version: 1.0
status: ACTIVE
aplica_a: todo proyecto de la agencia
last_updated: 2026-08-13
language: es-CL
---

# Base Legal

**Qué es este documento.** Lo legal que aplica a cualquier proyecto que construyamos, sin importar el rubro. Se copia tal cual a cada proyecto nuevo y solo se ajusta lo que corresponda al caso.

**Advertencia.** Esto es el estándar técnico mínimo, **no es asesoría legal**. Los puntos marcados como *requiere abogado* se validan con un especialista antes de salir a producción con clientes reales.

---

## 0. Lo primero: el país

**Nunca se asume el país de destino.** Es la primera pregunta antes de planificar cualquier cosa, porque de ella depende todo este documento.

| Qué cambia con el país | Por qué importa |
|---|---|
| Ley de datos personales | Chile: Ley 21.719. Otros: GDPR, LGPD, LFPDPPP |
| Dónde pueden alojarse los datos | Algunos países exigen alojamiento local o restringen la transferencia |
| Identificador de personas | RUT, CUIT, NIF, CNPJ. Cambia formato, validación y sensibilidad |
| Impuestos y documento tributario | IVA, IGV, VAT. Quién emite y qué documento |
| Moneda y formato de precios | Símbolo, decimales, si se muestra con o sin impuesto |
| Derechos del consumidor | Plazos de retracto, garantías, obligaciones de información |
| Facturación electrónica | Obligatoriedad y formato del organismo tributario |

**Valor por defecto en nuestros proyectos: Chile.** Cualquier proyecto para otro país lo declara explícitamente en su documento de proyecto y ajusta lo que corresponda.

---

## 1. Protección de datos personales

### 1.1 Marco aplicable en Chile

La **Ley 21.719** entra en plena vigencia el **1 de diciembre de 2026** y está alineada con el GDPR europeo. Aplica a todo proyecto que trate datos de personas. Las multas son altas, así que el cumplimiento se diseña desde el inicio y no se agrega al final.

### 1.2 Qué cuenta como dato personal

Cualquier cosa que identifique a una persona: nombre, RUT, correo, teléfono, dirección, dirección IP, ubicación, patente de vehículo, fotografía.

Los **datos sensibles** —salud, biometría, origen étnico, afiliación política o sindical, vida sexual— exigen protección reforzada y casi siempre consentimiento explícito.

### 1.3 Reglas técnicas obligatorias

- **Privacidad desde el diseño.** Antes de escribir código, por cada dato personal: ¿lo necesito?, ¿para qué?, ¿cuánto tiempo lo guardo?, ¿quién accede? Si no es necesario, no se guarda.
- **Minimización.** Solo se pide lo que el servicio realmente necesita. Un formulario que pide RUT "por si acaso" es un incumplimiento.
- **Cifrado en reposo** de las columnas con datos personales. Obligatorio para sensibles y financieros.
- **Cifrado en tránsito.** HTTPS siempre, sin excepción.
- **Derechos del titular.** El sistema debe poder, para una persona identificada: dar **acceso**, **rectificar**, **suprimir**, **portar** en formato estándar y registrar **oposición**.
- **Consentimiento registrado.** Cuándo se obtuvo, para qué, con qué versión de la política, y cómo revocarlo.
- **Registro de actividades de tratamiento.** Qué datos se tratan, con qué finalidad y por cuánto tiempo.
- **Retención y borrado automático.** Cada dato tiene plazo de conservación. Al expirar se borra o se anonimiza. **Nada se guarda indefinidamente.**
- **Notificación de brechas.** Registro y alertas que permitan detectar un incidente y notificarlo a la autoridad y a los afectados dentro del plazo legal.
- **Encargados de tratamiento.** Todo proveedor que procese datos por nosotros queda declarado y cubierto por su acuerdo de tratamiento.
- **Transferencia internacional.** Si un proveedor aloja datos fuera del país, se verifica que ofrezca nivel de protección adecuado.
- **Decisiones automatizadas e IA.** Si el sistema usa perfilado o IA que afecte a personas, debe haber explicación y opción de revisión humana.

### 1.4 En sistemas de varios módulos

Una solicitud del titular —acceso, supresión, portabilidad— se emite como **evento estándar** que cada módulo escucha y atiende con lo suyo. Sin eso, cada solicitud es trabajo manual módulo por módulo, y eso no escala ni cumple plazos.

### 1.5 Nunca

- **Datos reales de clientes en entornos de prueba.** Los datos de prueba se generan ficticios. Es de las infracciones más comunes y más fáciles de cometer sin darse cuenta.
- Datos personales en registros de aplicación sin enmascarar.
- Datos personales enviados a servicios de terceros sin acuerdo de tratamiento.

---

## 2. Propiedad intelectual

> *Requiere abogado para el contrato tipo.*

### 2.1 De quién es cada cosa

Hay que dejarlo escrito **antes** de empezar, no cuando aparece el conflicto:

| Elemento | Criterio habitual |
|---|---|
| Código desarrollado a medida | Se define en contrato: puede ceder al cliente o quedar en licencia de uso |
| Base o framework propio reutilizable | De la agencia, siempre. Se licencia su uso |
| Diseño e identidad visual del cliente | Del cliente |
| Diseño creado por la agencia para el cliente | Se define en contrato |
| Contenido cargado por el cliente | Del cliente |
| Datos personales de terceros | **De los titulares**, no del cliente ni de la agencia |
| Bibliotecas de terceros | De sus autores, bajo su licencia |

### 2.2 La distinción crítica

Cuando un cliente carga datos sobre **sus** clientes, esos datos no son del cliente ni nuestros: son de las personas a quienes identifican. Conservan sus derechos **aunque exista una deuda o un conflicto comercial**.

Lo que sí puede ser de la agencia es la configuración, el trabajo realizado y el software. El contrato debe distinguir ambas cosas con claridad.

### 2.3 Licencias de terceros

- Toda dependencia declara su licencia.
- **Prohibido sin decisión registrada:** licencias que obliguen a liberar el código propio (GPL y similares) en proyectos cerrados.
- Fuentes tipográficas, íconos e imágenes con licencia verificada. Nada de material tomado de internet sin verificar.
- Material de archivo y música con licencia comercial válida.

---

## 3. Relación con el cliente

> *Requiere abogado para los documentos tipo.*

### 3.1 Antes de empezar, por escrito

- **Alcance:** qué incluye y qué no. La lista de exclusiones importa tanto como la de inclusiones.
- **Entregables** concretos y criterio de aceptación.
- **Plazos** y qué pasa si el cliente no entrega lo que le toca.
- **Precio, forma de pago** y qué se cobra aparte.
- **Cambios de alcance:** cómo se cotizan y aprueban.
- **Propiedad** de cada elemento (§2).
- **Soporte posterior:** qué incluye, por cuánto tiempo, qué se cobra.

### 3.2 Si el proyecto trata datos de terceros

El cliente es el **responsable** del tratamiento y la agencia el **encargado**. Eso exige un acuerdo que declare qué datos tratamos, para qué, con qué medidas de seguridad, y qué pasa al terminar la relación.

### 3.3 Suspensión e impago

Si el servicio se suspende por falta de pago:

- El acceso puede cortarse.
- Los datos se **archivan, no se borran.**
- El archivo tiene **plazo máximo definido**: los datos personales no se conservan indefinidamente.
- Los titulares conservan sus derechos durante todo ese período.

---

## 4. Sitios y aplicaciones de cara al público

Todo proyecto público necesita, como mínimo:

- **Política de privacidad** — qué datos se recogen, para qué, cuánto se guardan, cómo ejercer derechos, y contacto del responsable.
- **Términos y condiciones** — reglas de uso, limitación de responsabilidad, ley aplicable.
- **Aviso de cookies** con consentimiento previo si se usan cookies no esenciales.
- **Identificación del responsable** — quién opera el sitio, con datos de contacto.

Si además hay **comercio electrónico**, se suman:

- Precio total, claro y con impuestos incluidos.
- Condiciones de despacho y plazos.
- Derecho de retracto y política de devoluciones.
- Garantía legal del producto.
- Documento tributario correspondiente.

---

## 5. Accesibilidad

No es solo un requisito legal creciente: es alcance de mercado. El estándar mínimo es **WCAG 2.1 nivel AA**, y está detallado en el documento de diseño de cada proyecto.

---

## 6. Lista de verificación antes de salir a producción

- [ ] País declarado y marco legal identificado
- [ ] Inventario de qué datos personales trata el sistema
- [ ] Cifrado en reposo de datos personales
- [ ] Los cinco derechos del titular implementados
- [ ] Plazos de retención definidos y borrado automático funcionando
- [ ] Consentimiento registrado y revocable
- [ ] Registro de auditoría de acciones sensibles
- [ ] Detección y protocolo de notificación de brechas
- [ ] Acuerdos de tratamiento con todos los proveedores
- [ ] Política de privacidad y términos publicados
- [ ] Contrato firmado con alcance y propiedad definidos
- [ ] Ningún dato real en entornos de prueba
- [ ] Licencias de dependencias, fuentes e imágenes verificadas
- [ ] Revisión de un abogado sobre los puntos marcados
