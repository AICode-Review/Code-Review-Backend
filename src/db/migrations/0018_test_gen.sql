-- 0018_test_gen.sql — auto-generate an actual runnable test file for a "tests"-category
-- finding (missing coverage), not just flag it — closes a real competitive gap vs Qodo.
--
-- Deliberately reuses the SAME apply-fix audit columns from 0016 (applied_at/applied_by/
-- applied_commit_sha) for the eventual commit, rather than a parallel set — "a commit was
-- made addressing this finding" is the same fact whether it came from patching existing
-- code or adding a new test file, and it already feeds the exact UI badge/audit trail this
-- needs. Only the PREVIEW step (generate, before any commit) needs its own storage, since
-- generation is re-callable and side-effect-free, and the eventual commit must read back
-- exactly what was previewed rather than trust anything the client echoes back.
alter table findings
  add column if not exists generated_test_path         text,
  add column if not exists generated_test_content       text,
  add column if not exists generated_test_generated_at  timestamptz;
