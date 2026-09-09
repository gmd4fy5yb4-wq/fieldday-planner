'use client'
import { useState, useEffect } from 'react'
import { loadLeague, createLeague } from '@/lib/sync'
import type { AppState } from '@/lib/types'
import { SPORTS } from '@/lib/sports'
import { getSupabase } from '@/lib/supabase'
import { minPaidTierForSports, getPlan } from '@/lib/plans'
import { leagueCodeHint } from '@/lib/codeHints'
import type { User } from '@supabase/supabase-js'

// Every new league starts on the trial, which covers 3 sports. Capping the picker
// there keeps the gate from creating a league the create route would reject.
// More sports are addable later in Setup once a bigger plan is in place.
const TRIAL_SPORTS_LIMIT = getPlan('trial').sportsLimit

interface Props {
  defaultState: AppState
  onJoin: (code: string, state: AppState, userName: string, created: boolean, updatedAt?: string) => void
}

type Mode = 'choose' | 'create' | 'join'

export default function LeagueGate({ defaultState, onJoin }: Props) {
  const [mode, setMode] = useState<Mode>('choose')
  const [name, setName] = useState('')
  const [leagueName, setLeagueName] = useState('')
  const [sports, setSports] = useState<string[]>(['softball'])
  const [joinCode, setJoinCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [user, setUser] = useState<User | null | undefined>(undefined) // undefined = loading

  // Resolve auth state once on mount
  useEffect(() => {
    getSupabase().auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
    })
  }, [])

  function toggleSport(id: string) {
    setError('')
    setSports(prev => {
      if (prev.includes(id)) return prev.length === 1 ? prev : prev.filter(s => s !== id)
      if (prev.length >= TRIAL_SPORTS_LIMIT) return prev
      return [...prev, id]
    })
  }

  async function handleCreate() {
    if (!name.trim()) { setError('Please enter your name'); return }
    setLoading(true); setError('')

    const initialState = {
      ...defaultState,
      season: {
        ...defaultState.season,
        leagueName: leagueName.trim() || defaultState.season.leagueName,
        // sports[] is the real field; sport keeps legacy readers (and snapshot
        // restores) working — getSports() prefers the array when it's present.
        sports,
        sport: sports[0],
      },
    }
    const result = await createLeague(initialState, name.trim())

    if ('code' in result) {
      onJoin(result.code, initialState, name.trim(), true)
    } else {
      setError(result.error ?? 'Could not create league — check your connection and try again.')
    }
    setLoading(false)
  }

  async function handleJoin() {
    if (!name.trim()) { setError('Please enter your name'); return }
    const code = joinCode.trim().toUpperCase()
    if (code.length !== 6) { setError('League code must be 6 characters'); return }
    setLoading(true); setError('')
    const result = await loadLeague(code)
    if (result) {
      // Pass the version we just loaded — it becomes the base for this tab's saves.
      onJoin(code, result.data, name.trim(), false, result.updatedAt)
    } else {
      // A wrong-KIND-of-code is the likeliest cause, and 'double-check the code'
      // is useless advice when the code they hold is a perfectly good sign-in
      // code. Say which code they need.
      setError(leagueCodeHint(code) ?? 'League not found — double-check the code and try again.')
    }
    setLoading(false)
  }

  // While resolving auth, show nothing (avoids flash)
  if (user === undefined) {
    return (
      <div className="min-h-screen bg-[var(--fd-primary)] flex items-center justify-center">
        <div className="text-white/50 text-sm">Loading…</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[var(--fd-primary)] flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">

        {/* Logo / title */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white">FieldDay Planner</h1>
          <p className="text-[var(--fd-primary-light)] mt-1">Any sport. Any league. One planner.</p>
        </div>

        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">

          {/* Choose mode */}
          {mode === 'choose' && (
            <div className="p-8 space-y-3">
              {/* If not logged in, show sign-in prompt for create */}
              {!user && (
                <div className="mb-2 p-4 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm text-center">
                  <a href={`/login?next=${encodeURIComponent(window.location.search || '/')}`} className="font-semibold underline">Sign in</a> to create or manage a league.
                </div>
              )}
              <button
                onClick={() => {
                  if (!user) { window.location.href = `/login?next=${encodeURIComponent(window.location.search || '/')}`; return }
                  setMode('create'); setError('')
                }}
                className="w-full bg-[var(--fd-primary)] text-white py-3.5 rounded-xl font-semibold text-base hover:bg-[var(--fd-primary-dark)] transition"
              >
                Start free — create your league
              </button>
              <p className="text-xs text-gray-500 text-center">14-day full trial · no credit card</p>
              <button
                onClick={() => { setMode('join'); setError('') }}
                className="w-full border-2 border-[var(--fd-primary)] text-[var(--fd-primary)] py-3.5 rounded-xl font-semibold text-base hover:bg-[#f5f5fb] transition"
              >
                Join with a league code
              </button>
              <p className="text-xs text-gray-500 text-center">
                Coaches &amp; parents: ask your admin for the code or a view-only link — no account needed.
              </p>
              {user && (
                <a
                  href="/account"
                  className="block text-center text-sm text-gray-400 hover:text-gray-600 mt-2"
                >
                  My Account
                </a>
              )}
            </div>
          )}

          {/* Create */}
          {mode === 'create' && (
            <div className="p-8 space-y-5">
              <button onClick={() => { setMode('choose'); setError('') }} className="text-sm text-gray-400 hover:text-gray-600 flex items-center gap-1">
                ← Back
              </button>
              <div>
                <h2 className="text-lg font-semibold text-gray-800">Create your league</h2>
                <p className="text-sm text-gray-500 mt-1 mb-4">
                  Everything is free for 14 days — you&rsquo;ll pick a plan later, only if you keep it.
                </p>
                <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="gate-your-name">Your name</label>
                <input
                  id="gate-your-name"
                  autoFocus
                  className="w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--fd-accent)]"
                  placeholder="e.g. Coach Johnson"
                  value={name}
                  onChange={e => setName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="gate-league-name">League name</label>
                <input
                  id="gate-league-name"
                  className="w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--fd-accent)]"
                  placeholder="e.g. Cedar Valley Little League"
                  value={leagueName}
                  onChange={e => setLeagueName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreate()}
                />
              </div>
              <div>
                <div className="flex items-baseline justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">Sports — pick all that apply</label>
                  <span className="text-xs text-gray-500">{sports.length} of {TRIAL_SPORTS_LIMIT}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {SPORTS.map(s => {
                    const on = sports.includes(s.id)
                    const full = !on && sports.length >= TRIAL_SPORTS_LIMIT
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggleSport(s.id)}
                        disabled={full}
                        aria-pressed={on}
                        className={`px-3 py-1.5 rounded-lg text-sm border transition ${
                          on
                            ? 'bg-[var(--fd-primary)] text-white border-[var(--fd-primary)]'
                            : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-gray-300'
                        }`}
                      >
                        {s.name}
                      </button>
                    )
                  })}
                </div>
                {/* The price at the moment of intent, not after the fact (finding 6). */}
                <p className="text-xs text-gray-500 mt-3">
                  After your free trial, this setup fits{' '}
                  <span className="font-semibold text-gray-700">
                    {minPaidTierForSports(sports.length).name} · ${minPaidTierForSports(sports.length).annualPriceUsd}/yr
                  </span>{' '}
                  — or ${minPaidTierForSports(sports.length).seasonPassPriceUsd} for a 3-month season pass.
                </p>
              </div>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <button
                onClick={handleCreate}
                disabled={loading || !name.trim()}
                className="w-full bg-[var(--fd-primary)] text-white py-3 rounded-xl font-semibold hover:bg-[var(--fd-primary-dark)] transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Creating league…' : 'Create league — free for 14 days'}
              </button>
            </div>
          )}

          {/* Join */}
          {mode === 'join' && (
            <div className="p-8 space-y-5">
              <button onClick={() => { setMode('choose'); setError('') }} className="text-sm text-gray-400 hover:text-gray-600">
                ← Back
              </button>
              <div className="space-y-4">
                <h2 className="text-lg font-semibold text-gray-800">Join an existing league</h2>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Your Name</label>
                  <input
                    autoFocus
                    className="w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--fd-accent)]"
                    placeholder="e.g. Assistant Coach"
                    value={name}
                    onChange={e => setName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">League Code</label>
                  <input
                    className="w-full border rounded-lg px-3 py-2.5 font-mono text-xl tracking-[0.3em] text-center uppercase focus:outline-none focus:ring-2 focus:ring-[var(--fd-accent)]"
                    placeholder="ABC123"
                    value={joinCode}
                    onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                    maxLength={6}
                    onKeyDown={e => e.key === 'Enter' && handleJoin()}
                  />
                  {/* A hint, never a gate — an all-digit league code is legal, so
                      Join stays enabled and the server remains the authority. */}
                  {leagueCodeHint(joinCode) && (
                    <p className="text-xs text-amber-700 mt-1.5">{leagueCodeHint(joinCode)}</p>
                  )}
                </div>
              </div>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <button
                onClick={handleJoin}
                disabled={loading || !name.trim() || joinCode.length !== 6}
                className="w-full bg-[var(--fd-primary)] text-white py-3 rounded-xl font-semibold hover:bg-[var(--fd-primary-dark)] transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Joining…' : 'Join League'}
              </button>
              {user && (
                <p className="text-xs text-gray-500 text-center pt-2">
                  Made this league before signing up?{' '}
                  <a href="/account" className="underline">Link it to your account</a>.
                </p>
              )}
              {!user && (
                <p className="text-xs text-gray-500 text-center pt-2">
                  Just checking a schedule? Ask your admin for a view-only link instead — no name or code needed.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer links */}
        <div className="text-center text-sm text-[var(--fd-primary-light)] space-x-4">
          {user ? (
            <span>Signed in as <span className="font-medium text-white">{user.email}</span></span>
          ) : (
            <a href="/login" className="underline hover:text-white">Sign in</a>
          )}
          <span>·</span>
          <a href="/pricing" className="underline hover:text-white">Plans & pricing</a>
        </div>
      </div>
    </div>
  )
}
