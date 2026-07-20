import { z } from "zod";

export const PlatformSchema = z.enum(["github", "bitbucket"]);
export type Platform = z.infer<typeof PlatformSchema>;

export type Markdown = string;
export type UnifiedDiff = string;
export type CommentId = string;

export const OrgRefSchema = z.object({
  platform: PlatformSchema,
  externalId: z.string(),
  name: z.string(),
});
export type OrgRef = z.infer<typeof OrgRefSchema>;

export const RepoRefSchema = z.object({
  platform: PlatformSchema,
  externalId: z.string(),
  /** org/user login (GitHub) or workspace slug (Bitbucket) */
  owner: z.string(),
  name: z.string(),
  orgExternalId: z.string(),
  orgName: z.string(),
  defaultBranch: z.string().optional(),
  /** GitHub App installation id — required to act on GitHub repos */
  installationId: z.number().optional(),
  /** From the platform's own repo payload — drives free-tier "public repos only" enforcement. */
  isPrivate: z.boolean().optional(),
});
export type RepoRef = z.infer<typeof RepoRefSchema>;

export const PrRefSchema = z.object({
  repo: RepoRefSchema,
  number: z.number().int(),
  title: z.string().optional(),
  author: z.string().optional(),
});
export type PrRef = z.infer<typeof PrRefSchema>;

export interface LineComment {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  body: Markdown;
  headSha: string;
}

export interface CheckStatus {
  headSha: string;
  state: "pending" | "success" | "neutral" | "failure";
  title: string;
  summary: Markdown;
}

export interface PlatformComment {
  id: CommentId;
  body: string;
}

export const NormalizedEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pr_opened"), pr: PrRefSchema, headSha: z.string() }),
  z.object({ kind: z.literal("pr_updated"), pr: PrRefSchema, headSha: z.string() }),
  z.object({
    kind: z.literal("command"),
    pr: PrRefSchema,
    command: z.enum(["review", "pause", "resume", "resolve"]),
    author: z.string(),
  }),
  z.object({
    kind: z.literal("feedback"),
    pr: PrRefSchema,
    commentId: z.string(),
    type: z.enum(["dismissed", "resolved", "thumbs_up", "thumbs_down", "reply"]),
    body: z.string().optional(),
    /**
     * Only meaningful for type "reply". "finding" = commentId is the id of
     * one of our own line comments — the reply is threaded under a specific
     * finding and must resolve to it or be dropped silently (never answer in
     * a thread we don't own). "general" = an explicit @mention in the PR's
     * main conversation, answered without a specific finding attached.
     */
    scope: z.enum(["finding", "general"]).optional(),
  }),
  z.object({
    kind: z.literal("installed"),
    org: OrgRefSchema,
    repos: z.array(RepoRefSchema),
    installationId: z.number(),
    /** GitHub account type the App was installed on — "User" -> individual org, "Organization" -> team org. */
    accountType: z.enum(["User", "Organization"]),
    /** whoever clicked "install" — becomes the org's owner the next time they sign into the web app. */
    installedBy: z.object({ githubId: z.number(), login: z.string() }),
  }),
  z.object({ kind: z.literal("uninstalled"), org: OrgRefSchema, repos: z.array(RepoRefSchema) }),
  /** A push landed on the repo's default branch — triggers re-indexing (DESIGN.md §7), never a review. */
  z.object({ kind: z.literal("repo_pushed"), repo: RepoRefSchema, headSha: z.string() }),
]);
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;
