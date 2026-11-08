# Codex cost accounting

`factory/bin/job <id> sync` calcula y persiste el costo; sigue siendo el único
escritor de `job.json` y `board.json`. No se requiere un proceso adicional.

## Configuration

Los precios Claude existentes siguen en `prices`, sin cambios. Para Codex,
configurá `providers.codex.prices` con claves que coincidan exactamente con
`turn_context.model` del rollout y valores USD por millón de tokens:

```json
{
  "providers": {
    "codex": {
      "prices": {
        "your-exact-model-id": {
          "input": 10,
          "cache_read": 2,
          "cache_write": 5,
          "output": 20
        }
      }
    }
  }
}
```

**Los números del ejemplo son sintéticos, no tarifas del proveedor.** Cargá las
tarifas verificadas de tu cuenta. Los cuatro valores deben ser números finitos
no negativos; cero explícito es válido. El mapa predeterminado está vacío:
Factory no inventa tarifas para los aliases locales `gpt-6-*`.

## Sources and attribution

- Se leen archivos JSONL regulares bajo `$CODEX_HOME/sessions`, o
  `~/.codex/sessions` si no existe `CODEX_HOME`. `FACTORY_CODEX_SESSIONS` permite
  usar una ubicación explícita. No se siguen enlaces simbólicos encontrados.
- Solo se acepta el worktree exacto del job (o sus subdirectorios), o una sesión
  del checkout principal con un contrato al comienzo de un mensaje de usuario:
  `Job folder: factory/jobs/<id>/`, seguido de `Branch: factory/<id>` (con
  `Round folder: factory/jobs/<id>/round-N/` opcional entre ambos). El contrato
  debe preceder al primer uso. Los mensajes de instrucciones previos no impiden
  reconocerlo. Encabezados aislados, ejemplos explicativos, bloques cercados,
  citas, menciones casuales y salidas de herramientas no autorizan consumo.
- Una sesión compartida entre jobs o con evidencia contradictoria no se atribuye.
  Se valida tanto `session_meta.cwd` como cada `turn_context.cwd` presente;
  un contexto de otro worktree invalida el total, incluso si la sesión comenzó
  en el worktree correcto. También se conserva evidencia de sesiones que entran
  al repositorio después de iniciarse fuera de él, incluido el checkout principal
  con contrato del job; esa evidencia invalida cualquier subtotal conocido de
  otras sesiones dedicadas del mismo job.
  No se hereda el consumo de un orquestador padre que pueda manejar varios jobs.
- Los snapshots acumulativos se deduplican por ID de sesión, incluso entre copias
  de archivos. Los deltas se valoran con el modelo activo en cada respuesta.
- Los forks pueden copiar prompts y contadores del padre usando un ID distinto.
  Se conserva `forked_from_id`, pero no se infiere un límite de historial a partir
  de snapshots: un fork relevante produce `ambiguous_session`, aunque el padre
  esté disponible o aparezca una asignación nueva. Se prefiere costo no disponible
  a duplicar uso heredado o inventar deltas. Para obtener costos verificables se
  necesita una sesión dedicada sin fork.
- `input_tokens` incluye sus subconjuntos de caché; se restan lectura/escritura
  antes de valorar input ordinario. `output_tokens` ya incluye reasoning.

## Availability

Un costo verificable usa `cost_status: "available"`, `cost_reason: null` y un
`cost_usd` numérico, incluido cero real. De lo contrario, `cost_usd` es `null`,
`cost_status` es `"unavailable"` y `cost_reason` es uno de:
`no_associated_usage`, `ambiguous_session`, `missing_model`, `missing_price` o
`invalid_usage`. Un costo parcial desconocido invalida el total del job.

El dashboard localiza el estado de costo no disponible, las indicaciones y los
agregados en `en`, `es` y `pt` según `board.language`. El CLI conserva
`Cost unavailable`. Los agregados señalan que son
subtotales conocidos y cuántos costos faltan. Los jobs Codex antiguos sin estado
se presentan como desconocidos hasta sincronizarlos. No se persisten prompts,
salidas de herramientas, secretos ni texto del rollout. Las tarjetas incluyen una
indicación accesible y un tooltip según `cost_reason`, con el siguiente paso para
precios ausentes, falta de uso/modelo, asociación ambigua o contadores inválidos;
motivos desconocidos no se interpolan en el HTML.

## Verification

