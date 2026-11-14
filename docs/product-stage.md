# The product stage (Ask Eminzo)

Before any issue exists, a Product Lead or Product Owner takes an idea to an **approved brief** and a list of
**deliverables**, in functional language, with the repository as context. Issues are cut from the approved brief
later; a tech lead decides which ones enter the factory. Nothing in this stage writes code, creates issues or adds
labels.

It runs in the Eminzo desktop (Ask Eminzo, Product mode) and, without the desktop, in Claude Code
(`/eminzo-product <idea>`) or Codex (`$eminzo-product <idea>`). `eminzo install` installs the `eminzo-product`
skill for both tools, next to `eminzo-factory`.

The skill's sub-commands are `<idea>`, `status`, `estimate`, `map` (draft or update the
[functional map](#the-functional-map)) and `report <brief issue>` (the [client report](#the-client-report)). In the terminal the skill follows the same rules as the desktop:

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
- `report <brief issue>` builds the weekly client report with `initiative_report`, shows the draft, reminds the person
  to review and edit it before sharing, and never sends it anywhere.

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
- A criterion or deliverable line starts with `-` (or `*`, `+`). Its id may be bold, italic or in backticks, with the
  colon inside or outside: `- BC-1: text`, `- **BC-1**: text`, `- **D1:** title | ...`, `` - `BC-1`: text ``. It is read
  as the plain id and the text stays as written. Unbalanced forms (`- **BC-1: text`) are reported, not guessed:
  "Acceptance criterion could not be read: write it as "- BC-1: what a person can check"" and "Deliverable could not be
  read: write it as "- D1: title | size: s | risk: low | covers: BC-1"", each followed by the line. Approval hashes
  are over the brief text, so emphasis is part of what was approved.
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
- The brief contract refuses `<!--`, control, invisible and bidirectional characters, and `@login` mentions outside
  backticks, fences and e-mail addresses (GitHub would notify people when the issues are created); the estimate in the marker is rounded to one decimal, or `none` when it
  does not fit.
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
| `in-factory` | Open, with the `factory` label, no open pull request (also: reopened after a merged change) |
| `in-review` | A pull request is open |
| `available` | The issue is closed as completed AND a merged pull request closes it |
| `closed` | Closed as not planned, or closed as completed without a merged change (with a warning) |

- The result has `brief` (issue, title, url, `author`, `approvedBy`, `approvedAt` and `valid`: the issue body, minus its
  hidden line, still passes the approval check and the hidden line points at that approval), `deliverables` (id, issue,
  title, url, status, `factory`, the ids it waits for, the pull request, the estimate shown at creation,
  `actual_min`, `available_at` (when it became available: the merge of its pull request, else the time its issue was
  closed; for an available deliverable `pr`, `actual_min`, `cost_usd` and `available_at` all come from the earliest merged
  trusted pull request that closes it, never from an open one) and `cost_usd` (known cost from the same facts line, else `null`)), `progress` (`done` = available, `total` = deliverables of the brief), `estimate_vs_actual` and
  `warnings` and `language` (the approved brief's, `null` when its text is not trusted). Read the warnings: they are where a forged, edited or odd issue shows up.
- Optional `known`: the numbers (up to 50) of deliverable issues the caller just created. They are read directly with
  `issue view` and go through the same rules, because GitHub's search can lag a minute. A deliverable with no issue
  found says "was not found yet (GitHub search can lag a minute)" in `warnings`.

**Which issues count (trust).** The search is only a way to find candidates. A candidate is a deliverable of this brief
only when ALL hold: it has the `eminzo-deliverable` label (the search also filters by it); its author is the brief
issue's author; it was created after the brief issue; its body has the `Part of #<n>` line of the template (`Parte de`
in Spanish and Portuguese); its marker is well-formed, names this brief issue, carries the brief issue's approval hash
(first 12 hex) and an id the approved brief has; and it is not the brief issue. A candidate that carries our marker but fails a
rule never gets a status: it produces the warning "issue #x looks like a deliverable of this brief but was not created by
Eminzo for it". When two valid issues claim one id the earliest counts and the others are named in a warning.

**The brief issue.** It must have the `eminzo-brief` label. Its author is reported and a warning says when it differs from
who approved. Its title is not covered by the approval, so a title different from the draft's gets a warning. When
`valid` is false there is a loud `WARNING`, the edited text decides nothing (no deliverable is invented or hidden from it:
only the valid deliverable issues found are listed, with `progress.total` = how many were found) and `complete` is false.

**Pull requests.** gh's closing references decide which pull requests close a deliverable. On a `gh` without them, a
search accepts only pull requests whose body has a closing keyword for that issue (`closes`, `fixes`, `resolves` and
their forms), not a mere mention, and warns when it hits its 30 results cap. Facts lines are read only from pull requests
whose head branch starts with `factory/`, from at most the first 256 KiB of the body. A pull request from a fork
(`isCrossRepository`, or an unknown origin) is never trusted, whatever its branch is called: it cannot make a
deliverable `in-review` or `available` or give it an `actual_min`, and a warning names it. `available` uses the merged
pull request of this repository only.

**What the author check proves.** It proves who *created* an issue, not who last edited its body: a collaborator with
write access can edit a deliverable issue's body, the marker included. Treat the initiative as read from a repository
whose writers you trust; the checks stop strangers and lookalikes, not a colleague who edits an issue on purpose.

- `actual_min` is the time from the job's start until it was ready for approval, from the LAST facts line of the pull
  request, measured as an estimate measures it (waiting for people not included).
- `estimate_vs_actual` compares only `available` deliverables, summing the estimate and the actual time over the same ones
  (those with both). `counted` says how many were compared out of how many exist, and `complete` is true only when
  every deliverable is available and has both, so a partial comparison is never presented as the whole.
- Limits: every `gh` call has a 20 second timeout and a run makes at most 60 calls (then a warning says some pull
  requests were not read). If `gh` fails, or the issue is not a brief issue, the tool answers with a sentence a person
  can act on.

Code: `factory/lib/state/initiative.js`.

## The client report

`initiative_report` (`{ issue, from?, to?, include_cost?, include_links?, known? }`) turns an initiative into the
weekly progress report a client can read. It reads the initiative exactly as `initiative` does (same trust rules, same
read-only `gh` calls) and builds a **draft**; it sends, posts and stores nothing. The person reviews and edits it, and
shares it themselves.

- Language: the approved brief's (`en`, `es` or `pt`); the repository's language when the brief's text is not trusted.
- It starts with the line "Draft — review before sharing." (localized), a title, the period as ISO dates and a one-line
  status ("2 of 5 parts are available; 1 is waiting for a decision.").
- Sections, in this order: **Delivered this period** (parts that became available between `from` and `to`, named by
  their titles, oldest first), **In progress** (being built or in review), **Waiting for a decision** (waiting for the
  tech lead), **Coming next** (not created yet, with the parts they start after), **Estimate and actual** (available
  parts only; ranges, never dates), **Cost of the parts delivered** (only with `include_cost`), **Notes** (only when there are
  warnings) and **Links** (only with `include_links`, plain URLs at the end).
- Functional language: no job ids, no issue or pull request numbers, no "PR", "merge", "gate", "round", "spec",
  "intake" or "factory". The initiative's warnings become plain sentences; one that is not recognized becomes "something
  unusual was found; the tech lead should take a look".
- Period, always in UTC and shown as "(UTC)" next to it: when `to` is omitted the window is the 7 whole UTC days before
  today (from 00:00 seven days ago to 23:59:59.999 yesterday), so the same day always gives the same report. A date
  alone (`2026-11-12`) means that whole UTC day; a date-time must carry its zone (`Z` or `+hh:mm`), otherwise it is
  refused, because a zoneless time would depend on the machine's time zone. A `to` in the future is capped at now. With
  `to` and no `from`, `from` is 7 days before `to`. Both are validated; `from` must be before `to`. A part belongs to the period by the time its merged change became
  available (else the time its issue was closed); a part with no known date is named in the notes.
- Titles are shown as plain words: links, `www.` addresses, bare domains and `#123` references are removed from them,
  so the draft never carries something that turns into a link or a mention when pasted elsewhere.
- Long lists are capped: at most 5 dependencies per part and 20 items per section, then "+N more".
- Cost: the amount is always in USD with a dot decimal (`USD 1.50`), in every language. It comes from the `cost_usd` of the LAST facts line of the part's trusted pull request (same-repository, `factory/`
  head). Only known costs are summed, with how many parts they cover; when none is known the report says "the cost is
  not known", never 0.
