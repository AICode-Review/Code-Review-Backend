# CodeFerret benchmark harness

Implements DESIGN.md §12 — the scoring machinery and a starting dataset for measuring
CodeFerret's actual verified catch rate and false-positive rate against the differentiation
targets in DESIGN.md §1:

- Verified catch rate > 70%
- False positives < 2 per review run

## Status

**The scoring logic and dataset schema are real and tested** (`npm test`, all pure functions,
no API keys needed). **The harness has not been run against the live engine yet** —
`runHarness.ts`'s `reviewCase()` is a deliberately unimplemented integration point, not a bug.
Running it for real means spending Anthropic/OpenAI API budget per case; that's a decision to
make explicitly when there's a dataset and a reason to fund it, not a side effect of `npm test`.

## Dataset

`src/dataset/seed.ts` — 8 hand-authored cases (`source: "synthetic"`), each a small realistic
diff with a single deliberately-injected bug and its exact expected location, spanning
`logic`, `security` (×2), `concurrency`, `errors`, `contracts`, and `tests` categories.

This is **not** the 100+ real-mined-PR corpus DESIGN.md §12 describes ("100+ real merged PRs
from OSS repos where a bug was later fixed, mined from 'fixes #issue' commits"). Building that
corpus properly means: finding a fix commit referencing an issue, tracing blame back to the PR
that introduced the regression, and verifying the pairing is actually correct — real research
work, not something to rush through as a side effect of a larger task. This seed set exists so
the harness itself is real and runnable today; growing the real-PR corpus is separate,
tracked work.

To add a real-mined case later: append a `BenchmarkCase` to the dataset with `source: "real_pr"`
and a real `prUrl` — the schema and scoring already support both kinds side by side. Do not set
`source: "real_pr"` on a case that isn't backed by a real, checkable PR URL; `scoring.test.ts`
enforces that every `real_pr` case has one, but can't verify the URL is genuine — that's on
whoever adds the case.

## Running

```
npm install
npm test        # scoring logic + dataset validation — safe, no API keys, no cost
npm run bench    # actually reviews every case with the live engine — needs ../.env's
                 # ANTHROPIC_API_KEY + OPENAI_API_KEY, and real API spend. See runHarness.ts's
                 # reviewCase() doc comment for the two ways to wire it to the live engine.
```

## Methodology

A case is **caught** if the reviewer reports at least one finding whose `path` matches the
case's expected finding and whose line range overlaps it. Every reported finding that matches
nothing is a **false positive** for that case — noise the reviewer generated regardless of
whether it also caught the real bug.

- **Catch rate** = cases caught ÷ total cases.
- **False positives per run** = total false positives ÷ total cases.

This intentionally does not credit a reviewer for a finding on the right file but a wildly
wrong line, or penalize it for surfacing additional *correct* context on the same lines as the
expected finding (only findings that don't overlap anything expected count as noise).

Per DESIGN.md §12, this harness is meant to run in CI on every prompt/engine change once it's
wired up — a prompt change should only merge if it doesn't regress catch rate or push false
positives up, not on vibes.
