# 020 · Quién decide mientras Aarón no esté disponible

**Estado:** propuesta con los ajustes que José pidió el 2026-10-28, **pendiente de su aprobación escrita final** · **Fecha:** 2026-10-28 · **Relacionada con:**
013 (forma de desarrollo), `docs/00-base/PROCESO.md` (compuertas), `docs/TRASPASO.md` §9

## Contexto

El proyecto pasó de Aarón a José el 2026-10-27. En su mensaje de traspaso, Aarón se reservó las
decisiones de producto, dinero y proveedores, y pidió que se le pregunte antes. Aarón aprueba hoy cada
sprint (decisión 013) y revisa los cambios.

Puede pasar que Aarón no responda durante un tiempo. Mientras tanto:

- Cada decisión pendiente detiene el desarrollo, aunque el trabajo siga siendo local y reversible.
- El CI de GitHub no corre (facturación de la cuenta de Aarón): la única red de seguridad son las pruebas
  locales.
- José tiene permiso de **escritura** en el repositorio, no de administración. No puede cambiar la
  facturación ni las reglas de `main`.
- Hoy **no existe producción ni clientes reales**: todo corre en local con datos ficticios, y el trabajo va
  en ramas y PR. Un supuesto equivocado se deshace con git antes de que le cueste algo a alguien.

`PROCESO.md` exige «aprobación escrita de una persona» para cruzar una compuerta y prohíbe que un agente de
IA lo haga solo. No exige que esa persona sea Aarón. Lo que falta es dejar escrito **quién puede aprobar y
hasta dónde**, para no relajar ninguna regla en silencio.

## Decisión

### 1. José puede cruzar compuertas y decidir lo reversible

Mientras Aarón no esté disponible, **José** puede:

- Confirmar por escrito el contenido de un sprint (Compuerta 3).
- Decidir el tamaño de un sprint y partir una historia en varias.
- Aceptar o cambiar los supuestos de diseño que ya traen los documentos del sprint.
- Resolver decisiones pendientes de `PROYECTO.md` §16.2 que **no tocan dinero real, datos reales,
  proveedores ni cumplimiento legal**: por ejemplo quién puede enviar directo (nº 15) y el canal de avisos
  internos (nº 5).
- Decidir la pregunta de las cuentas bancarias (nº 6) **solo cuando la historia que la necesita esté por
  empezar** (sprint 6). Hasta entonces sigue el supuesto de una sola cuenta.

Un agente de IA **nunca** cruza una compuerta por su cuenta: necesita la confirmación escrita de José, en la
conversación o en el documento del sprint.

### 2. Aviso y plazo

Antes de usar esta autorización, José le manda a Aarón un mensaje con los PR abiertos, los supuestos y un
plazo para responder: **24 horas**, que José puede alargar. Pasado el plazo sin respuesta se procede según
esta decisión. Si Aarón responde después y no está de acuerdo, **se revierte** lo que corresponda, y los
cambios de este periodo son fáciles de encontrar porque cada uno está en su PR.

**Lo anterior al aviso.** El 2026-10-28, antes de que existiera este aviso, José confirmó el sprint 5
(Compuerta 3) y ordenó mezclar los PR #1 al #6 con una revisión del agente `revisor` en los de código.
Eso queda vigente, pero Aarón puede ratificarlo o pedir que se revierta dentro del plazo. Esas mezclas se
apoyan en la orden explícita de José de ese día, no en esta decisión.

### 3. Lo que NO se decide sin Aarón

Estas cosas quedan esperando, aunque José esté de acuerdo:

- Las plantillas 2 y 3 del PDF (H-076) y todo lo de **marca**: dominio, nombre, identidad visual.
- El **proveedor y el dominio de correo** (decisión 016) y el **anti-robot real** (decisión 019). Mientras
  tanto sigue valiendo lo de desarrollo (Mailpit, `ANTIBOT_PROVIDER=memory`).
- Lo **legal**: abogado, términos, política de privacidad, acuerdo de tratamiento.
- La **custodia de las claves de cifrado** y **quién responde un incidente de seguridad**.
- La **facturación de GitHub** y los ajustes administrativos del repositorio (reglas de `main`, accesos).
- **Salirse del stack** o **relajar** un control de seguridad, de aislamiento entre organizaciones o de
  datos personales. Eso siempre exige su propia decisión registrada (`CLAUDE.md`, «Precedencia»). Esta
  decisión no lo autoriza.
