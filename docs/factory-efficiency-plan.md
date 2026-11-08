# Plan de eficiencia del pipeline Factory

Fecha: 2026-11-01. Alcance: los 8 roles (`.claude/agents/eminzo-*.md`, que Codex reutiliza
vía `.codex/agents/*.toml`), las dos skills orquestadoras (`.claude/skills/eminzo-factory`,
`.agents/skills/eminzo-factory`), `factory/config.json`, y el historial de los jobs 013 a 040.

Objetivo: menos rondas, menos tokens y menos minutos por job, **sin bajar** la
calidad, la seguridad ni las garantías del pipeline (gate determinista, revisión
por lentes, escalamiento humano).

**Alcance de las mejoras: agnósticas al repositorio.** La factory se va a compartir
con otras células para que la usen en sus propios repos. La **evidencia** (secciones
2 y 3) sale de este repo porque es donde corrió la factory, pero **cada mejora se
diseña para el motor** (skills, roles y scripts), no para este proyecto. Lo que
cambia de un repo a otro (stack, comandos, cómo se levanta la UI, idiomas, rama
base) lo declara cada repo en su **adaptador**. Ver la regla de diseño al
comienzo de la sección 4.

---

## 1. Resumen ejecutivo

- **El costo no está en construir: está en las rondas extra.** 13 de 24 jobs Claude
  con costo registrado (54 %) necesitaron 2 o más rondas. Un job de 1 ronda cuesta
  en promedio **$2.97**. Si los multi-ronda hubieran salido en 1, el gasto habría
  bajado unos **$32 de $103 (≈31 %)** (estimación: costo real de los jobs
  multi-ronda menos 13 × $2.97).
- **El lente UI genera el 65 % de los bloqueos de los agentes** (20 de 31 `CHANGES`
  no humanos). Casi todos son problemas medibles: overflow o texto cortado en un
  ancho concreto, contraste bajo WCAG o solapamiento de elementos. Se encuentran
  **después** de construir, y el revisor los mide a mano con Chrome headless (hasta
  58 tool calls y unos 10 minutos por revisión).
- **El lente UX no bloqueó nunca**: 0 `CHANGES` en 52 ejecuciones desde el job 013,
  y aun así corre con sonnet en todas las rondas.
- **Un cambio trivial paga la ceremonia completa.** Cambiar un texto lanza 7
  agentes: intake, spec (opus), builder, 3 revisores y approver (opus). Los jobs
  de solo texto más baratos (026, 031, 033) costaron entre $1.18 y $1.47, y eso es
  solo lo que cuentan los subagentes: **las tokens de la sesión orquestadora
  (`/factory` en Claude, `$factory` en Codex) no se miden**, así que el costo real
  es mayor. Ver P0-6 (carril XS).
- **Los revisores repiten trabajo en cada ronda**: los lentes que ya dieron PASS
  vuelven a revisar todo, y el lente UI encuentra problemas *nuevos* en cada ronda
  (job 024: 5 rondas y $12.01; job 025: 4 rondas).
- **No hay manera de corregir la spec.** El job 040 (un cambio de unas 10 líneas)
  hizo 3 rondas y terminó escalado. UI exigía cambiar el layout que pedía la spec y
  code exigía respetarla al pie de la letra, y el builder quedó en medio.
- **Fallas de protocolo que queman rondas o reintentos**: agentes que terminan sin
  escribir su archivo (3 veces en una sesión) y builders Codex que entregan con el
  gate en rojo (jobs 035 y 036: rondas perdidas en `GATE: FAIL`).
- **`factory/project.md` está desactualizado** (snapshot del job 007). No describe
  el dashboard ni la oficina, que concentran la mayoría de los jobs recientes, así que cada
  agente vuelve a explorar `factory/dashboard.html` (1112 líneas).

---

## 2. Evidencia

### 2.1 Costo por cantidad de rondas (jobs Claude con costo)

| Rondas | Jobs | Costo promedio | Costo total |
|---|---|---|---|
| 1 | 11 | $2.97 | $32.66 |
| 2 | 6 | $4.80 | $28.82 |
| 3 | 5 | $4.43 | $22.17 |
| 4 | 1 | $7.40 | $7.40 |
| 5 | 1 | $12.01 | $12.01 |

### 2.2 Bloqueos por lente (jobs 013 a 040)

| Lente | Ejecuciones | `CHANGES` | Tasa | Modelo actual |
|---|---|---|---|---|
| ui | 53 | 20 | 38 % | haiku (en el frontmatter, sonnet) |
| code | 55 | 10 | 18 % | haiku (low) / sonnet |
| ux | 52 | **0** | **0 %** | sonnet |
| security | 9 | 1 | 11 % | opus |
| human | 8 | 8 | — | — |

### 2.3 De qué se tratan los bloqueos UI (extraído de cada `review-ui.md`)

| Tipo | Jobs | ¿Se puede detectar con un script? |
|---|---|---|
| Overflow o texto cortado en un ancho concreto (390, 768, 1024, 1440 px) | 016, 021, 023, 030, 037 (×5), 038 (×2), 040 (×2) | Sí: `scrollWidth > clientWidth` y bounding boxes |
| Contraste bajo WCAG AA | 019, 024 (×3), 025, 037 | Sí: colores computados |
| Solapamiento (burbujas, labels, muebles, tokens) | 024 (×5), 025, 039 | Sí: intersección de rectángulos |
| Especificidad CSS que pisa `hidden` o colores | 030 | Parcial (estilo computado) |

Conclusión: casi todo lo que bloquea el lente UI es **geometría y color medibles**.
Hoy se descubre tarde, a mano y de a un ancho por ronda.

### 2.4 Anatomía del job 040 (pedido simple, 3 rondas, escalado)

1. La spec exigía literalmente que el valor del tile fuera `$91.58 + 4 N/D`, sin
   ninguna restricción de viewport.
2. R1: UI bloquea, porque el tile se desborda a 1024 y 390 px.
3. R2: el builder mueve `4 N/D` al label. UI pasa y code bloquea porque eso no es
   lo que dice la spec.
4. R3: el builder refactoriza. Code (haiku) vuelve a bloquear por el mismo motivo.
5. El approver escala. Al final, el humano mergeó lo que se había construido.

Comparación: los jobs low-risk 026, 031 y 033 salieron en 1 ronda por $1.18 a
$1.47 y en 7 a 10 minutos. El 040 costó $3.26 y tardó 36 minutos. La causa no fue
la complejidad, sino **tres huecos de proceso**: la spec no pedía validar viewports,
el builder no tenía cómo pedir un cambio de spec y no había regla para resolver un
conflicto entre lentes.

### 2.5 Paridad Claude ↔ Codex

