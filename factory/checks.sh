#!/bin/sh
# The repo's deterministic checks. factory/bin/gate runs the main checkout's copy of
# this file inside a job's worktree; exit 0 means the gate passes. It runs the whole
# suite (engine, dashboard, CLI and installer modules).
#
# This repo has no lint or typecheck step.
set -e

# A branch must not redirect `npm test` away from the full suite (and the protected
# spine tests in it).
expected='node --test test/*.test.js'
actual=$(node -p "require('./package.json').scripts.test")
if [ "$actual" != "$expected" ]; then
  echo "checks.sh: package.json scripts.test is \"$actual\", expected \"$expected\"" >&2
  exit 1
fi

npm test