- Poner **datos reales** en cualquier entorno, o publicar en producción.

### 4. Hasta dónde llega

Esta autorización cubre el desarrollo local hasta el **final del sprint 7** (cobro). **No cubre el piloto
con empresas reales ni el lanzamiento público**: para eso hacen falta las cosas de la lista anterior y la
presencia de Aarón. Si Aarón sigue ausente al llegar ahí, el proyecto se detiene en ese punto y se revisa
esta decisión.

### 5. Mezclar PR sin la revisión de Aarón

Para mezclar un PR a `main` sin que Aarón lo haya revisado, antes se cumple todo esto:

1. Pasan las verificaciones locales: tipos, lint, formato y pruebas unitarias; si el PR toca la base de datos,
   también `test:db`, `test:isolation` y `test:db:rollbacks`; y las pruebas de punta a punta cuando toca
   pantallas (`README.md` explica cómo correrlas). Si algo falla, no se mezcla.
2. Los PR de código que no tuvieron una revisión independiente pasan por el agente `revisor` (Opus). Las
   historias 🔒 siguen pasando siempre por `planificador` antes y `revisor` después (decisión 013).
3. Se mezclan con «Create a merge commit» y en el orden que indique el propio PR, para no romper los que van
   montados sobre otros.
4. El PR queda con una nota: **«mezclado sin revisión de Aarón, según la decisión 020»**, con la fecha y lo
   que se verificó.
5. Después de mezclar, se corren de nuevo las pruebas en `main`.

**Lo delicado no se mezcla sin Aarón.** Un PR que toque **permisos o roles, aislamiento entre
organizaciones, dinero o superficie pública** (o que sea de una historia 🔒) queda abierto, aunque pase todo
lo anterior, hasta que Aarón lo revise. Ante la duda, se trata como delicado. Mientras espera se puede
seguir construyendo encima en una rama apilada, pero esa rama tampoco se mezcla antes. El PR dice en su
descripción si es delicado y por qué.

### 6. Registro de lo decidido

Cada decisión tomada bajo esta autorización se anota en el documento del sprint o en `docs/decisiones/`, con
fecha, el supuesto elegido y por qué. Cuando Aarón vuelva, esa lista es lo primero que revisa. Aarón puede
ratificar, cambiar o anular esta decisión cuando quiera.

### 7. Cierre de un sprint

Aarón normalmente prueba cada historia en pantalla al cerrarla. Mientras no esté, **José** hace esa prueba
con el escenario de «Qué se podrá mostrar» del documento del sprint y deja anotado el resultado. Aarón lo
revisa al volver.

## Por qué

Todo el trabajo es local y reversible, y detener el proyecto por una respuesta que no llega tiene un costo
cierto. El riesgo real está en lo que no se puede deshacer: dinero, datos reales, proveedores, la ley y los
accesos. Eso se deja fuera y sigue siendo de Aarón.

## Alternativas descartadas

- **Esperar a Aarón sin hacer nada:** detiene el sprint 5 y los siguientes por decisiones que se pueden
  revertir.
- **Que la IA decida sola:** `PROCESO.md` lo prohíbe, y la responsabilidad tiene que tener nombre.
- **Relajar las compuertas hasta que Aarón vuelva:** se pierde justo el control que protege al proyecto. Aquí
  las compuertas se mantienen y solo cambia quién las cruza.

## Consecuencias y riesgos

- **El sprint 5 casi entero es delicado** (roles, invitaciones, dos pasos, precios bloqueados): se puede
  construir y probar en ramas, pero **mezclarlo a `main` espera a Aarón**. Lo que no es delicado
  (por ejemplo textos listos, H-048) sí puede mezclarse según el punto 5.
- **La revisión es más débil:** una persona y un agente en vez de dos personas, y sin CI. Se compensa con las
  condiciones del punto 5, pero no es lo mismo.
- **Aarón sigue siendo el único administrador del repositorio:** si tarda mucho, no se puede arreglar la
  facturación ni proteger `main`. Se le avisa en el mismo mensaje del punto 2.
- **El margen es limitado:** llega hasta el sprint 7. Pasado ese punto, el proyecto necesita a Aarón.
- **Esta decisión puede cambiarse o anularse** por Aarón en cuanto esté disponible.
