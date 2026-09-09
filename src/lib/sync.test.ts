// Standalone assert-based check (no framework). Run: npx tsx src/lib/sync.test.ts
// Guards the network-failure contracts: fetch() THROWING (connection drop, tab
// closing mid-request) must produce the same failure returns as a bad status,
// never an unhandled rejection. This was FIELDDAY-PLANNER-2 in Sentry.
import assert from 'node:assert'
import { saveLeague, createLeague, getOrCreateViewToken, loadLeagueByViewToken } from './sync'
import type { AppState } from './types'

const state = {} as AppState

async function main() {
  globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'))

  const save = await saveLeague('ABC123', state, 'Greg')
  assert.strictEqual(save.success, false)
  assert.ok(save.error?.includes('Network error'))

  const create = await createLeague(state, 'Greg')
  assert.ok('error' in create && create.error.includes('Network error'))

  assert.strictEqual(await getOrCreateViewToken('ABC123'), null)
  assert.strictEqual(await loadLeagueByViewToken('tok'), null)

  // A non-JSON error response (HTML 500 page) must not throw either
  globalThis.fetch = () =>
    Promise.resolve(new Response('<html>oops</html>', { status: 500 }))
  const save500 = await saveLeague('ABC123', state, 'Greg')
  assert.strictEqual(save500.success, false)

  // ── Save conflicts (optimistic concurrency) ────────────────────────────────
  // The server refuses a save whose baseUpdatedAt no longer matches the row, so
  // a stale tab cannot overwrite everyone else's work. These assertions guard
  // the client half of that contract: the base is transmitted, a 409 is reported
  // as a conflict rather than a generic failure, and a win returns the new
  // version to save against next time.
  let sent: Record<string, unknown> = {}
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string)
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, updatedAt: '2026-09-09T18:00:00.000+00:00' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    )
  }) as typeof fetch

  const ok = await saveLeague('ABC123', state, 'Greg', '2026-09-09T17:00:00.000+00:00')
  assert.strictEqual(ok.success, true)
  assert.strictEqual(sent.baseUpdatedAt, '2026-09-09T17:00:00.000+00:00', 'base must reach the server')
  assert.strictEqual(ok.updatedAt, '2026-09-09T18:00:00.000+00:00', 'new version must come back')

  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: 'Someone else saved this league.', conflict: true }), {
        status: 409, headers: { 'Content-Type': 'application/json' },
      })
    )
  const clash = await saveLeague('ABC123', state, 'Greg', 'stale')
  assert.strictEqual(clash.success, false)
  assert.strictEqual(clash.conflict, true, '409 must be reported as a conflict, not a network blip')
  assert.ok(clash.error?.includes('Someone else'), 'the server reason must survive to the UI')

  // A plain failure must NOT look like a conflict — the app would show the merge
  // banner for an expired plan, which no amount of merging can fix.
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: 'Your plan has expired.' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      })
    )
  const denied = await saveLeague('ABC123', state, 'Greg', 'whatever')
  assert.strictEqual(denied.success, false)
  assert.ok(!denied.conflict, '403 is not a conflict')
  assert.ok(denied.error?.includes('expired'))

  console.log('sync.test.ts: all assertions passed')
}

main()
