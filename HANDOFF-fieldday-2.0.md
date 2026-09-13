# Handoff — FieldDay Planner 2.0 (written 2026-08-27)

## State

**Production is healthy and two fixes shipped today.**

1. **Trial-clock bug — FIXED, LIVE** (`a9cc97a` → `main` as `9965d568`).
   Merely *opening* a populated league could burn a 14-day trial: geocode → `setState` →
   800ms debounced autosave → full-blob POST → clock stamp. Now gated by a pure function,
   `shouldStartTrialClock()` in `src/lib/trial.ts` — owner-only, first-generation-only.
   `src/app/api/leagues/save/route.ts` reads the prior value with a PostgREST JSON-path
   projection (`prev_generated:data->schedule->>generatedAt`) so it never pulls the blob.
   6 regression asserts in `src/lib/trial.test.ts`. Verified live: 0 clocks started after Greg's own edit.

2. **Anonymous read of every league blob — CLOSED, LIVE** (`fd_017_close_anon_league_reads`,
   applied via MCP to the Sports DB). 6 phone numbers and 14 emails across 2 leagues were
   readable by anyone with the anon key. Verified by effect: anon now reads 0 rows from all
   13 tables; no `USING (true)` policy survives in the Sports DB.
   `teams_select` deliberately keeps `OR (share_enabled = true)` — that's a Prospect Card
   feature, 0 of 10 teams have it on, and it does not cascade to `team_players`.
   Rollback SQL captured verbatim from `pg_policies` at `.backups/ROLLBACK-anon-rls-2026-08-27.sql`.
   `CLAUDE.md` now carries a 🔒 do-not-reopen block (`3caa895`) — its old note claimed the app
   relied on the public read. It did not.

**Git:** on `dev`, **2 commits unpushed** (`a9cc97a`, `3caa895`). `a9cc97a` is already in
production via `main`. Nothing is waiting on a deploy — the migration is applied in Supabase
independently of any push.

## Protected data

`.backups/` is gitignored (line 30 — "contain production PII — never commit"):

- `YWWM8G-…-live.json`, `UC2YE8-…-live.json` — both live leagues as of 11:08 today
- `YWWM8G-2026-07-28-spring-summer-286items.json` — **the recovered spring/summer season**
  (131 games, 113 practices, 41 teams). It had been wiped from `leagues` when YWWM8G was
  rolled forward to fall, and survived only inside one `league_snapshots` row.
  The `fd_010` guard trigger did **not** fire, because the deletion was incremental —
  each individual save stayed under the 50% threshold. That's a real gap in the guard.
- Both leagues also re-snapshotted into `league_snapshots` with labeled rows

Jonathan's UC2YE8 (paid fall league) and the YWWM8G Force travel schedule are untouched.

## The 2.0 work — Phase 1 APPLIED 2026-08-31

**`fd_016` is live in the Sports DB.** Applied via MCP and verified by measurement,
not by the tool's success flag: 12 tables, 12 with RLS, **24 policies (every table has
BOTH a read and a write policy — the silent deny-all trap did not recur)**, 5 functions,
12 indexes. anon reads 0 rows from all 12 by impersonation. 1.0 untouched and re-counted
after the fact: 6 leagues, 63 snapshots, 23 subscriptions, 10 Prospect Card teams,
8 policies.

**`fd_019` followed immediately.** fd_016's `revoke execute … from public` did NOT remove
anon's access, because Supabase's default privileges grant anon **explicitly** — the
spoc_006 trap, third time in this DB. Measured after fd_016: anon held table privileges
on all 12 fd2_ tables and EXECUTE on all 5 functions. Not a live leak (every policy is
`to authenticated`, so anon read 0 rows), but a tripwire for the first policy someone
writes without that clause. Now: anon grants NONE, anon/public EXECUTE NONE,
`authenticated` retains all 12 tables and all 5 functions.

