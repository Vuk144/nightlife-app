import {
  createClient,
  type WebSocketLikeConstructor,
} from "@supabase/supabase-js";

// Values come from .env (loaded automatically by the Expo CLI). Only the
// EXPO_PUBLIC_ prefixed vars are exposed to the client bundle, and both of
// these are safe to ship: the URL is public and the anon key is protected by
// Row Level Security. The service-role key must never be used here.
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase environment variables. Copy .env.example to .env and " +
      "fill in EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.",
  );
}

// @supabase/realtime-js probes for a native WebSocket the moment the client is
// created, which throws on Node < 22 — the runtime Expo Web's static render
// uses. This app only reads from Supabase and never opens a Realtime channel,
// so we pass a transport up front to skip that probe: the real WebSocket in the
// browser / on React Native, and an inert stub (never instantiated) during
// static rendering.
const realtimeTransport: WebSocketLikeConstructor =
  typeof WebSocket !== "undefined"
    ? WebSocket
    : (class {
        constructor() {
          throw new Error(
            "Supabase Realtime is not available in this environment.",
          );
        }
      } as unknown as WebSocketLikeConstructor);

// Read-only client: no session to persist, so the auth machinery (and its
// AsyncStorage dependency) is turned off.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  realtime: {
    transport: realtimeTransport,
  },
});
