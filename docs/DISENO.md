---
document_id: CP-DISENO
title: Cotiza Prime — Sistema de diseño
version: 0.2
status: DIRECCIÓN APROBADA — tokens y componentes pendientes
pais: Chile
last_updated: 2026-10-01
language: es-CL
---

# Cotiza Prime — Sistema de diseño

> **Estado: dirección visual aprobada.** Faltan los valores concretos (colores, tipografía,
> espaciado, radios, vidrio, movimiento) y los componentes. Se completan antes de construir
> pantallas, porque `/auditar` audita contra este documento.

---

## Dirección visual — aprobada por Aarón el 2026-10-01

**Moderno, minimalista y limpio, con la sensación de iOS.** Nada saturado: solo lo esencial y
estético.

| Rasgo | Qué significa |
|---|---|
| **Liquid Glass** | Menús, barras y paneles **flotantes** con vidrio translúcido y desenfoque, al estilo iOS |
| **Animaciones** | Transiciones suaves y con sentido; fondos animados donde aporten (ingreso, onboarding, estados vacíos) |
| **Minimalismo** | Mucho aire, pocos colores, jerarquía clara; cada elemento tiene que ganarse su lugar |
| **Escritorio a todo el ancho** | Aprovechar el ancho de la pantalla con un diseño pensado para eso: paneles laterales, vista de lista y detalle lado a lado, sin una columna angosta al centro |
| **Móvil de verdad** | Diseño propio para teléfono, no una versión achicada: barra inferior flotante, acciones al alcance del pulgar, tablas convertidas en tarjetas |

**Librerías de componentes candidatas** (gratuitas; cada una con su licencia verificada antes de
usarla, `LEGAL.md` §2.3):

- **shadcn/ui** — base de componentes accesibles (botones, formularios, tablas, menús)
- **React Bits** (reactbits.dev) — fondos y efectos animados. *Verificar su licencia exacta antes de usarla*
- **Motion** (antes Framer Motion) — animaciones y transiciones
- Otras con fondos animados o efectos de vidrio, si su licencia lo permite

### Búsqueda de librerías de componentes — tarea antes de construir pantallas

Buscar y comparar librerías de React (u otras piezas necesarias) con componentes **modernos**
para, como mínimo:

| Necesidad | Ejemplos de uso en Cotiza Prime |
|---|---|
| **Menús** | Barra flotante de navegación, menú de usuario, selector de organización, menú de acciones de una cotización |
| **Tarjetas** | Cotizaciones y clientes en móvil, resumen por estado, ficha del cliente |
| **Carruseles y slides** | Elegir plantilla de PDF, pasos del onboarding |
| **Desplazamiento (scroll)** | Listas largas que no se ponen lentas, desplazamiento suave, encabezados que se quedan fijos |
| **Lo que haga falta** | Diálogos, paneles laterales, notificaciones, tablas, formularios, selector de fechas, búsqueda `Ctrl + K`, fondos animados |

**Cada librería se acepta solo si cumple los cinco criterios:**

1. **Gratis** para uso comercial dentro de un producto que se vende.
2. **Licencia abierta reconocida y verificada** (MIT, Apache 2.0, ISC o similar). Nada con
   licencias que obliguen a liberar el código propio (GPL), ni con condiciones que restrinjan el
   uso comercial sin revisarlas (`LEGAL.md` §2.3).
3. **Buen rendimiento:** liviana, que cargue solo lo que se usa y que no baje el puntaje móvil bajo 80.
4. **Accesible:** funciona con teclado y lector de pantalla, y respeta "reducir movimiento".
5. **Mantenida:** actualizaciones recientes, comunidad activa y sin vulnerabilidades conocidas
   (`SEGURIDAD.md` §8).

El resultado queda en una tabla en este documento: librería, para qué se usa, licencia, peso y
fecha de verificación.

### Reglas para que lo bonito no rompa lo importante

El estilo se cumple **sin violar la base técnica**:

- **Contraste WCAG AA (4,5:1 en texto).** El vidrio translúcido baja el contraste. El texto importante
  va sobre superficies con suficiente opacidad, y se prueba sobre fondos claros y oscuros.
- **Movimiento reducido.** Si el usuario tiene activado "reducir movimiento", se apagan las
  animaciones decorativas y los fondos animados.
- **Rendimiento (puntaje móvil sobre 80).** El desenfoque y los fondos animados son pesados en
  teléfonos modestos: se usan con medida y se apagan o simplifican donde bajen el rendimiento.
- **Las pantallas de trabajo son tranquilas.** Cotizar, aprobar y cobrar exigen concentración:
  ahí el vidrio va en la navegación flotante y el contenido va sobre superficies sólidas. Los
  efectos más llamativos se reservan para el ingreso, el onboarding y los estados vacíos.
- **No aplica a lo que ve el cliente final.** El PDF, el correo y el enlace del cliente llevan la
  **marca de cada organización** (ver la distinción de abajo), no el estilo de Cotiza Prime.

---

## Por qué este documento existe

`/auditar` revisa cada pantalla contra este archivo antes de darla por terminada. Si está vacío,
la auditoría no tiene contra qué comparar y cada pantalla termina con valores inventados a mano.

---

## Lo que tiene que definir

| Sección | Qué fija | Estado |
|---|---|---|
| **Marca** | Nombre, logo, tono de voz | ⬜ |
| **Color** | Paleta completa con sus valores, en claro y oscuro | ⬜ |
| **Tipografía** | Familias, escala de tamaños, pesos, licencia verificada | ⬜ |
| **Espaciado** | La escala, y que nada se escriba fuera de ella | ⬜ |
| **Radios y sombras** | Los valores permitidos | ⬜ |
| **Íconos** | **Una sola familia.** Nunca emojis como íconos | ⬜ |
| **Componentes** | Botón, campo, tabla, tarjeta, aviso, modal, con sus estados | ⬜ |
| **Los cuatro estados** | Cargando, vacío, error y sin conexión, diseñados para cada pantalla | ⬜ |
| **Accesibilidad** | WCAG 2.1 nivel AA: contraste 4.5:1 en texto y 3:1 en interfaz | ⬜ |
| **Móvil** | Probado a 375px, área táctil de 44×44px, sin desplazamiento horizontal | ⬜ |

---

## Una distinción propia de este proyecto

Cotiza Prime tiene **dos sistemas visuales que no se mezclan**:

| Sistema | Quién lo ve | Quién manda en él |
|---|---|---|
| **La aplicación** | Los miembros de la organización | Cotiza Prime. Es nuestro diseño, igual para todos |
| **La cotización y el formulario público** | El cliente final de cada organización | **La organización**: su logo, sus colores, su plantilla |

El cliente final **nunca debería notar que hay un Cotiza Prime detrás**, salvo lo mínimo que la
marca decida mostrar. Eso obliga a que las plantillas y el formulario público tengan sus propios
límites de diseño: qué puede cambiar la organización y qué no.

Los límites se definen aquí, y son también un control de seguridad: el usuario elige entre valores
permitidos, **nunca escribe código ni HTML libre** (`PROYECTO.md` §9.6).
