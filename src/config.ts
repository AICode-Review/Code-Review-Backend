import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),

  GITHUB_APP_ID: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),

  /** Optional — Bitbucket PR review automation stays disabled (getAdapter throws) until this is set. Bitbucket *sign-in* (Supabase Auth) works independently of this. */
  BITBUCKET_WEBHOOK_SECRET: z.string().optional(),
  /** Publicly reachable backend URL — needed only for the Atlassian Connect descriptor (DESIGN.md §4) to advertise its own webhook/lifecycle URLs. Unset in the meantime-manual-token deployment mode. */
  BACKEND_PUBLIC_URL: z.string().url().optional(),

  /**
   * Invite + review-complete emails (src/email/smtp.ts) — optional. Without
   * SMTP_HOST/SMTP_USER/SMTP_PASS and FRONTEND_URL all set, everything still works
   * exactly as before: invite creation returns the token/link for the inviter to copy,
   * and the review-complete email is silently skipped. Same "explicit gap, not faked"
   * policy used for Razorpay billing elsewhere in this codebase.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** true = implicit TLS (typically port 465); false (default) = plain/STARTTLS (typically port 587) — matches how most providers (Gmail, Office365, SES, Mailgun SMTP) are configured out of the box. */
  SMTP_SECURE: z.coerce.boolean().default(false),
  EMAIL_FROM: z.string().default("CodeFerret <onboarding@codeferret.dev>"),
  /** Origin of the deployed web app, e.g. https://app.codeferret.dev — used only to build the /invite/:token and /runs/:id links inside emails. */
  FRONTEND_URL: z.string().url().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),

  /**
   * Comma-separated emails auto-granted `users.is_platform_admin = true` on their next
   * sign-in (verifyUser.ts) — the platform admin console's bootstrap path, mirroring how
   * `installed_by_github_id` auto-links org ownership elsewhere in this file's callers.
   * No manual SQL needed to grant the first admin; unset means no one is auto-promoted.
   */
  ADMIN_BOOTSTRAP_EMAILS: z.string().optional(),

  /**
   * Self-hosted edition (DESIGN.md §11) — customer-supplied LLM credentials
   * beyond direct Anthropic/OpenAI. The router auto-detects and prefers
   * these over the direct-API keys above when present ("router honors
   * availability").
   */
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.string().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().default("2024-10-21"),

  /** Self-hosted zero-retention mode (DESIGN.md §11/§13) — when true, findings never retain a verbatim source-line snippet, only metadata. */
  ZERO_RETENTION: z.coerce.boolean().default(false),
  /** Self-hosted license enforcement (DESIGN.md §11) — both unset = license checks skipped (normal SaaS deployment). */
  SELF_HOSTED: z.coerce.boolean().default(false),
  LICENSE_KEY: z.string().optional(),
  LICENSE_PUBLIC_KEY: z.string().optional(),

  RUN_COST_CAP_USD: z.coerce.number().positive().default(0.6),

  /**
   * Monthly review-usage quota (hard-block once exceeded — see repositories.ts
   * getOrgUsage). Free is a flat org-wide allowance; Pro/Team scale per purchased
   * seat. Self-hosted deployments (SELF_HOSTED=true) are never quota-limited —
   * that org brings its own LLM keys/infra, so there's no shared cost to protect.
   *
   * Sized against RUN_COST_CAP_USD ($0.60/review worst case) and an estimated
   * ~$0.15/review *typical* cost (3 always-on frontier passes + up to 4 cached
   * mid-tier passes + cross-exam verification — no live benchmark run has been
   * performed yet, so this is an architecture-based estimate, not measured data;
   * see /benchmark). Pro/Team target ~40% of seat revenue as LLM cost at that
   * typical rate (~60% gross margin): $15/seat ÷ 0.4 ÷ $0.15 ≈ 40/seat/mo,
   * $25/seat ÷ 0.4 ÷ $0.15 ≈ 65/seat/mo. Free has no revenue to protect margin
   * against — its number is a bounded acquisition cost (worst case $15/mo per
   * free org at the full $0.60 cap), not a margin calculation.
   */
  FREE_MONTHLY_REVIEW_QUOTA: z.coerce.number().int().positive().default(25),
  PRO_MONTHLY_REVIEWS_PER_SEAT: z.coerce.number().int().positive().default(40),
  TEAM_MONTHLY_REVIEWS_PER_SEAT: z.coerce.number().int().positive().default(65),
  MODEL_FRONTIER: z.string().default("claude-sonnet-5"),
  MODEL_MID: z.string().default("claude-haiku-4-5"),
  MODEL_SKEPTIC: z.string().default("gpt-5"),
  MODEL_EMBED: z.string().default("text-embedding-3-small"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parse and cache env. Called lazily so unit tests never need a real .env. */
export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid backend environment. Check .env (see .env.example). Problems: ${missing}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** GITHUB_PRIVATE_KEY may be a raw PEM, a PEM with literal \n, or base64 of the PEM. */
export function githubPrivateKey(): string {
  const raw = env().GITHUB_PRIVATE_KEY;
  if (raw.includes("BEGIN")) return raw.replace(/\\n/g, "\n");
  return Buffer.from(raw, "base64").toString("utf8");
}
