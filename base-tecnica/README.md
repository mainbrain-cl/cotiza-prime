# Base Técnica — Main Brain

La base que se copia a **cualquier proyecto nuevo** de la agencia, sin importar el rubro.

Aquí vive lo que **no cambia** entre proyectos. El diseño, las reglas de negocio y la arquitectura específica se definen en cada proyecto por separado.

---

## Los cuatro documentos

| Documento | Manda en |
|---|---|
| **`STACK.md`** | Con qué se construye, entornos, datos, caché, rendimiento, despliegue, y cómo dejar el proyecto listo para acoplarse después |
| **`SEGURIDAD.md`** | Identidad, cifrado, OWASP, secretos, accesos, auditoría, incidentes |
| **`LEGAL.md`** | País, datos personales, propiedad intelectual, contratos, sitios públicos |
| **`PROCESO.md`** | Cómo se construye: plan, historias, sprint, compuertas |

Y en **`comandos/`**, los cinco comandos guiados que ejecutan ese proceso.

---

## Cómo se usa en un proyecto nuevo

**1.** Copia los cuatro documentos como `docs/00-base/` dentro del repositorio del proyecto nuevo, y la carpeta `comandos/` como `.claude/commands/`.

**2.** En el `CLAUDE.md` de la raíz, impórtalos:

```
@docs/00-base/STACK.md
@docs/00-base/SEGURIDAD.md
@docs/00-base/LEGAL.md
@docs/00-base/PROCESO.md
@docs/PROYECTO.md
@docs/DISENO.md
```

**3.** Crea los dos documentos propios del proyecto:

- **`PROYECTO.md`** — qué es, para qué país, su marca, sus dominios, sus reglas de negocio y su terminología.
- **`DISENO.md`** — su identidad visual. Este cambia completamente entre proyectos.

**4.** Responde la primera pregunta antes de planificar nada: **¿para qué país es?**

**5.** Sigue el proceso con los comandos, en este orden:

```
/plan  →  ⛔  →  /historias  →  ⛔  →  /sprint  →  ⛔  →  construir
```

Las compuertas son aprobaciones tuyas. Un agente de IA no las cruza solo.

---

## Reglas que vienen incluidas

Al importar estos documentos, cualquier agente de IA que trabaje en el proyecto queda obligado a:

- **Preguntar el país** antes de planificar, sin asumirlo nunca.
- **Declarar el entorno** (🟢 pruebas / 🔴 producción) antes de tocar la base de datos, y pedir confirmación explícita si es producción.
- **Nunca copiar datos reales** a entornos de prueba.
- **Nunca dejar secretos** en el código o el repositorio.
- **No cruzar las compuertas** del proceso sin aprobación escrita.
- **Incluir `tenant_id` en toda tabla** desde el inicio, aunque haya un solo cliente.
- **Traducir todo término técnico** en la misma frase, porque el equipo no son desarrolladores profesionales.

---

## Precedencia

Cuando dos documentos se contradicen, manda el más específico **solo si es más estricto**:

```
PROYECTO.md  →  más específico
STACK / SEGURIDAD / LEGAL  →  la base
```

Un proyecto puede ser **más exigente** que la base. Nunca menos. Si necesita relajar un control, requiere decisión registrada que explique por qué.

---

## Cómo se mantiene

Esta base **no se edita dentro de un proyecto.** Si una regla mejora, se corrige aquí y se propaga a los proyectos.

Cuando una regla se cambia:

1. Se registra la decisión: qué cambió, cuándo y por qué.
2. Se sube la versión en el frontmatter de ese documento.
3. Se avisa al equipo, porque afecta a todos los proyectos.

## Si el proyecto puede acoplarse a otro más adelante

Un proyecto puede nacer suelto y años después volverse módulo de una plataforma mayor. **§5b de `STACK.md`** explica las cuatro decisiones que hay que tomar el primer día para que esa mudanza sea barata, y las que sí pueden esperar.

Resumen: `tenant_id` en toda tabla, `/api/v1/` en las direcciones, y la identidad y la resolución del cliente en un solo archivo cada una. Lo demás se agrega cuando de verdad se conecte.

---

> **Nota.** Hoy esta base se copia manualmente a cada proyecto. Cuando haya tres o más proyectos usándola, conviene moverla a su propio repositorio para que la actualización sea automática en vez de manual.
