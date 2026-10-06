---
document_id: CP-DISENO
title: Cotiza Prime — Sistema de diseño
version: 1.0
status: APROBADO — dirección y tokens
pais: Chile
last_updated: 2026-10-01
language: es-CL
---

# Cotiza Prime — Sistema de diseño

> **Estado: aprobado.** Dirección visual y tokens aprobados por Aarón el 2026-10-01. Vista previa
> visual: https://claude.ai/artifact/E5sUWmvb7jnp2Et3JuVwwb. Los
> componentes se completan a medida que se construyen las pantallas, porque `/auditar` audita
> contra este documento.

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
- **React Bits** (reactbits.dev) — fondos y efectos animados. *Licencia verificada: MIT + Commons
  Clause, ver la tabla de librerías*
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

## Librerías — licencias verificadas el 2026-10-01

Licencia y última versión revisadas en npm y en el repositorio de cada una.

| Librería | Para qué | Licencia | Versión revisada | Peso aprox. | Veredicto |
|---|---|---|---|---|---|
| **shadcn/ui** | Base de componentes (se copian al proyecto, no se instalan) | MIT | — | Solo lo que se usa | ✅ |
| **Radix UI** (`radix-ui`) | Lo que hay debajo de shadcn: menús, diálogos, accesibilidad | MIT | 1.6.7 | Por componente | ✅ |
| **Motion** (`motion`) | Animaciones y transiciones | MIT | 13.5.0 | ~5 kB con carga mínima (`LazyMotion`) | ✅ |
| **Lucide** (`lucide-react`) | Íconos — **la única familia** | ISC (algunos íconos de origen Feather, MIT) | 1.49.0 | Solo los íconos usados | ✅ |
| **Geist** y **Geist Mono** | Tipografía | SIL Open Font License 1.1 | 1.7.2 | 2 familias, autoalojadas con `next/font` | ✅ |
| **cmdk** | Búsqueda `Ctrl + K` | MIT | 1.1.1 | ~6 kB | ✅ (última actualización: ago-2025; vigilar) |
| **Sonner** | Avisos breves ("Anticipo confirmado") | MIT (verificada en npm, 2026-10-05) | 2.0.8 (fija) | ~4 kB | ✅ En uso desde H-115 (`src/components/ui/toaster.tsx`) |
| **Embla Carousel** | Carruseles: elegir plantilla, pasos del onboarding | MIT | 8.6.0 | ~7 kB | ✅ |
| **TanStack Virtual** | Listas largas sin ponerse lentas | MIT | 3.14.13 | ~4 kB | ✅ |
| **React Day Picker** | Selector de fechas | MIT | 10.0.2 | ~10 kB | ✅ |
| **@react-pdf/renderer** | PDF de la cotización, generado en el servidor (H-028). Sus 36 paquetes de apoyo (fontkit, pdfkit, yoga-layout…) son MIT, ISC o MIT\* | MIT | 4.9.0 | ~2 MB en el servidor; no llega al navegador | ✅ Verificada el 2026-10-05 |
| **IBM Plex Sans** e **IBM Plex Mono** (archivos `.woff` copiados del paquete `@fontsource` v5.3.0, que no queda como dependencia) | Tipografía del PDF (la de la aplicación sigue siendo Geist). Viven en el repositorio, subconjunto latino, y se incrustan en cada PDF; licencia en `src/lib/pdf/fonts/LICENSE-IBM-Plex.txt` | SIL OFL 1.1 | 5.3.0 | ~140 kB en total | ✅ Verificada el 2026-10-05 |
| **pdfjs-dist** | Leer el texto de un PDF en las pruebas (solo desarrollo; no se despliega) | Apache-2.0 | 6.4.299 | — | ✅ Verificada el 2026-10-05 |
| **Transiciones de vista** (`ViewTransition` de React, incluido en Next 16) | Transición corta entre pantallas | — (parte de React/Next, sin paquete nuevo) | — | 0 kB | ✅ En uso desde H-115 (2026-10-05); se apaga con "reducir movimiento" |
| **Vaul** | Hojas que suben desde abajo en el teléfono | MIT | 1.1.2 | ~5 kB | ⚠️ Sin actualizaciones desde dic-2024. Usar la hoja (`Sheet`) de shadcn; Vaul solo si hace falta arrastrar |
| **React Bits** | Fondos y efectos animados | **MIT + Commons Clause** | — | Por componente | ⚠️ Se puede usar dentro de Cotiza Prime (también comercialmente), pero **no revender ni redistribuir los componentes sueltos**. **Decisión 018 (2026-10-06, Aarón):** se usan sus componentes gratuitos para menú flotante, tarjetas, contadores y fondos; cada dependencia nueva se verifica antes de adoptarla |

