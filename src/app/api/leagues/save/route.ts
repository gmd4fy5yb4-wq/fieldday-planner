import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseServer, getSupabaseServiceRole } from '@/lib/supabase-server'
import { saveGate } from '@/lib/plans'
import { shouldStartTrialClock } from '@/lib/trial'
import { getSports } from '@/lib/sports'
import type { AppState } from '@/lib/types'

const schema = z.object({
  code: z.string().length(6),
  state: z.unknown().refine(v => JSON.stringify(v).length < 500_000, 'State too large'),
  userName: z.string().min(1).max(100).trim(),
  // The `updated_at` the client last saw. Its save only lands if the row still
  // carries that value — see the conditional UPDATE below. Deliberately a loose
  // string, not z.string().datetime(): PostgREST returns an offset ("+00:00")
  // that Zod's datetime() rejects by default, and a validation error here would
  // turn every save into a 422.
  baseUpdatedAt: z.string().min(1).max(64).optional(),
})

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseServer()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const parsed = schema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 422 })
  }

  const code = parsed.data.code.toUpperCase()
  const state = parsed.data.state as unknown as AppState
  const serviceSupabase = getSupabaseServiceRole()

  const SUB_COLS = 'sports_limit, divisions_limit, teams_limit, plan_tier, trial_started_at, subscription_status, subscription_end'

  // Fetch league ownership + the saver's subscription in parallel (independent).
  // The league code is the shared access credential — any authenticated user who
  // knows the code can save.
  const [{ data: league }, { data: sub }] = await Promise.all([
    // `prev_generated` is a JSON-path projection, NOT the blob — it reads
    // data->schedule->>generatedAt server-side so the trial-clock check can
    // detect the first generation without transferring the whole season.
    serviceSupabase
      .from('leagues')
      .select('owner_id, updated_at, prev_generated:data->schedule->>generatedAt')
      .eq('id', code)
      .single(),
    serviceSupabase.from('user_subscriptions').select(SUB_COLS).eq('user_id', session.user.id).single(),
  ])

  // A league belongs to its owner, and the owner's plan is what pays for it — so a
  // collaborator's write is gated by the OWNER's plan, not their own. One extra
  // query, and only on the collaborator path.
  const ownerId = league?.owner_id as string | null | undefined
  const isOwnLeague = !ownerId || ownerId === session.user.id
  let ownerSub = null
  if (!isOwnLeague) {
    const { data } = await serviceSupabase
      .from('user_subscriptions').select(SUB_COLS).eq('user_id', ownerId).single()
    ownerSub = data
  }

  // Expiry is no longer enforced by a middleware redirect (lapsed users get a
  // read-only app instead of a /pricing wall), so the write gate lives here —
  // without it an expired user could still POST straight to this route.
  // A NULL subscription_end = no expiry (unlimited testers, unstarted trials).
  const gate = saveGate({
    ownerId,
    savingUserId: session.user.id,
    savingUserSub: sub,
    ownerSub,
    sportCount: getSports(state.season).length,
    divisions: state.divisions ?? [],
  })

  if (!gate.allowed) {
    if (gate.expired) {
      // Say whose plan lapsed. Telling a collaborator "your plan has expired"
      // when it is the league owner's would send them to /pricing to fix
      // something buying a plan cannot fix.
      return NextResponse.json(
        {
          error: gate.blockedBy === 'owner'
            ? 'The owner of this league has an expired plan, so it is read-only. Ask them to renew — the league stays exactly as it is.'
            : 'Your plan has expired. Renew to make changes — your league stays exactly as it is.',
          expired: true,
        },
        { status: 403 }
      )
    }
    return NextResponse.json(
      { error: gate.reason, limitType: gate.limitType },
      { status: 403 }
    )
  }

  // ── The write, guarded against overwriting somebody else's save ──────────────
  //
  // This route used to `upsert` the whole blob unconditionally: last writer wins,
  // full stop. Every editor holds a complete copy of the league in memory, so a
  // tab that loaded an hour ago would happily post its hour-old season over
  // everything saved since — no error, no warning, "Synced" in the corner.
  //
  // It is not a rare race. YWWM8G lost 6 games on 2026-09-08 between 18:53 and
  // 21:50 that way, with three people editing and one of them holding four live
  // sessions at once. The 2026-04-19 "cross-tab sync" fix guarded the other
  // direction only (the poll overwriting local edits), which is why this survived
  // it.
  //
  // So: only overwrite the exact version the client loaded. `updated_at` is the
  // version token — Postgres re-checks the WHERE against the locked row, so two
  // simultaneous saves cannot both match. A mismatch means somebody saved first;
  // refuse with 409 and let the client show its review banner rather than
  // silently winning.
  const now = new Date().toISOString()
  const row = {
    data: state,
    updated_at: now,
    updated_by: parsed.data.userName,
    // Claim ownership on first save if the league is unclaimed
    ...(!league?.owner_id ? { owner_id: session.user.id } : {}),
  }

  if (!league) {
    const { error: insertError } = await serviceSupabase.from('leagues').insert({ id: code, ...row })
    if (insertError) {
      return NextResponse.json({ error: 'Failed to save league.' }, { status: 500 })
    }
  } else {
    let write = serviceSupabase.from('leagues').update(row).eq('id', code)
    // ponytail: an absent baseUpdatedAt writes unconditionally, exactly as before.
    // Browsers holding the pre-fix bundle keep working through the rollout instead
    // of having every save refused. Once nobody is on the old bundle this can
    // become mandatory — a missing base would then be a 422.
    if (parsed.data.baseUpdatedAt) write = write.eq('updated_at', parsed.data.baseUpdatedAt)

    const { data: written, error: updateError } = await write.select('id').maybeSingle()
    if (updateError) {
      return NextResponse.json({ error: 'Failed to save league.' }, { status: 500 })
    }
    if (!written) {
      // Zero rows matched: the row moved under us. Nothing was written.
      return NextResponse.json(
        {
          error: 'Someone else saved this league while you were editing. Load their changes, then reapply yours.',
          conflict: true,
        },
        { status: 409 }
      )
    }
  }

  // Trial clock (migration fd_014): the 14 days start the first time a trial user
  // generates a schedule on a league they own — not at signup, which burned the
  // whole trial for off-season admins (finding 2).
  //
  // This used to fire on ANY save of an already-generated schedule. That was
  // reachable with no user action at all — a field geocode writes to state and
  // the 800 ms autosave posts the whole season — so opening a populated league
  // could start someone's trial, and a collaborator opening a league they don't
  // own started their own. `shouldStartTrialClock` requires the not-generated ->
  // generated transition AND ownership. See src/lib/trial.ts.
  //
  // The .eq('plan_tier','trial') + .is('trial_started_at', null) filters keep it
  // one-shot and unable to touch a tester or a paying subscriber.
  if (shouldStartTrialClock({
    ownerId,
    savingUserId: session.user.id,
    previousGeneratedAt: (league as { prev_generated?: string | null } | null)?.prev_generated ?? null,
    nextGeneratedAt: state.schedule?.generatedAt,
  })) {
    const startedAt = new Date()
    const endsAt = new Date(startedAt.getTime() + 14 * 24 * 60 * 60 * 1000)
    const { error: clockError } = await serviceSupabase
      .from('user_subscriptions')
      .update({ trial_started_at: startedAt.toISOString(), subscription_end: endsAt.toISOString() })
      .eq('user_id', session.user.id)
      .eq('plan_tier', 'trial')
      .is('trial_started_at', null)
    // Non-fatal: the league is already saved. A failed clock start just means the
    // trial stays unstarted and the next save tries again.
    if (clockError) console.error('trial clock start failed', clockError)
  }

  // The client tracks this as the base for its next save.
  return NextResponse.json({ success: true, updatedAt: now })
}
