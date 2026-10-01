---
description: Declara el entorno antes de tocar la base de datos
---

## Qué hacer

1. Revisa a qué base apuntan las variables de entorno activas.
2. **Declara el resultado de forma visible:**
   - `🟢 ENTORNO: PRUEBAS — datos ficticios, se puede experimentar.`
   - `🔴 ENTORNO: PRODUCCIÓN — datos reales.`
3. **Si no puedes determinarlo, no actúes.** Pregunta. Ante la duda, trata como producción.

## Si es producción

Antes de ejecutar nada, advierte con estas tres cosas:

- Qué va a cambiar exactamente
- Qué podría salir mal
- Si ya se probó en pruebas

Y pregunta de forma explícita:

> 🔴 Esto toca **PRODUCCIÓN**.
> Voy a [qué]. Si sale mal, [consecuencia].
> ¿Ya lo probamos en pruebas? ¿Confirmas?

**Espera respuesta.** No continúes sin ella.

## Recordatorio

- **Cambio de código** (pantallas, lógica): se publica solo, aplica a ambos entornos.
- **Cambio de estructura** (tablas, columnas): se aplica en cada base por separado, primero pruebas.

Explícalo siempre: es la confusión más frecuente.