| Aspecto | Claude | Codex | Efecto |
|---|---|---|---|
| Instrucciones de rol | `.claude/agents/eminzo-*.md` | El `.toml` apunta al mismo `.md` | ✅ una sola fuente de verdad |
| Checks antes de terminar | Hook `Stop` → `bin/nudge` | **No hay equivalente** | Jobs 035 y 036 entregaron `READY` con el gate en rojo: 1 y 2 rondas perdidas |
| Builder entre rondas | Se retoma (`SendMessage`) y conserva el contexto | **Se lanza un builder nuevo por ronda** | Cada ronda Codex vuelve a leer todo |
| Modelos | spec-writer opus | spec-writer `gpt-6-luna` (el barato) | Asimetría: en Claude, la spec cuesta lo mismo para un rename que para un cambio high-risk |
| Costo | Calculado | 4 jobs con "Cost unavailable" | No se puede comparar la eficiencia entre proveedores |
| Reviewers | Solo los ruteados | Job 036 (`surfaces: none`, ruteado solo `code`) tiene `review-ui` y `review-ux` en R3 | Posibles reviewers lanzados de más; **verificar** |

---

## 3. Diagnóstico: causas raíz, por impacto

1. **La validación visual llega tarde y es manual.** El builder no verifica la UI
   en distintos viewports; el revisor UI lo descubre después y de a pedazos.
2. **Las re-revisiones no tienen alcance acotado.** En la ronda N, todos los lentes
   revisan todo de nuevo y pueden levantar bloqueos nuevos sobre código que no
   cambió (efecto "whack-a-mole").
3. **La spec es rígida.** No hay protocolo de enmienda, y cada revisor la interpreta
   distinto (literal o por intención).
4. **Se aplica la misma ceremonia a cualquier riesgo.** Un rename de label pasa por
   intake (fable), spec (opus), builder, 3 revisores y approver (opus).
5. **Los contratos de salida no se hacen cumplir.** Que el archivo exista depende de
   que el modelo "se acuerde"; solo `review-ui.md` tiene un paso de auto-verificación.
6. **Contexto compartido viejo.** `project.md` desactualizado más un monolito de
   1112 líneas hacen que cada agente redescubra el dashboard.

---

## 4. Mejoras propuestas

Cada mejora indica el problema, el cambio, el impacto esperado, el tradeoff y la
métrica para validarla. Las prioridades: **P0** = mayor retorno con menor riesgo;
**P1** = ahorro relevante; **P2** = estructural o de exploración.

### Regla de diseño: motor agnóstico, adaptador por repo

> El agente sabe hacer su oficio; el repo le dice dónde está parado.

| Capa | Qué contiene | Quién la mantiene |
|---|---|---|
| **Motor** | Skills (`/factory`, `$factory`), los 8 roles, `bin/*`, `lib/*`, el dashboard y los tests del propio motor | Dueño de la factory, con versiones |
| **Adaptador** | `factory/project.md`, `factory/checks.sh`, `factory/config.json` (base, idioma, proveedor, modelos, `auto_merge`, `visual`, `protected_tests` propios) | Cada célula, en su repo |
| **Estado** | `factory/jobs/`, `board.json`, `.worktrees/` (gitignored) | Generado |

Reglas:

- Ningún rol, skill ni script del motor nombra archivos, stacks, comandos,
  idiomas, viewports ni ramas de un repo concreto. Lee esos datos del adaptador o
  los recibe en el prompt.
- Si una mejora necesita un dato del proyecto, se agrega como **campo del
  adaptador con un valor por defecto seguro**. Si el repo no lo declara, la
  capacidad se desactiva; no se adivina.
- Lo que solo sirve para este repo va al **backlog de este repo** (sección 4.4),
  no al motor.

Esquema del adaptador que introducen las mejoras (`factory/config.json`):

```json
{
  "base": "origin/main",
  "language": "es",
  "default_provider": "claude",
  "visual": {
    "start": "npm start",
    "ready_url": "http://localhost:{port}/",
    "pages": ["/"],
    "viewports": [390, 768, 1024, 1440],
    "locales": ["en", "es"],
    "locale": { "param": "lang" },
    "themes": ["light", "dark"],
    "theme": { "media": "prefers-color-scheme" },
    "fixture": null
  },
  "code_index": { "enabled": false, "provider": "codebase-memory-mcp" },
  "review_paths": { "ui": ["src/**/*.css", "web/**/*.html"] },
  "lanes": { "xs": { "reviewers": ["code"], "spec": false, "approver": "script", "max_lines": 80 } },
  "approve": { "deny": ["infra/**", "src/billing/**"] }
}
```

`approve.deny` (opcional, P1-1) agrega globs a la lista que el approver por script nunca
aprueba solo (resultado no concluyente, decide el LLM). La lista por defecto del motor ya
cubre `.github/**`, `.claude/**`, `.agents/**`, `.codex/**`, `factory/bin|lib|roles|templates/**`,
`factory/config.json`, `factory/checks.sh`, `factory/project.md` y los archivos de CI de las
plataformas comunes. La lista por defecto incluye también las superficies de ejecución (`.npmrc`, `.yarnrc*`,
`.husky/**`, `Makefile`, `Dockerfile*`, `docker-compose*`, `.gitattributes`, `.gitmodules`,
`.env*`, `*.config.{js,cjs,mjs,ts}`, `.eslintrc*`, `babel.config.*`, `tsconfig*.json`); el
match de globs ignora mayúsculas. `lanes.xs.spec` debe ser `false`: el carril XS no tiene
etapa de spec. `lanes.xs.max_lines` (por defecto 80) topa las líneas agregadas más borradas
fuera de tests. El approver por script toma el alcance del `## Scope` de intake en XS y del
`## Design` del spec en el carril normal, solo de ítems de lista o filas de tabla con rutas
exactas entre backticks; una línea con negación (`not`, `do not`, `don't`, `without`,
`except`) se ignora. Límite conocido: una negación que la regex no conoce igual lista la ruta.

`review_paths` (opcional, P0-3) asigna globs a un lente. Con el campo, desde la ronda 2
un lente que ya pasó vuelve a correr solo si el diff de la ronda toca esos archivos: así
un repo opta por el ahorro. Sin el campo, el motor es conservador: el lente vuelve a
correr siempre que el diff toque cualquier archivo fuera de documentación y tests. En
ambos casos también vuelve a correr si el diff toca un archivo que su última revisión
cita (`path:line`).

Campos de `visual` (implementados en `factory/lib/visual.js`):

| Campo | Significado |
|---|---|
| `start`, `ready_url` | Comando (corre con `sh -c` en el worktree del job, `PORT` en el entorno) y URL a esperar; `{port}` se reemplaza en ambos. |
| `pages`, `viewports`, `locales`, `themes` | La matriz. Sin `locales` o `themes` esa dimensión no se aplica. |
| `locale` | Cómo aplicar un idioma: `{"param": "lang"}` (parámetro de URL), `{"header": true}` (`Accept-Language`) o `{"json": {"url": "board.json", "key": "language"}}` (fija una clave en un JSON que la página pide). Obligatorio con más de un idioma. |
| `theme` | Cómo aplicar un tema: `{"media": "prefers-color-scheme"}` (emulación; los temas se llaman como el valor del media feature) o `{"attribute": "data-theme"}` (atributo de `<html>` tras cargar). Obligatorio con más de un tema. |
| `fixture` | `null` o `{"url": "board.json", "file": "ruta/en/el/repo.json"}`: el archivo responde a los pedidos cuyo path termina en `url`. |
| `max_points` (48), `budget_ms` (120000), `ready_timeout_ms` (30000), `page_timeout_ms` (15000), `settle_ms` (300) | Topes de tiempo y de tamaño de la matriz; al cortar, el informe lo dice. |

