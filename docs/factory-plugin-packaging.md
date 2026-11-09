# Empaquetar el factory como plugin

* **Autor:** Jhon Barrantes
* **Fecha:** 2026-11-07
* **Estado:** análisis, sin decisiones tomadas

## Resumen

Hoy el motor del factory (`factory/lib`, `factory/bin`, `factory/roles`, la skill y los agentes) se
copia dentro de cada repo, y la única forma buena de instalarlo es la app Eminzo (el "kit"). La meta
de este documento es ver cómo instalarlo con un comando, sin la app, para Claude Code y Codex.

Conclusiones:

1. **Separar motor y adaptadores.** El motor (scripts Node) se publica como un CLI versionado,
   `eminzo`. Los adaptadores son delgados: un plugin de Claude Code y un plugin o skill de Codex, con la
   skill, los agentes y los hooks, que llaman a ese CLI. Así un solo motor sirve a los dos
   proveedores, que es la promesa del producto.
2. **El riesgo nuevo es la uniformidad.** Hoy todo el equipo usa el mismo motor porque está commiteado
   en el repo. Con un plugin, cada developer puede tener otra versión. Sin una versión fijada en
   `factory/config.json` que el motor haga cumplir, el plugin rompe justo lo que vendés: un flujo
   igual para todos.
3. **El trabajo más grande no es el plugin, es sacar las rutas fijas.** Hay unas 60 referencias a
   `factory/bin/...` en las skills, 36 en los roles, y hooks en el frontmatter de los agentes que un
   plugin de Claude Code **ignora**.
4. **Codex va un paso atrás.** Sus plugins no documentan agentes incluidos, sus hooks de plugin solo
   corren instalados desde la app de escritorio, y no hay una variable de raíz para scripts de skills.
   Codex necesita un `init` que escriba sus archivos en el repo, como hoy.

## Decisión actual (2026-11-08): CLI sin plugin como camino principal

El motor se publica como CLI (`@eminzo/factory`, comando `eminzo`) y el mismo CLI instala los
adaptadores en las carpetas del **usuario**. El plugin de Claude Code queda como canal opcional,
para más adelante, sobre el mismo CLI. Las secciones 2 a 6 analizan el plugin. Lo que ahí se dice del
motor, la versión fijada, `init`, la huella en el repo y la seguridad vale igual para este camino.

Por qué sin plugin:

- Un solo mecanismo para Claude y Codex.
- Los hooks de los agentes en el frontmatter siguen funcionando: no son agentes de plugin, que los
  ignoran. Hay que verificarlo en la fase 0.
- No depende de funciones de plugin recientes ni de las limitaciones de los plugins de Codex.

### Recorrido

| Cuándo | Dónde | Comando | Qué hace |
| --- | --- | --- | --- |
| Una vez por máquina | terminal | `npm i -g @eminzo/factory` | instala el motor |
| Una vez por máquina | terminal | `eminzo install` | copia la skill y los agentes a `~/.claude/skills`, `~/.claude/agents`, `~/.agents/skills`, `~/.codex/agents`; no toca ningún repo |
| Una vez por repo | Claude Code | `/eminzo-factory init` | corre `eminzo init`: escribe la huella mínima (sección 3.7) y abre el PR `chore/install-factory` |
| Una vez por repo | Claude Code | `/eminzo-factory setup` | crea las etiquetas y escribe `factory/project.md` |
| Día a día | Claude Code | `run`, `issue <n>`, `add <feature>`, `xs <pedido>`, `rework <n>`, `approve-spec <n>`, `revise-spec <n> <notas>` | igual que hoy |
| Cuando haga falta | terminal | `eminzo doctor`, `eminzo config show`, `eminzo summary` | versiones, configuración efectiva, costo y estado |

En Codex los mismos comandos se escriben con `$eminzo-factory`. Los comandos internos (`eminzo job`,
`eminzo gate`, `eminzo approve`...) los corre el orquestador, no el usuario.

