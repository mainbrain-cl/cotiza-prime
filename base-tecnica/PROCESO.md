---
document_id: BASE-PROC
title: Proceso de Desarrollo — cualquier proyecto
version: 1.0
status: ACTIVE
aplica_a: todo proyecto de la agencia
last_updated: 2026-08-25
language: es-CL
---

# Proceso de Desarrollo

**Qué es este documento.** Cómo se construye cualquier proyecto de la agencia, de la idea al código. Se copia tal cual a cada proyecto nuevo.

**Por qué existe.** El fallo más caro al construir con IA no es técnico: es empezar a programar antes de saber qué se está construyendo. Este proceso lo impide con compuertas: puntos donde no se avanza sin aprobación explícita.

---

## El recorrido

```
Plan  →  ⛔ COMPUERTA 1  →  Historias  →  ⛔ COMPUERTA 2
      →  Priorización y sprint  →  ⛔ COMPUERTA 3  →  Desarrollo
```

**Las compuertas no son sugerencias.** Un agente de IA no las cruza sin aprobación escrita de una persona.

---

## Fase 1 — El plan

**Qué se produce:** un documento que responde qué se construye y qué no.

**Lo que no puede faltar:**

| Punto | Qué responde |
|---|---|
| **País** | Se pregunta siempre, nunca se asume |
| Qué es | En una frase, y para quién |
| Qué problema resuelve | El dolor concreto que hoy existe |
| Qué **no** hace | El límite importa tanto como el alcance |
| Términos | Las palabras que se usarán siempre igual |
| Perfiles | Quiénes lo usan y qué puede cada uno |
| Flujos principales | Los recorridos completos |
| Datos | Qué información maneja, y si hay datos personales |
| Integraciones | Con qué servicios externos habla |
| Alcance de la primera versión | Qué entra ahora y qué se deja para después |
| Consideraciones | Las trampas técnicas que no se pueden pasar por alto |
| Decisiones pendientes | Lo que aún no está resuelto |

**Se perfecciona en ciclo.** Se escribe, se revisa contra el estándar, se detectan huecos, se ajusta, y se repite. **Sin apuro:** dar vueltas en el plan es barato; corregir código no.

> ### ⛔ COMPUERTA 1
> **No se generan historias sin plan aprobado.** La aprobación es explícita, de una persona.

---

## Fase 2 — Historias de usuario

**Qué se produce:** la lista de trabajo, contada desde quien usa el sistema.

### Formato de cada historia

```markdown
### H-042 · Completar una tarea con foto

**Como** trabajador
**quiero** marcar una tarea como hecha adjuntando una foto
**para** que quede registro de que se hizo.

**Criterios de aceptación**
- [ ] Solo puedo completar ocurrencias asignadas a mí
- [ ] La cámara se abre directo, sin pasos intermedios
- [ ] Puedo repetir la foto antes de confirmar
- [ ] Si falla la subida, la acción queda en cola
- [ ] Queda registrada la hora real de completado

**Prioridad:** núcleo
**Tamaño:** mediano
**Depende de:** H-011, H-023
**Datos personales:** sí — la foto puede contener personas
**Notas técnicas:** comprimir antes de subir
```

### Reglas de las historias

**Se cuentan desde quien la usa**, no desde la implementación. "Como trabajador quiero…" y no "crear el endpoint de completar tarea".

**Los criterios de aceptación son verificables.** Alguien tiene que poder decir si se cumplieron mirando la pantalla, sin abrir el código.

**Si una historia toma más de dos días, está mal partida.** Se divide.

**Toda historia declara si toca datos personales.** Eso dispara los controles del documento legal.

**Las dependencias se declaran.** Si H-042 necesita H-011, va escrito.

### Tres niveles de prioridad

| Nivel | Qué significa |
|---|---|
| **Núcleo** | Sin esto el producto no tiene sentido. Va primero, siempre |
| **Usable** | Lo que lo hace funcional de verdad en el día a día |
| **Extra** | Suma valor pero no es esencial |

> ### ⛔ COMPUERTA 2
> **No se escribe código sin historias aprobadas.** Una persona las lee, ajusta lo que no calce y confirma.

---

## Fase 3 — Priorización y sprint

**Qué se produce:** qué se construye primero y qué queda para después.

### Cómo se ordena

**Primero, el camino más corto que funcione de punta a punta.** No el módulo más completo: el recorrido más delgado que se pueda usar de verdad. Eso valida las decisiones difíciles antes de invertir en lo demás.

**Después, por dependencia.** Lo que otras historias necesitan va antes.

**Después, por riesgo.** Lo que puede salir mal se construye temprano, cuando corregir es barato.

**Al final, lo cómodo.** Lo que mejora la experiencia pero no bloquea nada.

### El sprint

| Aspecto | Criterio |
|---|---|
| Duración | Una o dos semanas |
| Contenido | Historias completas, nunca fragmentos |
| Cierre | Lo que entra tiene que quedar utilizable, no a medias |
| Qué queda fuera | Se devuelve a la lista, no se arrastra en silencio |

**Un sprint termina con algo que se puede mostrar.** Si al final no hay nada que enseñar, el sprint estaba mal armado.

> ### ⛔ COMPUERTA 3
> **Se confirma el contenido del sprint antes de empezar.**

---

## Fase 4 — Desarrollo

**Una historia a la vez.** El ciclo se repite igual para cada una:

1. **Antes** — se explica qué se va a hacer y por qué, en lenguaje simple
2. **Se aprueba**
3. **Se construye**
4. **Se muestra** el resultado funcionando
5. **Se revisa** contra los criterios de aceptación
6. **Se audita** contra el sistema de diseño y la revisión móvil
7. **Se cierra** y recién ahí empieza la siguiente

**Nada se da por terminado sin la auditoría.** Los criterios de aceptación y la revisión de diseño son parte del trabajo, no un extra.

**Si aparece algo no previsto**, no se agrega en silencio: se vuelve historia y entra a la lista.

---

## Reglas permanentes para agentes de IA

- **No cruzar compuertas sin aprobación escrita.** Ni "para avanzar más rápido", ni porque parezca obvio.
- **No escribir código durante la fase de plan.** Ni de ejemplo, ni de prueba.
- **Traducir todo término técnico en la misma frase.** El equipo no son desarrolladores profesionales.
- **Avanzar de a un paso**, mostrando y esperando aprobación.
- **Si algo del pedido es mala idea, decirlo** antes de construirlo.
- **Si algo no está claro, preguntar** en vez de asumir.
- **Declarar el entorno** antes de tocar la base de datos.

---

## Qué se guarda de todo esto

| Documento | Dónde vive |
|---|---|
| El plan | `docs/PROYECTO.md` |
| Las historias | `docs/HISTORIAS.md` |
| Los sprints | `docs/sprints/NNN-nombre.md` |
| Las decisiones | `docs/decisiones/NNN-titulo.md` |

**El plan se actualiza cuando cambia el alcance.** No se deja desactualizado: es el documento que lee cualquiera que llegue nuevo, incluida la IA en cada sesión.