`test/cost.test.js` se conserva intacto. Las regresiones Codex y de integración
están en `test/codex-cost.test.js`, también protegido. Ejecutá `factory/checks.sh`
con Node 20, el runtime documentado del proyecto. Las regresiones de la segunda
revisión están en `test/codex-cost-review.test.js`; cubren forks con ID distinto,
continuaciones entre worktrees, entrada al checkout principal desde fuera del
repositorio, contratos citados, paridad de sync/summary/board y localización de
tarjetas, indicaciones accesibles, detalles del pipeline y agregados.

## Costo por agente (`cost_by_agent`)

`job <id> sync` persiste en `job.json` un desglose con la misma forma para Claude
y Codex, además de `cost_usd`, que no cambia:

```json
"cost_by_agent": {
  "by_role":  { "builder": 0.84, "review-code": 0.10, "spec-writer": 0.02 },
  "by_round": { "1": 0.61, "2": 0.35, "unassigned": 0.02 }
}
```

- Las claves van ordenadas (roles alfabéticos; rondas numéricas, `unassigned` al
  final) y las dos sumas igualan `cost_usd`.
- **Claude**: el rol sale del `agentType` del `.meta.json` de cada transcript de
  subagente; si falta, de la línea `SubagentStart:<rol>` y, en último caso, del
  archivo que el agente escribió (`intake.md`, `review-ui.md`, ...). Sin ninguna
  pista el rol es `unknown`, nunca se descarta el gasto. La ronda sale de
  `Round folder: .../round-N/` y de los mensajes `Round N needs changes`, así un
  builder reanudado reparte su costo por ronda.
- **Codex**: el rol sale de `.claude/agents/eminzo-<rol>.md` en el contrato del worker y
  la ronda de su `Round folder:`. Cada delta de uso se atribuye al rol y la ronda
  del último contrato visto antes de ese snapshot.
- Un costo `unavailable` no lleva desglose, y un sync que lo vuelve no disponible
  borra el desglose viejo. El dashboard muestra "Agent cost" en el inspector del
  pipeline solo cuando hay datos para la etapa seleccionada.

## Por qué los jobs 032, 034, 035 y 036 mostraban "Cost unavailable"

Se revisaron los rollouts reales (`~/.codex`, solo metadatos) con las reglas de
`codexJobCost`:

- **034, 035 y 036 (`ambiguous_session`)**: cada job tiene sesiones de `intake` y
  `spec-writer` cuyo prompt empieza con `Job folder:` y sigue con `Issue:` y
  `Project checkout:`, **sin la línea `Branch: factory/<id>`**. El contrato exige
  esa línea porque un encabezado suelto no puede autorizar uso en el checkout
  principal (ver "Sources and attribution"). Esas sesiones se detectan como del job
  pero sin asignación, hay uso antes de una asignación válida y todo el job pasa a
  `ambiguous_session`. Las sesiones de builder y reviewers, con el contrato
  completo, sí se atribuyen. Es la regla fail-closed funcionando como se diseñó; la
  causa es el prompt del orquestador, no el parser.
- **Corrección**: ambas skills piden ahora enviar todos los campos del contrato
  (`Job folder`, `Round folder`, `Branch`, `Worktree`, `Issue`, `Port`) a **todos**
  los workers, incluidos `factory-intake` y `factory-spec-writer`, sin líneas
  previas a `Job folder:`. No se relajó el parser. Los jobs ya terminados no se
  recuperan: sus rollouts no tienen el contrato y siguen sin atribuirse.
- **032 (`cost_usd: 0` sin `cost_status`)**: job antiguo, anterior al estado de
  costo. No se sincronizó con el código actual; un `job 032-... sync` lo deja en
  `unavailable` por la misma razón, no en `$0.00`.

## Sesión orquestadora

`cost_usd` y `cost_by_agent` suman solo subagentes. La sesión que corre
`/eminzo-factory` o `$eminzo-factory` (cargar la skill, leer notificaciones, mover etapas) maneja
varios jobs y además cualquier otra cosa que la persona haga allí, así que **no se
reparte entre jobs**. Lo que sí se puede medir, sin inventar números:

- **Claude**: `factory/bin/job summary --orchestrator` agrega una línea
  `orchestrator sessions: N, $X`. Cuenta las sesiones cuyo `subagents/` contiene al
  menos un agente que trabajó en un job (`Job folder: factory/jobs/<id>/`), con el
  uso propio de la sesión completa. Los subagentes tienen transcript aparte, así que
  no hay doble conteo. Es una cota superior del costo de orquestar: incluye todo lo
  que se hizo en esa sesión. El resumen sin la opción no cambia.
- **Codex**: no se puede atribuir de forma confiable. La sesión orquestadora no lleva
  contrato `Job folder:` y la regla fail-closed descarta sesiones compartidas o
  ambiguas, por lo que no se reporta ningún número en lugar de uno falso.
