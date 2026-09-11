-- 0020_contact_submissions_reason.sql — categorizes a "Contact us" submission (general,
-- billing, legal, enterprise, bug) so it can be routed into a distinct email template
-- (email/templates.ts#contactSubmissionEmail) and filtered on later, instead of every
-- submission looking identical regardless of what it's actually about.

alter table contact_submissions add column reason text not null default 'general';