**LOADED 2026-08-31.** 236 rows across 9 tables: 2 orgs, 2 seasons, 7 venues, 15 fields,
3 field grants, 4 divisions, 23 teams, 18 contacts, 162 bookings (block 4, event 23,
game 27, practice 108). `fd2_staff`, `fd2_blackouts` and `fd2_org_members` are empty.
Verified after load: **0 orphan foreign keys, 0 rows left needing review**, 26 rows keeping
their original free-text in `source_raw`, 2 events deliberately holding no field, and 1.0
untouched (6 leagues, 63 snapshots).

Loaded over **PostgREST from the converter's `--json` output**, not by pasting SQL — 77KB of
generated INSERTs through a chat context is a transcription risk on a production write, and
the blob carries coach PII. `scripts/convert-to-v2.mjs --json <file>` emits the row sets in
FK-safe order; the loader upserts each table on its primary key, so re-running is safe
because every id is a deterministic UUIDv5. One wrinkle worth knowing: **PostgREST bulk
insert requires every object in a batch to carry identical keys**, and rows legitimately
differ (a game has no `source_raw`), so the loader pads to the union with nulls. A null
landing in a NOT NULL column is rejected by the database, so that padding cannot quietly
corrupt anything.

### Security re-verified WITH data in the tables

- **`anon` gets `permission denied`, not an empty result** — `fd_019` removed the table
  grant, so it is stopped at the privilege layer before RLS is even consulted.
- **A signed-in user with no `fd2_org_members` row reads 0** bookings, 0 contacts, 0 teams,
  0 orgs. This is the cross-app check that matters: the Sports DB has ONE `auth.users`, so a
  Prospect Card or AthleteCard session is a valid login here and must see nothing.
