# @codeferret/cli

Local + CI code review using the same multi-pass + verification engine (DESIGN.md §6) as
the CodeFerret PR bot — reused directly from `../src/engine` and `../src/verify`
via relative imports, not reimplemented. **Not published to npm.** Built and tested here so it's
real, working code — install/publish is a decision for whoever owns the npm org, not something
to do unilaterally from this repo.

## Prerequisites

- `npm install` already run in `../` (the backend package — this CLI package imports backend
  source files directly; those files' own dependencies resolve via `backend/node_modules`, so
  it needs to exist — no npm workspace setup required).
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in your environment — the same two keys the
  backend uses. This CLI never touches your CodeFerret account or the backend's `.env`;
  it calls Anthropic/OpenAI directly with these two keys and nothing else.

## Install locally (not published)

```
cd backend/cli
npm install
npm link
cd /path/to/some/other/repo
npm link @codeferret/cli
codeferret review --base main
```

Or run straight from source without linking:

```
cd backend/cli
npm install
npx tsx src/index.ts review --base main
```

## Commands

- `codeferret review --base <ref> [--format text|json|github] [--cost-cap <usd>]` — reviews
  the diff between `<ref>` and `HEAD` in the current git repo. Posts nothing anywhere;
  prints verified findings to stdout (`--format github` emits workflow-command annotations
  for CI). Exits 1 if any verified finding is critical.
- `codeferret config init [--force]` — writes a starter `.review.yml` into the repo root.
- `codeferret auth login` — **not implemented.** It needs an org-scoped API-key system on
  the backend (issue/verify/revoke, distinct from the web app's Supabase session auth) that
  doesn't exist yet — `review` doesn't need it and works standalone. See the command's own
  `--help` output for the full explanation.

## What's real here vs. what isn't

Real: `review`'s entire pipeline — git diff parsing, the actual specialist passes
(logic/security/contracts + the rest, cost-capped), merge/scoring, and verification
(static check + cross-examination), reusing the exact backend engine code, not a
reimplementation. `config init`. The test suite (`npm test`) exercises the full
orchestration with a fake router — no API keys or network needed to verify the wiring
itself is correct.

Not real yet: `auth login` and anything depending on it (rulebook/analytics sync from the
CLI). `codeferret review --pr <n>` (fetching a PR diff via `gh`/`bb` CLI auth, as the `/cli`
marketing page also describes) isn't implemented — only local-branch review (`--base`) is;
add PR-fetching as a small follow-up once someone actually needs it, rather than stub it
here.