Estados de `visual.md` (primera línea): `PASS`; `FAIL` solo cuando al menos un punto
renderizó y mostró overflow, contraste, solapamiento o animación bajo reduced motion (una
página que no carga entre otras que pasan también cuenta); `SKIPPED` (sin bloque `visual`,
sin Chrome o sin `puppeteer-core`); `ERROR` para todo fallo de entorno que el builder no
puede arreglar (bloque inválido, fixture ausente, `start` que sale o no responde a tiempo,
el navegador no arranca, el runner se cuelga o no escribe informe, ningún punto renderizó).
`SKIPPED` y `ERROR` llevan una línea `Reason:`; ninguno bloquea el gate, que anota
`Visual check: ERROR (not blocking)` en `checks.md`. El revisor UI mide por su cuenta
con `SKIPPED` o `ERROR`; el builder solo corrige `FAIL`.

Límites conocidos del análisis:

- Fondo efectivo: el color de fondo se resuelve solo por la cadena de ancestros, así que
  overlays, hermanos y pseudo-elementos pintados detrás del texto no se ven. Texto con
  `-webkit-text-fill-color` usa ese color; texto con alfa efectivo menor a 0,05 se ignora.
- Se recorren hasta 5000 elementos por página (el informe lo anota con `Note:` si se
  corta); el Shadow DOM y los iframes no se recorren.
- Reduced motion: solo se miran animaciones CSS en curso (`document.getAnimations()`),
  no animaciones por JS ni canvas. Se corre en un pase extra sobre el primer punto; si ese
  pase falla, el informe lo anota como `ERROR:` en una nota.
- Salida por elemento: `data-visual-ignore="overflow|contrast|overlap"` (varios valores
  separados por espacios o comas) excluye ese elemento y su subárbol de esas
  comprobaciones, para recortes, carruseles y avatares intencionales.

`visual` y `code_index` son opcionales: un repo de backend sin UI no declara
`visual` y el chequeo visual no corre.

| Mejora | Capa |
|---|---|
| P0-1 a P0-7, P1-1, P1-2, P1-4 a P1-6, P2-2 a P2-4 | Motor (con campos de adaptador cuando aplica) |
| P1-3 | Motor (plantilla y chequeo) + adaptador (contenido de cada repo) |
| Sección 4.4 | Solo este repo |

### P0-1. Verificación visual determinista "shift-left" (`factory/bin/visual`)

- **Problema:** el 65 % de los bloqueos de agentes son de UI medible (sección 2.3).
  No es un problema de este repo: cualquier proyecto con UI tiene que validar
  anchos, idiomas y contraste.
- **Cambio (motor):**
  - Un runner genérico del motor, `factory/bin/visual <id>`, que **no sabe qué
    app es**. Lee del adaptador el bloque `visual`: cómo levantar la app (`start`,
    con el `port` del job), qué páginas visitar (`pages`), la matriz (`viewports`,
    `locales`, `themes`) y un `fixture` opcional de datos de prueba.
  - Recorre la matriz y reporta, sin conocer el dominio:
    - elementos con overflow (`scrollWidth > clientWidth`, contenido fuera del viewport),
    - texto con contraste por debajo de 4.5:1 (colores computados),
    - solapamientos entre elementos que el repo marque con `[data-visual-check]`,
    - el estado de `prefers-reduced-motion`.
  - Cómo se aplica cada dimensión de la matriz depende del repo, que lo declara:
    - Idioma: por parámetro de URL, header `Accept-Language` o atributo `lang`.
    - Tema: por `prefers-color-scheme` o un atributo `data-theme`.
  - Salida: `round-N/visual.md`, con `VISUAL: PASS|FAIL` en la primera línea, y
    capturas opcionales.
  - **El builder lo corre antes de `STATUS: READY`** cuando la superficie es `ui`.
  - **El gate lo incluye** para jobs `ui` **si el repo declaró `visual`**. Un FAIL
    no lanza revisores, igual que hoy con `checks.sh`.
  - **El revisor UI lee `visual.md`** en vez de re-medir. Su trabajo pasa a ser el
    juicio de diseño (consistencia, tokens, jerarquía), no la geometría.
- **Cambio (adaptador):** cada repo con UI declara su bloque `visual`. Ejemplo de
  este repo: `start: "npm start"`, páginas `/` y `/factory/dashboard.html`, un
  `board.json` demo como `fixture`, locales `en/es/pt` y temas `navy/light`.
- **Implementación:** el navegador headless es una dependencia **del motor**
  (`puppeteer-core` usando el Chrome del sistema, sin descargar navegador), no del
  repo de la célula. Un repo Java o Python no tiene que agregar nada a su
  `package.json`.
- **Impacto esperado:** en este repo, la mayoría de los jobs UI multi-ronda (016,
  021, 023, 030, 037, 038, 040) habrían salido en 1 ronda. El revisor UI baja de
  unos 10 minutos y 40 a 58 tool calls a pocas lecturas.
- **Tradeoff:** requiere Chrome en la máquina que corre la factory; el gate tarda
  unos 10 a 30 s más. La matriz la define cada repo y conviene que sea chica. Los
  repos sin `visual` siguen como hoy.
- **Métrica:** tasa de `CHANGES` del lente ui (hoy 38 %, objetivo < 10 %);
  duración de `review-ui`.

### P0-2. Contrato de salida obligatorio para todos los agentes

- **Problema:** `build.md` y `review-code.md` faltaron aunque el agente respondió
  `READY` o `PASS`, lo que obligó a reintentos.
- **Cambio:**
  - Agregar a los 8 roles la sección "Before you finish" que hoy solo tiene
    `review-ui.md`: escribir el archivo, correr `head -1` y validar el token.
  - Claude: un hook `Stop` para contratos de salida conocidos (`factory/bin/ensure-output <file> <patrón-permitido>`) en
    el frontmatter de cada agente, como ya hace `nudge`. Si el archivo falta o es
    inválido, el agente no puede terminar.
  - Codex: el `.toml` de cada rol suma "Before replying, run `head -1 <file>` and
    rewrite the file if the token is wrong". La skill Codex valida antes de aceptar
    la respuesta.
- **Impacto:** elimina los reintentos y las esperas del orquestador por archivos
  que no existen.
- **Tradeoff:** ninguno relevante.
- **Métrica:** reintentos por archivo faltante por cada 10 jobs (objetivo 0).

### P0-3. Re-revisión incremental y alcance congelado desde la ronda 2

- **Problema:** en el job 024 UI encontró bloqueos nuevos en cada una de las 5
  rondas; UX y code se re-ejecutaron con PASS en todas.
- **Cambio** (en **las dos** skills orquestadoras, `.claude/skills/eminzo-factory/SKILL.md`
  y `.agents/skills/eminzo-factory/SKILL.md`, y en los `review-*.md` compartidos):
  - Desde la ronda 2, **solo se re-ejecutan los lentes que dieron `CHANGES`**, más
    `code` acotado al diff de la ronda (`git diff <sha ronda anterior>..HEAD`)
    para atrapar regresiones. Los lentes con PASS no vuelven a correr, salvo que el
    diff toque archivos de su superficie (por ejemplo, CSS para ui).
  - Regla para los revisores desde la ronda 2: *"Verify each blocker you raised.
    New findings are blockers only if they are regressions introduced by this
    round's diff; everything else is `[minor]`."*