### Reglas que este camino agrega

1. **Versión de los adaptadores.** Cada archivo que escribe `eminzo install` lleva la versión del
   motor. El motor rechaza los comandos si la versión de los adaptadores no es la suya, y
   `eminzo doctor` dice qué correr.
2. **Skill en un repo sin factory.** La skill está instalada para el usuario, así que aparece en
   todos los repos. Si no existe `factory/config.json`, responde "este repo no tiene el factory;
   corré `/eminzo-factory init`" y no hace nada más.
3. **Actualizar** es `npm update -g @eminzo/factory` y luego `eminzo install`. En cada repo,
   `eminzo upgrade` sube el rango de `engine` en un PR.

## 1. Qué hay hoy

### Motor (igual en todos los repos)

| Parte | Tamaño | Notas |
| --- | --- | --- |
| `factory/lib/*.js` | ~200 KB | `job.js` 74 KB, `cost.js`, `gate.js`, `approve.js`, `diff.js`, `ensure-output.js`, `nudge.js`, `visual*.js` |
| `factory/bin/*` | 10 shims `sh` | `exec node "$(dirname "$0")/../lib/job.js"` |
| `factory/roles/*.md` | 8 archivos, ~40 KB | el modelo los lee por ruta, el código no |
| `.claude/agents/eminzo-*.md` | 8 wrappers | frontmatter con `hooks: Stop:` que llama `factory/bin/ensure-output` |
| `.codex/agents/eminzo-*.toml` | 8 archivos | rutas fijas a `factory/roles`, `factory/bin/nudge` |
| `.claude/skills/eminzo-factory/SKILL.md` | 441 líneas | ~60 comandos `factory/bin/...` |
| `.agents/skills/eminzo-factory/SKILL.md` | variante Codex | distinta de la de Claude |
| `factory/templates/*` | config y project.md | solo para el instalador |
| `factory/pipeline.json` | 6 KB | generado por `job graph`; un repo puede tener el suyo |
| Dashboard (`dashboard.*`, `office*`, `assets/`) | ~1.3 MB | ya no va en el kit: lo trae la app (`desktop/package.json:59-70`) |
| Tests del motor | ~50 archivos en `test/` | importan `../factory/lib` por ruta relativa |

Dependencias: Node 20 o más, sin paquetes de npm, `git`, `gh` y `sh`. `puppeteer-core` es opcional (solo el
chequeo visual).

### Por repo

`factory/config.json` (política del equipo), `factory/config.local.json` (por developer,
gitignored), `factory/checks.sh` (generado según el stack), `factory/project.md` (lo escribe
`setup`), `factory/jobs/`, `factory/board.json` y `.worktrees/` (estado, gitignored), y las 4
etiquetas de GitHub.

### Cómo se distribuye hoy

La app arma un kit (`desktop/scripts/build-kit.mjs`) con la lista de archivos y su sha256.
`install/run.js` copia el kit al repo, genera `config.json`, `checks.sh` y el borrador de
`project.md`, actualiza `.gitignore`, escribe `factory/.manifest.json` y abre un PR. `update.js` hace
un merge de 3 vías por archivo y `config-merge.js` agrega claves nuevas al `config.json` sin pisar
valores. `migrations.js` está vacío. El propio plan de eficiencia deja pendiente
"separar el motor de esta app", "versiones" y "`factory init`" (`docs/factory-efficiency-plan.md:872-873`).

### Lo que ya juega a favor

- `factoryRoot()` (`factory/lib/util.js:35-41`) encuentra el checkout principal con
  `git rev-parse --git-common-dir`, incluso desde un worktree. El motor no depende de dónde está
  instalado: solo las rutas de **datos** son `factory/...` relativas a la raíz, y esas se quedan en
  el repo.
- Ya existen overrides por variable de entorno: `FACTORY_ROOT`, `FACTORY_GH`, `FACTORY_TRANSCRIPTS`,
  `FACTORY_CODEX_SESSIONS`.
