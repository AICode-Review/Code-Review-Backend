import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config.js";

let client: SupabaseClient | undefined;

/** Service-role client — bypasses RLS. Backend only; never expose this key. */
export function getDb(): SupabaseClient {
  client ??= createClient(env().SUPABASE_URL, env().SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
