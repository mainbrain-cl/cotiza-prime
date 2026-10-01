---
description: Revisa una pantalla antes de darla por terminada
---

Confirma primero en qué parte del proyecto se está trabajando. Después audita contra `docs/DISENO.md` y los criterios de aceptación de la historia.

## Criterios de aceptación

Recorre uno por uno los de la historia y di cuáles se cumplen y cuáles no. **Verificables mirando la pantalla**, no leyendo el código.

## Sistema de diseño

- Todo color, tamaño, radio, sombra y espacio sale de los tokens. Un valor escrito a mano es un hallazgo.
- Una sola familia de íconos. Nunca emojis como íconos.
- Los cuatro estados están diseñados: cargando, vacío, error y sin conexión.
- Esqueletos animados, no indicadores giratorios.

## Accesibilidad

- Contraste 4.5:1 en texto, 3:1 en interfaz
- Área táctil de 44×44px
- Ningún estado comunicado solo con color
- Foco de teclado visible
- Movimiento reducido respetado

## Revisión móvil — obligatoria

- Probado a 375px de ancho
- Sin desplazamiento horizontal
- Acciones principales al alcance del pulgar
- Áreas seguras respetadas
- El teclado no tapa el campo activo ni el botón
- Nada depende solo de pasar el cursor por encima
- Tablas convertidas en tarjetas, no comprimidas

## Seguridad

- Sin secretos en el código
- Entrada validada en el servidor
- Permisos verificados en el servidor, no solo en la interfaz

## Formato del reporte

Agrupa por severidad: **bloqueante**, **importante** y **menor**. Explica cada hallazgo en lenguaje simple y di exactamente qué cambiar. Si no hay hallazgos, dilo claramente.
