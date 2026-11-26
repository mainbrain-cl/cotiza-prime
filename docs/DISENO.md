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
| **shadcn/ui** | Base de componentes (se copian al proyecto, no se instalan). Sus estilos base están copiados en `src/app/shadcn-tailwind.css` (2026-10-28); el paquete `shadcn` ya no es dependencia. Para agregar un componente: `npx shadcn@4.23.0 add <componente>` y **revisar el resultado** (ver la regla de abajo) | MIT | 4.23.0 | Solo lo que se usa | ✅ |
| **Radix UI** (`radix-ui`) | Lo que hay debajo de shadcn: menús, diálogos, accesibilidad | MIT | 1.6.7 | Por componente | ✅ |
| **Motion** (`motion`) | Animaciones y transiciones. Hoy lo usan el menú flotante (resorte de la magnificación) y los contadores del inicio, solo con sus valores de movimiento (sin componentes `motion.*`, para no cargar el motor completo). Dependencias que trae: `framer-motion`, `motion-dom` y `motion-utils`, las tres MIT | MIT | **14.0.0** (fija; verificada 2026-10-06) | Solo se incluye lo que se importa (`animate`, `useSpring`, `useTransform`, `useInView`) | ✅ |
| **Dock** (de React Bits, copiado a `src/components/react-bits/dock.tsx`) | Menú flotante vertical de la aplicación (escritorio y tableta). Adaptado: vertical, enlaces reales, vidrio y colores del sistema, sin magnificación con "reducir movimiento" ni con dedo | MIT + Commons Clause (React Bits) | Código de la rama principal, 2026-10-06 | Sin dependencias propias (usa Motion) | ✅ 2026-10-06 |
| **Spotlight Card** (de React Bits, `src/components/react-bits/spotlight-card.tsx`) | Tarjetas del resumen por estado del inicio, con foco de luz tenue; sobre superficie sólida | MIT + Commons Clause (React Bits) | 2026-10-06 | Sin dependencias, ~1 kB | ✅ 2026-10-06 |
| **Count Up** (de React Bits, `src/components/react-bits/count-up.tsx`) | Contadores del resumen por estado. Adaptado: el valor final viene escrito desde el servidor, puntos de miles, lectores de pantalla leen el valor final | MIT + Commons Clause (React Bits) | 2026-10-06 | Usa Motion; ~1 kB propio | ✅ 2026-10-06 |
| **Waves** (de React Bits, `src/components/react-bits/waves.tsx`) | Líneas onduladas de fondo en ingreso, registro y estados vacíos. Adaptado: sin dependencias (lienzo 2D), 30 cuadros por segundo, se detiene fuera de pantalla o en otra pestaña. Carga diferida; no se monta en teléfonos, con "reducir movimiento" ni en equipos con 4 GB de memoria o 4 núcleos o menos | MIT + Commons Clause (React Bits) | 2026-10-06 | Sin dependencias, ~3 kB, solo se descarga donde se usa | ✅ 2026-10-06 |
| **Lucide** (`lucide-react`) | Íconos — **la única familia** | ISC (algunos íconos de origen Feather, MIT) | 1.49.0 | Solo los íconos usados | ✅ |
| **qrcode-generator** (`qrcode-generator`) | Código QR del formulario público (`src/lib/intake/qr.ts`). Solo calcula la matriz de módulos; el SVG y el PNG se arman en nuestro código (el PNG con `sharp`, decisión 014). Sin dependencias propias | MIT | **2.0.4** (fija; verificada 2026-10-07) | ~555 kB en disco, ~20 kB que se cargan; solo en el servidor | ✅ 2026-10-07 |
| **jsQR** (`jsqr`) | Leer un QR en las pruebas, para comprobar que el código dice exactamente la dirección esperada (solo desarrollo; no se despliega) | Apache-2.0 | **1.4.0** (fija; verificada 2026-10-07) | ~280 kB en disco, sin dependencias | ✅ 2026-10-07 (última actualización: nov-2025) |
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
| **React Bits** | Fondos y efectos animados | **MIT + Commons Clause** | — | Por componente | ⚠️ Se puede usar dentro de Cotiza Prime (también comercialmente), pero **no revender ni redistribuir los componentes sueltos**. **Decisión 018 (2026-10-06, Aarón):** se usan sus componentes gratuitos para menú flotante, tarjetas, contadores y fondos; cada dependencia nueva se verifica antes de adoptarla. Los componentes se copian a `src/components/react-bits/` con su aviso de licencia (`LICENSE.md`). **No usados por sus dependencias** (2026-10-06): los fondos WebGL (Aurora, Particles, Galaxy, Silk…) traen `ogl` (Unlicense, ~420 kB sin comprimir) o `three`, y varios efectos traen `gsap` (licencia propia, no es MIT ni similar). Se eligió Waves, que no necesita ninguna |

