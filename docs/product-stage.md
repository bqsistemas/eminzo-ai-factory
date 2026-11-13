# The product stage (Ask Eminzo)

Before any issue exists, a Product Lead or Product Owner takes an idea to an **approved brief** and a list of
**deliverables**, in functional language, with the repository as context. Issues are cut from the approved brief
later; a tech lead decides which ones enter the factory. Nothing in this stage writes code, creates issues or adds
labels.

It runs in the Eminzo desktop (Ask Eminzo, Product mode) and, without the desktop, in Claude Code
(`/eminzo-product <idea>`) or Codex (`$eminzo-product <idea>`). `eminzo install` installs the `eminzo-product`
skill for both tools, next to `eminzo-factory`.

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

Approval is a marker line inside the brief text, bound to a hash of its content:

```markdown
<!-- eminzo:approved sha256=<64 hex> by=<github login> at=<ISO 8601> -->
```

- The hash is SHA-256 over the brief's canonical text: the brief without any approval marker, `\n` line endings,
  no trailing whitespace per line and no trailing blank lines. Any later edit stops the hash from matching: the
  brief is `changed` and needs a new approval.
- `approve_brief` returns the brief with exactly one marker (an old one is replaced) and refuses a brief that has
  problems. It stores nothing; the caller saves the text. It is called only after the person said, in so many
  words, that they approve (the desktop calls it from the Approve button and keeps it away from its chat agent).
- `brief_status` says where a brief stands:

| State | Meaning | `can_create_issues` |
|---|---|---|
| `draft` | The brief has problems | no |
| `ready` | Complete, not approved | no |
| `approved` | The marker's hash matches the content | **yes** |
| `changed` | A marker is there but the content differs (or there are two markers) | no |

`brief_status` is **the gate**: whatever creates issues from a brief (phase 4; nothing creates issues today) must
call it and go on only when `can_create_issues` is true. `reason` is one sentence a Product Lead understands, for
example "The brief changed after it was approved on 2026-11-12; approve it again."

Code: `factory/lib/brief-approval.js` (`canonicalBrief`, `briefHash`, `approveBrief`, `briefStatus`).

## Decided by default, to confirm

These were chosen to keep moving and are pending the owner's confirmation:

- Approval is a marker inside the brief bound to a content hash (no separate approval store).
- `by` must look like a GitHub login (`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`); `at` is an ISO 8601 date and time.
- A brief with two approval markers is never trusted (`changed`).

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
`brief_status`, `approve_brief` and `estimate_work`.

## Not yet

- Creating the brief issue and the deliverable issues from the desktop, with the person's confirmation, and
  following an initiative from GitHub.
- Ask Eminzo on Codex in the desktop: its non-interactive flags are not verified yet.
