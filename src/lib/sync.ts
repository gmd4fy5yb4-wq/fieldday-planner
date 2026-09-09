import { getSupabase } from './supabase'
import type { AppState } from './types'

export interface LeagueRecord {
  data: AppState
  updatedAt: string
  updatedBy: string
}

export async function loadLeague(code: string): Promise<LeagueRecord | null> {
  const { data, error } = await getSupabase()
    .from('leagues')
    .select('data, updated_at, updated_by')
    .eq('id', code.toUpperCase())
    .single()
  if (error || !data) return null
  return { data: data.data as AppState, updatedAt: data.updated_at, updatedBy: data.updated_by }
}

export interface SaveResult {
  success: boolean
  error?: string
  limitType?: string
  /** True when the league moved on since `baseUpdatedAt` — nothing was written. */
  conflict?: boolean
  /** The row's new `updated_at`; becomes the base for the next save. */
  updatedAt?: string
}

/**
 * Save a league through the authenticated server route.
 * The server validates the user's subscription limits before saving.
 *
 * `baseUpdatedAt` is the `updated_at` this client last saw. The server only
 * overwrites that exact version, so a stale tab gets `conflict: true` instead of
 * quietly deleting whatever everyone else has saved since. Omitting it restores
 * the old last-writer-wins behaviour, so pass it wherever it is known.
 */
export async function saveLeague(
  code: string,
  state: AppState,
  userName: string,
  baseUpdatedAt?: string
): Promise<SaveResult> {
  try {
    const res = await fetch('/api/leagues/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.toUpperCase(), state, userName, baseUpdatedAt }),
    })
    const data = await res.json()
    if (!res.ok) {
      return { success: false, error: data.error, limitType: data.limitType, conflict: res.status === 409 }
    }
    return { success: true, updatedAt: data.updatedAt }
  } catch {
    // Network drop / tab closing mid-request — same contract as a failed save
    return { success: false, error: 'Network error — your changes were not saved. Please try again.' }
  }
}

/**
 * Create a new league through the authenticated server route.
 * Sets owner_id atomically and enforces subscription limits.
 * Returns the generated code on success, or null on failure.
 */
export async function createLeague(
  state: AppState,
  userName: string
): Promise<{ code: string } | { error: string; limitType?: string }> {
  try {
    const res = await fetch('/api/leagues/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, userName }),
    })
    const data = await res.json()
    if (!res.ok) {
      return { error: data.error ?? 'Failed to create league.', limitType: data.limitType }
    }
    return { code: data.code }
  } catch {
    return { error: 'Network error — please check your connection and try again.' }
  }
}

export async function leagueExists(code: string): Promise<boolean> {
  const { data } = await getSupabase()
    .from('leagues')
    .select('id')
    .eq('id', code.toUpperCase())
    .single()
  return !!data
}

// ── Read-only view tokens ──────────────────────────────────────────────────────
// A view_token is a random UUID stored alongside the league. It is completely
// separate from the admin code and cannot be used to modify the league.

/**
 * Returns the existing view token for a league, or creates and saves a new one.
 * Goes through the authenticated server route — the underlying RPC is
 * service-role-only (migration 008) and can't be called from the browser.
 */
export async function getOrCreateViewToken(leagueCode: string): Promise<string | null> {
  try {
    const res = await fetch('/api/league/share-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: leagueCode.toUpperCase() }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.token ?? null
  } catch {
    return null
  }
}

/**
 * Loads a league by its read-only view token.
 * Uses the server API route (service role) to bypass RLS.
 */
export async function loadLeagueByViewToken(token: string): Promise<LeagueRecord | null> {
  try {
    const res = await fetch(`/api/league/view?token=${encodeURIComponent(token)}`)
    if (!res.ok) return null
    const data = await res.json()
    return { data: data.data as AppState, updatedAt: data.updated_at, updatedBy: data.updated_by }
  } catch {
    // Network drop on a shared-link viewer's phone — the Sentry event that
    // prompted this guard. Caller shows the "couldn't load" state on null.
    return null
  }
}

// ── Snapshots ─────────────────────────────────────────────────────────────────

export interface Snapshot {
  id: string
  name: string
  data: AppState
  createdAt: string
  createdBy: string
}

export async function saveSnapshot(leagueId: string, name: string, state: AppState, userName: string): Promise<boolean> {
  const { error } = await getSupabase()
    .from('league_snapshots')
    .insert({ league_id: leagueId.toUpperCase(), name, data: state, created_by: userName })
  return !error
}

export async function listSnapshots(leagueId: string): Promise<Snapshot[]> {
  const { data } = await getSupabase()
    .from('league_snapshots')
    .select('id, name, data, created_at, created_by')
    .eq('league_id', leagueId.toUpperCase())
    .order('created_at', { ascending: false })
    .limit(30)
  return (data ?? []).map(s => ({
    id: s.id,
    name: s.name,
    data: s.data as AppState,
    createdAt: s.created_at,
    createdBy: s.created_by,
  }))
}

export async function deleteSnapshot(id: string): Promise<boolean> {
  const { error } = await getSupabase()
    .from('league_snapshots')
    .delete()
    .eq('id', id)
  return !error
}
