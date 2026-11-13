# The product stage (Ask Eminzo)

Before any issue exists, a Product Lead or Product Owner takes an idea to an **approved brief** and a list of
**deliverables**, in functional language, with the repository as context. Issues are cut from the approved brief
later; a tech lead decides which ones enter the factory. Nothing in this stage writes code, creates issues or adds
labels.

It runs in the Eminzo desktop (Ask Eminzo, Product mode) and, without the desktop, in Claude Code
(`/eminzo-product <idea>`) or Codex (`$eminzo-product <idea>`). `eminzo install` installs the `eminzo-product`
skill for both tools, next to `eminzo-factory`.

The skill's sub-commands are `<idea>`, `status`, `estimate` and `map` (draft or update the
[functional map](#the-functional-map)). In the terminal the skill follows the same rules as the desktop:

- It reads `product_map` first and labels each claim about today's behaviour `confirmed` (in the map, or seen in the
  product) or `assumed`.
- It approves only after the person's explicit words, with `brief_status` in state `ready` and no open blocker
  finding. It quotes those words back, uses the person's GitHub login (`gh api user --jq .login`, or asks; it never
  invents one), calls `approve_brief` and shows the returned brief. The desktop keeps `approve_brief` out of its chat
  agent's tools and calls it from the person's Approve button.