### Regla de revisión después de cada `npx shadcn@4.23.0 add <componente>`

El comando se ejecuta una vez y no queda instalado, pero puede tocar archivos que no esperamos. Después de
cada `add`, antes de subir, se comprueba:

1. `package.json` **no gana** el paquete `shadcn` (decisión 015: ya no es dependencia) **ni paquetes nuevos**
   (por ejemplo `cn`) sin verificar antes su licencia, versión y vulnerabilidades (`npm audit`). Un paquete
   nuevo que el comando agregue por su cuenta se revisa o se quita; no se deja pasar en silencio.
2. `src/app/globals.css` **no vuelve a importar** `shadcn/tailwind.css`: sigue importando
   `./shadcn-tailwind.css` (la copia local).
3. Los componentes nuevos usan `cn` de `@/lib/utils`, no de un paquete externo.

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

**Dónde va:** menú flotante vertical y barra inferior flotante, menús desplegables, selector de
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
| **Escritorio, desde 1.280 px** | Menú flotante vertical de vidrio pegado a la izquierda (72 px, solo íconos; el nombre aparece al lado al pasar el ratón o tabular; decisión 018) · lista · detalle a la derecha (hasta 380 px), los tres a la vista |
| **Tableta, 768–1.279 px** | El mismo menú flotante vertical · lista · el detalle se abre como panel lateral |
| **Teléfono, hasta 767 px** | Barra inferior flotante con cuatro destinos (Inicio, Cotizaciones, Clientes, Más) · botón flotante para la acción principal, abajo a la derecha · tablas convertidas en tarjetas · diálogos como hojas desde abajo |

Área táctil mínima de 44 × 44 px. Sin desplazamiento horizontal a 375 px.

**Excepción: el constructor del formulario público** (`/formularios/[id]`). Su columna derecha (estado,
enlace y vista previa con la marca) mide **26 rem desde 1.280 px y 32 rem desde 1.536 px**, más ancha que
el panel de detalle de 380 px de arriba. Es a propósito: es una **vista previa** de lo que verá el cliente
final, que se lee mejor con un ancho parecido al de su pantalla; no es un panel de detalle. Dentro de la
vista previa hay un selector «Formulario / Al enviar» (la confirmación que ve quien envía).

---

## Componente: campo de código de 6 números (H-004a)

`src/components/auth/code-field.tsx`. Lo usan la pantalla del código tras la contraseña (`/ingresar/codigo`) y la de activar
la verificación (`/cuenta/seguridad`). Es un campo de texto normal del sistema (altura de 44 px en teléfono, 16 px de letra),
con:

- `inputmode="numeric"`, `autocomplete="one-time-code"` (el teléfono ofrece el código), `enterkeyhint="done"`,
  `spellcheck="false"` y `autocapitalize="off"`. **Sin `maxlength` corto:** pegar «123 456» tiene que funcionar (el servidor
  quita espacios y guiones y exige 6 números).
- Geist Mono con espaciado de letras amplio. Etiqueta «Código de 6 números» y ayuda «Son 6 números; cambian cada 30
  segundos.».
- Tras un error el campo queda vacío y el foco vuelve a él. Sin envío automático al escribir el sexto número: Enter o el
  botón.

Las pantallas de cuenta son «de trabajo»: tarjeta de superficie sólida sobre el fondo de ingreso, el vidrio queda para el
menú flotante. El código QR va en una `<img>` sobre fondo **blanco fijo con relleno** (se lee también en modo oscuro), con
texto alternativo, y la clave para escribir a mano en Geist Mono en grupos de 4. Con «reducir movimiento» no cambia nada
funcional (las animaciones de entrada y los fondos se apagan como en el resto de la aplicación).

## Componente: lista de códigos de respaldo (H-004b)

`src/app/cuenta/seguridad/recovery-codes-screen.tsx`. Se muestra **una sola vez** (al activar la verificación o al crear o generar
códigos nuevos) y es una pantalla de trabajo: tarjeta de superficie sólida, sin vidrio ni fondos animados.

