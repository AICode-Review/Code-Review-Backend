import { env } from "../config.js";

/**
 * Platform-admin bootstrapping — deliberately its own module, separate from the general
 * user sign-in/provisioning path (verifyUser.ts). Every user who ever signs in, customer
 * or admin, runs through verifyBearerToken(); "which emails silently become a platform
 * admin" is a distinct, higher-stakes concern from "verify this session and get/create a
 * users row," and belongs in its own reviewable unit rather than inline in the general
 * auth check. verifyBearerToken() calls isBootstrapAdmin() explicitly rather than deciding
 * this itself.
 */

/** Case-insensitive match against the comma-separated ADMIN_BOOTSTRAP_EMAILS allowlist. */
export function isBootstrapAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = env().ADMIN_BOOTSTRAP_EMAILS;
  if (!list) return false;
  return list
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .includes(email.toLowerCase());
}
