---
description: Perfecciona el plan del proyecto hasta que sea fiable
---

Sigue `docs/00-base/PROCESO.md`, fase 1.

## Antes de nada

**Pregunta para qué país es**, si no está declarado en `docs/PROYECTO.md`. No lo infieras del idioma ni del contexto. De ahí dependen la ley de datos, la moneda, los impuestos y los formatos.

## Qué hacer

1. Lee `docs/PROYECTO.md` completo.
2. Revísalo contra `STACK.md`, `SEGURIDAD.md` y `LEGAL.md`. Señala lo que contradiga el estándar.
3. Busca **huecos**: qué falta responder de la lista de la fase 1 del proceso.
4. Busca **ambigüedades**: frases que dos personas leerían distinto.
5. Haz las preguntas necesarias, **de a pocas** y en lenguaje simple.
6. Propón los ajustes y espera aprobación antes de escribirlos.
7. **Repite este ciclo** hasta que el plan sea fiable.

## Verifica también

**Las decisiones que son caras de corregir.** Aunque el proyecto nazca suelto, confirma que el plan contemple:

- `tenant_id` en toda tabla, aunque hoy haya un solo cliente. **Con ese nombre exacto y como UUID, nunca un número correlativo**
- Las direcciones de la API con `/api/v1/` desde el inicio
- La validación del pase de sesión en un solo archivo
- La resolución del cliente en un solo punto

Están en §5b de `STACK.md`. **Son gratis ahora y caras después**: si el proyecto algún día se acopla a una plataforma mayor, esto es la diferencia entre un día de trabajo y rehacer la base de datos.

Si el equipo no lo tenía contemplado, **explícale por qué conviene** en vez de solo agregarlo.

## No hagas

- No escribas código, ni de ejemplo.
- No generes historias todavía.
- No asumas nada que no esté escrito.

## Al terminar

Pide **aprobación explícita del plan**. Recuerda que sin ella no se avanza a historias.