- Título «Tus códigos de respaldo» (el foco llega a él) y el texto «Solo los verás esta vez. Cada código sirve una sola vez. Si pierdes tu teléfono, entra con uno.»
- La lista numerada en **Geist Mono**, sobre `--surface-2` con borde: **una columna en teléfono y dos desde 640 px**, sin desplazamiento horizontal a 375 px. Cada código en grupos de 4 con guion (`7KQM-3XHP-W2RT`).
- «Copiar todos» (uno por línea; cambia a «Copiados» y se anuncia a lectores de pantalla sin mover el foco) y «Descargar (.txt)» (el archivo se arma en el navegador con un `Blob`, **no lleva el correo** ni nada más de la cuenta).
- La casilla «Guardé estos códigos en un lugar seguro» y el botón «Listo», **deshabilitado hasta marcarla**. Área táctil de 44 × 44 px en la casilla, los botones y el «Listo».
- Los códigos solo viven en la memoria de la pantalla: nunca van en la dirección, el almacenamiento del navegador ni una cookie, y recargar la página los borra. Si la persona no confirma, `/cuenta/seguridad` lo recuerda («No confirmaste que guardaste tus códigos de respaldo») y ofrece «Generar códigos nuevos».

## Componente: confirmar con contraseña y código (H-004b)

Un patrón, no un archivo: se usa al activar la verificación (`/cuenta/seguridad`), al crear o generar códigos de respaldo y al desactivarla. Siempre sobre superficie sólida.

- **Contraseña.** Etiqueta «Tu contraseña», ayuda «La pedimos de nuevo para confirmar que eres tú.», `type="password"`, `autocomplete="current-password"`, letra de 16 px. Un campo de texto oculto (`sr-only`, `aria-hidden`, `tabindex="-1"`, `autocomplete="username"`, **sin `name`**: no viaja en el envío) lleva el correo para que el gestor de contraseñas complete solo. La contraseña nunca vuelve en el estado del formulario.
- **Código.** Al activar y al crear códigos, el campo de 6 números de arriba (`CodeField`). Al **desactivar**, un solo campo «Código de tu aplicación o código de respaldo» (`AnyCodeField`, `src/components/auth/any-code-field.tsx`): Geist Mono con espaciado amplio y en mayúsculas, 16 px, `autocomplete="off"`, `autocapitalize="characters"`, sin corrector y **sin `maxlength` corto** (pegar «7KQM-3XHP-W2RT» o «123 456» tiene que funcionar). En el ingreso, el código de respaldo tiene su propio campo (`RecoveryCodeField`).
- **Errores.** Una contraseña incorrecta se muestra en el campo de la contraseña y el foco vuelve a él; un código incorrecto, bloqueos y fallos del correo, como aviso del formulario. Tras un error el campo del código queda vacío y el foco vuelve a él. Un código de respaldo que no sirve da **siempre el mismo mensaje**, sin revelar si existía o ya se usó.
- **Botones.** Primario para confirmar; «Cancelar» fantasma, centrado debajo. En teléfono, a todo el ancho y de 44 px.

### El botón de peligro (desactivar la verificación)

«Desactivar la verificación en dos pasos» es un botón `variant="danger"` (`--danger-soft` con texto `--danger`; al pasar el cursor, `--danger` con `--on-accent`), tamaño `lg`, dentro de su propia sección «Desactivar la verificación» (separada por un borde superior) al final de «Seguridad de tu cuenta». **No desactiva nada al pulsarlo**: abre una tarjeta de superficie sólida (`--surface`, borde, `r-md`, relleno de 16 px) con la contraseña y el código, y un botón de confirmar también de peligro («Desactivar la verificación»). En teléfono es la misma tarjeta en la página (no una hoja que sube desde abajo: el proyecto aún no tiene un componente `Sheet`). «Cancelar» la cierra y devuelve el foco al botón que la abrió. Texto de la tarjeta: «Para confirmar que eres tú, escribe tu contraseña y un código. Al desactivarla cerramos tu sesión en tus otros dispositivos y te enviamos un aviso por correo.» Con «reducir movimiento» no cambia nada funcional.

## Componente: precio bloqueado y descuento máximo (H-041)

Dos piezas de pantalla de trabajo (superficie sólida, sin vidrio ni fondos animados), con Lucide y sin colores fuera de los tokens.

