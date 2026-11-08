ACCEPT
RISK: high
SURFACES: security
RESCOPED: yes

## Scope
Per-IP limit on `/api/*` only, with a 429 and `Retry-After`. Leave `/health` and the
static pages unlimited. No per-user quotas and no shared (multi-instance) counter.

## Reason
A clear, testable request. High risk: it sits on every API request and may add a
runtime dependency.