---

## Tokens — aprobados por Aarón el 2026-10-01

Son los valores con nombre que usan todas las pantallas. Ninguna pantalla
escribe un color, tamaño o espacio fuera de esta lista. Viven en el CSS global de la aplicación
(variables de Tailwind) con estos mismos nombres.

### Color

Grises fríos con un leve tinte azul, y **un solo acento: azul cobalto**. Verde, ámbar y rojo solo
para estados. Todo texto cumple 4,5:1 sobre su fondo (calculado).

| Token | Uso | Claro | Oscuro |
|---|---|---|---|
| `--bg` | Fondo de la aplicación | `#F4F6FA` | `#0A0E16` |
| `--surface` | Paneles, tarjetas, tablas | `#FFFFFF` | `#121823` |
| `--surface-2` | Superficie hundida, filas al pasar el cursor | `#EEF1F6` | `#19202D` |
| `--border` | Bordes y divisiones | `#E2E6EE` | `#242D3D` |
| `--border-strong` | Borde de campos y botones secundarios | `#CDD3DF` | `#344055` |
| `--fg` | Texto principal | `#0F1729` | `#EEF1F7` |
| `--fg-muted` | Texto secundario | `#4B5468` | `#AEB6C6` |
| `--fg-subtle` | Etiquetas, fechas, texto de ayuda | `#6B7489` | `#8A93A6` |
| `--accent` | Botón principal, enlaces, selección | `#2B54E0` | `#7D9BFF` |
| `--accent-hover` | Acento al pasar el cursor | `#2245C2` | `#9DB3FF` |
| `--accent-soft` | Fondo de selección y de estado "Enviada" | `#E8EEFF` | `#1A2547` |
| `--on-accent` | Texto sobre el acento | `#FFFFFF` | `#0A0E16` |
| `--success` / `--success-soft` | Aceptada, pagada | `#16794A` / `#E4F4EA` | `#4CC38A` / `#10291D` |
| `--warning` / `--warning-soft` | Pendientes | `#8F5400` / `#FFF1D6` | `#F0B54A` / `#2C210E` |
| `--danger` / `--danger-soft` | Rechazos, errores, acciones destructivas | `#C2312B` / `#FDECEB` | `#FF7D75` / `#331715` |

**Estados de la cotización** — cada uno con punto, texto y color, nunca solo color:

| Color | Estados |
|---|---|
| Neutro | Borrador, Vencida, Reemplazada (tachado) |
| Acento | Enviada, Vista |
| Ámbar | Pendiente de aprobación, Cambios solicitados, Pendiente de pago, Pendiente de anticipo, Pendiente de saldo |
| Verde suave | Aceptada, Anticipo pagado |
| Verde sólido | Pagada |
| Rojo | Rechazada internamente, Rechazada por el cliente |

### Tipografía

**Geist** para todo y **Geist Mono** para números de cotización y RUT. Montos siempre con cifras
de ancho fijo (`tabular-nums`) para que las columnas se alineen.

| Token | Tamaño | Peso | Uso |
|---|---|---|---|
| `text-3xl` | 38 px | 650 | Títulos de ingreso y onboarding |
| `text-2xl` | 30 px | 650 | Monto principal de una cotización |
| `text-xl` | 24 px | 600 | Título de pantalla |
| `text-lg` | 20 px | 600 | Título de panel o sección |
| `text-md` | 17 px | 500 | Subtítulos, texto destacado |
| `text-base` | 15 px | 400 | Texto general en escritorio |
| `text-sm` | 13 px | 400–600 | Tablas, botones, metadatos |
| `text-xs` | 12 px | 500–600 | Etiquetas en mayúscula (+0,08em de espaciado), insignias de estado |

Reglas: interlineado 1,55 en texto y 1,1–1,2 en títulos; títulos con espaciado de letras −0,02em;
**campos de formulario a 16 px** (el iPhone hace zoom si son más chicos); texto corrido a ~65
caracteres de ancho como máximo.

### Espaciado

Escala de 4 en 4: `4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64 · 80` px. Nada fuera de ella.
Separación entre secciones de una pantalla: 32–64. Relleno interno de tarjetas y paneles: 16–24.

### Radios

| Token | Valor | Uso |
|---|---|---|
| `r-xs` | 6 px | Etiquetas, teclas |
| `r-sm` | 10 px | Botones, campos, ítems de menú |
| `r-md` | 14 px | Tarjetas, avisos |
| `r-lg` | 20 px | Paneles, diálogos, hojas |
| `r-xl` | 28 px | Barras flotantes |
| `r-full` | — | Insignias de estado, interruptores, botón flotante |