- **Precio bloqueado.** Ícono `Lock` de **16 px** en `--fg-muted`, siempre con texto. **Desviación anotada de la norma de íconos** (18 px en escritorio, 20 a 24 px en móvil, trazo 1,75): se deja en 16 px porque va en línea con el precio y con la etiqueta de la casilla, donde uno de 18 a 24 px desequilibra la línea; sigue siendo Lucide y nunca va solo (decisión de la revisión, 2026-11-17). En la lista del catálogo va junto al precio, con el texto «Precio bloqueado» oculto para lectores de pantalla (`sr-only`); en la ficha del servicio, igual. La casilla «Bloquear el precio» (servicio nuevo y editar) es una caja con borde que se tiñe con `--accent-soft` al marcarla: adentro, la etiqueta (cuadro de 20 px, alto de 44 px, ícono y «Bloquear el precio») y, **debajo de la etiqueta y fuera de ella** (para que el lector de pantalla no la lea dos veces), su ayuda enlazada con `aria-describedby` (id propio con `useId`): «Al cotizar, los Comerciales no podrán cambiar este precio, pero sí darle descuento hasta el descuento máximo de los Comerciales (hoy: 10 %). El Dueño y los Administradores sí pueden cambiar el precio, y queda registrado.» («hoy: sin tope» cuando no hay tope; sin el valor si no se pudo leer).
- **En el editor de la cotización.** Quien no se salta el candado (el Comercial) ve el precio en un campo de solo lectura (`readOnly`, fondo `--surface-2`, ícono `Lock` adentro a la izquierda) con la frase «Precio bloqueado por tu organización». Si el precio guardado difiere del precio de catálogo **con que se agregó la línea** (el que compara la regla), aparece el botón secundario «Usar el precio con que se agregó ($10.000)» que lo devuelve: va **a todo el ancho de la línea, debajo de la grilla de cantidad, precio, unidad e IVA** (`col-span-2`), con alto mínimo de 44 px y el texto puede cortarse en dos líneas, para no desbordar a 375 px. Si el catálogo hoy dice otra cosa, una frase pequeña debajo lo aclara («El catálogo hoy dice $12.000.»). El Dueño y el Administrador lo editan normal, con la ayuda «Precio bloqueado en el catálogo. Puedes cambiarlo; quedará registrado.» (`--fg-muted`, 12 px). Junto a cada descuento de línea y al descuento global, «Máximo 10 %» (o «Tu organización no permite descuentos» con tope 0) en `--fg-muted`, solo para quien tiene tope; el error por línea sale en `--danger` bajo el campo, y mientras haya uno, «Guardar cotización» queda apagado («Corrige los datos marcados para poder guardar.»). Si no se pudo leer el tope, junto al descuento general dice «No pudimos leer el descuento máximo de tu organización. Lo revisamos igual al guardar.» en vez de callar como si no hubiera tope. Un error que manda el servidor (las reglas cambiaron desde que se abrió la cotización) se muestra igual junto a la línea y se va en cuanto se cambia algo; el aviso general dice qué regla fue (precio bloqueado, descuento sobre el máximo, servicio no permitido).
- **Tarjeta «Descuento máximo de los Comerciales»** (arriba de la lista del catálogo). Superficie sólida con borde y `r-lg`; un campo de porcentaje (16 px, 44 px de alto en teléfono, `%` fijo a la derecha, ancho máximo de 12 rem desde tableta), la frase en vivo «Así quedará» sobre `--surface-2` (`aria-live="polite"`) y el botón secundario «Guardar descuento máximo»; si hay servicios con el precio bloqueado y no hay tope, sobre la frase en vivo un aviso breve en `--warning-soft` («Hay servicios con precio bloqueado y no hay tope: los Comerciales pueden darles cualquier descuento.») (apagado mientras no haya cambios, «Guardando…» al guardar, aviso de éxito con Sonner). Vacío = «Sin tope»; con 0, «Los Comerciales no podrán dar ningún descuento.». Sin conexión, el aviso estándar y el error «No pudimos comunicarnos con el servidor» conservan lo escrito. Quien no maneja el catálogo la ve en solo lectura (campo apagado, sin botón y la frase «Solo el Dueño y los Administradores pueden cambiarlo.»).

## Componente: textos de la cotización e «Insertar texto guardado» (H-048b)

Dos piezas de pantalla de trabajo (superficie sólida; el vidrio solo en el menú desplegable, como pide la regla de arriba), con Lucide y sin colores fuera de los tokens.

