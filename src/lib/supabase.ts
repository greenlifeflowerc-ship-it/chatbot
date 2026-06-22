import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

// Service-role client. Bypasses RLS, so it must never be exposed to the browser
// or the Flutter bundle. Auth persistence is disabled — this is a stateless
// server process, not a user session.
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

export type SupabaseClient = typeof supabase;
