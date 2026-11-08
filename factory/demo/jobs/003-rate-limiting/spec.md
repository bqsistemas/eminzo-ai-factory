# Spec: Rate limiting

## Goal
API consumers get a clear, predictable limit; the service stays up under bursts.

## Scope
- In: per-IP limit on `/api/*`, 429 response, `Retry-After` header.
- Out: per-user quotas, distributed (multi-instance) counters.

## Design
- `src/middleware/rateLimit.js`: wraps `express-rate-limit`, 100 req / 60 s per IP.
- Mounted in `src/app.js` before the `/api` router.
- 429 body: `{ "error": "rate_limited", "retryAfter": <seconds> }`.

## Acceptance criteria
- AC-1: Given 100 requests in a minute from one IP, when request 101 arrives, then it gets 429.
- AC-2: Every 429 includes a `Retry-After` header in seconds.
- AC-3: Requests from a second IP are unaffected by the first IP's count.
- AC-4: `/health` is never rate limited.

## Risks
Trusting `X-Forwarded-For` behind a proxy lets clients spoof their IP.
