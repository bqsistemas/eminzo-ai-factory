VERDICT: CHANGES

# Security review (round 2)

## Findings
- [blocker] `src/app.js:8`: `trust proxy` is `true`, so any client can set `X-Forwarded-For` and dodge the limit → trust exactly one hop.