- **Los cuatro campos de texto del editor**, en el orden del PDF: «Observaciones», «Condiciones comerciales», «Exclusiones» y «Notas al pie», todos «(opcional)», cada uno con su contador «x / 4.000» (`--fg-subtle`; en `--danger` si pasa) y su pista de una línea («Solo texto.»). El error de largo sale bajo el campo con el nombre del campo («Las exclusiones son demasiado largas…») y el campo queda `aria-invalid`.
- **Botón «Insertar texto guardado»** (`src/components/snippets/insert-snippet-menu.tsx`): secundario, tamaño `sm` (44 px en teléfono), junto a la etiqueta del campo (en teléfono baja a la línea siguiente, a la izquierda y con su ancho natural). Su nombre accesible dice el campo («Insertar texto guardado en Exclusiones»). Aparece en Condiciones, Exclusiones y Notas al pie; las observaciones no tienen tipo de texto guardado propio. No aparece cuando la cotización ya no se puede editar. «Crear textos en Configuración» / «Administrar textos» se abre en **otra pestaña** (el editor no guarda solo: navegar ahí perdería lo que está sin guardar).
- **El menú** (`menu-popup glass`, hasta 24 rem de ancho y 60 % del alto de la pantalla, con desplazamiento propio): un renglón de 44 px por texto, con el nombre en negrita y debajo un extracto de una línea. Un texto que **ya está en el campo** (como línea completa: «No incluye IVA» no cuenta como agregado dentro de «No incluye IVA ni transporte.») queda apagado con «Ya agregado»; uno que **haría pasar de 4.000** queda apagado y dice «No cabe: quedaría con 4.312 caracteres (máximo 4.000)». Elegir uno lo agrega **al final**, separado por una línea en blanco, y lo anuncia a los lectores de pantalla («Texto agregado al final del campo.»). Sin textos guardados dice «Aún no hay textos guardados»; quien administra los textos ve además «Crear textos en Configuración», y el resto «El Dueño o un Administrador los crea en Configuración». Si no se pudieron leer, lo dice («No pudimos cargar los textos guardados») en vez de mostrarse como vacío. El menú **no escribe nada en la base**: solo cambia el campo (se guarda con «Guardar cotización»).
- **«Usar un texto guardado» en Enviar:** un selector nativo (`Select`) con el botón secundario «Usar este texto» al lado (en teléfono, debajo), sobre el texto del correo. Elegir en la lista **no cambia nada**: lo cambia el botón (así, con el teclado, las flechas recorren la lista sin reemplazar el correo). La lista trae «Texto de siempre» (el de partida del sistema, para poder volver a él) y los textos guardados, con el inicial marcado «(texto inicial)». Si la persona había cambiado el texto, antes aparece una tarjeta de aviso en `--warning-soft` («Cambiaste el texto del correo. Si eliges «…», se reemplaza lo que escribiste.») con «Reemplazar el texto» (el foco pasa a él al aparecer) y «Mantener lo que escribí» (el foco vuelve a la lista). Si queda una variable `{{ }}` sin completar, un aviso en `--warning-soft` lo dice y «Enviar» queda apagado.
- **Lo que ve el cliente final:** en el PDF, «EXCLUSIONES» y «NOTAS» con el mismo estilo de los demás bloques, en el orden OBSERVACIONES, CONDICIONES, EXCLUSIONES, FORMA DE PAGO, NOTAS (las notas al final de la lista y no en el pie fijo de cada página; aprobado por Aarón el 2026-11-23); en la página del cliente, «Exclusiones» y «Notas» como texto simple, sin HTML.

## Componente: servicios que puede cotizar (H-042)

Dos piezas de pantalla de trabajo (superficie sólida, sin vidrio ni fondos animados), con Lucide y sin colores fuera de los tokens.

