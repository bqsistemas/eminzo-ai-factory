# Eminzo con Codex

Cómo funciona el adaptador de Codex, qué es portable y qué sigue acoplado a Claude Code. Volver al [README](../README.md).

## Compatibilidad con Codex

La factory conserva una **spine portable** y ahora incluye un adaptador nativo
para Codex. Claude Code sigue usando `/eminzo-factory`; Codex usa `$eminzo-factory`. Ambos
leen y actualizan los mismos archivos de trabajo y ejecutan los mismos scripts
de transición.

La identidad instalada es `eminzo-factory`: los agentes viven bajo nombres
`eminzo-*` y las skills canónicas están en `.claude/skills/eminzo-factory` y
`.agents/skills/eminzo-factory`. El instalador empaqueta únicamente esas skills
canónicas; las skills `factory` heredadas que quedan en este repositorio no se copian
a los repos nuevos.

### Qué ya es portable

- `factory/lib/job.js`: estados, worktrees, transiciones, PRs y merge.
- `factory/lib/route.js`: reviewers por riesgo y superficie.
- `factory/lib/gate.js`: gate determinista y tests protegidos.
- `factory/bin/job`, `gate`, `route` y `setup`.
- GitHub como cola y frontera de confianza.
- `factory/jobs/<id>/job.json` y `factory/board.json` como estado compartido.

### Qué está acoplado a Claude Code

- `.claude/skills/eminzo-factory/SKILL.md` define `/eminzo-factory run`, `/eminzo-factory issue` y
  `/eminzo-factory rework`, además de la orquestación en background.
- `.claude/agents/eminzo-*.md` son envoltorios finos: frontmatter, herramientas, hooks y
  aliases de modelos de Claude (`opus`, `sonnet`, `haiku`, `fable`). El cuerpo de
  cada rol vive en `factory/roles/<rol>.md`, compartido con Codex.
- El builder usa un hook `Stop` de Claude.
- `factory/lib/util.js` busca transcripts en `~/.claude/projects`.
- `factory/lib/cost.js` interpreta JSONL de transcripts Claude.
- `factory/lib/nudge.js` interpreta el payload del hook de Claude.

### Implementación actual

- `.agents/skills/eminzo-factory/SKILL.md` implementa `$eminzo-factory run`, `$eminzo-factory issue`,
  `$eminzo-factory add` y `$eminzo-factory rework` reutilizando `factory/bin/job`, `gate` y
  `route`. No duplica la máquina de estados.
- `factory/config.json` conserva el routing Claude y agrega `providers.codex`.
  Un job Codex se crea con `factory/bin/job new <issue> --provider codex`; al
  pasar intake, el proveedor y los modelos resueltos quedan persistidos en
  `job.json`.
- `.codex/agents/*.toml` registra los ocho roles de la factory como subagentes
  Codex. Cada perfil referencia el cuerpo del rol en `factory/roles/` y
  conserva sus límites de lectura/escritura y protocolos de primera línea.
- Los reviewers se lanzan en paralelo y el adaptador espera todos los archivos
  antes de avanzar. El gate sigue siendo la autoridad determinista y los merges
  siguen pasando por `factory/bin/job`.
- Claude y Codex pueden reanudar el mismo `job.json`; no deben ejecutar el mismo
  job simultáneamente porque todavía no existe un lease entre procesos.

### Limitaciones conocidas y siguiente fase

- `factory/lib/cost.js` solo interpreta transcripts JSONL de Claude. Un job
  ejecutado desde Codex puede mostrar `$0.00` aunque su uso no haya sido medido;
  ese valor **no** debe interpretarse como costo verificado. La siguiente fase
  debe agregar un adaptador de usage por proveedor y mostrar `unknown` cuando no
  exista una fuente confiable.
- El routing Claude conserva aliases (`opus`, `sonnet`, `haiku`, `fable`). Codex
  usa los IDs configurados en `providers.codex` (`gpt-6-luna` y
  `gpt-6.1-sol`); su disponibilidad depende de la cuenta, plan y cliente, por
  lo que deben validarse antes de ejecutar una cola real.
- El hook `Stop` de `.claude/agents/eminzo-builder.md` sigue siendo específico de Claude.
  En Codex, el builder corre `factory/bin/nudge <id>` antes de escribir `STATUS: READY`,
  la skill corre `factory/bin/nudge <id>` antes de `job <id> to gate` y el gate
  explícito (`factory/bin/gate`) es la barrera obligatoria.
- No se agregó persistencia ni una migración a Agents API: GitHub, worktrees,
  scripts y artefactos de etapa siguen siendo la frontera compartida.

La compatibilidad está cubierta por `test/codex-factory.test.js` y
`test/codex-routing.test.js`, que verifican el skill, los ocho perfiles, el
routing por proveedor, la persistencia del modelo y la permanencia del
adaptador Claude.

Referencias oficiales: [skills de Codex](https://learn.chatgpt.com/docs/build-skills),
[subagentes y agentes personalizados](https://learn.chatgpt.com/docs/agent-configuration/subagents)
y [modo no interactivo](https://learn.chatgpt.com/docs/non-interactive-mode).

Watch it on the dashboard:

```sh
factory/bin/dashboard 8000
open http://localhost:8000/dashboard.html         # live board
open http://localhost:8000/dashboard.html?demo    # sample data
```
