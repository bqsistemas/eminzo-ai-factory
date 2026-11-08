ESCALATE
Adds a new runtime dependency (express-rate-limit); a human should accept it.

## Checks
- [x] Last round all PASS
- [x] Gate PASS (pass 18, fail 0)
- [x] Diff within spec scope
- [x] Merges cleanly
- [ ] No human-judgment areas: new runtime dependency

## For the human
The code is ready. The open question is the dependency: `express-rate-limit` is widely used and MIT-licensed.
I would accept it. Merge PR #9 to approve, or comment on the PR and run `/eminzo-factory rework 6` to ask for an in-house limiter.
