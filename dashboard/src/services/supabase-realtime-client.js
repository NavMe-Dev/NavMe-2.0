/**
 * Shared Supabase JS client (Realtime / websocket).
 * REST CRUD stays in supabase.js; this is for live postgres_changes only.
 */
import { createClient } from '@supabase/supabase-js';
import { getSupabaseUrl, getSupabaseAnonKey, isSupabaseConfigured } from './supabase.js';

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let client = null;

export function getSupabaseRealtimeClient() {
  if (!isSupabaseConfigured()) return null;
  if (client) return client;
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();
  client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    realtime: {
      params: { eventsPerSecond: 8 },
    },
  });
  return client;
}
