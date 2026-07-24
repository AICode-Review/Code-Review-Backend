/**
 * Bitbucket Cloud credentials come in two shapes:
 * - Workspace Access Token → `Authorization: Bearer <token>`
 * - Personal API token (Account settings → API tokens) → HTTP Basic with
 *   Atlassian account email + token (Bitbucket rejects Bearer for these)
 *
 * We store either a raw token string (Bearer) or a JSON blob
 * `{ "token": "...", "email": "..." }` inside platform_tokens.encrypted_token
 * so the adapter can rebuild the right header without a schema migration.
 */

export interface BitbucketCredential {
  token: string;
  email?: string;
}

export function encodeBitbucketCredential(token: string, email?: string): string {
  const trimmedEmail = email?.trim();
  if (trimmedEmail) return JSON.stringify({ token, email: trimmedEmail } satisfies BitbucketCredential);
  return token;
}

export function parseBitbucketCredential(raw: string): BitbucketCredential {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<BitbucketCredential>;
      if (typeof parsed.token === "string" && parsed.token.length > 0) {
        return {
          token: parsed.token,
          email: typeof parsed.email === "string" && parsed.email.length > 0 ? parsed.email : undefined,
        };
      }
    } catch {
      /* fall through — treat as opaque token */
    }
  }
  return { token: trimmed };
}

/** Builds the Authorization header value (including the scheme). */
export function bitbucketAuthorizationHeader(rawCredential: string): string {
  const { token, email } = parseBitbucketCredential(rawCredential);
  if (email) {
    return `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;
  }
  return `Bearer ${token}`;
}