- **Impacto:** cerca de un tercio menos de agentes por ronda extra, y se corta el
  whack-a-mole.
- **Tradeoff:** un problema preexistente que se detecte tarde queda como minor; se
  registra en el PR y no bloquea. Es aceptable, porque el job no lo introdujo.
- **Métrica:** rondas promedio por job (hoy ≈2.0 en Claude; objetivo ≤ 1.3).

### P0-4. Protocolo de desviación de spec y resolución de conflictos entre lentes

- **Problema:** el job 040.
- **Cambio:**
  - `build.md` suma la sección `## Spec deviations`, con
    `AC-n / Design: what changed → why (blocker that forced it)`.
  - Los revisores evalúan contra **la intención del Goal y de los AC**. Una
    desviación documentada y motivada por un blocker de otro lente **no es un
    blocker** si el Goal se cumple; como mucho, es minor.
  - Si la desviación cambia un AC, el orquestador lanza el `spec-writer` en **modo
    enmienda** (lee `build.md` y edita solo los AC afectados, con un modelo barato)
    antes de la próxima revisión. Este paso de orquestación va en las dos skills;
    el resto del protocolo vive en los roles compartidos (`builder.md`,
    `review-*.md`, `approver.md`, `spec-writer.md`), así que Codex lo hereda.
  - El approver escala solo si la desviación cambia el Goal.
  - La spec deja de prescribir el render exacto de un texto, salvo que el issue lo
    pida literalmente. Para UI, la spec describe la intención más restricciones de
    viewport (ver P1-4).
- **Impacto:** el 040 habría cerrado en R2.
- **Tradeoff:** más juicio para el revisor. Se mitiga con la regla explícita y con
  que el approver ve la sección de desviaciones.
- **Métrica:** escalamientos por "spec mismatch" (objetivo 0).

### P0-5. Paridad Codex: checks obligatorios antes de `READY`

- **Problema:** los jobs 035 (R1) y 036 (R1 y R2) gastaron rondas en `GATE: FAIL`
  porque Codex no tiene el hook `nudge`.
- **Cambio:**
  - En `factory-builder.toml`: "Run `factory/checks.sh` in the worktree and only
    write `STATUS: READY` if it exits 0".
  - En la skill Codex: correr `factory/bin/nudge` (o `checks.sh`) en el worktree
    **antes** de `job <id> to gate`; si falla, devolver el log al mismo builder sin
    consumir una ronda.
  - Verificar por qué el job 036 tuvo revisores ui y ux no ruteados.
- **Impacto:** cero rondas perdidas por gate en Codex.
- **Métrica:** `GATE: FAIL` en R1 (objetivo: ≈0).

### P0-7. Quitar del motor lo que asume este repo

- **Problema:** hay supuestos de este repo cableados en el motor:
  - **Rama base fija en `main`.** Los roles revisores y el approver usan
    `git diff origin/main...`; el builder usa `gh pr create --base main` y
    `git merge origin/main`; el preflight de la skill exige estar en `main`. En
    cambio, `factory/lib/job.js` y `gate.js` ya leen `config.base`. En un repo con
    `develop` o `master`, los scripts trabajan bien pero los agentes revisan contra
    la rama equivocada.
  - **Codex depende de la carpeta de Claude.** Los `.toml` leen
    `.claude/agents/eminzo-<rol>.md`, así que una célula que use solo Codex igual necesita
    `.claude/`.
  - **El dashboard se sirve con `python3`**, que es una dependencia extra.
- **Cambio (motor):**
  - El orquestador pasa `Base: <config.base>` en el prompt de cada agente, igual
    que hoy pasa `Branch:` y `Port:`. Los roles usan `<base>` en vez de `main`, y
    el preflight compara contra la rama de `config.base`.
  - Mover los roles a una ubicación neutral (por ejemplo `factory/roles/<rol>.md`).
    `.claude/agents/eminzo-*.md` y `.codex/agents/*.toml` pasan a ser envoltorios finos
    que apuntan ahí.
  - Servir el dashboard con un servidor estático en Node, que ya es requisito del
    motor.
- **Paridad:** las dos skills pasan `Base:`; los envoltorios de los dos
  proveedores apuntan a los mismos roles neutrales.
- **Métrica:** el test de paridad (P2-4) y un test que falle si un rol o una skill
  contiene `origin/main`, `--base main` o rutas a `.claude/` desde Codex.

### P0-6. Carril XS para cambios triviales

- **Problema:** cambiar un texto, un color o un label recorre el mismo pipeline de
  7 agentes que una feature nueva. El costo fijo mínimo observado es de ≈$1.2 por
  job (026, 031), sin contar la sesión orquestadora, y un cambio XS mal
  especificado puede escalar (040: $3.26 y 3 rondas).
- **Cambio:**
  - Intake agrega una quinta línea, `SIZE: xs|s|m|l`. `xs` exige **todo** esto:
    - `RISK: low`,
    - `SURFACES: none` o `ui` (nunca `security`),
    - un cambio de texto, estilo o configuración en 1 o 2 archivos existentes,
    - nada de archivos nuevos, dependencias ni `protected_tests`.
  - El flujo completo, cómo se fuerza y qué pasa cuando falla están en
    **"Recorrido de un pedido XS"**, más abajo.
  - Configuración agnóstica de proveedor en `config.json`:
    `lanes.xs = { "reviewers": ["code"], "spec": false, "approver": "script" }`.
    Los modelos van por proveedor:
    - `providers.claude.lanes.xs`: builder `sonnet`, revisor `haiku`.
    - `providers.codex.lanes.xs`: builder `gpt-6-luna`, revisor `gpt-6-luna`.
  - Orquestador más liviano: para XS, la skill puede delegar los pasos 3 a 6 a un
    script (`factory/bin/xs <id>`), así la sesión principal no lee notificaciones
    paso a paso.
- **Paridad:** el carril se implementa igual en `.claude/skills/eminzo-factory/SKILL.md` y
  en `.agents/skills/eminzo-factory/SKILL.md`. Intake y builder son roles compartidos, y
  `factory/lib/job.js` y `route.js` leen `SIZE` y `lanes` para ambos proveedores.
#### Recorrido de un pedido XS

**1. Entrada.** El usuario usa la factory como siempre:
`/factory cambiá "Costo" por "Gasto" en el header` en Claude, o el mismo pedido con
`$factory` en Codex. Se crea la issue con label `factory` y arranca el job. No hace
falta saber de antemano que es XS.

**2. Quién decide el tamaño.** El pipeline, nunca el texto de la issue:

| Señal | ¿Se toma en cuenta? | Efecto |
|---|---|---|
| Intake evalúa los criterios XS | Sí, siempre | Si se cumplen todos, `SIZE: xs` |
| Label `factory:xs` en la issue (requiere permisos de triage o escritura) | Sí, como pedido | Intake **intenta** XS; si un criterio no se cumple, lo baja a normal y lo explica en `## Reason` |
| Subcomando `/factory xs <pedido>` o `$factory xs <pedido>` | Sí, como pedido | La skill crea la issue con `factory` + `factory:xs`; el efecto es el mismo que el del label |
| "Esto es XS" escrito en el cuerpo de la issue | **No** | Es dato no confiable (`issue.md`); no puede saltarse controles |

