# FieldDay Planner — CLAUDE.md

**Division:** Alfred Digital Sports
**Supabase:** Alfred Digital Sports (`actgfxrinoxlyrprzkoh`) — MCP: `supabase-sports`
**Live URL:** fielddayplanner.app (aliases `getfieldday.app`, `getfieldday.xyz` + all three `www` 308 to it — actually wired 2026-08-31; this line claimed it before it was true)
**Vercel project:** fieldday-planner

## Env Vars (copy .env.local.example → .env.local)
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SITE_URL=http://localhost:3000
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
# 6 price IDs: each tier has an annual (recurring) + a season (one-time 3-month) price
STRIPE_PRICE_STARTER_ANNUAL=
STRIPE_PRICE_STARTER_SEASON=
STRIPE_PRICE_PRO_ANNUAL=
STRIPE_PRICE_PRO_SEASON=
STRIPE_PRICE_ORG_ANNUAL=
STRIPE_PRICE_ORG_SEASON=
RESEND_API_KEY=
RESEND_FROM_EMAIL=     # must be @alfred-digital.com (only verified Resend domain)
```

## Branching & Deployment
- Active work happens on `dev` branch
- Merge `dev` → `main` to trigger Vercel production deploy
- Do NOT push directly to `main` for feature work

## Auth

### There are TWO codes in this product. They are not the same length.

This has been re-derived wrong more than once, in both directions — including
once against a live marketing page — so check here before writing any copy that
names a code:

| | Length | Alphabet | Where |
|---|---|---|---|
| **Sign-in code** | **8** | digits only | emailed by Supabase, entered at `/login` |
| **League code** | **6** | `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I, O, 0, 1) | given out by a league admin, entered at the join gate |

Verified 2026-08-29 against production: all 6 rows in `leagues` have a
6-character `id` (`YWWM8G`, `UC2YE8`, `JF9ZDS`, `D7USBR`, `NRAMGV`, `ZKP833`),
both generators are `length: 6` (`sync.ts:84`, `api/leagues/create/route.ts:16`),
and `LeagueGate` sets `maxLength={6}`. `git log -S "length: 8"` on those files
returns nothing — **the league code has never been 8.**

**alfred-digital.com still says "Teams join with an 8-character code" and is
wrong twice over**: wrong length, and teams don't join by code at all — admins
do, while coaches and parents use the read-only token link. Fix it there and
this stops regenerating.

Real users mix the two up (the first paying tester does, routinely). Both wrong
-code paths used to dead-end in "double-check the code and try again", which is
useless advice when the code in hand is fine and merely the wrong kind.
`src/lib/codeHints.ts` names the mistake at both inputs instead. **Those hints
must never gate submission:** the league alphabet includes 2-9, so an all-digit
league code is legal at roughly 1 in 4,096, and refusing one would lock a real
league out of its own app. `codeHints.test.ts` asserts every production code
above is hint-free.

**8-digit code via Supabase — there is no sign-in link.** Confirmed 2026-08-24 from
the actual email. **That template is shared with Prospect Card and AthleteCard** (one
Supabase project = one set of auth templates), so re-enabling links here re-enables
them everywhere. The template emits only the code, and `/login` signs users in with
`verifyOtp()`, which never routes through `/auth/callback`. (An older note below,
from 2026-07-29, says the magic-link email carries "both link and code" — the
template has since changed, or that note was wrong. The code is what ships today.)

**This app runs PKCE, not implicit, whatever the option says.** `getSupabase()` uses
`createBrowserClient`, which hardcodes `flowType: 'pkce'` AFTER spreading the
caller's auth options — so the `flowType: 'implicit'` that used to sit there was a
silent no-op. Verified in production 2026-08-24: a real login created an
`auth.flow_state` row with `code_challenge_method: 's256'`, and such rows go back to
at least 2026-05.

