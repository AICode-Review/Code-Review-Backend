# Scrutinye production-readiness review

Reviewed locally on 2026-09-12. This is a record of implemented hardening and remaining release gates, not production certification. No deployment, database migration, live PR mutation, or real-provider benchmark was performed in this hardening pass.

## Implemented

- **Invitation authorization:** automatic invite matching uses exact normalized email equality instead of SQL wildcard matching. Addresses containing `_` or `%` cannot match a different person's invitation.
- **Honest review results:** provider outages, missing source, analysis skipped at the budget limit and unavailable verification produce an incomplete-review notice. External checks are neutral rather than clean; verified critical issues can still fail the check. The run detail page displays the warning and retains available findings. Incomplete runs do not send the normal completion email.
- **Risk summaries:** high-severity findings in the digest count toward risk, including when the inline comment budget is zero.
- **Persistence and cancellation:** findings/completion write failures cannot silently publish success. Early failures are recorded on queued runs. Existing non-queued jobs are not re-executed. Completion and failure writes preserve a cancellation that occurs during summary posting. External comment writes are not transactional; see the remaining crash/delivery gate below.
- **Queue startup:** concurrent callers await one initialization, failed initialization releases resources and can retry, and required queue-creation failures are not swallowed.
- **Webhook retry:** an ordinary handler/enqueue failure releases the deduplication claim so a platform retry can attempt the event again. This does not close the process-crash window between claim and enqueue.
- **Context and cost accounting:** ignored files no longer consume the source-file review cap; context timeout timers are cleared. Verification and reproduction costs are attributed to the provider actually used, including fallback routing. Failed runs retain cost already recorded in the pipeline.
- **HTTP/process behavior:** malformed JSON returns 400. Unhandled server errors return a generic message with a request ID. Response headers disable caching and MIME sniffing; authorization/cookie headers are redacted from request logging. Fatal uncaught errors terminate the server/worker for supervisor recovery.
- **Release tooling:** dependency fixes and Vitest 4 / React Router 7 upgrades are integrated. CI and Docker use Node 24. Each independent repository has dependency-update configuration and a CI audit check. Customer and console production builds require Supabase/API settings unless explicitly opting into an unconfigured demo/CI artifact.
- **UI:** modern public and application styling, the corrected Scrutinye brand and the sidebar workspace placement are preserved. The partial-review notice fits the existing design.

## Validation

| Project | Final tests | Build |
| --- | --- | --- |
| Backend | 461 passed, 53 files | Typecheck and production build passed |
| Customer app | 90 passed, 12 files | Typecheck and production build passed |
| Admin console | 78 passed, 19 files | Typecheck and production build passed |

Backend tests used dummy environment values with dotenv pointed at a nonexistent test file; database, platform and LLM operations use test doubles. Frontend/console tests force demo mode. The customer suite initially hit worker-startup timeouts while all projects were testing concurrently; a complete rerun with `npm test -- --maxWorkers=2` passed. Tests ran on the local Node 25 runtime; the configured Node 24 CI/container environment still needs its own execution.

Chromium smoke checks against the local demo passed for `/`, `/features`, `/pricing`, `/dashboard`, `/settings` and `/runs/run-1`, with no page exceptions or horizontal overflow at 1440px. Settings also fit a 390px viewport. A browser-only injected incomplete-run fixture displayed the warning while retaining the findings/diff. Its screenshot was visually inspected. This is local demo coverage, not live authentication/provider coverage.

`git diff --check` passed in all three package repositories. Both SPA builds retain a bundle-size warning (main JavaScript chunks exceed 500 kB before gzip); performance budgets and real-device measurements are still needed.

After explicit user approval, a fresh `npm audit --json` completed successfully in backend, frontend and console. Each returned exit code 0 and zero known vulnerabilities across all severity levels, including development dependencies. No dependency changes were needed. This clears the dependency-audit gate; the remaining release gates below are unchanged.

## Remaining release gates

| Priority | Gap | Acceptance evidence needed |
| --- | --- | --- |
| High | Crash-safe event ingestion and delivery | Use a durable inbox/outbox or equivalent transactional enqueue/lease design; kill the process between webhook claim, enqueue and comment delivery, then prove eventual processing without duplicate comments/emails. The current retry fix covers caught errors only. |
| High | Worker recovery and cancellation during remote writes | Recover abandoned running jobs after a worker dies, with bounded retries and idempotent delivery. Test two workers and rapid pushes on the same PR. Conditional completion now preserves cancellation, but an already in-flight platform write cannot be retracted atomically. |
| High | Concurrent monthly quota admission | Usage checking and run admission need an atomic reservation or equivalent database enforcement. Race several triggers at the final available quota slot and prove no over-admission; verify the billing semantics for retries and partial runs. |
| High | Staging integration/security verification | Exercise GitHub and Bitbucket webhook-to-review flow, sign-in, cross-org denial/RLS, quotas, billing, apply-fix and generated-test commits against controlled staging repositories. Use no customer branches for these tests. |
| High | Review-quality evidence | Expand beyond the historical eight synthetic benchmark cases, include clean PRs and cross-file cases, repeat provider runs and publish variance, latency and actual costs. Historical 87.5% catch rate with zero observed false positives is not evidence of market-leading performance. |
| Medium | Structured coverage and budget semantics | Incomplete coverage currently uses a completed run plus its error/warning text. Introduce explicit coverage metadata for lists, analytics and exports; distinguish unavailable verification from a proven false alarm. Reserve expected concurrent model spend if a strict dollar ceiling is required. Current between-call checks are not a hard pre-reserved spending cap. |
| Medium | Operations and disaster recovery | Add readiness checks for database/queue health beyond `/healthz` liveness, actionable queue-age/failure alerts, and a tested backup/restore procedure. Verify supervisor restart and graceful shutdown in the actual deployment. |
| Medium | Deployment and isolation checks | Run CI/Docker on Node 24, verify secret management, CORS, TLS, sandbox isolation and retention behavior in the target hosting environment. Measure browser startup on realistic devices and split large bundles if the measured budget is exceeded. |

The next environment-dependent step is controlled staging validation. Its URL and hosting provider have not yet been supplied. The code-level gates above remain engineering work and are not solved merely by deploying this patch.