- **La sección «Servicios que puede cotizar»** (`src/components/team/catalog-scope-form.tsx`), en la ficha de un miembro (`/o/[tenantId]/equipo/[memberId]`, solo quien maneja el equipo), debajo de los datos de la persona: tarjeta de superficie sólida con borde y `r-lg`. Arriba una frase con **cómo está HOY la regla guardada** («Carla puede cotizar todos los servicios» o «Carla puede cotizar 3 servicios: A, B y C»; con más de tres, «A, B, C y 2 más»; `aria-live="polite"`). Debajo, **dos opciones de 44 px de alto** (radios nativos de 20 px con `accent`, una tarjeta con borde cada una y la elegida en `--accent-soft`): «Todos los servicios del catálogo» («Incluye los que agregues después.») y «Solo los que elijas» («Los servicios nuevos no se suman solos.»; apagada si el catálogo no tiene servicios activos).
- **Con «Solo los que elijas»:** un buscador (`type="search"`, 16 px), el contador «3 de 42 elegidos» (`aria-live`), los botones secundario `sm` «Marcar los que se ven» y fantasma `sm` «Desmarcar todos» (44 px en teléfono), y la lista en una caja con borde y desplazamiento propio (`max-h-80`, enfocable por teclado): un renglón de 44 px por servicio con casilla de 20 px, nombre y, a la derecha (en teléfono, debajo), «unidad · $precio» en `--fg-muted` con cifras de ancho fijo. **Los servicios elegidos que hoy están desactivados** salen aparte, bajo «Desactivados en el catálogo (no se pueden cotizar)», para poder quitarlos. Sin elegir ninguno, aviso en `--danger` («Elige al menos un servicio. Si esta persona no debe cotizar, cambia su rol a Observador.») y «Guardar» apagado.
- **Pie de la sección:** «Las líneas escritas a mano no se limitan.» (la verdad de D2: la regla ordena, no controla), «Cambiado por Ana el dd-mm-aaaa» (o «por ti» recién guardado) y el botón «Guardar» (a todo el ancho en teléfono; «Guardando…» y apagado mientras guarda; apagado también sin conexión, con el aviso estándar `OfflineNotice`). Al guardar, aviso breve (Sonner): «Listo: Carla solo puede cotizar 3 servicios.». Un error (versión vieja, miembro que ya no está…) sale como alerta dentro de la sección y **se conserva lo elegido**.
- **Para un rol al que no se limita** (Dueño y Administrador: «Su rol no tiene límite de servicios.»; Aprobador y Observador: «Su rol no cotiza.»), en vez de controles solo ese texto; si quedó una lista guardada de antes (D4), agrega «Tiene una lista guardada que se aplicará si vuelve a ser Comercial.». Los cuatro estados: cargando (el esqueleto de la ficha), vacío («Tu catálogo no tiene servicios activos», con enlace al catálogo), error («No pudimos cargar los servicios. Recarga la página en unos minutos.») y sin conexión.
- **En el editor de la cotización** (solo para quien tiene lista): sobre el buscador, un aviso con el ícono `Info` de Lucide (18 px): «Ves solo los servicios que tu organización te permite cotizar.»; sin ningún servicio permitido, «No tienes servicios del catálogo para cotizar. Pide a un Administrador que te asigne servicios. Puedes agregar una línea libre.» (no «Tu catálogo no tiene servicios activos», que sería falso); una búsqueda sin resultados dice «Ninguno de tus servicios coincide con ese nombre.». **Una línea que la cotización ya tenía** de un servicio que salió de su lista **se conserva y se puede editar**, con un aviso junto a la línea («Este servicio ya no está entre los que puedes cotizar. La línea se conserva.», en `--fg-muted`). Si el servidor rechaza una línea **nueva** porque le cambiaron la lista con el editor abierto, el error sale junto a la línea («Ya no puedes cotizar este servicio: un Administrador cambió tu lista. Quita la línea para guardar.») y la lista de servicios se vuelve a pedir sola, una vez por cada contenido fallido.
- **En convertir una solicitud** (panel «Solicitud original»): el aviso de servicios que no se cargaron ahora dice que ya no están activos «o no están entre los servicios que puedes cotizar».

## Componente: el registro en dos pasos (H-116)

Tres pantallas de ingreso (`/registro`, `/confirmar-correo` y `/crear-cuenta`): tarjeta de superficie sólida sobre el fondo animado de ingreso (`AuthCard`), con la marca arriba, Lucide, sin colores fuera de los tokens y sin vidrio en la tarjeta. Las tres llevan los **pasos** y comparten el patrón de las pantallas de cuenta (campo de 44 px y 16 px, botón principal a todo el ancho, aviso `FormAlert`).

