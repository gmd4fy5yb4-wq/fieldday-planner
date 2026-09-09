'use client'
import { useEffect, useRef, useState } from 'react'
import Icon, { type IconName } from './Icon'
import { BOTTOM_TABS, moreTabs } from '@/lib/mobileNav'

interface MobileNavProps {
  tab: number
  setTab: (i: number) => void
  tabLabels: string[]
  navOrder: number[]
  isViewer: boolean
  /** Owner-only: whether to surface "change the code" as an option at all. */
  canChangeCode: boolean
  leagueCode: string
  onCopyCode: () => void
  codeCopied: boolean
  syncStatus: 'idle' | 'saving' | 'synced' | 'error'
  /** Server's reason for the last failure; falls back to the generic line. */
  syncError?: string
  canUndo: boolean
  onUndo: () => void
  onSnapshots: () => void
  onSignOut: () => void
  onLeave: () => void
  isSignedIn: boolean
  readOnly: boolean
  kebabOpen: boolean
  onKebabChange: (open: boolean) => void
}

/**
 * Bottom sheet primitive. Local to this file — the two sheets below are its
 * only consumers, and a shared component with one shape and two callers is
 * an abstraction that has not earned itself yet.
 */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Escape closes, and the body under the sheet must not scroll behind it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    // Move focus into the sheet so the next Tab stays inside it.
    panelRef.current?.focus()
    return () => {
      // Return focus to whatever opened the sheet.
      opener?.focus?.()
    }
  }, [])

  function onKeyDownTrap(e: React.KeyboardEvent) {
    if (e.key !== 'Tab') return
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    if (!focusables || focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const onContainer = document.activeElement === panelRef.current
    if (e.shiftKey && (onContainer || document.activeElement === first)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && onContainer) { e.preventDefault(); first.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  // The sheet is `sm:hidden` — visually gone at >=640px but still mounted,
  // so the scroll-lock effect above never cleans up. Close it on the
  // desktop breakpoint crossing so overflow:hidden can't outlive the sheet
  // (e.g. tablet portrait -> landscape rotation with More open).
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 640px)')
    function onChange(e: MediaQueryListEvent) { if (e.matches) onClose() }
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-end animate-backdrop-in sm:hidden"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDownTrap}
        className="w-full bg-white rounded-t-2xl max-h-[85vh] overflow-y-auto animate-sheet-up pb-[env(safe-area-inset-bottom)]"
        onClick={e => e.stopPropagation()}
      >
        {/* Grabber — the affordance that says "this drags", even though it doesn't yet.
            ponytail: visual only; add real drag-to-dismiss when someone asks. */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-gray-300" />
        </div>
        <div className="px-4 pb-2 flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-900">{title}</h2>
          <button
            onClick={onClose}
            className="min-w-[44px] min-h-[44px] -mr-2 flex items-center justify-center text-sm font-medium text-gray-500 hover:text-gray-800"
          >
            Done
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** A full-width row in a sheet. 44px minimum, chevron for navigation rows. */
function SheetRow({ label, onClick, chevron = false, disabled = false }: {
  label: string; onClick: () => void; chevron?: boolean; disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full min-h-[52px] px-4 flex items-center justify-between text-left text-[15px] text-gray-800 border-t border-gray-100 active:bg-gray-50 disabled:opacity-40"
    >
      <span>{label}</span>
      {chevron && <span aria-hidden="true" className="text-gray-300 text-lg leading-none">›</span>}
    </button>
  )
}

const BAR_ICONS: Record<number, IconName> = { 0: 'home', 5: 'calendar', 9: 'chart' }
const BAR_LABELS: Record<number, string> = { 0: 'Today', 5: 'Calendar', 9: 'Standings' }

export default function MobileNav(props: MobileNavProps) {
  const {
    tab, setTab, tabLabels, navOrder, isViewer, canChangeCode, leagueCode, onCopyCode, codeCopied,
    syncStatus, syncError, canUndo, onUndo, onSnapshots, onSignOut, onLeave, isSignedIn, readOnly,
    kebabOpen, onKebabChange,
  } = props

  // The More sheet's state lives here; the kebab's lives in page.tsx because the
  // header owns the ⋯ button. Deriving one `sheet` value from both is what keeps
  // them from ever stacking.
  const [moreOpen, setMoreOpen] = useState(false)
  const sheet: 'more' | 'kebab' | null = moreOpen ? 'more' : kebabOpen ? 'kebab' : null
  function setSheet(s: 'more' | 'kebab' | null) {
    setMoreOpen(s === 'more')
    onKebabChange(s === 'kebab')
  }

  const more = moreTabs(navOrder, isViewer)
  const moreActive = more.includes(tab)

  return (
    <>
      {/* ── Bottom bar ── */}
      <nav
        aria-label="Main"
        className="sm:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-gray-200 flex pb-[env(safe-area-inset-bottom)]"
      >
        {BOTTOM_TABS.map(i => {
          const active = tab === i
          return (
            <button
              key={i}
              onClick={() => { setTab(i); setSheet(null) }}
              aria-current={active ? 'page' : undefined}
              className={`flex-1 min-h-[56px] flex flex-col items-center justify-center gap-1 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fd-accent)] ${
                active ? 'text-[var(--fd-accent)]' : 'text-gray-500'
              }`}
            >
              <Icon name={BAR_ICONS[i]} className="w-6 h-6" />
              {BAR_LABELS[i]}
            </button>
          )
        })}
        <button
          onClick={() => setSheet(sheet === 'more' ? null : 'more')}
          aria-expanded={sheet === 'more'}
          aria-haspopup="dialog"
          className={`flex-1 min-h-[56px] flex flex-col items-center justify-center gap-1 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fd-accent)] ${
            sheet === 'more' || moreActive ? 'text-[var(--fd-accent)]' : 'text-gray-500'
          }`}
        >
          <Icon name="menu" className="w-6 h-6" />
          More
        </button>
      </nav>

      {/* ── More sheet: every tab the bar does not show ── */}
      {sheet === 'more' && (
        <Sheet title="More" onClose={() => setSheet(null)}>
          <div className="pb-4">
            {more.map(i => (
              <SheetRow
                key={i}
                label={tabLabels[i]}
                chevron
                onClick={() => { setTab(i); setSheet(null) }}
              />
            ))}

            {!isViewer && (
              <div className="border-t border-gray-100 mt-2 pt-4 px-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">League</span>
                  <button
                    onClick={onCopyCode}
                    className="min-h-[44px] flex items-center gap-2 font-mono font-bold tracking-widest text-gray-800"
                  >
                    {leagueCode}
                    <span className="font-sans text-xs font-medium text-[var(--fd-accent)] tracking-normal">
                      {codeCopied ? 'Copied' : 'Copy'}
                    </span>
                  </button>
                </div>
                {/* The mobile half of the same discovery problem: an owner who
                    hands the code to the wrong person has to learn somewhere
                    that it can be changed. Links to /account, where the
                    confirmation panel explains what rotating actually does. */}
                {canChangeCode && (
                  <a
                    href="/account#leagues"
                    className="flex items-center text-xs text-[var(--fd-accent)] min-h-[44px]"
                  >
                    Change this code to remove someone&rsquo;s access →
                  </a>
                )}
                {!readOnly && (
                  <p className="text-xs text-gray-500">
                    {syncStatus === 'saving' ? 'Saving…'
                      : syncStatus === 'error' ? (syncError || 'Save failed — check connection')
                      : 'Synced'}
                  </p>
                )}
              </div>
            )}
          </div>
        </Sheet>
      )}

      {/* ── Kebab sheet: admin actions lifted out of the header ── */}
      {sheet === 'kebab' && (
        <Sheet title="Actions" onClose={() => setSheet(null)}>
          <div className="pb-4">
            {!readOnly && (
              <SheetRow label="Undo last change" disabled={!canUndo} onClick={() => { onUndo(); setSheet(null) }} />
            )}
            {!isViewer && (
              <SheetRow label="Snapshots" onClick={() => { onSnapshots(); setSheet(null) }} />
            )}
            {!readOnly && isSignedIn && (
              <a
                href="/account"
                className="w-full min-h-[52px] px-4 flex items-center text-[15px] text-gray-800 border-t border-gray-100 active:bg-gray-50"
              >
                Account &amp; billing
              </a>
            )}
            {!isViewer && (
              <a
                href="https://www.getprospectcard.com"
                target="_blank"
                rel="noopener"
                className="w-full min-h-[52px] px-4 flex items-center text-[15px] text-gray-800 border-t border-gray-100 active:bg-gray-50"
              >
                Prospect Card ↗
              </a>
            )}
            {!readOnly && (
              <SheetRow
                label={isSignedIn ? 'Sign out' : 'Leave this league'}
                onClick={() => { isSignedIn ? onSignOut() : onLeave(); setSheet(null) }}
              />
            )}
          </div>
        </Sheet>
      )}
    </>
  )
}
