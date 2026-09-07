import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.ts";

/**
 * Service-role Supabase client. RLS-bypassing.
 *
 * This module is the ONLY place the service-role key is used, and this whole
 * `ingestion/` project is never imported by or bundled into the Expo app.
 */
export function createServiceClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