- Sin dependencias de npm: el caché de plugins no tiene que instalar nada.

## 2. Qué ofrece cada plataforma (verificado el 2026-11-07)

### Claude Code

Fuente: `code.claude.com/docs/en/plugins/*`, `skills.md`, `hooks.md`.

| Necesidad del factory | Soporte |
| --- | --- |
| Skill con argumentos | Sí. Se invoca `/<plugin>:<skill>`, por ejemplo `/eminzo:factory run`. |
| Subagentes | Sí, como `eminzo:builder`. Frontmatter válido: `tools`, `model`, `effort`, `skills`, `omitClaudeMd`, `isolation: worktree`... |
| Hooks por agente en el frontmatter | **No.** En agentes de plugin se ignoran `hooks`, `permissionMode`, `mcpServers` e `initialPrompt`. |
| Hooks del plugin | Sí, en `hooks/hooks.json`. `SubagentStop` filtra por tipo de agente (`^eminzo:builder$`). |
| Scripts en el PATH | Sí. `bin/` entra al PATH de la herramienta Bash mientras el plugin está activo, después del PATH del usuario. |
| Ruta del plugin | `${CLAUDE_PLUGIN_ROOT}` se reemplaza en el texto de skills, agentes y hooks. **No** existe como variable de entorno en los comandos Bash que corre el modelo. |
| Datos que sobreviven a updates | `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`). |
| Configuración del usuario | `userConfig` en `plugin.json`, con valores sensibles en el llavero del sistema. |
| Permisos incluidos | **No.** El `settings.json` del plugin solo acepta `agent` y `subagentStatusLine`. Los permisos los pone el usuario, el admin o el `.claude/settings.json` del repo. |
| Distribución | Marketplace en un repo de GitHub (`.claude-plugin/marketplace.json`), `claude plugin install eminzo@<marketplace>`, versión fija con `version`, `ref` o `sha`, y repos privados con las credenciales de git. |
| Activarlo por repo | `.claude/settings.json` con `extraKnownMarketplaces` y `enabledPlugins`. Se aplica después del diálogo de confianza de la carpeta. |
| Empresas | Managed settings: `strictKnownMarketplaces`, `enabledPlugins` forzado, `blockedMarketplaces`. |
| Paneles al lado del chat | Sí, con "mods" (v2.1.287 o más). Corren con los permisos del usuario. |
| Modo headless (`claude -p`, Agent SDK) | Sí. Los plugins instalados se cargan. |
| Límites | El plugin se copia a `~/.claude/plugins/cache/...`. Nada fuera de su carpeta se copia, `..` está prohibido, y las versiones viejas se borran a los 14 días. |

### Codex

Fuente: `learn.chatgpt.com/docs/{build-skills,plugins,hooks,agent-configuration/subagents}`.

| Necesidad del factory | Soporte |
| --- | --- |
| Skill | Sí. Sigue el estándar abierto de agent skills: el mismo `SKILL.md` sirve en Claude y Codex. Se invoca con `$eminzo-factory`. |
| Plugin | Sí: skills, MCP, hooks y assets. Marketplace en `.agents/plugins/marketplace.json` y también lee `.claude-plugin/marketplace.json`. |
| Subagentes dentro del plugin | **No documentado.** `.codex/agents/*.toml` vive en el repo o en `~/.codex/agents`. |
| Hooks del plugin | Con limitaciones: según la guía, solo para plugins instalados a mano desde la app de escritorio. Piden confianza del usuario y la vuelven a pedir en cada update. |
| Ruta del plugin para scripts de la skill | **No documentada.** `PLUGIN_ROOT` existe solo en los hooks. |
| Instalar desde el CLI con un marketplace de git | `codex plugin marketplace add owner/repo` existe, pero no está confirmado que el CLI instale sin la app. |
| Empresas | `requirements.toml` (hooks gestionados), marketplaces en el `config.toml` del sistema. |