- It refuses to create issues, or to propose creating them, unless `brief_status` says `can_create_issues` is true,
  and quotes the `reason`. It never creates issues itself: the Eminzo desktop does, with the person's
  confirmation (see [Hand-off](#hand-off-from-an-approved-brief-to-issues)).
- In step 5 it sizes each deliverable by reading intake's criteria (`eminzo show roles/intake.md`) when it runs, never
  from a copy. When a deliverable is size `l` or risk `high` it proposes one or two other splits, runs `estimate_work`
  for each option and shows them side by side (range, base, warnings) for the person to choose. After approval it
  points to the Eminzo desktop, which creates the issues after the person confirms, and says the tech lead adds the
  `factory` label to the deliverables they accept.
- `status` with a brief issue calls `initiative` and reports in functional words
  (see [Following an initiative](#following-an-initiative)).

## The five steps

| Step | What happens | Who decides |
|---|---|---|
| 1. Explore | The problem, who has it, what they do today, the value, how the team would know it worked | Product Lead and agent |
| 2. Define | The brief is written section by section and checked after every change | Product Lead and agent |
| 3. Review | Readers who never saw the conversation look for gaps, one lens each | Context-free readers |
| 4. Approve | The brief is approved in so many words; it does not change without a new approval | Product Lead |
| 5. Deliverables | Deliverables with size and risk, estimated from the team's finished jobs | Agent, then tech lead |

## Discovery method

`factory/config.json` `discovery` picks how step 1 runs, and a person may pick their own in
`factory/config.local.json`:

| Value | Method |
|---|---|
| `eminzo` (default) | The basic method that ships with the engine: one question at a time |
| `elephant-goldfish` | Google's [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model) plugin: its brainstorm writes `concepts_brief.md`, which `import_egm_brief` turns into a brief draft |

Eminzo does not bundle Elephant-Goldfish. It only reads whether the plugin is installed and enabled:
`egm@egm` in Claude Code's `plugins/installed_plugins.json` (and not disabled in `enabledPlugins`), or a
`[plugins."egm@egm"]` table in Codex's `config.toml`. When the configured method is not installed, the basic
method runs and the person is told how to install the plugin:

```sh
claude plugin marketplace add google/elephant-goldfish-model && claude plugin install egm@egm
codex plugin marketplace add google/elephant-goldfish-model && codex plugin add egm@egm
```

## The brief contract

```markdown
<!-- eminzo:brief v1 -->
# Brief: <title>

## Problem
## For whom
## Expected value
## How it works today
## Scope
## Out of scope
## Acceptance criteria
- BC-1: <a behaviour a person can check by using the product>
## Open questions        (optional)
## Deliverables
- D1: <title> | size: s | risk: low | covers: BC-1, BC-2 | after: D2
```

- Headings may be in English, Spanish or Portuguese (the repository's `language`); the keys inside a deliverable
  line stay in English.
- Criteria ids (`BC-n`) are stable: each issue cut from the brief names the criteria it covers.
- `check_brief` lists what blocks approval: a missing section, a duplicate or malformed criterion, a deliverable
  with a bad size or risk, a criterion or deliverable that does not exist, deliverables waiting for each other. It
  warns about a criterion no deliverable covers and about a large deliverable.
- Size and risk are set the way the factory's intake sets them (`eminzo show roles/intake.md`), not by new rules.

Code: `factory/lib/brief.js` (`parseBrief`, `validateBrief`, `renderBrief`, `fromEgmConcepts`).

## Approval and the gate

Approval is a marker line at the end of the brief text, bound to a hash of the content, who approved and when:

```markdown
<!-- eminzo:approved sha256=<64 hex> by=<github login> at=<ISO 8601> -->
```

- The hash is SHA-256 (UTF-8) of `canonical + "\n" + by + "\n" + at`. The canonical text is the brief without its
  approval marker, with `\n` line endings, without a leading BOM, and without trailing spaces and tabs on each line
  or blank lines at the end. Only ASCII space and tab are ignored there; any other edit (a non-breaking space, a
  line separator) changes the hash. Any later edit to the text, to `by` or to `at` stops the hash from matching: the
  brief is `changed` and needs a new approval.
- A marker counts only as an unindented line outside fenced code blocks, and it must be the last non-blank line.
  Marker-like text inside a code fence is the person's content and is never removed. A malformed marker (uppercase
  hash, bad date, indented), two markers, or text after the marker make the brief `changed`.
- A line longer than 10 000 characters is a problem that blocks approval.
- **The marker detects edits; it does not authenticate.** `by` is self-declared and anyone who holds the text can
  compute a valid marker. GitHub (phase 4: the author and history of the issue created from the brief) is the record
  of who approved.
- `approve_brief` returns the brief with exactly one marker (an old one is replaced) and refuses a brief that has
  problems. It stores nothing; the caller saves the text. It is called only after the person said, in so many
  words, that they approve (the desktop calls it from the Approve button and keeps it away from its chat agent).
- `brief_status` says where a brief stands:

| State | Meaning | `can_create_issues` |
|---|---|---|
| `draft` | The brief has problems | no |
| `ready` | Complete, not approved | no |
| `approved` | The marker's hash matches the content | **yes** |
| `changed` | A marker is there but the content, `by` or `at` differ, or the marker is malformed, doubled or not at the end | no |

`brief_status` is **the gate**: whatever creates issues from a brief must call it and go on only when
`can_create_issues` is true (`handoff_drafts` does, and refuses with the `reason` when it is not). `reason` is one sentence a Product Lead understands, for
example "The brief changed after it was approved on 2026-11-12; approve it again."

Code: `factory/lib/brief-approval.js` (`canonicalBrief`, `briefHash`, `approveBrief`, `briefStatus`), linear in the size of the text.

## Hand-off: from an approved brief to issues

The engine only **builds the texts**. `handoff_drafts` stores nothing, creates nothing, labels nothing and closes
nothing on GitHub; the Eminzo desktop creates the issues after the person confirms them. The tech lead decides what
enters the factory by adding the `factory` label to a deliverable. Nothing here ever sets that label.

| Issue | Label | Body |
|---|---|---|
| The brief (one) | `eminzo-brief` | The approved brief text exactly as approved (approval marker included), then a hidden line |
| A deliverable (one per `Dn`) | `eminzo-deliverable` | Functional text (below), then a hidden line |

Hidden lines (HTML comments, found with a search on the issue body):

```markdown
<!-- eminzo:brief-issue v1 hash=<64 hex: the approval hash> -->
<!-- eminzo:deliverable v1 brief=<n> id=<Dn> hash=<first 12 hex of the approval hash> est=<low_min>-<high_min>|none -->
```

- A deliverable issue is titled with the deliverable title (up to 120 characters) and says: what it delivers, the
  acceptance criteria it covers (the `BC-n` lines, quoted), size and risk, what it waits for (other deliverables,
  as `#n` once they exist), the estimate shown when it was created (a range and how many similar finished jobs it
  rests on, or "too little history"), and `Part of #<brief issue>`. It is written in the brief's language and never
  mentions the factory label.
- `handoff_drafts` without `brief_issue` returns the brief issue draft. With `brief_issue` it returns one draft per
  deliverable in dependency order (`after` first), plus `estimate_input`. Pass `created` (`[{ id, issue }]`) so a
  draft refers to the deliverables already created as `#n`. It calls the gate first and fails with its `reason`
  when `can_create_issues` is false, including a brief edited after approval.
- The brief issue is never edited by Eminzo afterwards: it is the approved record. Whoever created it, and when, is
  GitHub's record of who approved.
- Markers are read in linear time: one well-formed unindented line outside code fences, every field checked, at most
  200 characters. A body with two markers, or a text inside a code fence, is not trusted.

Code: `factory/lib/handoff.js` (`briefIssueDraft`, `deliverableIssueDrafts`, `parseBriefIssueMarker`,
`parseDeliverableMarker`, `briefIssueValidity`).

## Following an initiative

An initiative is the brief issue plus the deliverable issues cut from it, found by their hidden markers. `initiative`
(`{ issue }`, the brief issue number) computes its state from GitHub alone, with read-only `gh` calls: `issue view` of
the brief issue, `issue list --search '"eminzo:deliverable v1 brief=<n> " in:body' --state all` for its deliverables,
and, for each, the pull requests that close it (`closedByPullRequestsReferences`, or a search for `#<n>` on a `gh` that
lacks it), reading the `factory:facts` line of the pull request. Nothing is stored or written.

| Status | Meaning |
|---|---|
| `not-created` | A deliverable of the brief that has no issue yet |
| `waiting-tech-lead` | Open, without the `factory` label: the tech lead has not accepted it |
| `in-factory` | Open, with the `factory` label, no pull request yet |
| `in-review` | A pull request is open |
| `available` | The pull request is merged, or the issue was closed as completed |
| `closed` | The issue was closed without being completed |

- The result has `brief` (issue, title, url, `approvedBy`, `approvedAt` and `valid`: the issue body, minus its hidden
  line, still passes the approval check and the hidden line points at that approval), `deliverables` (id, issue,
  title, url, status, `factory`, the ids it waits for, the pull request, the estimate shown at creation and
  `actual_min`), `progress` (`done` = available, `total` = deliverables of the brief), `estimate_vs_actual`
  and `warnings`.
- `actual_min` is the time from the job's start until it was ready for approval, from the facts line, measured as an
  estimate measures it (waiting for people not included).
- `estimate_vs_actual` sums the estimate and the actual time over the same deliverables: those that have both.
  `counted` says how many were compared out of how many exist, and `complete` is true only when every deliverable
  is available and has both, so a partial comparison is never presented as the whole.
- Issues that carry a marker for this brief but another approval hash, or an id the brief does not have, are
  ignored with a warning; when two issues claim one deliverable the lowest number counts, with a warning. A marker
  inside a code fence is never read.
- If `gh` fails, or the issue is not a brief issue, the tool answers with a sentence a person can act on.

Code: `factory/lib/state/initiative.js`.

## The functional map

"How does it work today" needs a source better than a guess. The team keeps a reviewed markdown file,
`factory/product-map.md`, that describes the product in functional language (no code terms):

```markdown
# Product map: <title>
Reviewed: 2026-11-12 by ana-p

## <area: something a person can do or see>
- <statement> [confirmed]
- <statement> [assumed] (source: <path or screen>)
```

- `confirmed` means a person checked it in the product; `assumed` means it was read or inferred and nobody has
  checked it. The labels and the word `source` stay in English; the title prefix and the review word follow the
  repository's language (`Product map`/`Reviewed`, `Mapa del producto`/`Revisado`, `Mapa do produto`/`Revisado`).
- `product_map` reads the file (fixed path, inside the repository, up to 1 MiB) and returns its areas, who reviewed
  it, and a state: `missing`, `draft` (never reviewed, empty, malformed, with a Reviewed date in the future or two
  Reviewed lines), `reviewed`, or `stale` (reviewed more than 90 days ago; the threshold is `STALE_AFTER_DAYS`). When
  the map is missing it says how to create it; when the file exists but cannot be used (larger than 1 MiB, outside the
  repository, permission error) `state` is `missing` and `reason` says why. A line over 2000 characters is a problem.
- Nothing in the engine writes the file. The `eminzo-product` skill, in a person's own terminal session, drafts it
  with `/eminzo-product map`, shows it in full, and writes it only after the person agrees.

Code: `factory/lib/product-map.js` (`parseProductMap`, `productMapTemplate`, `mapStatus`).

## Decided by default, to confirm

These were chosen to keep moving and are pending the owner's confirmation:

- Approval is a marker inside the brief bound to a content hash (no separate approval store).
- `by` must look like a GitHub login (`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`); `at` is an ISO 8601 date and time.
- A brief with two approval markers is never trusted (`changed`).
- The functional map is a committed markdown file at a fixed path, `factory/product-map.md`, reviewed by a person
  and stale after 90 days.
- The approved brief becomes ONE issue labeled `eminzo-brief`; its body is the approved text exactly as approved
  plus the hidden line `eminzo:brief-issue`, and Eminzo never edits it afterwards (it is the approved record).
- Each deliverable becomes ONE issue labeled `eminzo-deliverable`, never `factory`: the tech lead adds `factory`
  when they accept it. Its hidden line `eminzo:deliverable` carries the brief issue number, the deliverable id, the
  first 12 hex of the approval hash and the estimate shown at creation.
- An initiative is the brief issue plus its deliverable issues, found by those markers; its state is computed from
  GitHub only.
- `available` means a merged pull request or an issue closed as completed. The estimate is compared with the actual
  time only over deliverables that have both.

## The context-free review

A reader who never heard the discussion is the best test of whether the brief says what it means. Four lenses,
one reader each:

| Lens | The reader asks |
|---|---|
| `newcomer` | What can I not understand, or read two ways? |
| `user` | Does the value hold for the person it is for? |
| `scope` | Do scope and out of scope agree? Which edge cases are not handled? |
| `testability` | Can a person check each criterion by using the product? |

Each reader gets only the brief, as quoted data, and answers with fixed `FINDING:` lines. `merge_brief_review` puts
the answers together, blockers first. The desktop starts each reader as a fresh process with no tools, no MCP
server, no session kept and `--safe-mode`, so no conversation, CLAUDE.md, hook, plugin or memory reaches it. In a
terminal, the skill gives each prompt to a fresh subagent, or sends the person to the desktop or to
Elephant-Goldfish's own review.

Code: `factory/lib/brief-review.js`.

## Tools

The stage uses these `eminzo mcp` tools, all read-only (see [eminzo mcp](mcp.md)): `discovery_methods`,
`brief_template`, `check_brief`, `import_egm_brief`, `brief_review_prompts`, `merge_brief_review`,
`brief_status`, `approve_brief`, `handoff_drafts`, `initiative`, `product_map` and `estimate_work`.

## Not yet

- Creating the issues from the desktop, with the person's confirmation (the engine side, the drafts and the
  following of an initiative, is done).
- Ask Eminzo on Codex in the desktop: its non-interactive flags are not verified yet.
