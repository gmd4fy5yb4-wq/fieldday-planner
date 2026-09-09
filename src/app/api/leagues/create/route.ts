import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseServer, getSupabaseServiceRole } from '@/lib/supabase-server'
import { checkLimits, isWritable } from '@/lib/plans'
import { generateLeagueCode } from '@/lib/leagueCode'
import { getSports } from '@/lib/sports'
import type { AppState } from '@/lib/types'

const schema = z.object({
  state: z.unknown().refine(v => JSON.stringify(v).length < 500_000, 'State too large'),
  userName: z.string().min(1).max(100).trim(),
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

  const serviceSupabase = getSupabaseServiceRole()

  // Check subscription limits
  const { data: sub } = await serviceSupabase
    .from('user_subscriptions')
    .select('sports_limit, divisions_limit, teams_limit, subscription_status, subscription_end')
    .eq('user_id', session.user.id)
    .single()

  // Expiry gate — see the same block in /api/leagues/save. Middleware no longer
  // redirects lapsed users to /pricing (they get a read-only app instead), so the
  // write gate has to live in the write routes.
  if (!isWritable(sub)) {
    return NextResponse.json(
      { error: 'Your plan has expired. Renew to create a new league.', expired: true },
      { status: 403 }
    )
  }

  const limits = sub ?? { sports_limit: 1, divisions_limit: 1, teams_limit: 8 }

  const state = parsed.data.state as unknown as AppState
  const limitCheck = checkLimits(
    { sportsLimit: limits.sports_limit, divisionsLimit: limits.divisions_limit, teamsLimit: limits.teams_limit, adminsLimit: 999 },
    getSports(state.season).length,
    state.divisions ?? []
  )

  if (!limitCheck.allowed) {
    return NextResponse.json(
      { error: limitCheck.reason, limitType: limitCheck.limitType },
      { status: 403 }
    )
  }

  // Generate unique code (retry up to 10 times)
  let code = ''
  for (let i = 0; i < 10; i++) {
    const candidate = generateLeagueCode()
    const { data: existing } = await serviceSupabase
      .from('leagues')
      .select('id')
      .eq('id', candidate)
      .single()
    if (!existing) { code = candidate; break }
  }

  if (!code) {
    return NextResponse.json({ error: 'Could not generate a unique code. Try again.' }, { status: 500 })
  }

  const { error: insertError } = await serviceSupabase
    .from('leagues')
    .insert({
      id: code,
      data: state,
      updated_at: new Date().toISOString(),
      updated_by: parsed.data.userName,
      updated_by_id: session.user.id,   // verified saver id, see fd_023
      owner_id: session.user.id,
    })

  if (insertError) {
    return NextResponse.json({ error: 'Failed to create league.' }, { status: 500 })
  }

  return NextResponse.json({ code })
}