- The text is deterministic: the same data and the same period give the same markdown.

Code: `factory/lib/client-report.js` (pure); `initiative()` supplies `available_at`, `cost_usd` and `language`.

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
- The labels `eminzo-brief` and `eminzo-deliverable` now come from `factory/bin/setup` (one list, `factory/lib/labels.js`),
  like the factory's own; the desktop no longer has to create them at use time.
- The approved brief becomes ONE issue labeled `eminzo-brief`; its body is the approved text exactly as approved
  plus the hidden line `eminzo:brief-issue`, and Eminzo never edits it afterwards (it is the approved record).
- Each deliverable becomes ONE issue labeled `eminzo-deliverable`, never `factory`: the tech lead adds `factory`
  when they accept it. Its hidden line `eminzo:deliverable` carries the brief issue number, the deliverable id, the
  first 12 hex of the approval hash and the estimate shown at creation.
- An initiative is the brief issue plus its deliverable issues, found by those markers; its state is computed from
  GitHub only.
- `available` means the issue is closed as completed AND a merged pull request closes it. The estimate is compared
  with the actual time only over available deliverables that have both.
- A deliverable issue counts for an initiative only if it has the `eminzo-deliverable` label, the brief issue's author,
  a creation date after the brief issue, the `Part of #<n>` line, a marker with the brief's approval hash and a known
  id. Anything else that carries our marker is a lookalike: a warning, never a status. The earliest valid issue wins a
  duplicate id.