## 3. Arquitectura propuesta

```
┌──────────────────────────── repo eminzo-factory (nuevo) ───────────────────────────┐
│  engine/          CLI "eminzo" (Node, sin deps): job, gate, approve, route, init…   │
│  roles/           los 8 roles (fuente única)                                        │
│  skills/factory/  SKILL.md único (Claude + Codex)                                   │
│  adapters/claude  plugin: agents/*.md, hooks/hooks.json, bin/ → engine              │
│  adapters/codex   plugin o kit: agents/*.toml, hooks.json                           │
│  test/            tests del motor                                                   │
│  .claude-plugin/marketplace.json · .agents/plugins/marketplace.json                 │
└────────────────────────────────────────────────────────────────────────────────────┘
                 │ versión fijada                         │ versión fijada
                 ▼                                        ▼
┌──── repo del cliente ────────────────────────────────────────────────────┐
│ factory/config.json  ("engine": "0.4.x", política)                      │
│ factory/checks.sh · factory/project.md · factory/jobs/ (estado)         │
│ .claude/settings.json (marketplace + enabledPlugins + permisos Bash)    │
│ .codex/agents/*.toml (solo si usa Codex, escrito por init)              │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.1 El motor como CLI, no como archivos del plugin

Hay dos formas de llevar el motor:

| | A. El motor dentro del plugin de Claude (`bin/`) | B. El motor como paquete npm (`@eminzo/factory`, binario `eminzo`) |
| --- | --- | --- |
| Instalación | Un paso: instalás el plugin y listo | Dos pasos: `npm i -g @eminzo/factory` más el plugin |
| Codex | No sirve: Codex no pone el `bin/` del plugin en el PATH, no hay ruta documentada | Sirve igual: Codex llama `eminzo job ...` |
| App desktop | Tiene que encontrar el caché del plugin | Puede traer el mismo paquete npm adentro |
| Versión fijada por repo | Con `ref`/`sha` en `.claude/settings.json` | Con `npx @eminzo/factory@0.4.2` o chequeando la versión |

**Recomendación: B como fuente única, con A como atajo en Claude.** El plugin de Claude puede traer
una copia del motor en `bin/` (mismo build) para que quien use solo Claude no necesite npm. Pero el
motor se publica una sola vez y Codex y la app lo consumen igual. Esto también ordena el futuro SaaS:
la política corporativa la va a leer **un** motor, no tres copias.

### 3.2 Uniformidad: fijar la versión del motor por repo

Hoy la uniformidad sale gratis: el motor está en el commit. Con un plugin o un CLI hay que forzarla:

1. `factory/config.json` agrega `"engine": "0.4.x"` (un rango semver).
2. Cada comando del motor compara su versión con ese rango y, si no coincide, se niega con un mensaje
   claro (`engine 0.5.1 does not satisfy "0.4.x" in factory/config.json; run ...`).
3. `job.json`, `checks.md`, `decision.md` y `merge-checks.md` registran la versión del motor que
   juzgó. La auditoría sigue respondiendo "qué reglas aprobaron este PR".
4. `check-stamp.js:35` hoy hashea `factory/lib` y `factory/bin`. Pasa a usar la versión del motor y
   un hash de sus archivos. Un gate de otra versión no se reusa.
5. `.claude/settings.json` del repo fija el marketplace con `ref` a un tag, así el plugin y el motor
   avanzan juntos con un PR, igual que hoy.

### 3.3 Hooks: de frontmatter a `hooks.json`

Hoy los 8 agentes tienen `hooks: Stop:` en el frontmatter, que llama a
`ensure-output '<archivo>' '<regex>'`. En un plugin de Claude ese bloque **se ignora sin error**: el
factory perdería el control de que cada agente escriba su archivo y nadie lo notaría.

Cambio: un solo `hooks/hooks.json` con `SubagentStop` y matcher por agente (`^eminzo:builder$`, ...),
que llama a `eminzo ensure-output --agent builder`. El motor guarda la tabla agente → archivo y
primera línea esperada, que hoy está repartida en 8 frontmatters. El `nudge` del builder entra en el
mismo hook. **Hay que verificar** que `SubagentStop` con `decision: block` haga seguir trabajando al
subagente, igual que hoy hace `Stop` en el frontmatter.

### 3.4 Rutas en prompts

| Hoy | Con plugin |
| --- | --- |
| `factory/bin/job <id> to build` (≈60 en SKILL.md) | `eminzo job <id> to build` (en el PATH) |
| "Read `factory/roles/builder.md`" (8 wrappers) | el rol va en el cuerpo del agente del plugin; para Codex, `developer_instructions` generado del mismo rol |
| `factory/bin/nudge`, `factory/bin/visual` desde el worktree | `eminzo nudge`, `eminzo visual`; `factoryRoot()` ya encuentra la raíz desde el worktree |
| `gate.js:44` `sh <root>/factory/bin/visual` | ruta del motor resuelta con `import.meta.url` |
| `config.json` `visual.start: sh factory/bin/dashboard` | `eminzo dashboard {port}` |
| `factory/package.json` (`type: module`) | lo trae el paquete del motor |

Las 36 referencias en roles a `factory/jobs/...` o `factory/project.md` **se quedan**: son datos del
repo. `cost.js:101` y `nudge.js:16` dependen de que `factory/jobs/<id>/` aparezca en los transcripts,
y eso sigue igual.

Para no mantener dos skills a mano, un script de build genera la variante Codex y los wrappers de
agentes desde una sola fuente (`roles/` + `skills/factory/SKILL.md` + una tabla por proveedor). Ya
hay tests de paridad (`test/provider-parity.test.js`, `test/factory-commands-parity.test.js`) que
pasarían a validar lo generado.

### 3.5 Seguridad

- **`DEFAULT_DENY` (`factory/lib/diff.js:14-26`).** Las rutas del motor (`factory/bin/**`,
  `factory/lib/**`, `factory/roles/**`, `factory/templates/**`) dejan de existir en el repo del
  cliente. Se pueden dejar, no molestan. Las que importan siguen: `.claude/**` (un repo podría
  pisar los agentes del plugin con copias en `.claude/agents/eminzo-*.md`), `.codex/**`,
  `factory/config.json`, `factory/checks.sh`, `factory/project.md` y CI.
- **`protected_tests`.** Los 10 de este repo son tests del motor (`job.test.js` está partido en cinco archivos más su harness compartido). En un repo cliente el default
  es `[]`, y este repo pasa a ser solo el que consume el motor.
- **Integridad del motor.** Hoy el builder tiene Bash con los permisos del usuario. Podría editar el
  motor en el disco (hoy `factory/lib` del checkout principal; mañana el caché del plugin) sin que
  aparezca en el diff del PR. No es un riesgo nuevo, pero con el plugin conviene que el gate compare
  el hash de los archivos del motor con el que viene en el paquete publicado.
- **Permisos.** El plugin no puede traer reglas de permisos. Sin ellas, cada `eminzo job ...` pide
  aprobación. `init` escribe en `.claude/settings.json` del repo `allow: ["Bash(eminzo:*)"]`, y queda
  en un PR revisable.

### 3.6 `init` reemplaza al instalador del kit

`/eminzo:factory init` (o `eminzo init`) hace lo que hoy hace `desktop/src/main/features/install/*`:

1. Chequeos previos: árbol limpio, rama por defecto, origen en GitHub, `gh` logueado, Node 20 o más.
2. Genera `factory/config.json` desde el template, con `"engine": "<versión>"` y `"spec_review": false`,
   y `factory/checks.sh` según el stack (lógica de `plan.js`).
3. Agrega a `.gitignore` las entradas de estado y `config.local.json`.
4. Escribe `.claude/settings.json` (marketplace, `enabledPlugins`, permiso Bash) y, si se pide
   Codex, `.codex/agents/*.toml` y `.agents/skills/`.
5. Crea las etiquetas (hoy `factory/bin/setup`).
6. Abre un PR `chore/install-factory`.

`setup` (el análisis con LLM que escribe `project.md`) queda igual.

Para actualizar se usa `eminzo upgrade`: sube el rango `engine` y corre las migraciones de
`config.json` (`config-merge.js` y `migrations.js` se mudan al motor), en un PR. El merge de 3 vías
por archivo desaparece, porque el repo ya no tiene archivos del motor.

### 3.7 Huella mínima en el repo del cliente

Objetivo: que el repo del cliente quede limpio y liviano. Solo quedan archivos que son **del
cliente**, nunca código del motor:

```
factory/config.json      política del repo: solo lo que difiere de los defaults del motor
factory/checks.sh        cómo se testea ese repo
factory/project.md       contexto del proyecto (lo escribe setup)
.claude/settings.json    marketplace, enabledPlugins con versión fija, permiso Bash(eminzo:*)
.gitignore               + factory/jobs/, factory/board.json, factory/config.local.json, .worktrees/
.codex/agents/*.toml     solo si el repo usa Codex
```

**`config.json` con solo las diferencias.** Hoy el template tiene unos 180 líneas (modelos, routing,
precios, lanes...). Si los defaults viven en el motor, el `config.json` del repo queda en algo como:

```json
{
  "engine": "0.4.x",
  "repo": "acme/shop",
  "base": "main",
  "language": "es"
}
```

- `eminzo config show` imprime la configuración efectiva (defaults del motor más el repo más
  `config.local.json`) y de dónde salió cada valor.
- Ventaja: el archivo es corto y cada línea es una decisión del equipo, no una copia del template.
- Riesgo: un cambio de default en una versión nueva del motor cambia la política sin tocar el repo.
  Mitigación: la versión está fijada en `engine`, y `eminzo upgrade` lista los defaults que cambian
  entre versiones (lo que hoy hace `config-merge.js` como sugerencias) y deja escribir el valor viejo
  en el repo para conservarlo.

**Merge, no pisar.** Si el repo ya tiene `.claude/settings.json` o `.gitignore`, `init` agrega sus
entradas sin borrar las existentes.

### 3.8 Qué pasa con la app desktop

- Detección (`desktop/src/main/features/repo/repo.js:11-31`): pasa a buscar `factory/config.json`
  con la clave `engine`, en lugar de `.manifest.json`.
- Instalar y actualizar: llama a `eminzo init` y `eminzo upgrade` con su copia del motor, en vez de
  copiar el kit. Unos 90 KB de lógica del instalador se reemplazan por llamadas al CLI.
- El dashboard ya vive en la app (`engine/`). Pasa a salir del paquete del motor.
- Lectura de `factory/board.json`, `factory/jobs/` y `config.local.json`: sin cambios.

## 4. Plan por fases

| Fase | Qué | Resultado verificable |
| --- | --- | --- |
| 0. Pruebas cortas | Verificar lo no confirmado (sección 5) con un plugin mínimo cargado con `claude --plugin-dir` | Cada duda respondida por sí o por no |
| 1. Motor sin rutas fijas (en este repo) | CLI `eminzo` con subcomandos; hooks en `hooks.json` con tabla por agente; rutas del motor por `import.meta.url`; versión del motor y chequeo de `engine` en config; generar wrappers y variante Codex desde una fuente | Los tests pasan; el factory sigue funcionando en este repo sin `factory/bin` |
| 2. Separar repos | Repo `eminzo-factory`: motor, roles, skill, adaptadores, tests, marketplaces. Este repo lo consume como cliente | `claude plugin install eminzo@...` en un repo vacío corre `init` y un job xs |
| 3. `init` y `upgrade` | Portar el instalador y `config-merge` al motor | Instalar en un repo nuevo sin la app |
| 4. Codex | Plugin con la skill y `init --codex` para agentes y hooks | Un job completo con `$eminzo-factory` |
| 5. App desktop | Instalar y actualizar con el CLI; detección por `engine` | El kit se retira |

Las fases 1 y 3 son las grandes. La fase 1 se puede hacer dentro del factory mismo, como varios
issues chicos, sin romper nada para quien ya lo usa.

## 5. Lo que hay que verificar antes de decidir

1. Que una skill de plugin pueda lanzar `subagent_type: "eminzo:builder"` con la herramienta Agent
   (la documentación lo da a entender, pero no lo dice explícitamente).
2. Que `SubagentStop` con matcher `^eminzo:builder$` y `decision: block` haga continuar al
   subagente, igual que el `Stop` del frontmatter hoy.
3. Que el `bin/` del plugin esté en el PATH también del Bash de los **subagentes**, y dentro de un
   worktree.
4. Codex: que `codex plugin marketplace add` instale desde el CLI sin la app, y si los agentes `.toml`
   pueden ir dentro de un plugin.
5. Codex: si un hook `Stop`/`SubagentStop` con `decision: block` puede reemplazar al `nudge` manual.
6. Que `npx @eminzo/factory@<versión>` (o un binario global) responda rápido en llamadas repetidas,
   porque el orquestador llama al motor decenas de veces por job.

## 6. Riesgos y contraargumentos

- **"Funciona hoy, ¿para qué cambiarlo?"** Porque el único camino de instalación es la app, y eso
  ata la adopción por developers a un binario sin firmar de 40k líneas. Si la prueba con developers
  muestra que igual usan la app, la fase 5 se puede atrasar, pero las fases 1 a 3 valen igual: el
  motor necesita una versión para que exista "el mismo flujo para todos".
- **Más piezas para el usuario.** Instalar npm y el plugin son dos pasos, y Codex suma uno más.
  Mitigación: el plugin de Claude trae el motor en `bin/` y `init` lo deja todo escrito.
- **Velocidad de cambio.** Hoy un cambio al motor se prueba con el mismo factory en este repo. Con
  repos separados, cada cambio necesita publicar una versión o usar `--plugin-dir` para probar.
  El factory construyéndose a sí mismo se vuelve más lento.
- **La plataforma puede cambiar.** Mods, `SubagentStop` por agente y los plugins de Codex son
  recientes. Mantener el motor como un CLI propio limita el daño: si un host cambia, se cambia solo
  su adaptador.
- **Nombre del comando.** Hoy es `/eminzo-factory`. En plugin pasa a ser `/eminzo:factory`. Hay que
  actualizar README, dashboard, tips de la terminal y el issue #162.

## Fuentes

- Plugins de Claude Code: https://code.claude.com/docs/en/plugins/manifest-reference.md,
  `plugins/components.md`, `plugins/install.md`, `plugins/org.md`, `plugins/create-marketplace.md`,
  `plugins/mods/overview.md`, `agent-sdk/plugins.md`, `skills.md`, `hooks.md`.
- Codex: https://learn.chatgpt.com/docs/build-skills, https://learn.chatgpt.com/docs/plugins,
  https://learn.chatgpt.com/docs/hooks, https://learn.chatgpt.com/docs/agent-configuration/subagents,
  https://developers.openai.com/plugins/build/plugins.
- Código: `factory/lib/util.js:35-50`, `factory/lib/diff.js:14-26`, `factory/lib/check-stamp.js:35`,
  `factory/lib/gate.js:44,57`, `factory/lib/nudge.js:16-25`, `factory/lib/cost.js:101`,
  `.claude/agents/eminzo-builder.md:6-14`, `desktop/src/main/features/install/{kit,run,update,config-merge,migrations}.js`,
  `desktop/src/main/features/repo/repo.js:11-31`, `docs/factory-efficiency-plan.md:872-873`.
