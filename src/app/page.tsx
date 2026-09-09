'use client'
import { useState, useEffect, useRef } from 'react'
import type { AppState } from '@/lib/types'
import { getSportConfig } from '@/lib/sports'
import { shouldLockForOwnPlan } from '@/lib/plans'
import { trialBanner, isUnnamedLeague, DEFAULT_LEAGUE_NAME } from '@/lib/trial'
import type { PlanPanelSubscription } from '@/lib/planUsage'
import { getTheme, buildThemeVars } from '@/lib/themes'
import { loadLeague, loadLeagueByViewToken, saveLeague, saveSnapshot, getOrCreateViewToken } from '@/lib/sync'
import { getSupabase } from '@/lib/supabase'
import type { User } from '@supabase/supabase-js'
import SnapshotModal from '@/components/SnapshotModal'
import SetupTab from '@/components/SetupTab'
import DivisionsTab from '@/components/DivisionsTab'
import FieldsTab from '@/components/FieldsTab'
import UmpiresTab from '@/components/UmpiresTab'
import CalendarTab from '@/components/CalendarTab'
import AutoScheduleTab from '@/components/AutoScheduleTab'
import StandingsTab from '@/components/StandingsTab'
import CoachesTab from '@/components/CoachesTab'
import DashboardTab from '@/components/DashboardTab'
import LeagueGate from '@/components/LeagueGate'
import TrialBar from '@/components/TrialBar'
import Icon from '@/components/Icon'
import MobileNav from '@/components/MobileNav'
import { NAV_GROUPS, isTabVisible } from '@/lib/mobileNav'
import CoachView from '@/components/CoachView'
import TourOverlay from '@/components/TourOverlay'
import TourWelcomeModal from '@/components/TourWelcomeModal'
import { getActiveStep, advanceTour, TOUR_STEPS, TOTAL_STEPS, type TourState } from '@/lib/tour'
import HelpButton from '@/components/HelpButton'

interface SubscriptionRow extends PlanPanelSubscription {
  plan_tier: string
  subscription_status: string | null
  sports_limit: number
  divisions_limit: number
  teams_limit: number
  /** NULL for a one-time season pass or a tester row — see trialBanner. */
  stripe_subscription_id?: string | null
}

const DEFAULT: AppState = {
  season: { leagueName: DEFAULT_LEAGUE_NAME, sport: 'softball', startDate: '', endDate: '', gameDurationMinutes: 90, practiceDurationMinutes: 90 },
  divisions: [],
  blackoutDates: [],
  fields: [],
  umpires: [],
  fieldStaff: [],
  schedule: { games: [], practices: [], specialEvents: [], generatedAt: null, warnings: [] },
}

/**
 * Key-order-stable JSON stringify.
 * PostgreSQL JSONB stores object keys in sorted order, so naïve JSON.stringify
 * of a locally-built object produces a DIFFERENT string than JSON.stringify of
 * the same data returned from Supabase — causing the poll to see a false
 * "remote change" after every save and overwrite unsaved local edits.
 * Using stableStringify on both sides eliminates this class of false positives.
 */