- A brief cannot contain `<!--` (a bare `-->` is prose and is fine), control, invisible (C1 controls, U+2028/2029,
  soft hyphen, word joiner, zero-width characters, a byte order mark) or bidirectional characters, or `@login`
  mentions (approval is impossible until they are removed). A mention is an `@` followed by a letter or digit unless a
  letter, digit or underscore comes right before it (an e-mail address); text in backticks and in fenced blocks is not
  scanned, because GitHub never notifies there. The only exempt comment lines are the brief's own marker and a final
  line that matches the strict approval pattern exactly, and the draft builders refuse a text with an eminzo comment line of its own or an
  unclosed code block. Every brief-derived string in a deliverable issue is sanitized again (comment syntax stripped
  until stable, a zero-width space after `@`, control and bidi characters dropped).
- Facts lines are trusted only from pull requests whose head branch starts with `factory/`; a pull request counts as
  closing an issue by gh's closing references or, on an older gh, by a closing keyword.
- The client report is weekly (the last 7 days) by default, includes cost only when asked, is written in functional
  language, and is a draft that Eminzo never sends: the person reviews, edits and shares it.

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
the answers together, blockers first, and drops near-duplicates (the same target with the same first words), keeping the
most severe.

Each reader reports at most three findings, the ones that matter most for building the right thing, and answers
`NO FINDINGS` when the brief is clear for its lens (a good outcome, not a failure). Why: a first real review with ten
per reader returned 39 findings and overwhelmed the Product Lead; few and sharp findings get read and acted on. A
blocker means the brief cannot be built or checked as written; style and wording preferences are not reported. If a
reader mixes the order, the blockers are the ones kept. The desktop starts each reader as a fresh process with no tools, no MCP
server, no session kept and `--safe-mode`, so no conversation, CLAUDE.md, hook, plugin or memory reaches it. In a
terminal, the skill gives each prompt to a fresh subagent, or sends the person to the desktop or to
Elephant-Goldfish's own review.

Code: `factory/lib/brief-review.js`.

## Tools

The stage uses these `eminzo mcp` tools, all read-only (see [eminzo mcp](mcp.md)): `discovery_methods`,
`brief_template`, `check_brief`, `import_egm_brief`, `brief_review_prompts`, `merge_brief_review`,
`brief_status`, `approve_brief`, `handoff_drafts`, `initiative`, `initiative_report`, `product_map` and `estimate_work`.

## Not yet

- Creating the issues from the desktop, with the person's confirmation (the engine side, the drafts and the
  following of an initiative, is done).
- Ask Eminzo on Codex in the desktop: its non-interactive flags are not verified yet.
