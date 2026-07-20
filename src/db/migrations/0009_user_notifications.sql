-- Durable email on users, captured from the Supabase JWT at sign-in (auth/verifyUser.ts)
-- and kept fresh on every request. Previously email was only known transiently for the
-- currently-authenticated request — never persisted — so there was no way to look up
-- another org member's (e.g. the org owner's) email to send them a notification.
alter table users add column if not exists email text;