- **Pasos** (`src/components/auth/flow-steps.tsx`): dos barras (`h-1.5 w-8`, `--accent` la del paso actual y las anteriores, `--border-strong` las que faltan) y el texto «PASO 1 DE 2 · TU CORREO» en `text-xs` mayúscula con +0,08em, `--fg-subtle`. Las barras son decorativas (`aria-hidden`): el texto dice el paso, así que no depende del color. `/registro` y `/confirmar-correo` son el paso 1; `/crear-cuenta`, el paso 2.
- **`/registro`** (solo el correo): campo «Correo» (foco al abrir), la prueba anti-robot (el mismo `AntibotWidget` del formulario público; se vuelve a montar tras cada envío), la nota de privacidad y «Enviarme el enlace». **Al enviar** la tarjeta pasa a «Revisa tu correo»: ícono `MailCheck` sobre `--success-soft`, el correo en negrita (`[overflow-wrap:anywhere]`, nunca corta una palabra salvo que no quepa), el plazo y la frase de «si ya tenías una cuenta», más tres enlaces de 44 px (Ingresar, «¿Olvidaste tu contraseña?» y «¿No te llegó? Pedir otro enlace», que vuelve al formulario). La respuesta es la misma exista o no la cuenta y tarda al menos 0,8 s. Estados: cargando («Enviando…»), error (en el campo o aviso general, p. ej. «Demasiados intentos»), sin conexión (aviso estándar) y enviado.
- **`/confirmar-correo`**: título «Confirma tu correo», recuadro `--accent-soft` («Al continuar confirmamos que este correo es tuyo. El enlace sirve una sola vez.») y un solo botón «Continuar». **Abrir la página no gasta el enlace**: solo el clic. Si el enlace falta, está mal o ya no sirve: ícono `Link2Off` sobre `--warning-soft`, «Este enlace ya se usó o venció», «Pedir un enlace nuevo» y, debajo de una línea, la ayuda de quien ya confirmó su correo («Si ya habías confirmado tu correo, usa «¿Olvidaste tu contraseña?»…») con los enlaces «¿Olvidaste tu contraseña?» e «Ingresar». Si falló otra cosa (sin red, servidor), aviso y el mismo botón para reintentar. Estados: cargando («Confirmando…»), error, vencido y sin conexión.
- **`/crear-cuenta`**: título «Termina de crear tu cuenta». Arriba, un **recuadro destacado** (`--accent-soft`, `r-md`) con `MailCheck`, «Estás creando la cuenta de» y el **correo en negrita en su propia línea** (13 px en teléfono, 17 px desde tableta, `[overflow-wrap:anywhere]`), y debajo «¿No es tu correo? Salir» (botón de texto de 44 px que cierra la sesión): así quien abre un enlace ajeno lo nota. Después «Tu nombre», «Contraseña» (ayuda «Mínimo 10 caracteres.») y «Repite la contraseña», la casilla «Mostrar las contraseñas» (casilla nativa de 44 px, fuera del formulario a propósito: si no, React la desmarcaría al terminar una acción con las contraseñas aún a la vista) y la casilla de términos y privacidad. Tras un error los campos de contraseña quedan vacíos, el nombre y la casilla de términos se conservan (salvo si cambiaron los términos: hay que aceptarlos de nuevo). Estados: cargando («Creando tu cuenta…»), error por campo o aviso, sin conexión, y **vencido** (sin sesión o con una sesión que no nació del enlace): ícono `TimerOff`, «Tu enlace venció», «Pedir un enlace nuevo» (o «Cerrar sesión y pedir un enlace nuevo» si hay una sesión que cerrar) y la misma ayuda de quien ya confirmó su correo.
- **`/registro` bloqueado** (registro público de Supabase abierto en producción, `signup-open-guard`): la misma tarjeta, sin el paso ni el formulario; título «El registro no está disponible por ahora», una frase en `--fg-muted` y un enlace «Ingresar» de 44 px de alto. Sin ícono de error ni color de alerta: no es culpa de quien llega.
- **`/ingresar`** agrega, bajo el formulario y separado por una línea, la ayuda «¿Empezaste a crear tu cuenta y no la terminaste?…» con el enlace «Crear cuenta».
- **Reglas**: ningún texto promete algo que no exista (no se dice «ya tienes cuenta» ni se nombra la contraseña elegida); el correo de la cuenta solo se muestra en `/crear-cuenta`, a su dueña; con «reducir movimiento» no cambia nada funcional.

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
| **Componentes** | Botón, campo, tabla, tarjeta, aviso, modal, con sus estados | 🟡 Botón, campo e insignia aprobados; «campo de código de 6 números» construido (H-004a, abajo); el resto al construir |
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
