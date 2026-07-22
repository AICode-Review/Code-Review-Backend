import type { SupabaseClient } from "@supabase/supabase-js";
import { getDb } from "../db/client.js";
import { env } from "../config.js";

export interface AuthedUser {
  /** internal users.id, not the Supabase auth user id */
  id: string;
  authUserId: string;
  email: string | null;
  githubLogin: string | null;
  /** numeric GitHub account id — the stable identity used to auto-link an org the user installed the app on. */
  githubId: number | null;
  /** Platform admin console access — see ADMIN_BOOTSTRAP_EMAILS. */
  isPlatformAdmin: boolean;
}

/** Case-insensitive match against the comma-separated ADMIN_BOOTSTRAP_EMAILS allowlist. */
function isBootstrapAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = env().ADMIN_BOOTSTRAP_EMAILS;
  if (!list) return false;
  return list
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .includes(email.toLowerCase());
}

/**
 * Only ever reads from an actual "github" identity — a user who signed in
 * with Bitbucket must get { login: null, id: null } here, not a guess pulled
 * from Bitbucket's metadata shape. `githubId` drives GitHub-App-installer
 * auto-linking (see ensureOrgAccess below); a false match there would be a
 * real authorization bug, not just a cosmetic one.
 */
function extractGithubIdentity(supaUser: {
  identities?: { provider: string; identity_data?: Record<string, unknown> | null }[] | null;
}): { login: string | null; id: number | null } {
  const githubIdentity = supaUser.identities?.find((i) => i.provider === "github");
  if (!githubIdentity) return { login: null, id: null };
  const data = githubIdentity.identity_data ?? {};
  const login = (data["user_name"] as string | undefined) ?? (data["preferred_username"] as string | undefined) ?? null;
  const rawId = (data["provider_id"] as string | undefined) ?? (data["sub"] as string | undefined);
  const id = rawId ? Number(rawId) : null;
  return { login, id: Number.isFinite(id) ? id : null };
}

/**
 * Validates a Supabase session JWT and returns (auto-provisioning if needed)
 * the corresponding internal `users` row. DESIGN.md §9: "REST for frontend
 * (Supabase JWT verified via JWKS)" — verification here goes through
 * Supabase's own /auth/v1/user check rather than local JWKS decoding, which
 * is equivalent in trust and avoids re-implementing key rotation.
 */
export async function verifyBearerToken(token: string): Promise<AuthedUser | null> {
  const db = getDb();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) {
    // TEMPORARY diagnostic logging — remove once the Render/Vercel deploy issue is resolved.
    console.error("[verifyBearerToken] db.auth.getUser failed:", error?.message ?? "no error, but no user returned");
    return null;
  }
  const supaUser = data.user;
  const { login: githubLogin, id: githubId } = extractGithubIdentity(supaUser);

  const existing = await db
    .from("users")
    .select("id, external_id, email, is_platform_admin")
    .eq("auth_user_id", supaUser.id)
    .maybeSingle();
  if (existing.data) {
    // Backfill external_id for users provisioned before GitHub-identity linking existed,
    // and keep email fresh (it's how review-completion notifications find a recipient —
    // see email/ — and Supabase account emails can change).
    const patch: Record<string, unknown> = {};
    if (!existing.data.external_id && githubId !== null) patch["external_id"] = String(githubId);
    if (supaUser.email && supaUser.email !== existing.data.email) patch["email"] = supaUser.email;
    const alreadyAdmin = existing.data.is_platform_admin as boolean;
    if (!alreadyAdmin && isBootstrapAdmin(supaUser.email)) patch["is_platform_admin"] = true;
    if (Object.keys(patch).length > 0) await db.from("users").update(patch).eq("id", existing.data.id);
    return {
      id: existing.data.id as string,
      authUserId: supaUser.id,
      email: supaUser.email ?? null,
      githubLogin,
      githubId,
      isPlatformAdmin: alreadyAdmin || patch["is_platform_admin"] === true,
    };
  }

  const bootstrapAdmin = isBootstrapAdmin(supaUser.email);
  const inserted = await db
    .from("users")
    .insert({
      auth_user_id: supaUser.id,
      external_id: githubId !== null ? String(githubId) : null,
      handle: githubLogin ?? supaUser.email?.split("@")[0] ?? "user",
      email: supaUser.email ?? null,
      seat_active: true,
      is_platform_admin: bootstrapAdmin,
    })
    .select("id")
    .single();
  if (inserted.error || !inserted.data) {
    throw new Error(`db: failed to provision user for ${supaUser.id}: ${inserted.error?.message ?? "no row"}`);
  }
  return {
    id: inserted.data.id as string,
    authUserId: supaUser.id,
    email: supaUser.email ?? null,
    githubLogin,
    githubId,
    isPlatformAdmin: bootstrapAdmin,
  };
}

