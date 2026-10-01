---
description: Genera las historias de usuario desde el plan aprobado
---

Sigue `docs/00-base/PROCESO.md`, fase 2.

## Antes de empezar

1. Verifica que el plan esté **completo y aprobado**. Si no lo está, detente y avísalo.
2. Verifica que el **país esté declarado**. Afecta validaciones, formatos y cumplimiento legal.

## Qué hacer

Genera las historias con este formato:

```markdown
### H-NNN · Título corto

**Como** [rol]
**quiero** [acción]
**para** [beneficio].

**Criterios de aceptación**
- [ ] Verificable mirando la pantalla
- [ ] ...

**Prioridad:** núcleo · usable · extra
**Tamaño:** chico · mediano · grande
**Depende de:** H-NNN
**Datos personales:** sí/no
**Notas técnicas:** solo si hacen falta
```

## Reglas

- **Desde quien la usa**, no desde la implementación.
- **Criterios verificables** sin abrir el código.
- **Si una historia toma más de dos días, pártela.**
- **Declara dependencias** entre historias.
- **Marca las que tocan datos personales.**
- Agrupa en **núcleo, usable y extra**.

Guarda el resultado en `docs/HISTORIAS.md`.

## Al terminar

Pide que las revisen y aprueben. **Sin esa aprobación no se escribe código.**
