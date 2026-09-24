import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { isWritable } from '@/lib/plans'
import { isOwnerGatedMutation } from '@/lib/writeGate'

/** Redirect domains → canonical domain (308 Permanent Redirect). */
const REDIRECT_HOSTS = new Set([
  'www.fielddayplanner.app',
  'getfieldday.app',
  'www.getfieldday.app',
  'getfieldday.xyz',
  'www.getfieldday.xyz',
])
const CANONICAL = 'https://fielddayplanner.app'

/** Paths that never require auth or a subscription check. */
const PUBLIC_PREFIXES = [
  '/login',
  '/pricing',
  '/auth/callback',
  '/api/payments',          // all payment routes bypass the subscription gate:
                            //  - /webhook: Stripe hits it without a cookie
                            //  - /create-session & /portal: an UNSUBSCRIBED user
                            //    must be able to reach these to subscribe/manage
                            //    billing. They enforce their own getUser() auth.
  '/_next',
  '/pwa-icon',
  '/api/league/view',       // read-only token route
  '/api/welcome',           // first-sign-in welcome email; does its own getUser(), and a
                            //  brand-new user has no subscription row for the write gate yet
  '/checkout/success',      // post-payment landing: polls for the row, then forwards to /.
                            //  Must be reachable by an authed user whose webhook hasn't
                            //  committed yet — gating it would re-create the bounce it fixes.
  '/help',                  // public help docs, must be reachable by prospects who have
                            //  no account yet (linked from sales emails)
  '/icon',                  // favicon + apple-touch-icon are next/og routes, not files, so the
  '/apple-icon',            //  extension rule below misses them; logged-out tabs had no icon
  '/opengraph-image',       // the link-preview card; crawlers carry no cookie, and a 307
                            //  to /login here is exactly the bug class in memory/tech-patterns.
  '/welcome',               // the landing page. `/` rewrites here for logged-out
                            //  visitors, and the rewrite re-enters this matcher.
  '/marketing/',            // the landing page's screenshots and hero photo (public/marketing).
                            //  The extension rule below passes .png but not .jpg, so the
                            //  photo 307'd to /login for every logged-out visitor.
]

const PUBLIC_EXTENSIONS = ['.ico', '.png', '.svg', '.webmanifest', '.txt', '.xml']

// Service worker script must be served without redirects (browser requirement)
const PUBLIC_EXACT = ['/sw.js']

export async function middleware(req: NextRequest) {
  // Redirect alias domains to the canonical domain before any auth logic runs
  const host = req.headers.get('host') ?? ''
  if (REDIRECT_HOSTS.has(host)) {
    const destination = CANONICAL + req.nextUrl.pathname + req.nextUrl.search
    return NextResponse.redirect(destination, { status: 308 })
  }

  const { pathname, searchParams } = req.nextUrl

  // Static assets & public paths — skip auth entirely
  if (
    PUBLIC_PREFIXES.some(p => pathname.startsWith(p)) ||
    PUBLIC_EXTENSIONS.some(ext => pathname.endsWith(ext)) ||
    PUBLIC_EXACT.includes(pathname)
  ) {
    return NextResponse.next()
  }

  // Read-only schedule viewers (coaches, players with view token) — no auth required.
  // The TOKEN ALONE is sufficient, deliberately: messaging apps and clipboard tools
  // strip query params, and page.tsx has always treated a bare ?token= as a valid
  // share link. Requiring &view=readonly here sent those viewers to /login holding a
  // link the app itself considers good — and, once `/` became the landing page, to
  // the marketing site instead of the schedule they were sent.
  if (searchParams.get('token')) {
    return NextResponse.next()
  }

  // Build response first so we can write refreshed session cookies onto it
  const response = NextResponse.next()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            req.cookies.set(name, value)
            response.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  // Use getUser() — it revalidates the JWT with the Supabase Auth server.
  // getSession() only reads the cookie and must not be trusted for authz.
  const { data: { user } } = await supabase.auth.getUser()

  // Not logged in
  if (!user) {
    // An /api caller reads res.json(); handing it a 307 to an HTML login page makes
    // the fetch blow up on parse and surface as a bogus "Network error". Same rule as
    // the expiry gate below.
    if (pathname.startsWith('/api')) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
    }
    // The front door. A logged-out visitor to `/` gets the landing page, served
    // at `/` — a rewrite, not a redirect, so the URL people paste and crawlers
    // index stays fielddayplanner.app. Sending them to /login instead made the
    // front door of a paid product a bare sign-in box.
    //
    // This branch, not a check inside app/page.tsx, is where the decision belongs:
    // the refreshed session cookies set above ride on `response` and are NOT
    // propagated to a server component, so a getUser() there could read a
    // just-rotated refresh token and show a paying customer the marketing page.
    if (pathname === '/') return NextResponse.rewrite(new URL('/welcome', req.url))
    return NextResponse.redirect(new URL('/login', req.url))
  }

  // A lapsed plan no longer bounces the user to /pricing. Locking an admin out of a
  // schedule their coaches are still reading destroys the trust the renewal depends
  // on (finding 3) — so the app renders read-only instead and the gate moves to
  // writes only. Reads (GET) always pass; anything that changes state does not.
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
  if (!isMutation) return response

  // Routes that gate themselves, correctly, against the plan that actually pays
  // for the league being written. See src/lib/writeGate.ts — middleware cannot
  // make this call, because it does not know which league the request is for.
  if (isOwnerGatedMutation(pathname)) return response

  const { data: sub } = await supabase
    .from('user_subscriptions')
    .select('subscription_status, subscription_end')
    .eq('user_id', user.id)
    .single()

  if (!isWritable(sub)) {
    // JSON for API callers, a redirect for a real form/page POST. Never redirect an
    // /api route — the client reads the body, and an HTML login page there surfaces
    // as an unexplained "Network error".
    if (pathname.startsWith('/api')) {
      return NextResponse.json(
        { error: 'Your plan has expired. Renew to make changes — your league stays exactly as it is.', expired: true },
        { status: 403 }
      )
    }
    return NextResponse.redirect(new URL('/pricing', req.url))
  }

  return response
}

export const config = {
  // Run on all paths except Next.js internals and static files
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