That is **harmless today** because `verifyOtp()` is flow-agnostic and works on any
device. It stops being harmless the moment the email template sends links again:
PKCE keeps the code verifier in the requesting browser, so a link opened on a phone
could not complete. **If links are ever re-enabled, move to plain `createClient` with
a cookie adapter first** (Prospect Card's `src/lib/supabase.ts` is the reference).

**"Confirm email" is OFF in Supabase (Authentication → Providers → Email) — deliberately. Do not turn it back on.** With it on, a brand-new address gets Supabase's *Confirm signup* template instead of *Magic Link*. That template carries a link but **no 8-digit code**, so the user lands on the "Check your email" screen — which promises a code and autofocuses the code field — with an email that doesn't contain one. Clicking the link confirmed the address without creating a session, dropping them back at `/login` to enter their email a second time. Only then, as an existing user, did they get the real magic-link email with the code. Two emails, and it read as broken on the first attempt.

With confirmation off, a new signup gets one magic-link email containing both link and code, and is signed in ~13 seconds after submitting (verified `greg+test8`, 2026-07-29: `confirmation_sent_at` NULL, `email_confirmed_at` == `created_at`, no second email). No security is lost — this app is passwordless, so the user must still open the mailbox to get in; confirmation was a second proof of the same thing.

This regressed once already (auth config changed mid-day 2026-07-28; `test1`/`test4` signed up in one step before it, `test5`–`test7` needed two after). To check whether it has regressed again: `select email, confirmation_sent_at, recovery_sent_at, last_sign_in_at from auth.users order by created_at desc limit 3` — a non-null `confirmation_sent_at` on a recent signup means it is back on.

## Email (two separate Resend paths)
- **Magic links:** sent by Supabase Auth via custom SMTP → Resend, from an `@alfred-digital.com` sender. Configured in the Supabase dashboard, NOT via app env vars.
- **Coach notifications (`notify-coaches`):** app uses the Resend SDK with `RESEND_API_KEY` + `RESEND_FROM_EMAIL` from env. From-domain must be Resend-verified (`alfred-digital.com` only — free tier = 1 domain).

## Billing & Subscriptions (Stripe)
Status: **LIVE. First real sale 2026-08-19** — a $39 Starter season pass, which provisioned correctly (`starter` / `season_3mo` / 1-3-24 limits / `subscription_end` = +90d). The six live-mode prices and the six `STRIPE_PRICE_*` vars are set on Vercel **Production** (verified 2026-08-19).
- **Model (`src/lib/plans.ts`):** tiers `trial / starter / pro / org`, gated on **sports** (headline) with **divisions + teams** as silent guards. Trial = full Pro limits for 14 days. Each paid tier has two prices — **annual (recurring)** and a **3-month season pass (one-time payment, no auto-renew)**:
  - Starter $99/yr · $39 season · 1 sport / 3 div / 24 teams
  - Pro $199/yr · $69 season · 3 sports / 10 div / 100 teams
  - Org $399/yr · $129 season · unlimited
- **Enforcement is DB-column-driven:** `save`/`create` routes read `sports_limit / divisions_limit / teams_limit` off `user_subscriptions` (NOT `plan_tier`) and call `checkLimits(limits, sportCount, divisions)`. Sport count = `getSports(season).length` (tolerant of legacy single-sport blobs). `leagues_limit` is deprecated/unused; `admins_limit` reserved, not yet enforced.
- **Flow:** `/pricing` → `POST /api/payments/create-session` → branches `mode: 'subscription'` (annual) vs `mode: 'payment'` (season pass) → Stripe → signature-verified `/api/payments/webhook` upserts `user_subscriptions`. Season pass writes `stripe_subscription_id=NULL`, `billing_period='season_3mo'`, `subscription_end = now+90d`. Checkout `success_url` → `/checkout/success` (subscription-exempt page that polls the row then forwards to `/`, avoiding the post-pay → `/pricing` race).
- **Expiry:** middleware enforces `subscription_end` (null = no expiry for testers; past = lapsed). This is what makes the one-time season pass actually lapse at 90 days.
- **Migration 012** (`sports_limit`, `trial_started_at`, `billing_period`) applied to prod June 17, 2026; backfilled `sports_limit=999` for all `leagues_limit>=999` rows (protects testers).
- **Stripe prices are immutable** — create new, repoint env var, archive old. Test price IDs are per-account; live needs separate live-mode prices.
- **Go-live is DONE** (live prices created, the 6 `STRIPE_PRICE_*` vars set on Production, prod webhook registered for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` — the same events serve one-time + recurring). Historical runbook: `docs/STRIPE_GO_LIVE.md`.
- **An unrecognised price ID or metadata tier is now REFUSED, not defaulted.** Both checkout paths used to fall back to `starter` with 1/3/24 limits, so an Org customer paying $399 against a missing or wrong-mode `STRIPE_PRICE_ORG_ANNUAL` was charged in full and provisioned as Starter, silently. `src/lib/subscriptionRow.ts` now returns a typed refusal, the route logs user + price + subscription id, and **no row is written** — the customer keeps whatever access they had. If you ever see `[webhook] paid checkout with unrecognised price` in the logs, an env var is wrong. Covered by `src/lib/subscriptionRow.test.ts`.
- **Season passes generate a real Stripe invoice** (`invoice_creation` on the Checkout Session, payment mode only — Stripe rejects it on a subscription, and subscriptions invoice every cycle on their own). Without it a one-time pass produced only a receipt email, which depends on a dashboard toggle nobody can see from the repo; the first sale had to be receipted by hand. Both this and the customer fields are computed in `src/lib/checkout.ts` and tested in `checkout.test.ts`, because setting either on the wrong mode kills the checkout button outright.
- **`stripe_customer_id` NULL on a season pass — FIXED 2026-08-19 for new checkouts.** Stripe does not attach a Customer to a one-time payment unless the session sets `customer_creation: 'always'`, so the first sale landed with NULL: `/api/payments/portal` answers 404 "No billing account found" for that user and the row cannot be traced back to Stripe. `src/lib/checkout.ts` now computes the customer fields (and reuses an existing customer rather than duplicating one); covered by `checkout.test.ts`. **The one pre-existing NULL row is NOT backfilled** — if Stripe created no Customer for that payment there is nothing to link, so check the payment in the Stripe dashboard and set `stripe_customer_id` by hand if a customer exists.
- **Stripe MCP connector is LIVE-mode and read-only for prices** — cannot see test-mode objects. Verify test activity via the DB (`user_subscriptions`), not the connector.
- **Trial expiry IS enforced**, and `fd_014` moved the clock off signup. **Say "the first save of a schedule with anything on it", never "when you generate a schedule"** — `/api/leagues/save` stamps the 14 days when `state.schedule.generatedAt` is non-null, and `EventModal.tsx:327` sets `generatedAt` unconditionally for a game, a **practice**, or a special event. So a coach who never opens Auto-Schedule and hand-adds one practice starts their paid clock. The loose phrasing already shipped a false claim to the help docs once (2026-08-19).
- **Paying customers get an expiry countdown** (`trialBanner` in `src/lib/trial.ts`), but only when nothing will auto-renew them — a NULL `stripe_subscription_id` means a season pass that genuinely stops. An annual subscriber has a live Stripe subscription and must **never** be told their plan is ending; there is a test asserting that.

## Entitlements: whose plan governs a write

`saveGate()` in `src/lib/plans.ts` is the single answer to "may this save proceed".

**A league belongs to its owner, and the owner's plan is what pays for it** — so a
collaborator saving someone else's league is gated by the **OWNER's** plan, both for
expiry and for division/team limits. Your OWN league is always gated by your own
plan, so a shared league code only ever buys edit rights on a league someone else
is paying for; there is no collaborating around a limit. An owner whose plan lapses
takes their league read-only for everyone.

The route claimed this for months and did not do it: only the *sports* gate was
carved out, while limits and `isWritable` still ran against whoever was saving. The
practical failure (2026-08-19) was a tester who bought a season pass for his own
league and was instantly capped on a shared test league he neither owns nor pays
for. Fixed 2026-08-19; nine assertions in `plans.test.ts` cover it.

`saveGate` reports `blockedBy: 'self' | 'owner'` — a collaborator blocked by the
owner's expiry must not be told "your plan has expired", which would send them to
`/pricing` to buy something that cannot fix it.

**And then it happened again one layer out (fixed 2026-09-03).** `saveGate` was
correct and *unreachable*: two gates in front of it still tested the requester's
own row.

- `middleware.ts` 403'd every non-GET on a lapsed plan **before the save route
  ran**. It cannot do better — it does not know which league a request is for —
  so `/api/leagues/save` is now exempt via `OWNER_GATED_MUTATIONS` in
  `src/lib/writeGate.ts` and `saveGate` is the sole authority. **Do not put a
  league write back under the middleware expiry check.**
- `page.tsx` set `expired`/`readOnly` from `!isWritable(sub)` alone. Now
  `shouldLockForOwnPlan()` in `plans.ts`, which locks **only** on a league your
  plan governs. A collaborator is never locked client-side: the owner's row is
  unreadable from the browser (`user_subscriptions` RLS is own-row only), so the
  server answers.
  Watch the ordering trap: `leagueOwnerId` is NULL both for "unclaimed" and for
  "not fetched yet", so the decision waits on `ownerResolved`. Deciding early
  reads every collaborator as the owner, and the effect only ever *sets*
  read-only — so the lock never lifts.

The victim was `achic107@gmail.com` (Alicia Ciccarello, a head coach in YWWM8G's
Travel Softball division): personal trial lapsed 2026-07-07, told "your plan has
expired" on a league owned by an unlimited account, with a Renew button that
would have fixed nothing. Nine assertions in `plans.test.ts` and
`writeGate.test.ts` cover both gates.

**Still self-gated, deliberately or otherwise:** `/api/leagues/create` correctly
(a new league is always your own). `/api/notify-coaches` and
`/api/league/share-token` are *inconsistent* with the owner-pays model — a lapsed
collaborator on a paid league cannot email its coaches or mint a share link.
Not fixed because neither has an owner-aware gate to defer to yet.

## League ownership vs. access (they are NOT the same thing)

**The 6-character league code IS the access credential.** Any authenticated user
who knows it can edit the league — `save/route.ts` checks the code and the
governing plan, nothing else. There is **no membership or collaborator table**;
"collaborator" is not a stored relationship, and `leagues.updated_by` is a
free-text display name, not a user reference. The app therefore *cannot* tell you
which leagues you collaborate on — only which you own.

`leagues.owner_id` decides **who pays**, not who may edit. Claiming a league sets
that column and nothing else. Never write UI copy implying a claim restricts
access — that exact sentence shipped on the account page and was corrected
2026-08-19.

- `/api/leagues/claim` only succeeds on a league that is **unclaimed or already
  yours** (`.or(owner_id.is.null,owner_id.eq.<uid>)` in one conditional UPDATE);
  anything else is a 409. A collaborator cannot take an owned league.
- **An unclaimed league is silently auto-claimed by whoever saves it first**
  (`save/route.ts`: `...(!league?.owner_id ? { owner_id: session.user.id } : {})`).
  No confirmation, no notice. As of 2026-08-19 **zero leagues have a NULL owner**
  — the three legacy pre-migration-001 rows (`MZB7NY`, `U9TU6U`, `TFRD8G`, all
  empty default scaffolding) were deleted. Keep it that way; a NULL owner is a
  first-toucher ownership window.
- 🔒 **RLS on `leagues` is `SELECT` for `authenticated` ONLY (migration `fd_017`,
  applied 2026-08-27). It used to be `USING (true)` to `public`, and the note here
  claimed "the app relies on it" — that was wrong.** Anyone with the publishable
  anon key could `select *` and enumerate every league blob without a login or a
  league code, including the coach name/phone/email inside
  `data->divisions->teams->coaches` (measured: 6 phones, 14 emails, 2 leagues).
  Nothing needed it: the public read-only share link goes through
  `/api/league/view` on the **service role**, and every browser-client read
  (`sync.ts` `loadLeague`/`leagueExists`, `page.tsx`, `account/page.tsx`) happens on
  `/` or `/account`, both behind the middleware auth gate. The policy predated the
  server routes and stopped being load-bearing without anyone noticing.
  **Do not re-open it.** Rollback (if ever needed):
  `.backups/ROLLBACK-anon-rls-2026-08-27.sql`.
  `UPDATE` is unchanged: `owner_id IS NULL OR owner_id = auth.uid()`. Writes still
  go through the service-role save route, which is where `saveGate` runs.
- 🔒 **`league_snapshots` lost its two `anon` policies in the same migration** —
  anon could read *every* snapshot of *every* league (`USING (true)`) and INSERT
  unbounded rows behind only a league-id format check. Both were `TO anon`, so
  signed-in behaviour is untouched: the owner-scoped `authenticated_select` /
  `authenticated_insert` / `authenticated_delete` policies still govern the app.
- **`/api/notify-coaches` follows the same model** (changed 2026-08-27). It used to
  be the one route that treated `owner_id` as *authorization*, 403-ing anyone but
  the owner — so a collaborator could rewrite the whole schedule and read every
  coach's address but not email them. The check protected nothing reachable and is
  gone; auth + the 5-min per-user rate limit remain. Do not re-add it.
- 🔑 **The owner can now ROTATE the code (fd_022, 2026-09-03)** — the only way to
  withdraw edit access, since there is nobody to remove from a membership table.
  `/api/leagues/rotate-code` → `fd_rotate_league_code()`; UI is "Change code" per
  league on `/account`.
  - **Ownership is authorization here, and this is the one place that is right.**
    Gating on the code would hand the power to the person being removed. An
    unclaimed league is refused outright (nobody can authorise it, and allowing it
    would let any code-holder lock everyone else out).
  - **`leagues.id` is the PK *and* the credential**, so a rename is not a column
    update. `fd_league_guard_peak` FK'd it `ON DELETE CASCADE` only — a plain
    UPDATE was **rejected**; fd_022 adds `ON UPDATE CASCADE`. `league_snapshots`
    has **no FK at all**, so the same UPDATE would have silently orphaned every
    snapshot including the fd_010/fd_018 recovery points. The function re-keys
    them explicitly, in the same transaction. **Anything else that ever keys off
    a league code must be added to that function.**
  - The guard trigger no-ops on a rotation (its UPDATE path needs
    `NEW.data IS DISTINCT FROM OLD.data`). Verified, not assumed.
  - **`view_token` is NOT rotated by default.** It is a separate credential on a
    separate path, and coaches holding a read-only link should not lose the
    schedule because an admin was removed. `revokeViewLinks: true` opts in — the
    UI checkbox is off by default and says what each choice means.
  - **Discoverability is part of the feature.** A rotation nobody can find does
    not remove anyone, so the owner is told where it lives from the place the
    code is actually displayed: a "Change" link in the header code badge
    (desktop) and a row in the mobile League sheet, both gated on
    `canChangeCode = ownerResolved && isLeagueOwner` and both **linking** to
    `/account#leagues` rather than rotating in place. Rotating removes every
    collaborator at once — it belongs behind the confirm panel, not one stray
    click from "Copy".
  - Codes now come from `generateLeagueCode()` (`src/lib/leagueCode.ts`), a
    **CSPRNG**. The old `Math.random()` generator was fine for uniqueness and
    wrong for a credential you rotate to lock out someone who is holding a
    previous one. It is the single copy of the alphabet+length now (was four).
- Real roles (recorded membership, owner-revocable access) still do **not** exist.
  Rotation is a blunt substitute: it removes *everyone*, so the owner has to
  re-share with the people they are keeping. A membership table remains the real
  fix, plus a decision about whether to keep the frictionless link-sharing model
  at all.

## Plan display rules (three bugs came from getting these wrong)

- **Never route `plan_tier` through `getPlan()` to display a name.** `getPlan`
  falls back to `PLANS[0]` (trial) for anything it doesn't sell, and the DB carries
  tiers it doesn't sell: `unlimited` on the 3 tester rows and legacy `small` on
  `greg.amundson@gmail.com`. All four display sites did this, so a 999-limit
  account and a lapsed paid row both read **"Free Trial"**. Use
  `planDisplayName(tier)` in `src/lib/plans.ts`. A guard of the shape
  `getPlan(tier).name ?? tier` does **not** work — the fallback plan's name is a
  truthy string, so `??` never fires.
- **Limits come from the row's columns**, never from the plan table — the same
  `sports_limit / divisions_limit / teams_limit` the save route enforces. The
  account page printed the fallback plan's limits and told an unlimited account it
  had 3 sports / 10 divisions / 100 teams.
- **Only sell to an account nothing currently covers.** `planCta()` in
  `planUsage.ts` returns `buy` (trial, or any lapsed plan) / `manage` (covered,
  with a `stripe_customer_id` for the portal) / `none` (covered, nothing to
  manage — a tester, or a season pass whose one-time payment left no customer
  record). The panel used to render "Your setup fits Starter — $99/yr" and a
  purchase button for **every** owner, so the first paying customer was shown a
  buy button for the pass he had bought three days earlier — and it links to
  `/pricing`, where buying it twice works.
- **`PlanPanel` is owner-aware.** On a league you don't own it shows neither meters
  nor CTA, because writes there are gated by the OWNER's plan: your own limits are
  not the rule and buying a plan would change nothing. Ownership is derived from
  `leagueCode` in `page.tsx`, **not** threaded through `loadLeague` — a league
  arrives three ways (URL code, saved code, join gate) and only the code is common
  to all three.

**The pattern behind all of these:** the plan panel and account page were written
for one user — a trial admin setting up a first league — and every assumption
baked in holds only for that person. Collaboration broke one; a completed purchase
broke another. When touching either screen, walk all five viewers: trial, paying,
lapsed, collaborator, tester.

## Onboarding tour + help docs

- 7-step guided tour, keyed on **tab index** (this app is one page with 11 tabs, not
  11 routes). `src/lib/tour.ts` is pure and tab-keyed; there is deliberately **no**
  React context — Prospect Card needs one to survive `router.push()`, FieldDay has
  no navigation to lose. Do not port it.
- `TourOverlay` falls back to a centred, dimmed tooltip when a target is missing OR
  taller than the viewport OR still off-screen after `scrollIntoView`. All three
  paths exist because each one produced a blank, dead-looking tour in testing — the
  last only reproduces on a league with a **generated season**, so verify onboarding
  changes on a populated league, never an empty one.
- Welcome modal fires only for league **creators** (`LeagueGate`'s `onJoin` carries a
  `created` flag). A coach joining by code gets the `?` button but no modal.
- State is one row in `fd_user_tour` (migration `fd_015`), NOT a column on
  `user_subscriptions` — the Stripe webhook full-row-upserts that table, so any
  column outside its fixed list is wiped at every checkout and renewal.
- `/help` is in `PUBLIC_PREFIXES`. It must stay there: the docs exist to be linked
  from sales emails to prospects who have no account.

## There are TWO confirm flags on a game, and they mean different things

Added 2026-09-08 (`69e5295` on `dev`, merged to `main` as `c474e10`, deployed).

| | Field | Means | Edited where |
|---|---|---|---|
| **All parties** | `confirmed` | coaches **and** the official **and** field staff notified | Today card header checkbox (`DashboardTab`), and now the event modal |
| **Official only** | `umpireConfirmed` | the assigned official has accepted this game | event modal only, under the {official} select |

Only `confirmed` lights the green ring on the Today card; `umpireConfirmed`
renders as a small pill beside the official's name. **Do not collapse them** —
the umpire usually says yes days before the coaches do, which is the whole
reason the second flag exists.

- **Both are game-only.** They are cleared when the event is switched to a
  practice or special event, and `umpireConfirmed` is cleared (and its checkbox
  disabled) when the official goes back to TBD — a confirmation with nobody
  attached would still render a pill.
- **Neither is ever written as `false`.** `commitDates` in `EventModal.tsx`
  spreads them conditionally. The league is one JSON blob and the fd_010/fd_018
  guards compare blob *size*, so writing a `false` onto every game inflates every
  league for no information.
- **No migration.** Both live inside `leagues.data`, not in a column.

## Lint

`npm run lint` (`eslint .`) and `next build` both run ESLint. The config had been in
the repo since scaffolding importing three packages that were never installed, so
every build shipped unlinted until 2026-08-19. 0 errors is the gate; ~16 warnings
are known and tracked.

Ten `eslint-disable` comments exist. Two of them suppress
`@next/next/no-html-link-for-pages` on `<a href="/">` links that are **deliberate
hard reloads, not missed `<Link>`s** — `checkout/success` (the Stripe webhook may
still be committing the subscription row, so a full boot guarantees a fresh read)
and the invalid-view-token screen in `page.tsx` (the reload is what clears
`?view=readonly&token=`). Both carry their reason inline. Do not "fix" them.

## Saves are version-checked — never restore the unconditional upsert

`/api/leagues/save` overwrites **only the exact version the client loaded**. The
client sends the `updated_at` it last saw as `baseUpdatedAt`; the route does
`.update(...).eq('id', code).eq('updated_at', base)` and returns **409** when zero
rows match, having written nothing. On 409 the client reloads the league into the
existing `pendingRemote` review banner.

It used to be a plain `upsert`: last writer wins, silently. Every editor holds the
whole league in memory, so a tab that loaded an hour ago would post its hour-old
season over everything saved since and show "Synced" while doing it.

**This is not theoretical.** On 2026-09-08 YWWM8G went 35 games → 29 between 18:53
and 21:50 UTC. Three people had edit access and one of them (`jonathan@lev-itsb.com`)
had **four live sessions** across two browsers and two networks — two of them
refreshing 2 seconds apart at 21:44. The loss was 198→193 items, ~2.5%, so the fd_010
/ fd_018 guard never fired: **the guard is calibrated for catastrophe and the real
failure mode is attrition.** Recovered from `fd_league_guard_peak` on 2026-09-09 by
merging the 2 still-missing games into the live blob — not by restoring the old blob,
which would have deleted a practice added that morning.

Rules that follow from it:

- **Key the check on `updated_at`, never on the user.** Jon's four tabs are one
  account; an identity check passes all of them and changes nothing.
- **Every place this tab adopts a version must set `baseUpdatedAtRef`** — all three
  load paths, `handleJoin` (the gate passes `result.updatedAt` through), the
  read-only poll, and *both* banner buttons. Miss one and that tab 409s forever with
  no way out. **Dismiss deliberately adopts the remote version**: that is what makes
  it mean "keep mine, overwrite theirs".
- **A missing `baseUpdatedAt` still writes unconditionally**, so browsers holding the
  pre-fix bundle keep working through a rollout. Make it mandatory (422) once nobody
  is on the old bundle.
- The 2026-04-19 "cross-tab sync" commit (`c8a7c3e`) guarded the **opposite**
  direction — the poll overwriting local edits — and is often mistaken for having
  fixed this. It did not.

Related, same shipment: the sync indicator shows the **server's** reason for a failed
save (`syncError`), because "Save failed — check connection" was also what an expired
plan, a plan limit and a conflict all looked like. Failed saves retry 3× at 5 s, but
never a `limitType` (a decision, not a blip) and never a conflict (retrying would just
conflict again). The unload backup listens on `pagehide` + `visibilitychange`, not
`beforeunload` alone — iOS Safari discards backgrounded tabs without firing it, which
is precisely the phone-at-a-field case the backup exists for.

## The league guard (fd_010 + fd_018)

`trg_leagues_guard_snapshot` on `leagues` writes a recovery point into
`league_snapshots` before a destructive write. It is **non-blocking by design** — it
never rejects a save, it only guarantees something is recoverable. Two rules:

- **fd_010** — one write that drops a league below half its previous size.
- **fd_018** (2026-08-29) — a league that ends up below half its **high-water mark**,
  however many saves it took. `public.fd_league_guard_peak` holds one row per league
  with the largest version seen, blob and all; crossing the line promotes that copy
  into `league_snapshots`, once per peak.

fd_018 exists because fd_010 alone is nearly useless against a slow deletion. Replaying
the 2026-07-28 loss (286 items removed 20 at a time), fd_010 fired only in the last
gasp and left a best recovery point of **26 of 286 items**. Verified in prod with a
rolled-back probe on YWWM8G: five saves taking it 144→68, each keeping 84–89% of the
previous — fd_010 fired 0 times, fd_018 recovered all 144.

**Do not turn the high-water copy into a daily auto-snapshot.** `loadSnapshots()` in
`src/lib/sync.ts` reads the 30 most recent rows with no filter on `created_by`, so a
daily guard row would flush the admin's own snapshots out of their own list inside a
month. The copy is deliberately invisible to the app until something looks wrong.

`fd_league_guard_peak` holds full league blobs (coach names, phones, emails). RLS is on
with **no policies** and all grants revoked from `PUBLIC` — verified by
`has_table_privilege`, not by reading `pg_policies`. Only the SECURITY DEFINER trigger
touches it. If you ever add a policy to it, you have made a mistake.

## Known Issues / Do-Not-Touch
- ✅ **Trial trigger RESTORED (migration 013, June 17 2026).** The `handle_new_user` / `on_auth_user_created` trigger was missing in the Sports DB (so new signups got no `user_subscriptions` row and were gated straight to `/pricing`). 013 recreates it with sports-model trial values (3/10/100, `subscription_end=now()+14d`) and backfilled the 6 rowless users. Verified: trigger enabled on `auth.users`; testers + legacy `small` row untouched.
- ℹ️ **`greg.amundson@gmail.com` is one of the owner's own accounts, not a customer.** `plan_tier='small'` (1/4/16) is a legacy tier absent from `PLANS`, with a real `stripe_customer_id`, lapsed 2026-07-11. Confirmed 2026-08-19 to be left exactly as it is — do not migrate it to `starter`, and do not treat it as a customer needing outreach. It displays as "Small" since `planDisplayName` landed, which is correct and intended.
- 🛑 **Tester accounts — do not modify.** **3** accounts have `plan_tier='unlimited'` (an invalid value vs code's `trial/starter/pro/org`), `active`, no Stripe link, `subscription_end=NULL` (never expires). Migration 012 set their `sports_limit=999`. These are real-world testers depending on the app: **never change their access, and never complete a Stripe checkout while signed in as one** (the webhook would overwrite the protected row).
  **This has already happened once:** `jonathan@lev-itsb.com` was a 4th `unlimited` tester until he bought a season pass on 2026-08-19, which overwrote his row to `starter`. He is a paying customer now, deliberately left that way — the row is an honest customer record. He keeps write access to the shared test league `YWWM8G` because collaborator writes are gated on the league OWNER's plan (see below), not his own.
- ℹ️ **`achic107@gmail.com` (Alicia Ciccarello) has `subscription_end = NULL` as of 2026-09-03** — set by hand at the owner's request while diagnosing the gate bug above. `plan_tier` is still `trial`/`trialing`, so **NULL here means her trial now never expires** (same shape as the tester rows, without the 999 limits — she keeps 3/10/100). She did not need it for YWWM8G once the gate was fixed, since that league's owner is on an unlimited plan; it only matters if she owns or creates a league of her own. Put a date back in `subscription_end` to make it a normal trial again.
- ℹ️ **`user_subscriptions → auth.users` FK is NOT `ON DELETE CASCADE` in prod** (migration 002 source says it is — prod drift). To delete a user, delete their `user_subscriptions` row first.

## Common Gotchas
- **Do NOT re-add `flowType: 'implicit'` to `createBrowserClient`** — it is silently overridden to `'pkce'` and reads as a load-bearing choice to the next person. See **Auth** above; it only matters if the email template starts sending links.
- **Authorization uses `getUser()`, not `getSession()`** in middleware + payment routes — `getSession()` only reads the cookie without revalidating the JWT. Do not revert.
- **Payment routes (`/api/payments/*`) are exempt from the subscription gate** in `middleware.ts` (`PUBLIC_PREFIXES`). An unsubscribed user must be able to reach `create-session`/`portal`; webhook has no cookie. Don't re-gate them, or checkout breaks with a redirect-to-`/pricing` (which surfaces as a misleading "Network error" in the UI).
- **Service worker registers in PRODUCTION only** (`src/components/ServiceWorker.tsx`); in dev it self-unregisters and clears caches. If a dev page loads unstyled/non-interactive, a stale SW is the cause — hard-reload after clearing.
- **CSP `upgrade-insecure-requests` + HSTS are production-only** (`next.config.ts`). They were forcing `https://localhost` and breaking dev with `ERR_SSL_PROTOCOL_ERROR`. Keep them gated to `NODE_ENV==='production'`.
- Sentry CSP host must use a leftmost-label wildcard (`*.ingest.de.sentry.io`), never `o*.ingest…` (invalid, silently dropped).
- Stripe price IDs are per-environment (test vs. live) — confirm before committing
- Resend `from` address must be verified in Resend dashboard (only `alfred-digital.com` is verified)
- League collaborator saves: see **Entitlements** and **League ownership vs. access** above — the code is the access credential, the owner's plan is the rule
