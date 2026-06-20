import { createClient } from '@supabase/supabase-js'

// Publishable (anon) key — safe to ship to the browser; access is gated by RLS.
// Values live in .env.local locally and in Vercel project env vars for deploys.
const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(url, key, {
  realtime: { params: { eventsPerSecond: 5 } },
})

export const hasSupabase = Boolean(url && key)
