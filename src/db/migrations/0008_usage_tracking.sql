-- Monthly review-usage quota (hard-block once exceeded, tracked per plan in the web app —
-- see repositories.ts getOrgUsage). `blocked_reason` distinguishes reviews that never
-- actually ran (blocked before any LLM spend — private-repo gate, monthly-quota gate)
-- from real completed/failed reviews, so usage counting and the UI can both exclude
-- blocked rows without string-matching the free-text `error` column.
alter table review_runs add column if not exists blocked_reason text;
