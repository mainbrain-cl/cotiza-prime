# 018 · React Bits en la interfaz

**Estado:** aprobada por Aarón el 2026-10-06 · **Modifica:** `docs/DISENO.md` (tabla de librerías y
sección de dirección visual), que decía "React Bits solo para un efecto puntual y con aprobación
previa de Aarón".

## Decisión

Se usan componentes de **React Bits** (reactbits.dev), **solo los de la versión gratuita**, para:

1. **Menú flotante** en vertical a la izquierda (como la barra lateral actual de vidrio, pero con
   el estilo de menú flotante de React Bits).
2. **Tarjetas** (cotizaciones, resumen por estado, ficha del cliente).
3. **Contadores** animados en el resumen del inicio.
4. **Fondos con movimiento**, en la entrada, el onboarding y los estados vacíos.

## Licencia

React Bits es **MIT + Commons Clause**: se puede usar dentro de Cotiza Prime, incluso en un producto
comercial, pero **no se pueden revender ni redistribuir los componentes sueltos**. Cotiza Prime no
los vende por separado, así que la condición se cumple. Los componentes se copian al repositorio
(no son una dependencia instalada) y conservan el aviso de licencia.

**Cada componente puede traer sus propias dependencias** (por ejemplo GSAP, OGL o three). Antes de
adoptar un componente se verifica la licencia y el peso de cada dependencia nueva y se anota en la
tabla de `DISENO.md`. Si una dependencia no tiene licencia abierta reconocida o pesa demasiado, se
descarta ese componente o se reemplaza por una versión propia en CSS.

## Reglas que se mantienen (de `DISENO.md`)

- Contraste AA, también sobre vidrio y fondos.
- "Reducir movimiento" apaga fondos y animaciones decorativas.
- Puntaje de rendimiento móvil sobre 80: los fondos pesados (WebGL) se cargan solo donde se usan,
  con carga diferida y apagados o simplificados en teléfonos modestos.
- **Las pantallas de trabajo siguen tranquilas.** Cotizar, aprobar y cobrar no llevan fondos
  animados; ahí van el menú flotante y las tarjetas sobre superficies sólidas. Los fondos con
  movimiento van en ingreso, onboarding y estados vacíos.
- No aplica a lo que ve el cliente final (PDF, correo, enlace): ahí manda la marca de la
  organización.