El forzado **pide** el carril liviano pero **no se salta los criterios**: un pedido
que toca `security`, agrega dependencias o es `high` nunca corre como XS, aunque
tenga el label.

**3. Flujo feliz.**

```
/factory o $factory  →  issue (+ factory:xs opcional)  →  job new
        │
  1. INTAKE            Claude: fable · Codex: gpt-6-luna
        │  ACCEPT + SIZE: xs
        │  intake.md ## Scope = mini-spec con 1-3 AC
        │
  2. ROUTE (script)    lane: xs
        │  crea el worktree; sin spec-writer; reviewers: [code]
        │
  3. BUILDER           Claude: sonnet · Codex: gpt-6-luna
        │  test por AC → cambio → checks.sh (+ bin/visual si es ui)
        │  commit, push, PR draft, build.md
        │
  4. GATE (script)     checks.sh + bin/visual (si es ui)
        │
  5. REVIEW            Claude: haiku · Codex: gpt-6-luna
        │  un solo revisor: lente code + checklist UI básico
        │
  6. APPROVER (script, sin LLM)
        │  todo PASS · gate PASS · merge-tree limpio · diff dentro del scope
        │
  7. MERGING (script)  sync con la rama base (config.base) → gate de nuevo → gh pr merge
        ▼
     merged
```

Agentes LLM: **3** (intake, builder, revisor) en lugar de 7. Las demás etapas son
scripts sin costo de tokens.

**4. Qué se quita y qué no.**

| Etapa | Carril normal | Carril XS | Por qué es seguro |
|---|---|---|---|
| Spec-writer | ✅ (opus / gpt-6-luna) | ❌ | La mini-spec de intake alcanza para un cambio de 1 o 2 archivos |
| Revisores | code + ux + ui (+ security) | 1 combinado | Lo medible de UI lo cubre `bin/visual` (P0-1) |
| Approver | LLM | script (P1-1) | Sus checks son deterministas; ante la duda, escala al LLM |
| Intake como barrera de la issue | ✅ | ✅ | **Sin cambios** |
| Gate y `protected_tests` | ✅ | ✅ | **Sin cambios** |
| Worktree, PR y trazabilidad | ✅ | ✅ | **Sin cambios** |

**5. Cuando algo falla: se promueve, no se itera.**

```
gate FAIL  ·  revisor CHANGES  ·  builder STATUS: BLOCKED  ·  approver-script no concluyente
        │
        ▼
  PROMOCIÓN A CARRIL NORMAL  (job.lane: xs → normal, job.promoted_from: xs)
        │  1. spec-writer arma spec.md a partir de la mini-spec de intake + build.md
        │  2. route re-rutea los revisores según las superficies (code/ux/ui/security)
        │  3. el mismo builder sigue en la ronda 2 con los hallazgos de la ronda XS
        │  4. max_rounds sigue siendo 3 en total (la ronda XS cuenta como la 1)
        ▼
  flujo normal de hoy
```

- XS nunca sale peor que el carril normal: si funciona, cuesta una fracción; si no,
  termina en el mismo pipeline, y la ronda XS no se desperdicia, porque su código y
  sus hallazgos alimentan la ronda 2.
- La promoción la hace `factory/bin/job <id> promote`, que es el único escritor de
  `job.json`, igual que hoy.
- Excepción: si el approver por script falla solo por un conflicto con la rama
  base, se
  sigue el camino normal de merge (`needs-human` con nota) y no se promueve.

**6. Lo que se ve en el dashboard.**

- La card del job muestra el chip `XS`, o `XS→normal` si se promovió.
- El canvas del pipeline dibuja solo las etapas que corren:
  `Intake → Build → Gate → Review → Merge`. Spec y Approve aparecen "omitidas" y
  atenuadas, no como pendientes.
- La telemetría registra la **tasa de promoción**. Si supera el 30 %, los criterios
  de intake son demasiado laxos.

**7. Cambios necesarios (con paridad).**

| Pieza | Compartido | Claude | Codex |
|---|---|---|---|
| Criterio `SIZE` y mini-spec | `intake.md` (línea 5 `SIZE:`), parser en `lib/job.js` | — | — |
| Carril y promoción | `lanes.xs` en `config.json`, `lib/route.js`, `bin/job <id> promote` | `providers.claude.lanes.xs` | `providers.codex.lanes.xs` |
| Forzado | Label `factory:xs` en `bin/setup` | Subcomando `xs` en `.claude/skills/eminzo-factory/SKILL.md` | Subcomando `xs` en `.agents/skills/eminzo-factory/SKILL.md` |
| Revisor combinado | Checklist UI básico en `review-code.md`, activo solo en `lane: xs` | — | — |
| Approver por script | `bin/approve` (P1-1) | — | — |
| Dashboard | chip `XS`, etapas omitidas en `pipeline-canvas.js` | — | — |
| Tests | `test/lane-xs.test.js` (criterios, promoción, forzado no confiable desde el cuerpo) y el test de paridad (P2-4) | — | — |

- **Impacto (estimado):** de 7 agentes LLM a 3 (intake, builder y un revisor).
  Objetivo ≤ $0.40 por job XS en Claude, y 1 ronda.
- **Tradeoff:** intake puede clasificar como XS algo que no lo es. Se mitiga con
  criterios cerrados, la promoción automática ante el primer `CHANGES` y gate y
  `protected_tests` sin cambios. El formato de `intake.md` cambia (línea 5), así
  que hay que ajustar el parser y sus tests, y `job.test.js` es protegido: requiere
  aprobación humana.
- **Métrica:** costo y minutos por job XS, y tasa de promoción de XS a normal
  (si supera el 30 %, los criterios están mal).
- **Alternativa honesta:** para un cambio de una línea que harías vos en 30
  segundos, lo más barato es no usar la factory: editás, abrís un PR y listo. La
  factory se justifica cuando importan el aislamiento en un worktree, los tests,
  la revisión y la trazabilidad.

### P1-1. Carril rápido según el riesgo

- **Cambio en `config.json`: modelos por riesgo en los dos proveedores**
  (`providers.claude.models` y `providers.codex.models` pasan a aceptar
  `{low, medium, high}`, igual que `routing.builder`):

  | Rol | Proveedor | low | medium | high |
  |---|---|---|---|---|
  | spec-writer | Claude | sonnet | opus | opus |
  | spec-writer | Codex | gpt-6-luna (ya es así) | gpt-6-luna | gpt-6.1-sol |
  | approver | ambos | script determinista | script, más LLM si hay dudas | LLM (opus / gpt-6.1-sol) |

  En Codex hoy el spec-writer siempre usa el modelo barato, incluso en high
  (job 034). Conviene subirlo en high para que las specs de alto riesgo valgan
  lo mismo en los dos proveedores.

- **Approver por script** (`factory/bin/approve`): los checks 1, 2 y 4 del approver
  ya son deterministas (todos los lentes en PASS, `GATE: PASS`,
  `git merge-tree --write-tree` limpio). Para el 3 (scope), comparar los archivos
  del diff con los que lista el `## Design` de la spec. Para el 5 (juicio humano),
  usar el riesgo y las superficies de intake más patrones (nuevas `dependencies`,
  `protected_tests`, archivos de auth o secrets). Si todo pasa y el riesgo no es
  `high` → `APPROVE`. Si algo no es concluyente, se lanza el approver opus.