function stableStringify(val: unknown): string {
  if (val === null || typeof val !== 'object') return JSON.stringify(val)
  if (Array.isArray(val)) return '[' + (val as unknown[]).map(stableStringify).join(',') + ']'
  const obj = val as Record<string, unknown>
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

function migrateState(s: AppState): AppState {
  if (s.schedule) {
    s.schedule.games = (s.schedule.games ?? []).map(g => ({ ...g, durationMinutes: g.durationMinutes ?? 90 }))
    s.schedule.practices = (s.schedule.practices ?? []).map(p => ({ ...p, durationMinutes: p.durationMinutes ?? 90 }))
    s.schedule.specialEvents = s.schedule.specialEvents ?? []
  }
  s.season.sport = s.season.sport ?? 'softball'
  s.blackoutDates = s.blackoutDates ?? []
  // Strip legacy time slots from fields (fields are now open 8 AM–8 PM daily), preserve blackoutDates + geocoords
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  s.fields = (s.fields ?? []).map((f: any) => ({ id: f.id, name: f.name, location: f.location ?? '', address: f.address ?? '', blackoutDates: f.blackoutDates ?? undefined, geocoords: f.geocoords ?? undefined }))
  // Field staff (added later — default to empty array for old leagues)
  s.fieldStaff = s.fieldStaff ?? []
  // Auto-schedule state
  s.autoScheduleConflicts = s.autoScheduleConflicts ?? undefined
  s.autoSchedulePreview = s.autoSchedulePreview ?? undefined
  return s
}

/**
 * Save an auto-snapshot at the start of each admin session, rate-limited to
 * once per 8 hours per league per device. This gives a rolling recovery point
 * if data is accidentally lost or overwritten.
 */
function maybeAutoSnapshot(code: string, state: AppState, userName: string) {
  const key = `sb-auto-snap-${code}`
  const last = parseInt(localStorage.getItem(key) ?? '0', 10)
  const EIGHT_HOURS = 8 * 60 * 60 * 1000
  if (Date.now() - last < EIGHT_HOURS) return
  localStorage.setItem(key, String(Date.now()))
  const label = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
  void saveSnapshot(code, `[Auto] ${label}`, state, userName)
}

type SyncStatus = 'synced' | 'saving' | 'error'

export default function Home() {
  const [state, setState] = useState<AppState>(DEFAULT)
  const [tab, setTab] = useState(0)
  const [kebabOpen, setKebabOpen] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [leagueCode, setLeagueCode] = useState<string | null>(null)
  const [userName, setUserName] = useState('Unknown')
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('synced')
  // Why the last save failed, in the server's own words. Without this every
  // failure rendered as "check connection" — including an expired plan, a plan
  // limit and a save conflict, none of which the connection can fix.
  const [syncError, setSyncError] = useState('')
  const [lastUpdatedBy, setLastUpdatedBy] = useState('')
  const [lastUpdatedAt, setLastUpdatedAt] = useState('')
  const [codeCopied, setCodeCopied] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  // Lapsed plan. Distinct from readOnly-by-share-link: an expired OWNER still sees
  // their league code, setup tabs and share controls — they have just lost editing.
  const [expired, setExpired] = useState(false)
  const [viewTokenError, setViewTokenError] = useState(false)
  const [roLinkCopied, setRoLinkCopied] = useState(false)
  const [showSnapshots, setShowSnapshots] = useState(false)
  const [pendingRemote, setPendingRemote] = useState<{ data: AppState; updatedBy: string; updatedAt: string } | null>(null)

  const [user, setUser] = useState<User | null>(null)
  // The user_subscriptions row, kept whole. The plan limits, the trial bar and the
  // plan panel are all views of it — deriving beats storing the same fetch 3 times.
  const [sub, setSub] = useState<SubscriptionRow | null>(null)
  // Who owns the loaded league. Keyed on leagueCode rather than captured at each
  // load site: a league arrives here three ways (URL code, saved code, join gate)
  // and only the code is common to all of them.
  const [leagueOwnerId, setLeagueOwnerId] = useState<string | null>(null)
  // NULL leagueOwnerId is ambiguous — it means "unclaimed" AND "not fetched yet"
  // — so ownership decisions need this to know which. Without it the read-only
  // gate below reads a collaborator as the owner during the first render pass,
  // greys the app out, and never takes it back.
  const [ownerResolved, setOwnerResolved] = useState(false)
  // Unclaimed (NULL owner) counts as your own, matching saveGate(). While `user`
  // is still loading we assume owner, so the real owner never sees a flash of
  // collaborator copy on their own league.
  const isLeagueOwner = !leagueOwnerId || !user || leagueOwnerId === user.id

  // ponytail: the tour lives inline because page.tsx already owns `tab`, `setTab`
  // and `user`. A useTour() hook would need all three passed in and would return
  // four values — more indirection than the ~30 lines cost. Revisit if page.tsx
  // is ever split.
  const [tourState, setTourState] = useState<TourState | null>(null)
  const [showWelcome, setShowWelcome] = useState(false)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSyncedRef = useRef('')
  const isSavingRef = useRef(false)
  // The `updated_at` this tab last saw. Sent with every save so the server can
  // refuse to overwrite a newer version than the one we are editing on top of.
  // Must be updated at EVERY point where this tab adopts a version of the
  // league — each load path, the join gate, and both banner buttons — or the
  // next save 409s with no way out.
  const baseUpdatedAtRef = useRef<string | null>(null)
  // Consecutive failed save attempts, for the bounded retry below.
  const saveRetriesRef = useRef(0)
  const localUserRef = useRef('Unknown')
  const viewTokenRef = useRef<string | null>(null)       // token generated by owner for sharing
  const roTokenRef   = useRef<string | null>(null)       // token this session is viewing (read-only)

  // ── Undo stack ────────────────────────────────────────────────────
  const undoStackRef = useRef<AppState[]>([])
  const isUndoingRef = useRef(false)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [canUndo, setCanUndo] = useState(false)

  // On mount: check URL params for read-only share link, then localStorage
  useEffect(() => {
    // After a magic-link login the auth callback drops us at '/'.
    // If the login page saved a ?next= destination, navigate there now so the
    // user lands on the right league instead of whatever localStorage holds.
    const loginNext = localStorage.getItem('sb-login-next')
    if (loginNext) {
      localStorage.removeItem('sb-login-next')
      // Only navigate if the destination differs from the current URL
      if (loginNext !== window.location.pathname + window.location.search) {
        window.location.replace(loginNext)
        return
      }
    }

    const params = new URLSearchParams(window.location.search)
    const viewToken = params.get('token')
    const urlCode = params.get('code')?.toUpperCase()
    const isReadOnly = params.get('view') === 'readonly'

    if (viewToken) {
      // Token-based read-only share link — never exposes the admin code
      // Note: we don't require `&view=readonly` here because messaging apps
      // and clipboard tools sometimes strip query params. The token alone is
      // sufficient to identify a view-only link.
      setReadOnly(true)
      roTokenRef.current = viewToken
      loadLeagueByViewToken(viewToken).then(result => {
        if (result) {
          const s = migrateState(result.data)
          setState(s)
          lastSyncedRef.current = stableStringify(s)
          setLastUpdatedBy(result.updatedBy)
          setLastUpdatedAt(result.updatedAt)
          setLeagueCode('VIEW')  // sentinel: lets the render gate pass, no saves possible in readOnly mode
        } else {
          setViewTokenError(true)
        }
        setHydrated(true)
      })
      return
    }

    // Flush any state that was saved to localStorage on the previous tab close
    // (beforeunload backup). Run this before loading so Supabase gets the latest.
    async function flushUnloadBackup(code: string, userName: string) {
      const key = `fd-unload-${code}`
      const raw = localStorage.getItem(key)
      if (!raw) return
      localStorage.removeItem(key)   // always clear, even if flush fails
      try {
        const { state: pending, userName: u, at } = JSON.parse(raw) as {
          state: AppState; userName: string; at: number
        }
        // Only flush if written within the last 30 minutes (stale after that)
        if (Date.now() - at < 30 * 60 * 1000) {
          await saveLeague(code, pending, u || userName)
        }
      } catch { /* ignore parse/save errors */ }
    }

    if (urlCode) {
      // Legacy: code in URL — load as admin (no read-only via code anymore)
      flushUnloadBackup(urlCode, 'Admin').then(() =>
        loadLeague(urlCode).then(result => {
          if (result) {
            const s = migrateState(result.data)
            setState(s)
            lastSyncedRef.current = stableStringify(s)
            setLeagueCode(urlCode)
            setLastUpdatedBy(result.updatedBy)
            setLastUpdatedAt(result.updatedAt)
            baseUpdatedAtRef.current = result.updatedAt
            maybeAutoSnapshot(urlCode, s, 'Admin')
          }
          setHydrated(true)
        })
      )
      return
    }

    const code = localStorage.getItem('sb-league-code')
    const name = localStorage.getItem('sb-user-name')
    if (code && name) {
      localUserRef.current = name
      setLeagueCode(code)
      setUserName(name)
      flushUnloadBackup(code, name).then(() =>
        loadLeague(code).then(result => {
          if (result) {
            const s = migrateState(result.data)
            setState(s)
            lastSyncedRef.current = stableStringify(s)
            setLastUpdatedBy(result.updatedBy)
            setLastUpdatedAt(result.updatedAt)
            baseUpdatedAtRef.current = result.updatedAt
            maybeAutoSnapshot(code, s, name)
          }
          setHydrated(true)
        })
      )
    } else {
      setHydrated(true)
    }
  }, [])

  // Track auth state
  useEffect(() => {
    const sb = getSupabase()
    sb.auth.getSession().then(async ({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        const { data: sub } = await sb
          .from('user_subscriptions')
          .select('sports_limit, divisions_limit, teams_limit, plan_tier, subscription_status, subscription_end, stripe_subscription_id, stripe_customer_id, billing_period')
          .eq('user_id', session.user.id)
          .single()
        setSub(sub as SubscriptionRow | null)
      }
    })
    const { data: { subscription } } = sb.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  // Push to undo stack on state change (debounced 1s, skipped during undo)
  useEffect(() => {
    if (!hydrated || isUndoingRef.current) return
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    undoTimerRef.current = setTimeout(() => {
      const current = JSON.stringify(state)
      const last = undoStackRef.current[undoStackRef.current.length - 1]
      if (last && JSON.stringify(last) === current) return  // no change
      undoStackRef.current = [...undoStackRef.current.slice(-19), state]
      setCanUndo(undoStackRef.current.length > 1)
    }, 1000)
    return () => { if (undoTimerRef.current) clearTimeout(undoTimerRef.current) }
  }, [state, hydrated])

  // Auto-save on state change — debounced 800ms (skip in read-only mode)
  useEffect(() => {
    if (!hydrated || !leagueCode || readOnly) return
    const current = stableStringify(state)
    if (current === lastSyncedRef.current) return

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveRetriesRef.current = 0   // a fresh edit supersedes any retry in progress
    setSyncStatus('saving')

    // Capture the code so the closure doesn't go stale if leagueCode changes.
    // leagueCode is guaranteed non-null here (checked above).
    const codeAtSchedule = leagueCode as string

    async function doSave() {
      if (isSavingRef.current) {
        // Another save is in flight — retry in 1 s so we don't silently drop this state
        saveTimerRef.current = setTimeout(doSave, 1000)
        return
      }
      isSavingRef.current = true
      try {
        const result = await saveLeague(
          codeAtSchedule, state, localUserRef.current, baseUpdatedAtRef.current ?? undefined
        )
        if (result.success) {
          lastSyncedRef.current = current
          if (result.updatedAt) baseUpdatedAtRef.current = result.updatedAt
          saveRetriesRef.current = 0
          setSyncStatus('synced')
          setSyncError('')
        } else if (result.conflict) {
          // Nothing was written — somebody saved while we were editing. Pull what
          // actually landed and hand it to the review banner. Retrying would only
          // conflict again, and forcing it through is the data loss we are fixing.
          setSyncStatus('error')
          setSyncError(result.error ?? 'Someone else saved this league while you were editing.')
          const latest = await loadLeague(codeAtSchedule)
          if (latest) {
            setPendingRemote({
              data: migrateState(latest.data),
              updatedBy: latest.updatedBy,
              updatedAt: latest.updatedAt,
            })
          }
        } else {
          setSyncStatus('error')
          setSyncError(result.error ?? 'Save failed — check connection.')
          // Retry only what a retry can fix. A plan limit or an expired plan is a
          // decision, not a blip, and hammering it would just burn battery in a
          // dugout. ponytail: 3 tries, fixed 5 s apart — enough to ride out a lost
          // signal between innings. Add backoff if that proves too few.
          if (!result.limitType && saveRetriesRef.current < 3) {
            saveRetriesRef.current += 1
            saveTimerRef.current = setTimeout(doSave, 5000)
          }
        }
      } catch {
        // Network error — don't leave isSavingRef stuck true (would block all future saves)
        setSyncStatus('error')
        setSyncError('Save failed — check connection.')
      } finally {
        isSavingRef.current = false
      }
    }

    saveTimerRef.current = setTimeout(doSave, 800)

    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, hydrated, leagueCode])

  // Flush any unsaved changes before the page goes away.
  // Strategy: always write to localStorage as a reliable backup (no size limit),
  // AND attempt a keepalive fetch (fast path, works for smaller states < 64 KB).
  // The localStorage backup is flushed to Supabase on the next app load.
  //
  // Listen on pagehide + visibilitychange, NOT beforeunload alone. iOS Safari
  // routinely discards a backgrounded tab without ever firing beforeunload, so
  // on a phone — the device most likely to be carrying unsaved edits around a
  // field — the backup was never written in exactly the case it exists for.
  useEffect(() => {
    function flush() {
      if (!leagueCode || readOnly) return
      const current = stableStringify(state)
      if (current === lastSyncedRef.current) return   // nothing new to save

      // Reliable backup — no size limit, survives any tab close
      try {
        localStorage.setItem(
          `fd-unload-${leagueCode}`,
          JSON.stringify({ state, userName: localUserRef.current, at: Date.now() })
        )
      } catch { /* ignore quota errors */ }

      // Fast path — keepalive fetch (may silently fail if body > 64 KB).
      // baseUpdatedAt goes along so a dying tab cannot overwrite a newer version
      // either; if it conflicts the localStorage copy is still there to flush.
      fetch('/api/leagues/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: leagueCode,
          state,
          userName: localUserRef.current,
          baseUpdatedAt: baseUpdatedAtRef.current ?? undefined,
        }),
        keepalive: true,
      })
    }
    function onHidden() { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [state, leagueCode, readOnly])

  // Eagerly pre-generate the view token so the clipboard write in copyReadOnlyLink()
  // is synchronous on the first click. Safari iOS drops the user-gesture context
  // across any await, so we need the token ready before the button is ever pressed.
  useEffect(() => {
    if (!leagueCode || readOnly || leagueCode === 'VIEW') return
    if (viewTokenRef.current) return   // already have it
    getOrCreateViewToken(leagueCode).then(token => {
      if (token) viewTokenRef.current = token
    })
  }, [leagueCode, readOnly])

  // Keyed on the VIEW sentinel rather than `readOnly`: the plan gate below sets
  // readOnly, so depending on it here made the two effects feed each other —
  // going read-only wiped leagueOwnerId, which told the gate the league was the
  // user's own, which kept it read-only.
  useEffect(() => {
    if (!leagueCode || leagueCode === 'VIEW') {
      setLeagueOwnerId(null)
      setOwnerResolved(false)
      return
    }
    let cancelled = false
    setOwnerResolved(false)
    getSupabase().from('leagues').select('owner_id').eq('id', leagueCode).single()
      .then(({ data }) => {
        if (cancelled) return
        setLeagueOwnerId((data?.owner_id as string | null) ?? null)
        setOwnerResolved(true)
      })
    return () => { cancelled = true }
  }, [leagueCode])

  // Lapsed plan → read-only app instead of the old /pricing lockout.
  //
  // Only on a league YOUR plan governs. saveGate() weighs a write against the
  // OWNER's plan, so on someone else's league your own expiry is simply not the
  // rule — and the owner's row is unreadable from the browser (user_subscriptions
  // RLS is own-row only), so there is nothing to check client-side. Leave the UI
  // editable and let the server answer.
  //
  // This is what broke Alicia Ciccarello on YWWM8G (2026-09-03): her personal
  // trial had lapsed months earlier, so she was shown "your plan has expired" and
  // a dead app on a league owned by an unlimited account. Telling a collaborator
  // that is wrong twice — it is not their plan's business, and buying one would
  // not have changed anything.
  //
  // Only ever sets read-only, never clears it: share-link viewers get readOnly
  // from the view-token path above and must keep it.
  useEffect(() => {
    if (!shouldLockForOwnPlan({ sub, leagueCode, ownerResolved, isLeagueOwner })) return
    setExpired(true)
    setReadOnly(true)
  }, [sub, leagueCode, ownerResolved, isLeagueOwner])

  // Poll for remote changes
  useEffect(() => {
    if (!leagueCode || !hydrated) return
    const interval = readOnly ? 30000 : 5000
    const poll = setInterval(async () => {
      if (isSavingRef.current) return // skip if mid-save
      // In read-only mode, load by view token; in admin mode, load by league code
      const result = readOnly && roTokenRef.current
        ? await loadLeagueByViewToken(roTokenRef.current)
        : await loadLeague(leagueCode)
      if (!result) return
      const migratedRemote = migrateState(result.data)
      const remote = stableStringify(migratedRemote)
      if (remote !== lastSyncedRef.current) {
        if (readOnly) {
          // Read-only viewers always get the latest automatically
          setState(migratedRemote)
          lastSyncedRef.current = remote
          baseUpdatedAtRef.current = result.updatedAt
          setLastUpdatedBy(result.updatedBy)
          setLastUpdatedAt(result.updatedAt)
        } else {
          // Admins see a review banner — never silently overwrite
          setPendingRemote({ data: migratedRemote, updatedBy: result.updatedBy, updatedAt: result.updatedAt })
        }
      }
    }, interval)
    return () => clearInterval(poll)
  }, [leagueCode, hydrated, readOnly])

  function handleJoin(code: string, data: AppState, name: string, created: boolean, updatedAt?: string) {
    localStorage.setItem('sb-league-code', code)
    localStorage.setItem('sb-user-name', name)
    localUserRef.current = name
    const s = migrateState(data)
    setState(s)
    lastSyncedRef.current = stableStringify(s)
    baseUpdatedAtRef.current = updatedAt ?? null
    setLeagueCode(code)
    setUserName(name)
    setHydrated(true)

    // Offer the tour only to someone who just CREATED a league. A coach who joined
    // with a code cannot perform most of the setup steps the tour walks through.
    // This lookup lives here rather than in the auth effect because the effect runs
    // on mount, before any league exists — it would always read "not created".
    if (created) {
      const sb = getSupabase()
      sb.auth.getSession().then(async ({ data: { session } }) => {
        if (!session?.user) return
        const { data: row } = await sb
          .from('fd_user_tour')
          .select('user_id')
          .eq('user_id', session.user.id)
          .maybeSingle()
        if (!row) setShowWelcome(true)
      })
    }
  }

  /** Fire-and-forget: a failed write only means the modal may appear once more. */
  function markTourSeen() {
    const sb = getSupabase()
    sb.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) return
      sb.from('fd_user_tour').insert({ user_id: session.user.id }).then(() => {})
    })
  }

  function startTour() {
    setTourState({ step: 1, dismissed: false })
    setTab(TOUR_STEPS[0].tab)
  }

  function acceptTour() {
    setShowWelcome(false)
    markTourSeen()
    startTour()
  }

  function declineTour() {
    setShowWelcome(false)
    markTourSeen()          // declining still counts as "offered"
  }

  function advanceTourStep() {
    if (!tourState) return
    const next = advanceTour(tourState)
    setTourState(next)
    // Drive the app to the next step's tab so the user never has to find it.
    const nextDef = TOUR_STEPS.find(s => s.step === next.step)
    if (nextDef) setTab(nextDef.tab)
  }

  function dismissTour() {
    setTourState(current => (current ? { ...current, dismissed: true } : current))
  }

  function handleLeave() {
    localStorage.removeItem('sb-league-code')
    localStorage.removeItem('sb-user-name')
    setLeagueCode(null)
    setState(DEFAULT)
    lastSyncedRef.current = ''
  }

  async function handleSignOut() {
    await getSupabase().auth.signOut()
    handleLeave()
  }

  function copyCode() {
    if (!leagueCode) return
    navigator.clipboard.writeText(leagueCode)
    setCodeCopied(true)
    setTimeout(() => setCodeCopied(false), 2000)
  }

  function handleUndo() {
    const stack = undoStackRef.current
    if (stack.length < 2) return
    const prev = stack[stack.length - 2]
    undoStackRef.current = stack.slice(0, -1)
    setCanUndo(undoStackRef.current.length > 1)
    isUndoingRef.current = true
    setState(prev)
    setTimeout(() => { isUndoingRef.current = false }, 100)
  }

  function handleRestore(restoredState: AppState, snapshotName: string) {
    // Push current state to undo stack before restoring
    undoStackRef.current = [...undoStackRef.current.slice(-19), state]
    setCanUndo(true)
    isUndoingRef.current = true
    setState(migrateState({ ...restoredState }))
    setTimeout(() => { isUndoingRef.current = false }, 100)
    void saveSnapshot(leagueCode!, `[Auto] Before restoring "${snapshotName}"`, state, localUserRef.current)
  }

  function acceptRemoteUpdate() {
    if (!pendingRemote) return
    setState(pendingRemote.data)
    lastSyncedRef.current = stableStringify(pendingRemote.data)
    baseUpdatedAtRef.current = pendingRemote.updatedAt
    setLastUpdatedBy(pendingRemote.updatedBy)
    setLastUpdatedAt(pendingRemote.updatedAt)
    setSyncStatus('synced')
    setSyncError('')
    setPendingRemote(null)
  }

  function dismissRemoteUpdate() {
    // Mark the remote version as "seen" so the banner doesn't re-appear for the same version
    if (!pendingRemote) return
    lastSyncedRef.current = stableStringify(pendingRemote.data)
    // Adopting the remote version as our base is what makes Dismiss mean "keep
    // mine": the next save is allowed to write over their change. Without it the
    // server would 409 this tab forever with no way for the user to resolve it.
    baseUpdatedAtRef.current = pendingRemote.updatedAt
    setSyncStatus('synced')
    setSyncError('')
    setPendingRemote(null)
  }

  async function copyReadOnlyLink() {
    if (!leagueCode) return
    if (!viewTokenRef.current) {
      viewTokenRef.current = await getOrCreateViewToken(leagueCode)
    }
    if (!viewTokenRef.current) { alert('Could not generate share link — check your connection.'); return }
    const url = `${window.location.origin}${window.location.pathname}?token=${viewTokenRef.current}&view=readonly`
    try {
      await navigator.clipboard.writeText(url)
      setRoLinkCopied(true)
      setTimeout(() => setRoLinkCopied(false), 2500)
    } catch {
      alert('Could not copy to clipboard. Link: ' + url)
    }
  }

  const sc = getSportConfig(state.season.sport)
  // Indices are the app's only navigation truth (tour.ts, FirstRunChecklist and
  // mobileNav all address tabs by number), so 6 and 7 keep their slots even
  // though Calendar (5) now renders both — see RETIRED_TABS in mobileNav.ts.
  const TABS = ['Today', 'Season Settings', 'Divisions & Teams', sc.venuePlural, `${sc.officialPlural} / Staff`, 'Calendar', '—', '—', 'Auto-Schedule', 'Standings', 'Coaches']
  const trial = trialBanner(sub)
  const tourStep = getActiveStep(tourState, tab)
  const planLimits = sub
    ? { sportsLimit: sub.sports_limit, divisionsLimit: sub.divisions_limit, teamsLimit: sub.teams_limit, planTier: sub.plan_tier }
    : undefined
  const themeStyle = buildThemeVars(getTheme(state.season.theme))
  // A share-link viewer, as opposed to an owner whose plan lapsed. Only the former
  // should lose the admin chrome (league code, share link, setup tabs).
  const isViewer = readOnly && !expired
  // Only the owner may rotate the code, and only once we actually know who that
  // is — isLeagueOwner reads NULL-owner as "yours", which is also what an
  // unresolved fetch looks like. Not gated on the plan: a lapsed owner still
  // needs to be able to lock someone out.
  const canChangeCode = ownerResolved && isLeagueOwner

  // WAI-ARIA tabs keyboard support. The visual order is NAV_GROUPS' order, not
  // TABS' numeric order, so arrow keys must walk the flattened visible list —
  // moving by index would jump around the screen.
  function onTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    const order = NAV_GROUPS.flatMap(g => g.indices).filter(i => isTabVisible(i, isViewer))
    const pos = order.indexOf(tab)
    if (pos === -1) return
    let nextPos: number | null = null
    if (e.key === 'ArrowRight') nextPos = (pos + 1) % order.length
    else if (e.key === 'ArrowLeft') nextPos = (pos - 1 + order.length) % order.length
    else if (e.key === 'Home') nextPos = 0
    else if (e.key === 'End') nextPos = order.length - 1
    if (nextPos === null) return
    e.preventDefault()
    const nextTab = order[nextPos]
    setTab(nextTab)
    // Focus follows selection, per the tabs pattern.
    requestAnimationFrame(() => document.getElementById(`tab-${nextTab}`)?.focus())
  }

  if (!hydrated) {
    return (
      <div className="min-h-screen bg-[var(--fd-primary)] flex items-center justify-center">
        <p className="text-[var(--fd-primary-light)]">Loading…</p>
      </div>
    )
  }

  if (viewTokenError) {
    return (
      <div className="min-h-screen bg-[var(--fd-primary)] flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl p-8 max-w-sm w-full text-center space-y-4">
          <Icon name="link" className="w-8 h-8 mx-auto text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-800">Link not found</h2>
          <p className="text-sm text-gray-500">This view-only link is no longer valid. Ask the league admin to share a new link.</p>
          {/* Hard reload on purpose, NOT a missed <Link>: this screen renders at
              "/" with an invalid ?view=readonly&token=... still in the URL. A full
              navigation is what drops those params and reboots the app cleanly; a
              soft route change to the same path would not reliably clear them. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" className="inline-block mt-2 text-sm text-[var(--fd-primary)] underline hover:text-[var(--fd-primary-dark)]">Go to FieldDay Planner</a>
        </div>
      </div>
    )
  }

  if (!leagueCode) {
    // The bar belongs here too: a brand-new signup has no league yet, so this
    // screen — not the dashboard — is where they'd otherwise hear nothing about
    // the trial at all.
    return (
      <>
        {trial && <TrialBar banner={trial} />}
        <LeagueGate defaultState={DEFAULT} onJoin={handleJoin} />
      </>
    )
  }

  // A share-link viewer gets a purpose-built read surface instead of the admin
  // shell. Placed after the gates above so a bad token still shows "Link not
  // found" and an unhydrated page still shows the loader.
  //
  // An expired OWNER is not a viewer (isViewer = readOnly && !expired), so they
  // keep the admin shell and its amber renew banner — that split is deliberate.
  //
  // Consequence, accepted: the isViewer guards further down are now unreachable.
  // They remain correct and cost nothing; sweeping ~900 lines to delete them
  // would risk regressions for no user-visible benefit.
  if (isViewer) {
    return (
      <div style={themeStyle}>
        <CoachView state={state} viewToken={roTokenRef.current} lastUpdatedAt={lastUpdatedAt} />
      </div>
    )
  }

  const timeSince = lastUpdatedAt
    ? new Date(lastUpdatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''

  return (
    <div className="min-h-screen bg-gray-50" style={themeStyle}>
      <header className="bg-[var(--fd-primary)] text-white shadow-md">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4 sm:flex-wrap">
          {/* A league still on the placeholder name gets the title as a prompt.
              LeagueGate only started asking for a name recently, so most existing
              leagues are called "My League" and their admins never saw the field. */}
          {isUnnamedLeague(state.season) && !readOnly ? (
            <button
              onClick={() => setTab(1)}
              className="text-xl font-bold text-white/90 border-b-2 border-dashed border-white/40 hover:text-white hover:border-white/70 transition truncate min-w-0 sm:whitespace-normal sm:overflow-visible"
            >
              Name your league →
            </button>
          ) : (
            <h1 className="text-xl font-bold truncate min-w-0 sm:whitespace-normal sm:overflow-visible">{state.season.leagueName || 'FieldDay Planner'}</h1>
          )}

          <div className="hidden sm:flex items-center gap-3 flex-wrap">
            {/* Read-only badge */}
            {readOnly && (
              <span className="bg-yellow-400 text-yellow-900 text-xs font-bold px-2.5 py-1 rounded-full uppercase tracking-wide">
                {expired ? 'Read Only' : 'View Only'}
              </span>
            )}

            {/* League code badge — hidden from read-only viewers */}
            {!isViewer && (
              <div className="flex items-center gap-2 bg-[var(--fd-primary)] rounded-lg px-3 py-1.5">
                <span className="text-[var(--fd-primary-muted)] text-xs font-medium">LEAGUE</span>
                <span className="font-mono font-bold tracking-widest">{leagueCode}</span>
                <button onClick={copyCode} className="text-[var(--fd-primary-muted)] hover:text-white transition text-sm" title="Copy league code">
                  {codeCopied ? 'Copied' : 'Copy'}
                </button>
                {/* Where an owner discovers that the code can be changed at all.
                    Handing out the code is how people get edit access, so this is
                    the only way to take it back — and nobody was going to find it
                    buried on /account. It LINKS there rather than rotating here:
                    the action removes every collaborator at once, so it belongs
                    behind the explain-and-confirm panel, not one stray click away
                    from "Copy". Owners only — a collaborator following it would
                    find a page that does not list the league. */}
                {canChangeCode && (
                  <>
                    <span className="text-[var(--fd-primary-muted)] text-xs" aria-hidden="true">·</span>
                    <a
                      href="/account#leagues"
                      className="text-[var(--fd-primary-muted)] hover:text-white transition text-sm"
                      title="Change this league's code — the way to remove someone you gave it to"
                    >
                      Change
                    </a>
                  </>
                )}
              </div>
            )}

            {/* Undo button */}
            {!readOnly && (
              <button
                onClick={handleUndo}
                disabled={!canUndo}
                className="text-xs bg-[var(--fd-primary)] hover:bg-[var(--fd-primary-dark)] text-[var(--fd-primary-light)] hover:text-white border border-[var(--fd-primary-muted)] rounded-lg px-3 py-1.5 transition disabled:opacity-30 disabled:cursor-not-allowed"
                title="Undo last change"
              >
                Undo
              </button>
            )}

            {/* Snapshots button */}
            {!isViewer && (
              <button
                onClick={() => setShowSnapshots(true)}
                className="text-xs bg-[var(--fd-primary)] hover:bg-[var(--fd-primary-dark)] text-[var(--fd-primary-light)] hover:text-white border border-[var(--fd-primary-muted)] rounded-lg px-3 py-1.5 transition"
                title="Save or restore a schedule snapshot"
              >
                Snapshots
              </button>
            )}

            {/* Share read-only link (admins only) */}
            {!isViewer && (
              <button
                data-tour="share-link"
                onClick={copyReadOnlyLink}
                className="text-xs bg-[var(--fd-primary)] hover:bg-[var(--fd-primary-dark)] text-[var(--fd-primary-light)] hover:text-white border border-[var(--fd-primary-muted)] rounded-lg px-3 py-1.5 transition"
                title="Copy a view-only link for coaches/parents"
              >
                {roLinkCopied ? 'Copied!' : 'Share View-Only Link'}
              </button>
            )}

            {/* Prospect Card cross-app link */}
            {!isViewer && (
              <a
                href="https://www.getprospectcard.com"
                target="_blank"
                rel="noopener"
                className="text-xs bg-[var(--fd-primary)] hover:bg-[var(--fd-primary-dark)] text-[var(--fd-primary-light)] hover:text-white border border-[var(--fd-primary-muted)] rounded-lg px-3 py-1.5 transition"
                title="Prospect Card — player recruiting cards by Alfred Digital"
              >
                Prospect Card ↗
              </a>
            )}

            {/* Sync status */}
            {!readOnly && (
              <div className="text-xs">
                {syncStatus === 'saving' && <span className="text-[var(--fd-primary-light)] animate-pulse">Saving…</span>}
                {syncStatus === 'synced' && <span className="text-[var(--fd-primary-muted)]">Synced</span>}
                {syncStatus === 'error' && (
                  <span className="text-red-300" title={syncError}>
                    {syncError || 'Save failed — check connection'}
                  </span>
                )}
              </div>
            )}

            {/* User name + leave + account */}
            {!readOnly ? (
              <div className="flex items-center gap-2 text-sm text-[var(--fd-primary-light)]">
                <span>{userName}</span>
                {user && (
                  <a
                    href="/account"
                    className="text-[var(--fd-primary-light)] hover:text-white transition text-xs border border-[var(--fd-primary-muted)] rounded-lg px-2 py-0.5"
                    title="Account & billing"
                  >
                    Account
                  </a>
                )}
                {user ? (
                  <button
                    onClick={handleSignOut}
                    className="text-[var(--fd-primary-light)] hover:text-white transition text-xs border border-[var(--fd-primary-muted)] rounded-lg px-2 py-0.5"
                    title="Sign out"
                  >
                    Sign Out
                  </button>
                ) : (
                  <button
                    onClick={handleLeave}
                    className="text-[var(--fd-primary-light)] hover:text-white transition text-xs border border-[var(--fd-primary-muted)] rounded-lg px-2 py-0.5"
                    title="Leave this league"
                  >
                    Leave
                  </button>
                )}
              </div>
            ) : (
              <span className="text-xs text-[var(--fd-primary-muted)]">Live schedule — auto-updates every 30s</span>
            )}
          </div>

          {/* Mobile: share + kebab only. Everything else moved into the
              MobileNav sheets — the desktop cluster wraps to three lines on a
              390px screen. */}
          <div className="flex sm:hidden items-center gap-1">
            {readOnly && (
              <span className="bg-yellow-400 text-yellow-900 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide">
                {expired ? 'Read Only' : 'View Only'}
              </span>
            )}
            {!isViewer && (
              <button
                data-tour="share-link"
                onClick={copyReadOnlyLink}
                aria-label="Copy view-only link"
                className="w-11 h-11 flex items-center justify-center rounded-lg text-[var(--fd-primary-light)] hover:text-white transition"
              >
                <Icon name="link" className="w-5 h-5" />
              </button>
            )}
            {!isViewer && (
              <button
                onClick={() => setKebabOpen(true)}
                aria-label="More actions"
                aria-haspopup="dialog"
                className="w-11 h-11 flex items-center justify-center rounded-lg text-[var(--fd-primary-light)] hover:text-white transition"
              >
                <Icon name="dots" className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>

        {/* Last updated bar */}
        {lastUpdatedBy && (
          <div className="max-w-7xl mx-auto px-4 pb-2 text-xs text-[var(--fd-primary-muted)]">
            Last saved by <strong className="text-[var(--fd-primary-light)]">{lastUpdatedBy}</strong>
            {timeSince && <> · {timeSince}</>}
          </div>
        )}
      </header>

      {/* Remote update review banner */}
      {pendingRemote && (
        <div className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2 text-sm text-amber-800">
              <Icon name="refresh" className="w-4 h-4 shrink-0" />
              <span>
                <strong>{pendingRemote.updatedBy}</strong> updated this schedule.
                {pendingRemote.updatedAt && (
                  <> &middot; {new Date(pendingRemote.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={acceptRemoteUpdate}
                className="text-xs bg-amber-600 hover:bg-amber-700 text-white font-medium rounded-lg px-3 py-1.5 transition"
              >
                Load changes
              </button>
              <button
                onClick={dismissRemoteUpdate}
                className="text-xs text-amber-700 hover:text-amber-900 border border-amber-300 rounded-lg px-3 py-1.5 transition"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Trial status. Hidden from share-link viewers (a coach has no plan) and
          silent once the trial lapses — the amber banner below owns that state. */}
      {trial && !isViewer && <TrialBar banner={trial} />}

      {/* Expired plan — the app stays fully readable, editing is what stops.
          Coaches keep their view-only link working, which is the whole point:
          locking the admin out of a live schedule is what kills the renewal. */}
      {expired && (
        <div className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm text-amber-900">
              <span className="font-semibold">Your plan has expired.</span>{' '}
              Your league, schedule and share links all still work — you just can&apos;t make changes until you renew.
            </p>
            <a
              href="/pricing"
              className="shrink-0 text-xs font-semibold bg-amber-900 text-white rounded-lg px-3 py-2 hover:bg-amber-800 transition"
            >
              Renew plan →
            </a>
          </div>
        </div>
      )}

      {/* Tab nav — hide setup/admin tabs in read-only mode.
          Grouped into Overview / Schedule / League (NAV_GROUPS in mobileNav.ts)
          so the tabs read as clusters instead of one flat row; indices stay the
          ones the switch below and onNavigate() calls expect. */}
      <div className="hidden sm:block bg-white border-b shadow-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4">
          <nav className="flex overflow-x-auto" role="tablist" aria-label="Sections">
            {NAV_GROUPS.map((group, gi) => {
              const visible = group.indices.filter(i => isTabVisible(i, isViewer))
              if (visible.length === 0) return null
              return (
                <div key={group.label} className="flex items-stretch" role="presentation">
                  {gi > 0 && <span className="w-px my-2.5 bg-gray-200" />}
                  <div className="flex flex-col" role="presentation">
                    <span aria-hidden="true" className="px-5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 select-none whitespace-nowrap">
                      {group.label}
                    </span>
                    <div className="flex items-stretch" role="presentation">
                      {visible.map(i => (
                        <button
                          key={TABS[i]}
                          id={`tab-${i}`}
                          role="tab"
                          aria-selected={tab === i}
                          aria-controls="tab-panel"
                          tabIndex={tab === i ? 0 : -1}
                          onClick={() => setTab(i)}
                          onKeyDown={onTabKeyDown}
                          // The default focus ring draws a full rounded box that beats the
                          // border-b-2 active underline. focus-visible keeps the ring for
                          // keyboard users without painting it on every mouse click.
                          className={`px-5 pt-1 pb-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fd-primary)] ${
                            tab === i ? 'border-[var(--fd-primary)] text-[var(--fd-primary)]' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                          }`}
                        >
                          {TABS[i]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })}
          </nav>
        </div>
      </div>

      {/* pb-28: the fixed bottom bar is ~56px plus the home-indicator inset. */}
      <main className="max-w-7xl mx-auto px-4 py-6 pb-28 sm:pb-6">
        <div id="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === 0  && <DashboardTab state={state} setState={setState} readOnly={readOnly} onNavigate={setTab} />}
          {tab === 1  && <SetupTab state={state} setState={setState} planLimits={planLimits} sub={sub ?? undefined} isLeagueOwner={isLeagueOwner} />}
          {tab === 2  && <DivisionsTab state={state} setState={setState} planLimits={planLimits} isLeagueOwner={isLeagueOwner} />}
          {tab === 3  && <FieldsTab state={state} setState={setState} />}
          {tab === 4  && <UmpiresTab state={state} setState={setState} />}
          {tab === 5  && <CalendarTab state={state} setState={setState} readOnly={readOnly} />}
          {tab === 8  && <AutoScheduleTab state={state} setState={setState} leagueCode={leagueCode} userName={userName} />}
          {tab === 9  && <StandingsTab state={state} readOnly={readOnly} />}
          {tab === 10 && <CoachesTab state={state} readOnly={readOnly} />}
        </div>
      </main>

      {showSnapshots && leagueCode && (
        <SnapshotModal
          leagueCode={leagueCode}
          userName={userName}
          currentState={state}
          onRestore={handleRestore}
          onClose={() => setShowSnapshots(false)}
        />
      )}

      {showWelcome && (
        <TourWelcomeModal onAccept={acceptTour} onDecline={declineTour} />
      )}
      {tourStep && (
        <TourOverlay
          step={tourStep}
          stepNumber={tourStep.step}
          totalSteps={TOTAL_STEPS}
          onNext={advanceTourStep}
          onDismiss={dismissTour}
        />
      )}
      {!isViewer && <HelpButton onStartTour={startTour} hidden={tourStep !== null || showSnapshots} />}

      <MobileNav
        tab={tab}
        setTab={setTab}
        tabLabels={TABS}
        navOrder={NAV_GROUPS.flatMap(g => g.indices)}
        isViewer={isViewer}
        canChangeCode={canChangeCode}
        leagueCode={leagueCode}
        onCopyCode={copyCode}
        codeCopied={codeCopied}
        syncStatus={syncStatus}
        syncError={syncError}
        canUndo={canUndo}
        onUndo={handleUndo}
        onSnapshots={() => setShowSnapshots(true)}
        onSignOut={handleSignOut}
        onLeave={handleLeave}
        isSignedIn={!!user}
        readOnly={readOnly}
        kebabOpen={kebabOpen}
        onKebabChange={setKebabOpen}
      />
    </div>
  )
}