### Sombras

| Token | Uso |
|---|---|
| `shadow-1` | Apoyado: botones, panel sobre fondo |
| `shadow-2` | Flotante: menús, vidrio, barra de navegación |
| `shadow-3` | Encima de todo: diálogos, botón flotante en móvil |

Valores en la vista previa; en oscuro las sombras son más densas porque el negro absorbe.

### Vidrio (Liquid Glass)

| Token | Claro | Oscuro |
|---|---|---|
| `--glass` | blanco al 62% | `#161C28` al 55% |
| `--glass-strong` (ítem activo dentro del vidrio) | blanco al 82% | `#161C28` al 78% |
| Desenfoque | 22 px, saturación 180% | igual |
| Borde | 1 px al 8% de opacidad + brillo interior de 1 px arriba | 1 px al 6% + brillo al 10% |

**Dónde va:** barra lateral y barra inferior flotantes, menús desplegables, selector de
organización, búsqueda `Ctrl + K`, avisos breves. **Dónde no:** tablas, formularios, detalle de
una cotización, cualquier cosa que se lea con atención.

**Respaldo:** si el navegador no soporta desenfoque, o el sistema pide "reducir transparencia", el
vidrio pasa a `--surface` opaca.

### Movimiento

| Token | Duración | Uso |
|---|---|---|
| `dur-fast` | 120 ms | Pulsar, pasar el cursor, cambiar un interruptor |
| `dur-base` | 200 ms | Abrir menús, cambiar de pestaña |
| `dur-slow` | 320 ms | Paneles laterales, hojas, avisos que entran |
| `dur-enter` | 480 ms | Entrada de pantallas de ingreso y onboarding |

Curva por defecto `cubic-bezier(.22, 1, .36, 1)` (salida suave, parecida a iOS). En Motion, el
resorte equivalente: rigidez 420, amortiguación 34. Al pulsar, un botón se achica al 97%.

**Fondos animados:** manchas de color difuminadas que se mueven lento (22–30 s por ciclo), **solo
en ingreso, onboarding y estados vacíos**. Con "reducir movimiento" quedan quietas y se apagan las
transiciones decorativas.

### Íconos

**Lucide**, trazo de 1,75, tamaño 18 px en escritorio y 20–24 px en móvil. Nunca emojis como
íconos.

### Disposición

| Ancho | Disposición |
|---|---|
| **Escritorio, desde 1.280 px** | Barra lateral flotante de vidrio (232 px, se puede contraer) · lista · detalle a la derecha (hasta 380 px), los tres a la vista |
| **Tableta, 768–1.279 px** | Barra lateral contraída a íconos · lista · el detalle se abre como panel lateral |
| **Teléfono, hasta 767 px** | Barra inferior flotante con cuatro destinos (Inicio, Cotizaciones, Clientes, Más) · botón flotante para la acción principal, abajo a la derecha · tablas convertidas en tarjetas · diálogos como hojas desde abajo |

Área táctil mínima de 44 × 44 px. Sin desplazamiento horizontal a 375 px.

---

## Por qué este documento existe

`/auditar` revisa cada pantalla contra este archivo antes de darla por terminada. Si está vacío,
la auditoría no tiene contra qué comparar y cada pantalla termina con valores inventados a mano.

---

## Lo que tiene que definir

| Sección | Qué fija | Estado |
|---|---|---|
| **Marca** | Nombre, logo, tono de voz | ⬜ Depende de la decisión pendiente 1 (dominio y marca) |
| **Color** | Paleta completa con sus valores, en claro y oscuro | ✅ Aprobado |
| **Tipografía** | Familias, escala de tamaños, pesos, licencia verificada | ✅ Aprobado |
| **Espaciado** | La escala, y que nada se escriba fuera de ella | ✅ Aprobado |
| **Radios y sombras** | Los valores permitidos | ✅ Aprobado |
| **Íconos** | **Una sola familia.** Nunca emojis como íconos | ✅ Lucide |
| **Componentes** | Botón, campo, tabla, tarjeta, aviso, modal, con sus estados | 🟡 Botón, campo e insignia aprobados; el resto al construir |
| **Los cuatro estados** | Cargando, vacío, error y sin conexión, diseñados para cada pantalla | ⬜ Se diseñan con cada pantalla |
| **Accesibilidad** | WCAG 2.1 nivel AA: contraste 4.5:1 en texto y 3:1 en interfaz | ✅ Colores calculados para cumplir; se verifica en cada pantalla |
| **Móvil** | Probado a 375px, área táctil de 44×44px, sin desplazamiento horizontal | ✅ Reglas definidas; se verifica en cada pantalla |

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