- 7 venues ARE visible to any authenticated user, by design (`fd2_venues_read USING (true)`
  — a public park's name and address, so cross-org field matching can work).

**Nobody can see this data in an app yet**, because `fd2_org_members` is empty and every
policy routes through `fd2_role_in()`. Membership rows are the next functional step.

### The first thing 2.0 found: 4 cross-org overlaps — READ THE CAVEAT

The moment both leagues shared one field registry, this query became answerable for the
first time, and it returned four collisions on shared fields:

| Date | Field | LEv-IT | Jonathan Fall League |
|---|---|---|---|
| 2026-09-13 10:00 | Azalea Turf | Force (14U) Harrison vs **Away Team** | Force (White) vs Cobras (Gold) |
| 2026-09-19 10:00 | Azalea Turf | Force (14U) Harrison vs **Away Team** | Force (White) vs Lady Diamond Pros |
| 2026-09-19 12:00 | Azalea Turf | Force (16U) Herrera vs **Away Team** | Force (Hererra) vs Lady Diamond Pros |
| 2026-09-20 10:00 | MacLaren Turf 60' | Force (16U) Herrera vs **Away Team** | Force (Hererra) vs Cobras (Black) |

**These are very probably NOT conflicts.** In all four, LEv-IT's side plays `Away Team`
(`is_external = true`, its placeholder for an out-of-league opponent) while Jonathan's side
carries the same club team against a *named* opponent — and `Force (16U) Herrera` /
`Force (Hererra)` is the same team with the coach's name misspelled. The likeliest reading
is one interleague game recorded in both leagues, which matches the note that ~70% of
LEv-IT's games are interleague.

**RESOLVED same day — `fd_020`.** Greg confirmed `Force (White)` IS `Force (14U) Harrison`,
and `Force (Blue)` IS `Force Blue (10U) Ciccarello`. So **all four are duplicate records and
there are ZERO real cross-org conflicts.**

The fix is a **link, not a merge**: a nullable `fd2_teams.identity_key`. Two rows sharing a
key are the same real-world team, while each org keeps its own row, name, division and
contacts — merging would have raised an ownership question nobody has answered and destroyed
each league's naming. NULL is the default and stays the default for every other team.

Three keys, six rows:

| key | LEv-IT | Jonathan Fall League |
|---|---|---|
| `force-14u-harrison` | Force (14U) Harrison | Force (White) |
| `force-16u-herrera` | Force (16U) Herrera | Force (Hererra) |
| `force-10u-ciccarello` | Force Blue (10U) Ciccarello | Force (Blue) |

**Identity is never inferred from names** and there is an assertion holding that line:
"Force (White)" and "Force (14U) Harrison" share almost no trigrams, and real data misspells
Herrera. The map lives in `scripts/field-aliases.json` under `_team_identity` and the
converter emits the column, so the link survives a re-export rather than being a one-off
SQL update.

Detection now separates the two cases — an overlap whose two sides share an `identity_key`
is one game recorded twice, anything else is a genuine conflict. Verified in prod:
**0 real conflicts, 4 duplicates identified.**

Still open, deliberately: nothing *dedups* those four. Both rows remain, which is correct —
each league legitimately has its own record of the game — but a future ledger or
travel-burden calculation must count them once, not twice.

### Converter inputs must be re-exported, not reused (2026-08-31)

The first conversion runs used `.backups/*-2026-08-27-1108-live.json`, which had gone
**stale within four days**: YWWM8G had grown from 14 fields to 15 and from ~80 scheduled
items to **153** (20 games, 108 practices, 25 events), because it is a live league someone
edits. Every count reported off those files was therefore wrong, including "Red Wing has 6
bookings" — it has **23**.

**Re-export before every conversion run.** Straight from PostgREST to disk with the service
role key, so the blob (which carries coach names, phones and emails) never passes through a
terminal or an agent's context:

```bash
set -a; . ./.env.local; set +a
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/leagues?id=eq.YWWM8G&select=id,data,updated_at,updated_by,view_token,owner_id"   -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"   -o ".backups/YWWM8G-$(date +%Y-%m-%d-%H%M)-live.json"
```

The converter accepts a PostgREST array directly (`Array.isArray(raw) ? raw[0] : raw`), so
that file needs no reshaping.

**Current numbers, from `2026-08-31-2107` exports:** 2 orgs, 2 seasons, **7 venues**,
**15 fields**, 3 grants, 4 divisions, 23 teams, 18 contacts, **162 bookings**
(= 153 + 7 source items, +2 from the two tournaments splitting into per-field blocks).
21 warnings, none blocking.

**Everything decided earlier survived the refresh**, which is the real test of keying
decisions by id rather than by position or text: `[event]` 0, `[suggest]` 0, and
`[geocode]` 0 — the last confirming the Red Wing fix reaches all the way through
conversion.

**One new item: `LSW FIELD (TBD)`** — and my first reading of it was wrong. I called it a
placeholder to delete. It is a deliberate, load-bearing workaround.

**Booking onto a "TBD" field is how these leagues schedule, and it works.** Greg,
2026-08-31: *"It has been very helpful for us to create a field called TBD or TBA and just
use that when we don't know the field. It does mark the team as busy."* Date, time and
teams are routinely known before the field — an opponent has not named their diamond, or
the park assignment lands later. Marking the team busy is the behaviour that matters, and
it falls out for free precisely BECAUSE the game genuinely has a field.

**A design was drafted and then dropped.** It added `location_status`
(`field`/`home_tbd`/`away`/`none`), a `day_part` column and a candidate-field join table.
It was abandoned once Greg said the workaround works: replacing a working model with a
richer one is how you acquire a subsystem nobody asked for. Recorded here so it is not
re-proposed without new evidence. Two facts that killed it: Auto-Schedule is not used
("we don't use the auto scheduler that often if at all"), which removed the one structural
objection; and the confusing coach-view entry needs **no code at all** — CoachView renders
`name · location`, so leaving the location box empty when creating a TBD field renders a
clean `LSW FIELD (TBD)` instead of `LSW FIELD (TBD) · TBD`.

**What DID need fixing is 2.0-only.** Venues and fields here are global and owned by the
first org to define them, so one league's "TBD" would become a shared row others could be
granted against, and two leagues each with one would collide via `unique (venue_id, name)`.
`fd_021` adds `fd2_fields.is_placeholder`; the converter sets it from the TBD/TBA name and
keys placeholders by org id, so they are org-private, never cross-org matched and never
granted — while staying fully bookable. The `[placeholder]` warning is now a **worklist**
("N bookings still awaiting a real field") rather than an instruction to delete a row
someone meant to create.

Verified in prod: the placeholder is org-private, 0 placeholder grants, 0 orphans, and the
3 real shared-field grants still work.

### Field-identity decisions — SETTLED 2026-08-31 (Greg)

**All three suggested merges were REJECTED, on evidence.** They were an artifact, not
duplicates: **1.0 stores ONE geocode per venue**, so every field at a venue carries the
park's coordinate. The design rule is "distance is primary, name similarity only the
tiebreaker" — but *within* a venue the distance is always zero, so the suggester falls
back on names, and the venue name dominates the trigram. That blind spot is the whole
source of the suggestions.

- **Azalea Dirt vs Turf — distinct, PROVEN.** They hold **8 bookings at the identical
  date and time** (2026-06-14 09:00, 06-21, 06-28, 07-05, …). One physical field cannot
  host two events at once. 11 vs 42 bookings, and dirt is not turf.
- **Salisbury Turf vs Grass — distinct** (different surfaces; Grass has 0 bookings, so
  no usage evidence either way — Greg's call).
- **East Meadow Greco vs Cook — distinct** (two named diamonds; both 0 bookings — Greg's call).

Rejections are recorded in `scripts/field-aliases.json` under `_rejected`, and the
converter now skips them, so **a decision made once no longer resurfaces as a warning on
every run.** Two more pairs were rejected the same way (Azalea Cages vs Dirt, vs Turf) —
the identical artifact, surfaced only once the cages were correctly placed into the park.

### Two defects the suggester never flagged

1. **`Red Wing 75` was geocoded to Minnesota — FIXED IN PROD 2026-08-31.**
   Stored coordinate was `44.56247, -92.5338`, **1,609 km** from every other field, from the
   address `Red Wing Lane, Levittown NY 11756`, carrying **23 real bookings** (the
   "6" reported earlier came from a stale 2026-08-27 export; current data has 23).

   **Root cause was the geocode chain, not a bad row.** `/api/geocode` led with an
   Open-Meteo lookup of the bare **venue name** — the least specific input available, with
   no state or country constraint — and returned on first success, so the address was never
   tried. "Red Wing" is a real city in Minnesota. Confirmed against the live API: it returns
   exactly the stored value. `Hicksville` survived the same path only by luck, that venue
   genuinely being in Hicksville.

   **Reordering alone was NOT enough** — that address resolves nowhere, so the chain fell
   straight through to the bare name anyway. The fix is that the bare name is now the LAST
   stage, below the city+state extracted from the address. Open-Meteo indexes populated
   places, not parks, so a bare name only ever yields an *unconstrained* city-level guess;
   the city derived from an address we were actually given is the same granularity but
   anchored to real input. Simulated over all six venues before shipping: Red Wing moves
   1,609 km to Levittown, Hicksville and Central Nassau get *more* precise (they now use
   their street address rather than a city centroid), East Meadow resolves for the first
   time, and nothing regresses.

   The chain moved to `src/lib/geocodeChain.ts` as a pure function so its ORDER is testable
   (`src/lib/geocodeChain.test.ts`, verified to fail when the old order is reintroduced).
   The route delegates to it, so there is one implementation rather than two.

   Production value is now `40.721775, -73.512558`, from a real Nominatim lookup of
   `Levittown, NY` — the same value the corrected chain produces. **No coordinate was
   hand-invented.** Rollback: `.backups/ROLLBACK-redwing-geocode-2026-08-31.sql`; the prior
   value is recorded above in case that gitignored file is ever lost. Verified after the
   write: 0 geocode outliers across all 6 leagues, all 15 YWWM8G fields present with every
   other coordinate byte-identical, 153 scheduled items untouched.

   **Caveat worth knowing:** Levittown's centroid is also what Azalea Road Park stores, so
   the two now sit at the same point and travel burden between them reads 0 km. That is
   city-level accuracy, which is what the chain promises; a precise fix needs a real
   street address for the actual park.

   The converter also emits a `[geocode]` warning for any venue >100 km from the median, so
   the class cannot hide again — leagues are local by nature, and the median resists a few
   bad rows where a mean would not.
2. **`Azalea Cages` had no venue at all** — empty `location`, but byte-identical address and
   coordinates to Azalea Road Park. Now placed there via a `"|<field>"` alias key. The
   "no venue" warning used to say "grouped under Unassigned venue" unconditionally, which
   was false once an alias placed it; it now reports where the field actually landed.

### Free-text event locations — SETTLED 2026-08-31 (Greg)

**All 24 resolved; `[event]` warnings are now 0.** The 24 collapsed to 12 distinct strings
(`Azelea` is a consistent misspelling of Azalea), and 13 were unambiguous:
6 named the Turf, 3 named the Dirt, 1 named Red Wing 75, 2 named MacLaren — which has
exactly one field, so "park only" was never ambiguous there — and 1 more was recoverable
because its **title** named the Turf even though its location field did not.

The remaining 11 named only Azalea Road Park, which has three fields. Greg's calls:
Summer Clinic ×6 → Turf; Tryouts ×2 → Turf; **one-day tournaments ×2 → Turf AND Dirt,
not the cages** (so each emits a `block` per field and is visible to conflict detection);
12U Team Party → **no field**, because a party is not a field booking and should not
block five hours of ball.

**The decisions are keyed by 1.0 event id, not by the location string, and they have to
be** — the single string `"Azelea"` covers a clinic, a 12-hour tournament and the team
party, which resolve three different ways. A string→field table cannot express that.
They live in `scripts/field-aliases.json` under `_event_fields`, each with a
human-readable note. A decided event carries `needs_review: false` — re-flagging a
settled question is what makes a review queue useless — while `source_raw` keeps the
original text verbatim either way.

Two events legitimately end with no field: the team party (decided), and
**"Williamsport Tryout" (2026-05-16), which had no location at all in 1.0** — nothing was
lost in conversion, 1.0 simply never recorded one. Worth a look if that tryout mattered.

Net effect across both passes: warnings **47 → 21**, venues **7 → 6**, fields still **14**
(nothing wrongly merged), bookings **87 → 89** (the two tournaments split into blocks),
and `[suggest]` and `[event]` are both empty.

**Nothing blocking remains.** The 21 are all informational: 14 field names that carry no
base distance, 1 note that Azalea Cages was placed by alias, 1 placeholder opponent
correctly flagged external, 3 `[grant]` lines that are the feature working, 1 division
needing a program set by hand, and the `[geocode]` warning for Red Wing, which is now FIXED in prod (re-run the
converter against fresh data and it will be gone).

The converter is proven against real data (`--self-test` passes; a full run over both
live leagues produced 2 seasons / 7 venues / 14 fields / 21 teams / 87 bookings and
correctly emitted 3 cross-org field grants for Azalea Dirt, Azalea Turf and MacLaren
Turf 60' — the exact double-booking risk 2.0 exists to solve). **47 warnings are not yet
resolved**, and they are the reason nothing was loaded: 24 events carry free-text
locations (`"REDWING 75 TURF"`, `"Azelea - Turf"`) with no field mapping. The field-identity
half of that list is now settled — see the section immediately below.

- `src/db/migrations/fd_016_v2_schema.sql` — 12 tables, 24 policies, 67 objects.
  Header carries a SAFETY CONTRACT: purely additive, only `fd2_*` names, never touches
  `leagues` / `league_snapshots` / `user_subscriptions` / `profiles` / `fd_user_tour` / `app_signups`.
  Validated in a throwaway Docker `postgres:16` with an `auth` schema shim, including RLS
  behaviour across an org boundary.
- `scripts/convert-to-v2.mjs` — 1.0 blob → 2.0 rows. Plain ESM, zero new deps, read-only
  against 1.0, `--self-test` built in. Many orgs → **one global field registry**: first org to
  define a field owns it, later orgs get an `fd2_field_grants` row instead of a duplicate.
  Never auto-merges differently-named records; `--aliases` is the human confirmation step.
  Deterministic UUIDv5 ids + `ON CONFLICT DO UPDATE` → re-runnable.
- `docs/superpowers/specs/2026-08-27-shared-field-registry-design.md` — the design record,
  10 sections, 5 accepted decisions.

### Decisions already made (don't re-litigate)

- **Teams only.** No rosters, no players, no stats — ever. No player table in the schema.
- **Home/away is a coin flip at the field**, not a property of the venue. `home_team_id` is
  nullable with a `home_away_method` column. Travel burden (from `Location`) is the metric
  that can't be corrupted by a flip.
- **Conflicts warn, never refuse.** No exclusion constraint on booking overlap.
- **Team names cross a `detail` grant** — Greg: *"That gives a real clue as to whom to
  contact for resolution, not just Lev-IT."* Org identity crosses too, but only at `detail`;
  at `busy` the booking row itself is invisible.
- **Per-row writes are the concurrency fix.** 1.0's whole-blob rewrite amplified one geocode
  ~590×; two people editing at once would clobber each other.
- LEv-IT is the test case, not the customer shape. This generalizes.

### Blocking prerequisite — DONE

The `fd2_` prefix is registered in the **Table Ownership Map** (`memory/migrations.md`
line 56), which was confirmed before `fd_016` was applied.

## Open threads (none started)

1. **Phase 2 of the field registry** — `fd2_field_busy`, the masked free/busy projection.
   This is where we stopped. RLS is row-level only and *cannot blank columns*, so free/busy
   has to be a separate projection, not a policy.
2. **The xlsx matrix importer** — better next data source than converting a third season.
   (I proposed converting spring separately and withdrew it: season ids key on league code,
   so spring and fall both being `YWWM8G` collide outright, as do 2 team ids.)
3. **Anon-leak sweep on the Education and Web Supabase projects** — the only item with
   unknown risk. They have their own `anon` policies and I have not looked at either.

## Known-unresolved, deliberately deferred

- Cross-org **team** identity — a Force team booked in two leagues at the same hour won't be
  caught in v1 (field identity is solved; team identity isn't).
- The 500KB save cap on the 1.0 blob.
- ~~The `fd_010` guard's blind spot for incremental deletion (see above).~~ **CLOSED
  2026-08-29 by `fd_018`** (`1d5009c`, live in the Sports DB, all 6 leagues seeded):
  a per-league high-water copy in `fd_league_guard_peak`, promoted into
  `league_snapshots` when the league falls below half its peak however many saves
  it took. Still non-blocking. **Separately**, the 2026-09-08 loss of 6 games was a
  different failure — concurrent tabs overwriting each other, 2.5% of the blob, far
  under any size guard — closed 2026-09-09 by `1077280`: the save route now
  compare-and-swaps on `updated_at` and answers 409 instead of overwriting.

## Gotchas worth carrying forward

- **RLS enabled + zero policies = silent deny-all.** Six tables shipped that way in a draft
  because I wrote a *comment* saying "the same two policies apply to…" and never wrote them.
  Symptom was `INSERT 0 0` and empty selects. Write all policies explicitly.
- **`REVOKE … FROM anon` is a no-op** while the default `PUBLIC` grant stands. Revoke from
  `public`, then re-grant, then verify by impersonation.
- The repo's 14 test files are standalone `node:assert` scripts — run them with `npx tsx`
  (documented in their own headers), not a framework.
- Trigram matching on field names alone does not work: venue-alone 0.38, field-alone 0.18,
  concatenated 0.50. **Distance is primary; name similarity is only the tiebreaker.**
  (`pg_trgm` is available but NOT installed, and extensions are database-wide on a shared DB.)
- Use a git worktree for the `dev`→`main` merge; never switch branches in this shared checkout.