/**
 * Org-scoped authorization with two auto-linking fallbacks beyond direct
 * membership — both driven by data the backend itself wrote, not by
 * inference from names (which breaks the moment an org has more than one
 * member, or a member's GitHub login doesn't match the org's):
 *
 * 1. Installer linking: this user's GitHub id matches `orgs.installed_by_github_id`
 *    (set authoritatively from the GitHub installation webhook) — they get owner.
 * 2. Invite linking: a pending `org_invites` row for this org matches their
 *    email — they get the invited role, and the invite is marked accepted.
 */
export async function ensureOrgAccess(db: SupabaseClient, user: AuthedUser, orgId: string): Promise<boolean> {
  const membership = await db
    .from("org_members")
    .select("org_id")
    .eq("org_id", orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membership.data) return true;

  if (user.githubId !== null) {
    const org = await db.from("orgs").select("installed_by_github_id").eq("id", orgId).maybeSingle();
    if (org.data && (org.data.installed_by_github_id as number | null) === user.githubId) {
      const { error } = await db.from("org_members").insert({ org_id: orgId, user_id: user.id, role: "owner" });
      if (error && error.code !== "23505") throw new Error(`db: failed to grant installer access: ${error.message}`);
      return true;
    }
  }

  if (user.email) {
    const { data: invite } = await db
      .from("org_invites")
      .select("id, role")
      .eq("org_id", orgId)
      .eq("status", "pending")
      .ilike("email", user.email)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (invite) {
      const { error: memberError } = await db
        .from("org_members")
        .insert({ org_id: orgId, user_id: user.id, role: invite.role as string });
      if (memberError && memberError.code !== "23505") {
        throw new Error(`db: failed to accept invite: ${memberError.message}`);
      }
      await db.from("org_invites").update({ status: "accepted" }).eq("id", invite.id);
      return true;
    }
  }

  return false;
}

export type OrgRole = "owner" | "admin" | "member";
const ROLE_RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };

/** Call after ensureOrgAccess has confirmed membership — checks the member's role meets a minimum bar. */
export async function getOrgRole(db: SupabaseClient, userId: string, orgId: string): Promise<OrgRole | null> {
  const { data } = await db.from("org_members").select("role").eq("org_id", orgId).eq("user_id", userId).maybeSingle();
  return (data?.role as OrgRole | undefined) ?? null;
}

export function roleAtLeast(role: OrgRole | null, minimum: OrgRole): boolean {
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * Auto-claims ownership of every GitHub org this user installed the App on
 * but doesn't have an org_members row for yet. `ensureOrgAccess` only ever
 * checks membership for ONE already-known orgId, which is fine for routes
 * that operate on a specific org — but `GET /api/orgs` has no orgId to check
 * in the first place, so without this the installer would never see their
 * own newly-installed org in the switcher at all. Best-effort: called on
 * every org listing, cheap when there's nothing to claim.
 */
export async function claimInstalledOrgs(db: SupabaseClient, user: AuthedUser): Promise<void> {
  if (user.githubId === null) return;

  const { data: orgs } = await db
    .from("orgs")
    .select("id")
    .eq("platform", "github")
    .eq("installed_by_github_id", user.githubId);
  if (!orgs || orgs.length === 0) return;

  const { data: existing } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", user.id)
    .in("org_id", orgs.map((o) => o.id as string));
  const alreadyMember = new Set((existing ?? []).map((m) => m.org_id as string));

  const unclaimed = orgs.map((o) => o.id as string).filter((id) => !alreadyMember.has(id));
  if (unclaimed.length === 0) return;

  const { error } = await db
    .from("org_members")
    .insert(unclaimed.map((orgId) => ({ org_id: orgId, user_id: user.id, role: "owner" as const })));
  if (error && error.code !== "23505") throw new Error(`db: failed to claim installed orgs: ${error.message}`);
}

/** First org this user belongs to — used as a fallback default when a route doesn't receive an explicit orgId. */
export async function getPrimaryOrgId(db: SupabaseClient, user: AuthedUser): Promise<string | null> {
  const { data } = await db.from("org_members").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
  return (data?.org_id as string | undefined) ?? null;
}

/** Every org this user belongs to, with their role — powers the frontend's org switcher. */
export async function listUserOrgs(
  db: SupabaseClient,
  userId: string,
): Promise<{ id: string; name: string; kind: "individual" | "team"; plan: string; platform: "github" | "bitbucket"; role: OrgRole }[]> {
  const { data, error } = await db
    .from("org_members")
    .select("role, orgs(id, name, kind, plan, platform)")
    .eq("user_id", userId);
  if (error) throw new Error(`db: failed to list orgs for user: ${error.message}`);
  return (
    (data ?? []) as unknown as {
      role: OrgRole;
      orgs: { id: string; name: string; kind: "individual" | "team"; plan: string; platform: "github" | "bitbucket" } | null;
    }[]
  )
    .filter((row) => row.orgs !== null)
    .map((row) => ({ ...row.orgs!, role: row.role }));
}
