# CodeFerret benchmark harness

Implements DESIGN.md §12 — the scoring machinery and a starting dataset for measuring
CodeFerret's actual verified catch rate and false-positive rate against the differentiation
targets in DESIGN.md §1:

- Verified catch rate > 70%
- False positives < 2 per review run

## Status

**The scoring logic and dataset schema are real and tested** (`npm test`, all pure functions,
no API keys needed). **`reviewCase()` is now wired to the live engine** (`runAllPasses` →
`mergeAndScore` → `verifyFinding`, the same pipeline `jobs/reviewRun.ts` uses, against a fake
`ReviewContext` built directly from each case's `diff`/`files` — no adapter, db, or repo index
needed since seed cases are self-contained).

**First real run** (2026-08, OpenAI-only — `ANTHROPIC_API_KEY` was unset, so every pass and
cross-examination ran on GPT models, not the intended Anthropic+OpenAI split):

```
Cases: 8  Caught: 6  Catch rate: 75.0%
False positives: 0 total, 0.00 per case

  ✓ sql-injection-fstring
  ✓ off-by-one-pagination
  ✓ missing-await-cleanup-loop
  ✓ swallowed-payment-error
  ✓ removed-null-check-billing
  ✓ signature-change-breaks-caller
  ✗ stale-test-after-threshold-change
  ✗ xss-unescaped-comment-render
```

Investigating the `xss-unescaped-comment-render` miss (added a one-off debug script, not
committed) found the specialist passes had caught it correctly at high confidence (security
pass: 0.99) — it was cross-examination that rejected it, because `crossExamine()` only ever
gave the skeptic model the current file content, never the PR's diff. The finding's claim was
inherently a before/after one ("escaping was removed"), which is unconfirmable without seeing
what changed. Fixed in `verify/crossExamine.ts` / `engine/prompts/cross_exam.v2.md`: the
skeptic is now shown this PR's diff for the finding's file (via the new
`engine/diff.ts#diffTextForPath`), when the caller has one.

**Second run, same day, after the cross-exam diff-context fix** (still OpenAI-only):

```
Cases: 8  Caught: 7  Catch rate: 87.5%
False positives: 0 total, 0.00 per case

  ✓ sql-injection-fstring
  ✓ off-by-one-pagination
  ✗ missing-await-cleanup-loop
  ✓ swallowed-payment-error
  ✓ removed-null-check-billing
  ✓ signature-change-breaks-caller
  ✓ stale-test-after-threshold-change
  ✓ xss-unescaped-comment-render
```

`xss-unescaped-comment-render` now catches, as intended, and `stale-test-after-threshold-change`
(also a before/after claim) flipped to caught too. `missing-await-cleanup-loop` flipped from
caught to missed — plausibly ordinary run-to-run LLM variance rather than something this change
caused (nothing about that case's cross-exam prompt should have changed), but there's no
repeat-run data yet to rule that out either way.

Both runs clear the DESIGN.md §1 targets (catch rate > 70%, false positives < 2/run). Treat
these as early data points, not a stable baseline — 8 synthetic cases is a small sample, each
number above is a single run (no repeat-run variance data yet), and neither run exercised real
cross-vendor verification (see above). Re-run with a real `ANTHROPIC_API_KEY` configured,
run repeatedly to characterize variance, and grow the dataset past 8 synthetic cases, before
treating these numbers as publishable.

**Since the second run**: `crossExamine()` only ever saw the finding's own file — for
`signature-change-breaks-caller` specifically (a `contracts` finding whose entire claim is
"`summary.ts`'s `computeTotal` still calls `applyDiscount` with only 2 args"), the skeptic had
no way to actually check that caller and had to take the pass's word for it. Fixed: for
`contracts` findings, `verifyFinding()` now also shows the skeptic every other file from the
case/PR (`## Other files from this PR`) and, in production, the same best-effort repo-index
text (`## Repository index context`) the originating pass saw — see `verify/crossExamine.ts`
and `engine/prompts/{contracts,cross_exam}.v*.md`. `contracts.v1.md` itself was also fixed: it
previously told the model "you do not have a cross-file symbol index," which was stale —
`passRunner.ts` had already been feeding it `buildRepoContextBlock` output for a while, so the
pass was being told to distrust evidence it was actually being given. Not yet re-run against
the live engine to confirm the effect on `signature-change-breaks-caller`'s catch consistency —
that's the next real run to do once a live key is available.

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

### Mining real cases

`src/dataset/mine.ts` (`npm run mine -- --repo <owner/name> [--limit N] [--depth N]`) automates
the *finding* half of that real-PR work — not the *verifying* half, which still needs a human.
It's an SZZ-style bug-introduction miner:

1. Scans the target repo's history for commits whose message references an issue
   (`fixes/closes/resolves #N`).
2. For each, diffs it against its parent to find exactly which pre-fix lines it touched, then
   `git blame`s those lines at the parent to find whichever commit last touched them.
3. If that blamed commit is *itself* another fix/refactor commit (very common — a fix often
   lands on top of an earlier patch, not the original bug), recurses back through it (up to 4
   hops) rather than accepting a meta-commit as "the" introduction.
4. Emits the resolved introducing commit's own diff/files as a **candidate** case, with its own
   added lines as the expected-finding location, a heuristically-guessed category/severity (from
   keywords in the fix commit's message), and — via GitHub's commit→PR API — a real `prUrl` when
   one can be resolved.

Output goes to stdout as JSON, not into the dataset. Every candidate needs a human to actually
read the diff before it's promoted:

- The blame-based pairing can still be wrong even after the meta-commit skip (blame just says
  "who last touched this line," not "who introduced this specific bug" — it can land on an
  unrelated refactor that happened to touch the same lines).
- `category`/`severity` are keyword guesses from the fix commit's message, not a real
  classification.
- A missing `prUrl` (commit pushed directly, or squash-merged in a way GitHub can't map back)
  means you need to find the real PR URL yourself before the case can be `source: "real_pr"`.

Needs `git` and network access to `github.com`/`api.github.com`; no LLM key required (this is
pure git history mining, decoupled from `npm run bench`'s scoring, which does need keys). Set
`MINE_DEBUG=1` to see why each candidate fix-commit was accepted or rejected at every stage.

In practice, on a small-to-medium repo, most candidate fix-commits get filtered out before
producing anything (pure-addition fixes have no old-side lines to blame; many blame results are
ambiguous or resolve to an oversized refactor) — a low yield-per-repo is expected and correct
behavior, not a bug: it's the tool declining to guess rather than fabricating a pairing.

## Running

```
npm install
npm test        # scoring logic + dataset validation — safe, no API keys, no cost
npm run bench    # actually reviews every case with the live engine — real API spend
```

`npm run bench` runs with `backend/` as its working directory (not `benchmarks/`) specifically
so `env()` (backend/src/config.ts) resolves `../.env` → `backend/.env` correctly — dotenv finds
`.env` relative to the process's current working directory, and `backend/.env` is where the
real `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` live.

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
