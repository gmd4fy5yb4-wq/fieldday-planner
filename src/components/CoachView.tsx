'use client'
import { useState, useEffect, useMemo, useRef } from 'react'
import type { AppState, ScheduledGame, ScheduledPractice } from '@/lib/types'
import { teamOptions, upcomingFor, upcomingLeagueWide, nextGameFor, isTeamEvent, type CoachEvent } from '@/lib/coachView'
import type { ScheduledItem, ScheduledSpecialEvent } from '@/lib/types'
import { fetchDailyWeather, weatherEmoji, weatherDesc, type DayWeather } from '@/lib/weather'
import { getDivisionColor } from '@/lib/divisionColors'
import StandingsTab from './StandingsTab'
import Icon from './Icon'

interface CoachViewProps {
  state: AppState
  viewToken: string | null
  lastUpdatedAt: string
}

type Panel = 'next' | 'schedule' | 'standings'

function fmtTime(t: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${m.toString().padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}
function fmtDay(d: string) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}
function nowKey() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function CoachView({ state, viewToken, lastUpdatedAt }: CoachViewProps) {
  const [panel, setPanel] = useState<Panel>('next')
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  // Escape closes the picker, matching MobileNav's sheets. Guarded on
  // pickerOpen (rather than hooked inside the conditional JSX below) so the
  // hook itself is always called — only its behavior varies.
  useEffect(() => {
    if (!pickerOpen) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setPickerOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pickerOpen])

  // Move focus into the picker on open, and restore it to the opener on
  // close. Same unconditional-hook / guarded-body shape as above.
  useEffect(() => {
    if (!pickerOpen) return
    const opener = document.activeElement as HTMLElement | null
    pickerRef.current?.focus()
    return () => {
      opener?.focus?.()
    }
  }, [pickerOpen])

  function onPickerKeyDownTrap(e: React.KeyboardEvent) {
    if (e.key !== 'Tab') return
    const focusables = pickerRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    if (!focusables || focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const onContainer = document.activeElement === pickerRef.current
    if (e.shiftKey && (onContainer || document.activeElement === first)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && onContainer) { e.preventDefault(); first.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  // Keyed by view token on purpose: a parent with children in two leagues
  // follows two different share links, and a bare key would make one league's
  // choice clobber the other's. Lazy initializer — a bare read would run
  // during server rendering and crash.
  const storageKey = `fd-coach-team:${viewToken ?? 'unknown'}`
  const [myTeamId, setMyTeamId] = useState<string | null>(
    () => (typeof window === 'undefined' ? null : window.localStorage.getItem(storageKey))
  )

  const teams = useMemo(() => teamOptions(state), [state])

  // A team that has since been deleted from the league is treated as no
  // selection, and the stale key is cleared.
  useEffect(() => {
    if (myTeamId && !teams.some(t => t.id === myTeamId)) {
      setMyTeamId(null)
      window.localStorage.removeItem(storageKey)
    }
  }, [myTeamId, teams, storageKey])

  function chooseTeam(id: string | null) {
    setMyTeamId(id)
    if (id) window.localStorage.setItem(storageKey, id)
    else window.localStorage.removeItem(storageKey)
    setPickerOpen(false)
  }

  const myTeam = teams.find(t => t.id === myTeamId) ?? null
  const now = nowKey()
  const next = useMemo(() => nextGameFor(state, myTeamId, now), [state, myTeamId, now])
  const upcoming = useMemo(() => upcomingFor(state, myTeamId, now, 6).slice(1), [state, myTeamId, now])
  const wholeLeague = useMemo(() => upcomingLeagueWide(state, now, 200), [state, now])

  const fieldMap = useMemo(() => new Map(state.fields.map(f => [f.id, f])), [state.fields])
  const teamMap = useMemo(() => new Map(teams.map(t => [t.id, t])), [teams])

  // Weather for the next event only, from the field's already-cached coords.
  // DashboardTab's geocode proxy + cache is deliberately not replicated here.
  const [wx, setWx] = useState<DayWeather | undefined>()
  const nextField = next ? fieldMap.get(next.fieldId) : undefined
  const coords = nextField?.geocoords
  useEffect(() => {
    if (!next || !coords) { setWx(undefined); return }
    let cancelled = false
    fetchDailyWeather(coords.lat, coords.lon)
      .then(map => { if (!cancelled) setWx(map.get(next.date)) })
      .catch(() => { if (!cancelled) setWx(undefined) })
    return () => { cancelled = true }
    // `next` and `coords` are fresh object references on every poll-driven
    // `setState` (page.tsx polls every 30s and replaces `state` wholesale),
    // even when nothing about the next event actually changed. Depending on
    // the primitives the effect actually reads avoids refetching weather on
    // unrelated league edits. The rule wants `next` and `coords` themselves;
    // adding them would refetch the weather every 30s forever, so this is a
    // deliberate deviation rather than an oversight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next?.id, next?.date, coords?.lat, coords?.lon])

  function eventTitle(e: CoachEvent): string {
    if (e.type === 'game') {
      const g = e as ScheduledGame
      return `${teamMap.get(g.homeTeamId)?.name ?? 'TBD'} vs ${teamMap.get(g.awayTeamId)?.name ?? 'TBD'}`
    }
    return `${teamMap.get((e as ScheduledPractice).teamId)?.name ?? 'TBD'} practice`
  }
  function scheduleItemTitle(e: ScheduledItem): string {
    if (e.type === 'special') return (e as ScheduledSpecialEvent).name
    return eventTitle(e as CoachEvent)
  }
  function directionsUrl(fieldId: string): string | null {
    const f = fieldMap.get(fieldId)
    if (!f) return null
    if (f.geocoords) return `https://www.google.com/maps/search/?api=1&query=${f.geocoords.lat},${f.geocoords.lon}`
    if (f.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(f.address)}`
    return null
  }

  const TABS: { id: Panel; label: string; icon: 'home' | 'calendar' | 'chart' }[] = [
    { id: 'next', label: 'Next', icon: 'home' },
    { id: 'schedule', label: 'Schedule', icon: 'calendar' },
    { id: 'standings', label: 'Standings', icon: 'chart' },
  ]

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* ── Header ── */}
      <header className="bg-[var(--fd-primary)] text-white">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <h1 className="text-lg sm:text-xl font-bold truncate min-w-0">
            {state.season.leagueName || 'FieldDay Planner'}
          </h1>
          <span className="shrink-0 flex items-center gap-1.5 bg-white/10 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide">
            <span className="w-2 h-2 rounded-full bg-green-400" />
            Live
          </span>
        </div>
        <div className="max-w-3xl mx-auto px-4 pb-3">
          <button
            onClick={() => setPickerOpen(true)}
            className="min-h-[44px] w-full sm:w-auto flex items-center justify-between sm:justify-start gap-2 bg-white/10 hover:bg-white/15 rounded-lg px-3 text-sm font-medium transition"
          >
            {myTeam ? (
              <>
                <span className="truncate">{myTeam.name}</span>
                <span className="text-[var(--fd-primary-light)] text-xs shrink-0">change</span>
              </>
            ) : (
              <span>Pick your team →</span>
            )}
          </button>
        </div>
      </header>

      {/* ── Desktop tabs ── */}
      <nav aria-label="Sections" className="hidden sm:block bg-white border-b sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 flex">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setPanel(t.id)}
              aria-current={panel === t.id ? 'page' : undefined}
              className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fd-accent)] ${
                panel === t.id ? 'border-[var(--fd-accent)] text-[var(--fd-accent)]' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-5 pb-28 sm:pb-8 space-y-4">
        {panel === 'next' && (
          <>
            {!myTeamId && (
              <div className="bg-white rounded-xl border p-6 text-center space-y-3">
                <p className="text-base font-semibold text-gray-800">Whose schedule matters to you?</p>
                <p className="text-sm text-gray-500">We&apos;ll remember on this device — no account needed.</p>
                <button
                  onClick={() => setPickerOpen(true)}
                  className="min-h-[44px] px-5 rounded-lg bg-[var(--fd-primary)] text-white text-sm font-semibold"
                >
                  Pick your team
                </button>
              </div>
            )}

            {myTeamId && !next && (
              <div className="bg-white rounded-xl border p-6 text-center">
                <p className="text-sm text-gray-500">No upcoming games for {myTeam?.name}.</p>
              </div>
            )}

            {myTeamId && next && (
              <section className="bg-[var(--fd-primary)] text-white rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--fd-primary-light)]">
                    {fmtDay(next.date)} · {fmtTime(next.time)}
                  </span>
                  {wx && (
                    <span className="shrink-0 flex items-center gap-1.5 text-sm">
                      <span role="img" aria-label={weatherDesc(wx.weatherCode)}>{weatherEmoji(wx.weatherCode)}</span>
                      <span className="font-bold">{wx.tempHigh}°</span>
                      <span className="text-[var(--fd-primary-light)]">/ {wx.tempLow}°</span>
                    </span>
                  )}
                </div>
                <h2 className="text-xl font-bold leading-tight">{eventTitle(next)}</h2>
                {fieldMap.get(next.fieldId) && (
                  <p className="text-sm text-[var(--fd-primary-light)]">
                    {fieldMap.get(next.fieldId)!.name}
                    {fieldMap.get(next.fieldId)!.location ? ` · ${fieldMap.get(next.fieldId)!.location}` : ''}
                  </p>
                )}
                {directionsUrl(next.fieldId) && (
                  <a
                    href={directionsUrl(next.fieldId)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[44px] w-full flex items-center justify-center rounded-lg bg-white text-[var(--fd-primary)] text-sm font-semibold"
                  >
                    Directions
                  </a>
                )}
              </section>
            )}

            {myTeamId && upcoming.length > 0 && (
              <section className="bg-white rounded-xl border divide-y">
                <h3 className="px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-gray-500">Then</h3>
                {upcoming.map(e => (
                  <div key={e.id} className="px-4 py-3 flex items-start gap-3">
                    <span className="w-24 shrink-0 text-xs font-semibold text-gray-500 pt-0.5">{fmtDay(e.date)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-gray-900 truncate">{eventTitle(e)}</span>
                      <span className="block text-xs text-gray-500">{fmtTime(e.time)}{fieldMap.get(e.fieldId) ? ` · ${fieldMap.get(e.fieldId)!.name}` : ''}</span>
                    </span>
                  </div>
                ))}
              </section>
            )}
          </>
        )}

        {panel === 'schedule' && (
          /* overflow-clip, not overflow-hidden: -hidden makes this card the date
             headers' scroll box, so they never stuck to the page and the desktop
             sm:top-12 (clearing the sticky tab bar) pushed each header 48px down
             onto its first game. -clip still rounds the corners. */
          <section className="bg-white rounded-xl border overflow-clip">
            {wholeLeague.length === 0 && (
              <p className="px-4 py-10 text-center text-sm text-gray-500 italic">No upcoming events.</p>
            )}
            {(() => {
              const groups: { date: string; items: ScheduledItem[] }[] = []
              for (const e of wholeLeague) {
                const last = groups[groups.length - 1]
                if (last && last.date === e.date) last.items.push(e)
                else groups.push({ date: e.date, items: [e] })
              }
              return groups.map(g => (
                <div key={g.date}>
                  <h3 className="sticky top-0 sm:top-12 z-[1] bg-gray-50 border-y px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-gray-500">
                    {fmtDay(g.date)}
                  </h3>
                  {g.items.map(e => {
                    const isSpecial = e.type === 'special'
                    const mine = !isSpecial && myTeamId ? isTeamEvent(e, myTeamId) : false
                    const c = !isSpecial ? getDivisionColor(e.divisionId, state.divisions) : null
                    const subLine = isSpecial
                      ? ((e as ScheduledSpecialEvent).location ?? '')
                      : (fieldMap.get((e as CoachEvent).fieldId)?.name ?? '')
                    return (
                      <div key={e.id} className={`px-4 py-3 flex items-start gap-3 border-b last:border-0 ${mine ? 'bg-[#f9f9fd]' : ''}`}>
                        <span className="w-16 shrink-0 text-sm font-semibold text-gray-800 pt-0.5">{fmtTime(e.time)}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-gray-900 truncate">{scheduleItemTitle(e)}</span>
                          <span className="block text-xs text-gray-500 truncate">{subLine}</span>
                        </span>
                        {mine && (
                          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide bg-[var(--fd-accent)] text-white rounded px-1.5 py-0.5">
                            Yours
                          </span>
                        )}
                        {isSpecial && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium bg-gray-100 text-gray-600">
                            League
                          </span>
                        )}
                        {!isSpecial && !mine && (
                          <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${c!.pill}`}>
                            {state.divisions.find(d => d.id === (e as CoachEvent).divisionId)?.name ?? ''}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              ))
            })()}
          </section>
        )}

        {panel === 'standings' && (
          <>
            <StandingsTab state={state} readOnly highlightTeamId={myTeamId ?? undefined} />
            {lastUpdatedAt && (
              <p className="text-xs text-center text-gray-500">
                Updated {new Date(lastUpdatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · auto-refreshes
              </p>
            )}
          </>
        )}

        {/* The acquisition loop: every coach and parent who opens this link is a
            future league admin. /pricing is public and trial-first; linking to
            "/" would bounce a signed-out visitor to /login. */}
        <footer className="pt-2 text-center">
          <a href="/pricing" className="text-xs text-gray-500 hover:text-[var(--fd-primary)] underline underline-offset-2">
            Powered by FieldDay Planner — run your own league free
          </a>
        </footer>
      </main>

      {/* ── Mobile bottom tabs ── */}
      <nav aria-label="Sections" className="sm:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t flex pb-[env(safe-area-inset-bottom)]">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setPanel(t.id)}
            aria-current={panel === t.id ? 'page' : undefined}
            className={`flex-1 min-h-[56px] flex flex-col items-center justify-center gap-1 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fd-accent)] ${
              panel === t.id ? 'text-[var(--fd-accent)]' : 'text-gray-500'
            }`}
          >
            <Icon name={t.icon} className="w-6 h-6" />
            {t.label}
          </button>
        ))}
      </nav>

      {/* ── Team picker ── */}
      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center animate-backdrop-in sm:p-4"
          onClick={() => setPickerOpen(false)}
        >
          <div
            ref={pickerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Choose your team"
            tabIndex={-1}
            onKeyDown={onPickerKeyDownTrap}
            className="w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl max-h-[85vh] overflow-y-auto animate-sheet-up sm:animate-none pb-[env(safe-area-inset-bottom)] sm:pb-0"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-4 pt-4 pb-2">
              <h2 className="text-base font-bold text-gray-900">Whose schedule matters to you?</h2>
              <p className="text-sm text-gray-500 mt-0.5">We&apos;ll remember on this device — no account needed.</p>
            </div>
            {state.divisions.map(d => (
              d.teams.length > 0 && (
                <div key={d.id}>
                  <h3 className="px-4 py-1.5 bg-gray-50 border-y text-xs font-bold uppercase tracking-wider text-gray-500">{d.name}</h3>
                  {d.teams.map(t => (
                    <button
                      key={t.id}
                      onClick={() => chooseTeam(t.id)}
                      className="w-full min-h-[52px] px-4 flex items-center justify-between text-left text-[15px] text-gray-800 border-b last:border-0 active:bg-gray-50"
                    >
                      {t.name}
                      {t.id === myTeamId && <span className="text-xs font-semibold text-[var(--fd-accent)]">Selected</span>}
                    </button>
                  ))}
                </div>
              )
            ))}
            <button
              onClick={() => chooseTeam(null)}
              className="w-full min-h-[52px] px-4 flex items-center text-left text-[15px] font-medium text-gray-600 border-t"
            >
              Show the whole league
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