- **Impacto:** se quita un opus por job low o medium, y el spec opus en los low.
- **Tradeoff:** para low, la spec con sonnet puede ser algo menos precisa. Se
  mitiga porque los AC y el gate siguen igual. El approver por script tiene que
  ser conservador: ante la duda, escala al LLM.
- **Métrica:** $/job low (hoy entre $1.18 y $4.33; objetivo ≤ $1.20).

### P1-2. Fusionar UX dentro de UI o restringirlo

- **Evidencia:** 0 de 52 bloqueos.
- **Opción A (recomendada):** un único revisor `review-ui` con el checklist UX
  (flujo, mensajes, estados vacío/error/loading, teclado y lector de pantalla).
  Ahorra un sonnet por ronda en todo job `ui`.
- **Opción B:** mantener UX solo cuando la spec tenga flujos interactivos nuevos
  (formularios, navegación, CLI) y solo en la ronda 1.
- **Tradeoff:** se pierde una mirada independiente. El historial muestra que no
  aportó bloqueos, pero conviene dejar UX activable por superficie (`interaction`)
  para jobs que lo justifiquen.
- **Paridad:** el cambio va en `routing.reviewers` de **ambos** bloques
  (`providers.claude` y `providers.codex`), más el checklist UX dentro del
  `review-ui.md` compartido.
- **Métrica:** costo de revisión por job `ui`.

### P1-3. `project.md` vivo, con una plantilla común

- **Problema:** los agentes exploran el código de cero cuando `project.md` no
  tiene un mapa o está viejo. En este repo, el snapshot es del job 007 y no
  describe los módulos que tocaron la mayoría de los jobs recientes.
- **Cambio (motor):**
  - Definir una **plantilla** de `project.md` con secciones obligatorias e iguales
    para todos los repos:
    - `Stack`,
    - `Commands` (correr, testear, construir),
    - `Module map` (qué módulo hace qué y dónde, con rutas),
    - `UI contract` (tokens, breakpoints, i18n, selectores estables; solo si hay UI),
    - `Conventions`,
    - `Snapshot` (fecha y último job que lo actualizó).
  - Que `factory init` (o un rol en modo "survey") genere el primer borrador a
    partir del repo.
  - **Chequeo de frescura** en el motor: el approver o el script de merge marca
    `project.md stale` si el diff agrega o mueve módulos que el `Module map` no
    menciona, y el siguiente job lo actualiza.
- **Cambio (adaptador):** cada repo completa la plantilla con su contenido. En
  este repo, eso implica agregar el mapa del dashboard y de la oficina.
- **Impacto:** intake, spec, builder y los revisores leen un mapa en lugar de hacer
  grep por el repo. Es el ahorro de tokens más barato de implementar y crece con el
  tamaño del repo.
- **Métrica:** tool calls de lectura por agente.

### P1-4. Specs de UI con restricciones verificables

- **Cambio en `spec-writer.md` (motor):**
  - Para `SURFACES: ui` en un repo que declara `visual`, exigir un AC del estilo
    *"Given the repo's visual matrix (`config.visual`), when the touched pages
    render, then `bin/visual` reports no overflow, contrast or overlap in the
    touched selectors"*. El rol no nombra anchos ni idiomas; los toma del adaptador.
  - `## Design` debe listar **archivos y rangos de líneas** (`ruta:inicio-fin`) para
    que el builder no tenga que redescubrir.
- **Impacto:** el builder diseña pensando en el peor caso desde la ronda 1.

### P1-5. Intake liviano

- **Cambio:** intake no necesita "search the repo before you decide" a fondo.
  Alcanza con `project.md` y una búsqueda puntual para clasificar riesgo y
  superficies. La exploración profunda queda para el spec-writer, que de todos
  modos la repite.
- **Tradeoff:** riesgo de clasificar mal la superficie. Se mitiga con que el
  spec-writer pueda pedir que se reclasifique (lo que re-rutea los revisores).

### P1-6. Builder Codex retomable

- **Cambio:** si la plataforma Codex permite retomar una sesión, reutilizar el
  builder entre rondas como en Claude. Si no, entregarle en el prompt de la ronda
  N un `round-(N-1)/handoff.md` corto (escrito por el propio builder al terminar,
  con archivos tocados y decisiones) para que no relea todo.

### P2-1. Evitar jobs en paralelo sobre los mismos archivos (motor)

- **Problema:** dos jobs que tocan el mismo archivo a la vez (en este repo, 038 y
  040 sobre `dashboard.html`) generan conflictos al mergear el segundo, y un
  conflicto termina en `needs-human`. Pasa en cualquier repo con archivos grandes
  o centrales.
- **Cambio (motor):** antes de lanzar el builder de un job, el orquestador compara
  los archivos del `## Design` de su spec con los de los jobs activos. Si se
  solapan, el job espera (sin usar un lugar de `concurrency`) o se avisa, en vez de
  correr en paralelo.
- **Impacto:** menos escalamientos por conflicto, sin depender de cómo esté
  organizado el código de cada repo.

### P2-2. Paquete de contexto por ronda (`round-N/context.md`)

- El gate ya corre en la ronda. Puede además escribir un resumen: `git diff --stat`,
  los archivos tocados, los AC de la spec y los blockers abiertos de la ronda
  anterior. Así, los revisores en paralelo no repiten cada uno el mismo
  `git diff` + lectura de spec + lectura de build.
- **Impacto:** moderado; el prompt caching ya amortiza parte.

### P2-3. Telemetría de costo por agente

- `factory/lib/cost.js` calcula el costo por job. Sumarle el desglose por rol y
  ronda (el transcript ya identifica el job; falta agrupar por tipo de agente) y
  mostrarlo en el panel "Costo por agente".
- Sin esto, las mejoras de esta lista se validan por inferencia. **Implementar antes
  o junto con P0** para tener una línea base.
- Resolver también los "Cost unavailable" de Codex (jobs 032, 034, 035 y 036).
  El desglose tiene que existir en `jobCost` (Claude) y en `codexJobCost` (Codex)
  con la misma forma de salida, para poder comparar proveedores.
- **Medir también la sesión orquestadora.** Hoy `cost_usd` suma solo los
  subagentes; las tokens de la sesión que corre `/factory` o `$factory` (cargar la
  skill, leer notificaciones, mover etapas) quedan afuera. Sin ese número, el
  costo de los cambios chicos está subestimado.

### P2-4. Test de paridad Claude ↔ Codex

- **Problema:** las reglas de orquestación viven en dos skills y la configuración
  en dos bloques de `providers`. Cada mejora que toque solo uno hace divergir los
  proveedores sin que nadie se entere (ya pasó con el hook `nudge`).
