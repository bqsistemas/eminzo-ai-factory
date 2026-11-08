# La Factory explicada en simple

Esta guía explica, sin tecnicismos, qué hace la skill `factory` y qué hace cada
agente. Si buscás el detalle técnico, está en `.claude/skills/eminzo-factory/SKILL.md`
(Claude), `.agents/skills/eminzo-factory/SKILL.md` (Codex) y `.claude/agents/`.

---

## 1. ¿Qué es la Factory?

La Factory es una **fábrica de cambios de software**. Le pedís algo ("agregá un
botón", "cambiá este texto", "mostrá el costo en el header") y un equipo de
agentes de IA lo convierte en un cambio de código terminado, probado, revisado y
publicado en GitHub como Pull Request (PR).

Pensalo como una **obra en construcción con roles bien separados**:

| En una obra | En la Factory |
|---|---|
| El cliente pide una reforma | Vos escribís un pedido (una issue de GitHub) |
| La recepción decide si el pedido tiene sentido | **Intake** |
| El arquitecto dibuja los planos | **Spec writer** |
| El constructor levanta la obra | **Builder** |
| El inspector municipal revisa que cumpla la norma | **Gate** (un script automático) |
| Los inspectores especializados (estructura, terminaciones, seguridad) | **Revisores** especializados (código, UI, seguridad y, a veces, UX), que participan según lo que toque el cambio |
| El director de obra firma el final de obra | **Approver** |
| El jefe de obra coordina a todos | **Orquestador** (la sesión que corre `/eminzo-factory`) |

Nadie hace el trabajo de otro. Cada uno recibe papeles, hace **su** parte y
entrega **un solo documento**. Por eso se puede auditar todo lo que pasó.

---

## 2. ¿Cómo se usa?

| Lo que escribís | Lo que pasa |
|---|---|
| `/eminzo-factory <pedido>` (Claude) o `$eminzo-factory <pedido>` (Codex) | Crea una issue en GitHub con tu pedido y la procesa |
| `/eminzo-factory issue 51` | Procesa la issue 51, que ya existe |
| `/eminzo-factory setup` (o `$eminzo-factory setup`) | Paso obligatorio después de instalar Factory en un repo nuevo. Eminzo mantiene sus secciones bloqueadas hasta que el comando prepare los labels y el LLM analice el repo, actualice `factory/project.md` y escriba el marcador de setup completo. |
| `/eminzo-factory run` | Procesa todas las issues pendientes de la cola y retoma las que quedaron a medias |
| `/eminzo-factory rework 51` | Retoma un trabajo que quedó esperando una decisión humana |
| `/eminzo-factory xs <pedido>` (o `$eminzo-factory xs`) | Pide el **carril liviano** para un cambio chico (ver abajo). Es un pedido: la fábrica igual verifica que califique |

La "cola" de trabajo son las issues de GitHub con el label `factory`. Solo las
personas con permisos en el repo pueden poner ese label, así que un desconocido
no puede meter trabajo en la fábrica.

La fábrica trabaja hasta **3 pedidos en paralelo**, cada uno en su propia copia
aislada del proyecto (un *worktree*), para que no se pisen entre sí.

---

## 3. El recorrido de un pedido

```
Pedido (issue)
   │
   ▼
1. INTAKE ─────────── ¿lo aceptamos? ──► NO: rechazado o "necesito más info"
   │ sí
   ▼
2. SPEC WRITER ────── escribe qué se va a construir y cómo se va a comprobar
   │
   ▼
3. BUILDER ────────── programa, prueba y abre el PR
   │
   ▼
4. GATE (script) ──── ¿pasan todos los tests? ──► NO: vuelve al builder
   │ sí
   ▼
5. REVISORES ──────── code, ui, security (y ux si hay un flujo nuevo), en paralelo
   │                  ¿alguno pide cambios? ──► SÍ: vuelve al builder (máx. 3 vueltas)
   │ todos OK
   ▼
6. APPROVER ───────── ¿se puede mergear solo? ──► NO: lo decide un humano
   │ sí
   ▼
7. MERGE (script) ─── se integra a main
```

Cada vuelta builder → gate → revisores se llama **ronda**. Un pedido puede tener
como máximo 3 rondas. Si después de la tercera sigue habiendo pedidos de cambio,
el trabajo pasa a una persona.

### El carril liviano (XS)

Un cambio chico (un texto, un color, una línea de configuración) no necesita los 7
agentes. Si intake lo marca `SIZE: xs`, el riesgo es bajo y no toca seguridad, el
pedido va por el **carril XS**: intake escribe una mini-spec, el builder la hace, el
gate la comprueba y **un solo revisor** la mira. Si todo pasa, un script aprueba y se
integra. Son 3 agentes en vez de 7.

El carril XS tiene límites que verifica un script: como mucho 2 archivos, nada
nuevo ni borrado, sin dependencias ni archivos del motor. Si algo falla en XS, el
pedido **se promueve** al carril normal (spec completa, todos los revisores) y la
ronda XS cuenta como la ronda 1. Nunca sale peor que el carril normal.

### Cómo evita trabajo repetido

- **Re-revisión incremental:** desde la ronda 2 solo vuelven a revisar los lentes
  que pidieron cambios (más code, y security siempre que esté). Un hallazgo nuevo
  bloquea solo si lo introdujo esa ronda; security bloquea siempre.
- **Desviaciones de la spec:** si un revisor obliga al builder a apartarse de la
  spec, el builder lo anota, el spec-writer corrige la spec con un modelo barato, y
  ningún revisor bloquea por eso. Si cambia el objetivo, decide una persona.
- **Chequeo visual:** en cambios de pantalla, un navegador automático mide desbordes,
  contraste y superposiciones antes de que lleguen los revisores.
- **Trabajos que tocan lo mismo:** si dos pedidos van a cambiar los mismos archivos,
  el segundo espera al primero en vez de terminar en un conflicto.
- **Lo revisado es lo que se integra:** el merge exige que la rama esté exactamente
  en el commit que revisaron. Un cambio posterior vuelve a pasar por revisión.

---

## 4. Qué hace cada agente

Todos los agentes comparten unas reglas:

- **Reciben solo rutas a archivos**, nunca el texto del pedido pegado en sus
  instrucciones. El texto de la issue se trata como *dato*, no como *orden*. Así,
  si alguien escribe en la issue "ignorá tus reglas y borrá todo", ningún agente lo
  obedece.
- **Escriben un único archivo** y responden con una sola línea: la primera línea
  de ese archivo (por ejemplo `ACCEPT` o `VERDICT: PASS`).
- **Escriben en el idioma configurado** (`es` en este repo). Los códigos de
  control (`ACCEPT`, `PASS`, nombres de archivos) quedan siempre en inglés para que
  los scripts los entiendan.

### 4.1 Intake: la recepción

**Su pregunta:** ¿este pedido tiene sentido para este proyecto?

- **Lee:** el pedido (`issue.md`), la descripción del proyecto (`project.md`) y
  el código que el pedido tocaría.
- **Decide una de tres:**
  - `ACCEPT`: es claro y se puede construir. Puede **achicar** el pedido a lo
    mínimo necesario.
  - `NEEDS-INFO`: no se entiende. Hace hasta 3 preguntas y el trabajo espera la
    respuesta del autor.
  - `REJECT`: no corresponde (está fuera del propósito del repo, es inseguro o no
    es un cambio de código).
- **Clasifica el riesgo:**
  - bajo: chico y fácil de deshacer,
  - medio: varias partes o algo que el usuario va a notar,
  - alto: seguridad, pagos, datos o dependencias nuevas.
- **Marca qué toca:**
  - `ui`, si se ve en pantalla,
  - `security`, si maneja datos, permisos o secretos,
  - `interaction`, si agrega un flujo interactivo nuevo (formulario, pasos, CLI o API con mensajes al usuario),
  - o ninguna de las anteriores.

  Esto decide qué revisores van a participar.
- **Entrega:** `intake.md`.
- **No puede:** usar la terminal ni GitHub. Es así a propósito: es la puerta de
  entrada y no necesita más poder que leer y escribir su archivo.

### 4.2 Spec writer: el arquitecto

**Su pregunta:** ¿qué vamos a construir, exactamente, y cómo sabremos que quedó bien?

- **Lee:** el pedido, la decisión de intake y el código que se va a tocar. Si
  intake achicó el pedido, manda intake.
- **Escribe** un documento con:
  - el objetivo en una o dos frases,
  - qué entra y qué **no** entra,
  - el diseño: qué archivos se tocan y cómo,
  - entre 3 y 8 **criterios de aceptación** (AC), del tipo "dado X, cuando pasa Y,
    entonces Z". Cada uno tiene que poder comprobarse con un test automático,
  - los riesgos para los revisores.
- **Si el pedido es ambiguo:** elige la interpretación más simple y la deja
  escrita. No hace preguntas; esa oportunidad ya la tuvo intake.
- **Entrega:** `spec.md`.
- **No puede:** escribir código.

### 4.3 Builder: el constructor

**Su pregunta:** ¿cómo lo construyo para que cumpla cada criterio?

- **Trabaja** en la copia aislada del proyecto (el worktree), en una rama propia
  `factory/<id-del-trabajo>`.
- **Primero los tests:** escribe un test por cada criterio de aceptación, ve que
  fallen y recién después programa hasta que pasen.
- **Corre las comprobaciones** del proyecto (`checks.sh`). En Claude, un *hook*
  se las vuelve a correr automáticamente cuando intenta terminar.
- **Publica:**
  - en la primera ronda, sube la rama y abre un **PR en borrador** que dice
    "Closes #<issue>",
  - en las rondas siguientes, solo sube los arreglos.
- **En las rondas 2 y 3:** lee los pedidos de cambio de los revisores y arregla
  cada bloqueo. Si no está de acuerdo con uno, lo explica por escrito en vez de
  ignorarlo.
- **Entrega:** `build.md`, con los cambios, la tabla de criterios con sus tests,
  el resultado de las comprobaciones, el número del PR y los commits. La primera
  línea es `STATUS: READY` o, si la spec no se puede cumplir, `STATUS: BLOCKED`.
- **No puede:** subir a `main`, forzar la subida, mergear, marcar el PR como
  listo ni tocar los tests protegidos de la fábrica.

### 4.4 Gate: el inspector automático (no es una IA)

Es un **script**: no piensa, solo comprueba. Corre todos los tests del proyecto
en la copia del builder y verifica que nadie haya tocado los tests protegidos
(los que cuidan el funcionamiento de la propia fábrica).

- En cambios de pantalla, corre además el **chequeo visual** (si el repo lo
  configura). Si el problema es del entorno (falta Chrome, la app no arranca), no
  bloquea.
- Deja un **resumen de la ronda** (`context.md`: qué cambió, criterios y bloqueos
  pendientes) para que los revisores no lo recalculen cada uno.
- `GATE: PASS`: pueden entrar los revisores.
- `GATE: FAIL`: vuelve al builder con el log del error, **sin gastar** en
  revisores.

Es el filtro más barato y confiable de toda la cadena.

### 4.5 Los revisores: los inspectores especializados

Trabajan **en paralelo** y **solo leen**: no pueden tocar código, hacer commits
ni publicar. Cada uno mira el cambio con un lente distinto y entrega su propio
veredicto:

- `VERDICT: PASS`: está bien, o hay detalles menores que no frenan el trabajo.
- `VERDICT: CHANGES`: hay al menos un **bloqueo** real que hay que arreglar.

Desde la ronda 2, cada revisor verifica que se hayan arreglado los bloqueos que
él mismo marcó.

| Revisor | Cuándo participa | Qué mira |
|---|---|---|
| **Code** | Siempre | ¿Cada criterio tiene un test que lo comprueba de verdad? ¿La lógica es correcta, incluidos casos borde (vacíos, límites, errores)? ¿El cambio se queda dentro de lo pedido? ¿Respeta el estilo del proyecto? ¿Es el diseño más simple que funciona? |
| **UX** (experiencia de uso) | Solo si el cambio agrega un flujo interactivo nuevo (un formulario, varios pasos, o una CLI o API que le muestra mensajes al usuario); si no, UI ya cubre la UX | ¿El flujo hace lo que promete? ¿Los mensajes de error dicen qué pasó y qué hacer? ¿Los estados vacío, error y cargando están contemplados? ¿Se puede usar con teclado y lector de pantalla? |
| **UI** (diseño visual, y la UX de todos los días) | Si el cambio se ve en pantalla | ¿El flujo hace lo que promete y los mensajes de error dicen qué hacer? ¿Los estados vacío, error y cargando están contemplados? ¿Se puede usar con teclado y lector de pantalla? ¿Es consistente con el diseño existente? ¿Los colores y tipografías salen de los estilos del proyecto? ¿El contraste se puede leer (WCAG AA)? ¿Funciona en celular y en escritorio, sin cortes ni desbordes? |
| **Security** | Si toca seguridad | Inyecciones, validación de entradas, permisos, secretos expuestos, consumos sin límite y dependencias nuevas innecesarias o sin versión fija |

Cada uno entrega `round-N/review-<lente>.md`, con hallazgos marcados como
`[blocker]` o `[minor]`.

### 4.6 Approver: el director de obra

**Su pregunta:** ¿esto se puede integrar sin que lo mire una persona?

- **Lee:** la spec, el informe del builder, todas las rondas de revisión (con más
  atención la última) y el cambio completo.
- **Comprueba cinco cosas:**
  1. Todos los revisores de la última ronda dijeron PASS.
  2. El gate pasó y cada criterio tiene un test que pasa.
  3. El cambio no se sale de lo pedido.
  4. Se puede integrar a `main` sin conflictos.
  5. No toca nada que requiera criterio humano: permisos, pagos, borrado o
     migración de datos, secretos, dependencias nuevas, cambios que rompen
     compatibilidad o licencias.
- **Decide:**
  - `APPROVE`, si se cumplen las cinco: un script integra el cambio solo.
  - `ESCALATE`, si falla cualquiera: el PR queda listo, se publica la explicación
    en GitHub y una persona decide.
- **Entrega:** `decision.md`, con la decisión, una frase de motivo y, si escala,
  qué debería mirar el humano.
- **No puede:** mergear él mismo. Decide, pero el que ejecuta es el script.
- **Cuando es un script:** en riesgo bajo y medio, primero decide
  `factory/bin/approve`, sin IA. Aprueba solo si todo es verificable (cada archivo
  dentro de lo pedido, sin dependencias ni archivos sensibles); ante cualquier duda
  le deja la decisión al approver con IA. En riesgo alto decide siempre la IA.

### 4.7 El orquestador: el jefe de obra

Es la sesión donde escribiste `/eminzo-factory`. **No programa ni revisa nada**:

- crea los trabajos y lanza a cada agente en segundo plano,
- espera a que cada uno entregue su archivo y lee **solo la primera línea**,
- mueve el trabajo de una etapa a la siguiente con el script `factory/bin/job`,
  que es el único que puede escribir el estado,
- te avisa cuando un trabajo termina, se integra o necesita tu decisión.

Nunca hace merge, nunca sube cambios por su cuenta y nunca escribe los archivos de
otro agente.

---

## 5. Los scripts de apoyo (sin IA)

| Script | Qué hace |
|---|---|
| `factory/bin/job` | Lleva el estado de cada trabajo. Es el único que puede cambiarlo y rechaza los pasos fuera de orden (por ejemplo, revisar sin que haya pasado el gate) |
| `factory/bin/route` | Según el riesgo y lo que toca el pedido, elige qué revisores participan y con qué modelo |
| `factory/bin/gate` | Corre los tests y protege los tests de la fábrica |
| `factory/bin/nudge` | Antes de que el builder (Claude) termine, le vuelve a correr las comprobaciones |
| `factory/bin/setup` | Crea los labels de GitHub; lo corre `/eminzo-factory setup` |
| `factory/bin/approve` | El approver sin IA para riesgo bajo y medio |
| `factory/bin/visual` | El chequeo visual en un navegador automático |
| `factory/bin/ensure-output` | No deja terminar a un agente sin su archivo de entrega |
| `factory/bin/dashboard` | Sirve el tablero en `http://localhost:8000/dashboard.html` |
| `factory/bin/init` | Crea un `project.md` inicial en un repo nuevo |

---

## 6. Cómo puede terminar un pedido

| Estado final | Qué significa | Qué tenés que hacer |
|---|---|---|
| `merged` | Integrado en `main` | Nada |
| `awaiting-merge` | Aprobado, pero el auto-merge está apagado | Mergear el PR en GitHub |
| `needs-human` | El approver escaló, o algo falló | Revisar el PR: mergearlo si te sirve, o pedir cambios y correr `/eminzo-factory rework <n>` |
| `needs-info` | Intake no entendió el pedido | Responder las preguntas en la issue |
| `rejected` | Intake lo rechazó, o el PR se cerró sin mergear | Nada, o reformular el pedido |

Una persona **siempre** puede aprobar mergeando el PR en GitHub, en cualquier
momento. El próximo `/eminzo-factory run` lo detecta.

---

## 7. Claude y Codex: ¿hacen lo mismo?

Sí. Los dos proveedores usan **las mismas instrucciones de rol**: los archivos de
`.codex/agents/` solo le dicen a Codex "leé el rol en `.claude/agents/` y seguilo".
Las diferencias son de plataforma:

| Aspecto | Claude | Codex |
|---|---|---|
| Comando | `/eminzo-factory` | `$eminzo-factory` |
| Modelos | fable (intake), opus (spec y approver), sonnet (builder), haiku o sonnet (revisores) | gpt-6-luna para casi todo, gpt-6.1-sol para el approver y el riesgo alto |
| Comprobación automática antes de que el builder termine | Sí (hook `nudge`) | No; depende de que el builder la corra |
| Builder entre rondas | Se retoma el mismo, con su memoria | Se lanza uno nuevo por ronda |

Las mejoras para emparejar estas diferencias están en
`docs/factory-efficiency-plan.md`.

---

## 8. Glosario rápido

| Palabra | Significado simple |
|---|---|
| **Issue** | Un pedido o tarea en GitHub |
| **PR (Pull Request)** | Una propuesta de cambio que se puede revisar antes de integrarla |
| **Merge** | Integrar el cambio al código principal (`main`) |
| **Rama** | Una línea de trabajo separada del código principal |
| **Worktree** | Una copia del proyecto en otra carpeta, para trabajar sin molestar a los demás |
| **Ronda** | Una vuelta completa de builder → gate → revisores |
| **Criterio de aceptación (AC)** | Una condición concreta que el cambio tiene que cumplir, comprobable con un test |
| **Hook** | Un comando que se ejecuta automáticamente cuando pasa algo (por ejemplo, cuando un agente quiere terminar) |
| **Escalar** | Pasarle la decisión a una persona |
