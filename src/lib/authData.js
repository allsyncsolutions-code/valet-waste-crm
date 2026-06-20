import { supabase } from './supabaseClient.js'

// --- Session helpers --------------------------------------------------------

export async function getSession() {
  const { data } = await supabase.auth.getSession()
  return data.session || null
}

// Subscribe to auth changes. Returns an unsubscribe function.
export function onAuthChange(cb) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session))
  return () => {
    try { data.subscription.unsubscribe() } catch (e) {}
  }
}

// --- Profile (staff role) ---------------------------------------------------

// Loads the signed-in user's profile row. Returns null if not signed in.
// If the auth user exists but has no profile row yet, returns a pending stub.
export async function getProfile() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, role')
    .eq('id', user.id)
    .maybeSingle()
  if (error) {
    // RLS or network issue — treat as pending so the gate blocks access.
    return { id: user.id, email: user.email, full_name: null, role: 'pending' }
  }
  if (!data) return { id: user.id, email: user.email, full_name: null, role: 'pending' }
  return { ...data, email: data.email || user.email }
}

export function isStaff(profile) {
  return Boolean(profile && (profile.role === 'admin' || profile.role === 'staff'))
}

// --- Actions ----------------------------------------------------------------

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: (email || '').trim(),
    password: password || '',
  })
  if (error) throw error
  return data
}

export async function signOut() {
  await supabase.auth.signOut()
}
