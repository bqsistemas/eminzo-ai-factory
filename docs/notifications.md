# Discord pipeline notifications

The full reference for the optional Discord notifications. Back to the [README](../README.md).

Notifications are optional and disabled by default. In `factory/config.json`, select
only the events you want:

```json
"notifications": {
  "enabled": true,
  "events": ["job.started", "job.needs_human", "job.failed", "job.merged"]
}
```

Supply `FACTORY_DISCORD_WEBHOOK_URL` in the environment of the factory process,
using your local secret manager. Never put this bearer credential in configuration,
Git, issue text, job artifacts, or command-line arguments. The only accepted format is
`https://discord.com/api/webhooks/<numeric-id>/<token>` (also `discordapp.com`, the
`ptb.`/`canary.` hosts and an `/api/v<N>/` prefix; no query, fragment, credentials,
other host, or port). Missing/invalid URLs or unsupported event ids
skip delivery with a static `notifications: invalid_config` diagnostic, not the URL.
The default configuration is `{"enabled": false, "events": []}`; absent/disabled
configuration does not make requests. There is no interactive setup or Discord bot.

| Event | Meaning |
|---|---|
| `job.started` | A new job has been persisted (not an idempotent `new` call). |
| `stage.changed` | Any effective persisted stage change, including promotions and intermediate merging. |
| `job.needs_human` | The job enters `needs-human`. |
| `job.failed` | The job ends at `rejected`; gate/review retries are stage changes, not terminal failures. |
| `job.succeeded` | Successful terminal stage `merged`; alias of `job.merged`. |
| `job.merged` | The job reaches `merged`. |

Exactly one selected event is sent per change: a selected specific event takes
precedence over `stage.changed`; `job.merged` takes precedence over `job.succeeded`.
Messages contain the job id, issue number, job title, event, from/to stages, the
generated result (`succeeded` on `merged`, `failed` on `rejected`), the transition note,
GitHub issue/PR links when available, and the timestamp. Title and note are untrusted
free text: they are cut to one line of 200/300 characters, common credential shapes
(webhook and credential-bearing URLs, GitHub/OpenAI/Slack/AWS tokens, JWTs, private
keys, `Bearer ...`, `password=`/`token:`-style pairs, long opaque strings) are replaced
by `[redacted]`, and Markdown, masked links, autolinks and mentions are shown literally;
`allowed_mentions` is empty, so nobody is pinged. Redaction is best-effort: do not put
secrets in issue titles or `--note` text. Issue bodies, environment values, worktree
paths and other job artifacts are never sent.

Each message is a compact embed: the repository (`owner/repo`, linked, from `repo` in
`factory/config.json`) above the title, the stage change (`Spec → Build`, `New` for a started
job), links to the issue and the PR, the round, the intake risk (with an `XS` marker on
the fast lane) and the note. When leaving `review` it adds one line with each reviewer's
verdict (`code ✅ · ui ✏️`); on `merged`, `awaiting-merge`, `needs-human`, `needs-info`
and `rejected` it adds the total cost and the time since the job started. Only
validated enums, numbers and GitHub links are added, never free text.

A process started by `node --test` (it has `NODE_TEST_CONTEXT` set) never sends, even when
the shell that ran the tests holds a real webhook.

[Discord's webhook reference](https://github.com/discord/discord-api-docs/blob/main/developers/resources/webhook.mdx)
describes the JSON format used by this connector.

Delivery is **best-effort**, after persistence, independent of pipeline success.
Requests use a 1.5-second timeout and reject redirects. Static delivery diagnostics
(`sent`, `failed`, `timeout`, `rate_limited`) go to stderr, never response bodies or
exception details. No immediate automatic retry is attempted (including HTTP 429),
to avoid rate-limit storms and ambiguous timeout duplicates. Failed events may be
resubmitted to the dispatcher; successful deliveries and in-flight requests are
deduplicated per adapter and deterministic job/event/from/to/round id. The most
recent 512 successful ids are retained in memory only: separate CLI processes or
restarts may duplicate events, crashes can lose them, and there is no outbox or
guaranteed delivery. No new job/board fields or persistent delivery state are used.

Run focused tests without network access:
`node --test test/notifications.test.js test/discord-notifications.test.js`.
