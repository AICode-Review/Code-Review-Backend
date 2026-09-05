-- 0016_apply_fix.sql — auto-apply a verified finding's suggestedFix as a real commit onto
-- the PR branch (Pro+, admin role — see routes/api.ts POST /api/findings/:id/apply-fix).
-- Audit columns live directly on findings (not just learning_events/audit_log) so the run
-- detail UI can show "applied as commit <sha>" without a second query, and so re-applying
-- an already-applied finding is a cheap, race-safe check.

alter table findings
  add column if not exists applied_at         timestamptz,
  add column if not exists applied_by         uuid references users(id) on delete set null,
  add column if not exists applied_commit_sha text;