- **Cambio:** extender `test/codex-factory.test.js`, o crear
  `test/provider-parity.test.js`, para que falle si:
  - `providers.claude` y `providers.codex` no tienen las mismas claves en `models`,
    `routing.reviewers` y `lanes`;
  - un rol de `.claude/agents/eminzo-<rol>.md` no tiene su `.codex/agents/eminzo-<rol>.toml`
    apuntando a ese mismo `.md`;
  - una regla de orquestación marcada en una skill (por ejemplo "incremental
    re-review", "lane xs", "spec amendment" u "output contract") no aparece en la
    otra.
- **Impacto:** la paridad deja de depender de la memoria de quien implementa.

### 4.4 Backlog de este repo (no es motor)

Estas mejoras bajan el costo de los jobs **en este repo** y no se distribuyen a
otras células:

- **Completar el adaptador de este repo:**
  - el `project.md` con la plantilla de P1-3: mapa de `dashboard.html`,
    `pipeline-canvas.js`, `office-*.js`, `avatars.js` y `sprite-atlas.js`, tokens,
    breakpoints e i18n;
  - el bloque `visual` de P0-1.
- **Partir el monolito `factory/dashboard.html`** (1112 líneas) en
  `dashboard.css`, `header.js`, `kanban.js` y `pipeline-panel.js`, respetando la
  CSP (sin inline). Como el dashboard es parte del motor, esto también mejora el
  motor, pero el ahorro de tokens se ve sobre todo cuando la factory trabaja sobre
  su propio código.
- **Separar el motor de la app de este repo** (landing y juego). Hoy viven juntos,
  y `protected_tests` mezcla tests del motor con la suite de la app. Es el primer
  paso para distribuir la factory.

---

## 5. Matriz de paridad Claude ↔ Codex

Regla: **una mejora no está terminada hasta que funciona en los dos proveedores**.
Lo compartido se cambia una sola vez. Lo que depende de la plataforma se
implementa por proveedor con el mismo efecto observable.

| Mejora | Compartido (una vez) | Claude | Codex |
|---|---|---|---|
| P0-1 `bin/visual` | Runner del motor, gate, `builder.md`, `review-ui.md`; bloque `visual` en el adaptador de cada repo | — | — |
| P0-2 Contrato de salida | Sección "Before you finish" en los 8 roles | Hook `Stop` → `bin/ensure-output` en el frontmatter | Instrucción en cada `.toml` y validación en `.agents/skills/eminzo-factory/SKILL.md` antes de aceptar la respuesta |
| P0-3 Re-revisión incremental | Regla de alcance en `review-*.md` | `.claude/skills/eminzo-factory/SKILL.md` | `.agents/skills/eminzo-factory/SKILL.md` |
| P0-4 Desviaciones de spec | `builder.md`, `review-*.md`, `approver.md`, `spec-writer.md` (modo enmienda) | Paso de enmienda en la skill Claude | Paso de enmienda en la skill Codex |
| P0-5 Checks antes de `READY` | — | Ya existe (hook `nudge`) | `.toml` del builder más `checks.sh` en la skill antes de `to gate` |
| P0-7 Sin supuestos del repo | Roles neutrales en `factory/roles/`, `<base>` en los roles, dashboard servido con Node | Skill Claude pasa `Base:`; `.claude/agents/eminzo-*.md` como envoltorios | Skill Codex pasa `Base:`; `.toml` apuntan a `factory/roles/` |
| P0-6 Carril XS | `intake.md` (`SIZE`), `lib/job.js`, `lib/route.js`, `lanes.xs`, `bin/job promote`, `bin/xs`, label `factory:xs` | `providers.claude.lanes.xs`, subcomando `/factory xs` y promoción en la skill Claude | `providers.codex.lanes.xs`, subcomando `$factory xs` y promoción en la skill Codex |
| P1-1 Modelos por riesgo y approver por script | `bin/approve`, `lib/route.js` | `providers.claude.models` por riesgo | `providers.codex.models` por riesgo (subir spec-writer en high) |
| P1-2 Fusionar UX | Checklist UX en `review-ui.md` | `providers.claude.routing.reviewers` | `providers.codex.routing.reviewers` |
| P1-3 `project.md` vivo | Plantilla, generación inicial y chequeo de frescura en el motor; contenido en el adaptador | — | — |
| P1-4 AC visuales | `spec-writer.md` | — | — |
| P1-5 Intake liviano | `intake.md` | — | — |
| P1-6 Builder retomable | — | Ya existe (`SendMessage`) | Sesión retomable, o `handoff.md` por ronda |
| P2-1 Jobs sin solapamiento de archivos | Comparación de `## Design` entre jobs activos | Skill Claude | Skill Codex |
| P2-2 `context.md` por ronda | Gate | — | — |
| P2-3 Telemetría | Panel "Costo por agente" | `jobCost` por rol y la sesión orquestadora | `codexJobCost` por rol, resolver "Cost unavailable" y la sesión orquestadora |
| P2-4 Test de paridad | `test/provider-parity.test.js` | — | — |

Notas:

- La invocación también tiene que ser equivalente: `/factory <pedido>` en Claude y
  `$factory <pedido>` en Codex deben aceptar los mismos subcomandos (`run`,
  `issue`, `rework` y, si se agrega, `xs`).
- Antes de implementar, verificar por qué el job 036 (Codex, ruteado solo `code`)
  tiene `review-ui.md` y `review-ux.md` en R3 (sección 2.5).

---

## 6. ¿Conviene conectar Graphify u otro grafo de código?

**Qué es.** [Graphify](https://claudelog.com/claude-code-mcps/graphify) es una skill
para Claude Code que arma un grafo de conocimiento del repo (AST con tree-sitter,
más extracción semántica con LLM para documentos) y permite consultar el grafo en
vez de releer archivos. Los ahorros publicados (46× a 71×) salen de corpus
específicos, no de un estudio controlado. Una prueba práctica reporta entre 5 y 10×
y aclara que el grafo sirve para **leer**, no para **escribir**: para editar sigue
haciendo falta el archivo real ([fuente](https://www.mejba.me/blog/graphify-knowledge-graph-codebase-claude-code)).
El build semántico inicial tiene costo propio (unos 1.5 M de tokens en el repo del
autor) ([fuente](https://github.com/az9713/graphify-on-graphify)).

**Cómo encaja en un motor agnóstico:** como **capacidad opcional del adaptador**
(`code_index` en `config.json`), apagada por defecto. Cada célula la prende si su
repo lo justifica, y el motor solo le da acceso a la herramienta a los roles que
exploran (intake y spec-writer). El veredicto de abajo es para **este** repo; un
repo grande de otra célula puede llegar a la conclusión contraria con la misma
regla de adopción.

**Veredicto para este repo: ahora no es prioridad.**

1. **Lo que cuesta no es descubrir código, son las rondas.** El 31 % del gasto se
   fue en rondas extra causadas por validación visual tardía y por protocolo (P0).
   Un grafo no arregla nada de eso.
2. **El repo es chico.** Hay unas 2900 líneas en `factory/`. Un `project.md` con mapa
   (P1-3) más rangos de líneas en la spec (P1-4) dan la mayor parte del beneficio
   sin infraestructura.
3. **El builder y los revisores trabajan sobre el diff y sobre archivos concretos**,
   justo el caso en que el grafo ayuda menos (hay que leer y editar el archivo real).
4. **Costo operativo:** el índice tiene que reflejar el worktree de cada job (otra
   rama), las tools MCP se tienen que agregar al `tools:` de cada agente Claude y a
   la configuración de Codex, y el build semántico consume tokens.

**Cuándo sí convendría:** si el repo crece mucho (decenas de miles de líneas), si
la factory se usa sobre otros repos más grandes, o si la telemetría (P2-3) muestra
que intake y spec-writer gastan más del 30 % en exploración.

**Si se prueba, cómo hacerlo:**

- Hay que preferir **`codebase-memory-mcp`**, que ya está instalado en este entorno.
  Es solo AST, así que el índice no tiene costo LLM, y responde
  "quién llama a X" y "qué hay en el módulo Y".
- Piloto acotado: habilitarlo **solo para intake y spec-writer** (exploración), con
  el índice sobre `main` (no por worktree). Builder y revisores siguen leyendo
  archivos y el diff.
- Medir 5 jobs con y 5 sin: tokens de entrada de intake y spec-writer, y la calidad
  de `## Design` (¿el builder tuvo que redescubrir?).
- Criterio de adopción: −30 % de tokens en esos dos roles sin más rondas.

**Herramienta con mejor retorno que un grafo:** el **navegador headless como
check determinista** (P0-1). Ataca directamente la principal causa de rondas.

---

## 7. Orden de implementación sugerido

Cada ítem puede ser un issue de la propia factory. Ojo: los que tocan los
`protected_tests` (`job.test.js`, `gate.test.js`, `cost.test.js`) van a necesitar
aprobación humana, porque el gate falla si un job los edita. **Cada paso se cierra
con los dos proveedores** (sección 5).

| Paso | Ítems | Por qué en este orden |
|---|---|---|
| 1 | P2-4 (test de paridad) + P2-3 (telemetría por agente y orquestador) + P0-2 (contrato de salida) | Primero la red de paridad y la línea base; P0-2 es trivial y elimina reintentos |
| 2 | P0-7 (sacar supuestos del repo) + P1-3 (plantilla de `project.md`) + P0-5 (checks en Codex) | Deja el motor agnóstico antes de sumarle capacidades |
| 3 | P0-3 (re-revisión incremental) + P0-4 (desviaciones de spec) | Cambios de skill y prompts; cortan el whack-a-mole |
| 4 | P0-1 (`bin/visual`) + P1-4 (AC visuales) | El de más impacto, pero suma devDependency y gate; mejor cuando ya hay métricas |
| 5 | P0-6 (carril XS) + P1-1 (modelos por riesgo y approver por script) | XS reutiliza `bin/visual` y `bin/approve`; por eso va después del paso 4 |
| 6 | P1-2 (fusionar UX) | Con datos de los pasos 1 a 5 que muestren que la calidad se sostiene |
| 7 | P2-1 (jobs sin solapamiento), P1-5, P1-6, P2-2 | Estructurales |
| En paralelo | Backlog de este repo (sección 4.4) | No bloquea al motor; baja el costo de los jobs sobre la propia factory |
| 8 | Piloto de grafo (sección 6) | Solo si la telemetría lo justifica |

## 8. KPIs y objetivos

La columna "Hoy" es la línea base de **este** repo. Los KPIs se miden **por repo**:
cada célula tiene su propia línea base y la telemetría (P2-3) los reporta separados.

| KPI | Hoy | Objetivo |
|---|---|---|
| Jobs resueltos en 1 ronda | 46 % | ≥ 75 % |
| Rondas promedio por job | ≈2.0 | ≤ 1.3 |
| Costo promedio por job (Claude) | $4.29 | ≤ $2.80 |
| Costo de un job low-risk | $1.18 a $4.33 | ≤ $1.20 |
| `CHANGES` del lente ui | 38 % | < 10 % |
| Escalamientos por conflicto de spec | 1 (040) | 0 |
| Reintentos por archivo faltante | 3 por sesión | 0 |
| `GATE: FAIL` en R1 (Codex) | 2 de 4 jobs | 0 |
| Costo de un job XS (solo texto o estilo) | $1.18 a $3.26 (026, 031, 033, 040) | ≤ $0.40 (estimado) |
| Agentes LLM por job XS | 7 | 3 |
| Tokens de la sesión orquestadora por job | Sin medir | Medido en los dos proveedores |
| Mejoras con paridad Claude y Codex verificada por test | 0 | 100 % |

Calidad y seguridad no se negocian: gate, `protected_tests`, revisor de seguridad
con opus en superficie `security`, y escalamiento de todo lo `high` o de juicio
humano quedan **sin cambios**. Lo que se recorta es repetición (rondas,
re-revisiones, exploración duplicada), no controles.

---

## 9. Estado de implementación

Todo se implementó directo sobre el repo (sin `/factory`), como una cadena de PRs apilados.
Cada PR apunta al anterior y se mergean en orden.

| PR | Paso | Mejoras |
|---|---|---|
| #59 | 0 | Este plan y `docs/factory-explicado.md` |
| #60 | 1 | P2-4 (test de paridad), P2-3 (costo por agente y ronda, costo del orquestador), P0-2 (contrato de salida con hook) |
| #61 | 2 | P0-7 (roles neutrales, `Base:` desde la config, dashboard en Node), P1-3 (plantilla y frescura de `project.md`), P0-5 (checks en Codex antes del gate) |
| #62 | 3 | P0-3 (re-revisión incremental), P0-4 (desviaciones de spec, enmienda, exigidas por el script) |
| #63 | 4 | P0-1 (`bin/visual` en el gate, estados PASS, FAIL, SKIPPED y ERROR), P1-4 (AC visuales), bloque `visual` de este repo |
| #64 | 5 | P0-6 (carril XS con promoción), P1-1 (modelos por riesgo, `bin/approve`), merge atado al SHA revisado |
| #65 | 6 | P1-2 (UX dentro de UI; UX solo con `interaction`) |
| #66 | 7 | P2-1 (espera por archivos compartidos), P2-2 (`context.md` por ronda), P1-5 (intake liviano y `## Reclassify`), P1-6 (notas de handoff del builder) |
| (este) | 8 | Backlog 4.4: `dashboard.html` partido en `dashboard.css` y `dashboard.js`; documentación al estado final |

**Además de lo planificado** (lo trajeron las revisiones adversariales):
- El merge exige que la rama esté en el commit revisado. Esta falla ya existía antes del plan.
- La aprobación en XS es imposible de falsificar: queda registrada por el script en `job.json`.
- `bin/approve` ve permisos, symlinks, binarios, altas y bajas de archivos, y tiene una
  denylist de rutas del motor, CI y configuración de herramientas.
- Los revisores arrastrados vuelven a correr por defecto (`review_paths` lo afina por repo).

**Fuera de alcance, a propósito:**
- El piloto de grafo de código (sección 6). Depende de lo que muestre la telemetría.
- Separar el motor de la app de este repo, para distribuirlo a otras células. Necesita su
  propio diseño: empaquetado, versiones y `factory init`.
- `factory/bin/xs` (un script que maneje solo el carril XS). Duplicaría el ciclo de las
  skills.
- La telemetría de la tasa de promoción XS → normal. Se puede calcular desde
  `promoted_from` en `job.json`.

**Próximo paso:** mergear la cadena y medir con jobs reales contra los KPIs de la sección 8.
Los ahorros de este plan son estimaciones hasta entonces.
