# CLAUDE.md

Guide for Claude Code agents working on this repo. Read before making edits.

## What this project is

A self-hosted scoring app for a multi-round golf trip. The intent is **fork and customize**: users fork the repo, change the players + rounds to match their trip, and deploy. The original tournament was 6 players / 5 rounds on the Robert Trent Jones Trail; everything is structured so a different group can swap in their own players, rounds, courses, and formats.

## Architecture at a glance

- **Frontend:** React 19 + Vite, single page (`src/App.jsx`, ~2000 lines), PWA (`src/sw.js`)
- **Backend:** Supabase — Postgres for data, one Edge Function (`supabase/functions/send-push`) for Web Push fan-out
- **State:** all live state in Supabase; client subscribes via realtime channel
- **Auth:** lightweight — players pick an identity from `PLAYERS` and a session is stored in localStorage

## The customization surface

When someone asks you to "change the players" or "add a round" or "customize for our group", the **single most important file** is:

### `src/tournament.config.js`

Exports `PLAYERS`, `ROUNDS`, `ADMIN_PLAYER_ID`, `CHAMPIONSHIP_ROUND_ID`, and `TOURNAMENT_TITLE`. Edit these to match the user's trip. App.jsx imports them and derives its internal lookup maps.

- `PLAYERS` — each `{ id, name, emoji, initials }`.
- `ROUNDS` — each `{ id, name, format, desc }`. `format` here is the **display label only**; the scoring engine reads the format key from the DB (see "Format keys" below).
- `ADMIN_PLAYER_ID` — gates admin-only UI (course setup, lock override). Must match one of the player ids, or `null` to disable admin entirely.
- `CHAMPIONSHIP_ROUND_ID` — the round that runs the `championship` format. Cumulative points from every other round feed its starting-stroke ladder. Set to `null` for tournaments without a championship final — the pre-championship leaderboard then spans every round and the "Projected Starting Strokes" card hides.
- `TOURNAMENT_TITLE` — `{ primary, accent }` rendered as `${primary} · ${accent}` in the header and login screen.

### `db/seed_courses.sql`

Hardcoded par + stroke index for each course's 18 holes, keyed by `round_id`. When changing rounds, this file must be re-seeded for each new course.

### Branding strings (not in the config)

The visible app title comes from `TOURNAMENT_TITLE` in the config. The static files below hold neutral defaults (`Golf Tournament`, etc.); update them when a forker wants a custom installed-PWA name or notification text:

- `index.html` — `<title>` and `apple-mobile-web-app-title`
- `vite.config.js` — PWA manifest (`name`, `short_name`, `description`)
- `src/sw.js` — default push title and tag
- `package.json` — `name` field

## Format keys (important)

There are **two** format names per round and they must stay in sync:

1. **UI label** — `format` field in `ROUNDS` (e.g. `'3-Man Best Ball'`). Display only.
2. **Engine key** — `rounds.format` column in the DB. Must be one of `'individual_stroke'`, `'best_ball'`, `'scramble'`, `'championship'`. The scoring engine in `src/App.jsx` (functions `deriveStrokesForFormat`, `computeRoundPoints`, etc.) branches on this.

When adding or changing a round, set both. To add a brand new format (e.g. Stableford, Skins), you need to:
1. Add a new engine key and handle it in `deriveStrokesForFormat` and the `computeRoundPoints` branches near line 226.
2. Update the `ScoringGrid` component to handle the new format's input UI if it differs.
3. Add the new key as an allowed value wherever DB constraints enforce it.

## Scoring engine quick map

All in `src/App.jsx`:

- `getStrokesOnHole` — per-hole strokes allocation given total strokes received and the hole's stroke index
- `deriveStrokesForFormat(strokesMap, formatKey)` — derives effective strokes per player for a round; group-relative for individual stroke, field-relative for everything else
- `computeHoleWinners` — per-hole low-net winner with tie tracking
- `computeMatchPlayState` — live match-play +1-per-hole-won state
- `computeRoundPoints(roundId, scores, strokes, holes, formatKey, cumulativePreR5)` — final round-point allocation; this is the function that varies most by format
- `startingStrokeLadder(n)` — returns the symmetric-around-zero adjustment array for the championship round. For 6 players: `[-3, -2, -1, 0, 1, 2]`. Drives both the projected card on the leaderboard and the actual championship-round scoring.

### Structural assumptions baked into the engine

These are *not* fixed by the config and would require scoring-engine changes if a forker hits them:

- **Two 3-somes for `individual_stroke`** — the per-hole 5/3/1 and round 12/8/4 awards assume each group has exactly 3 players (see `computeRoundPoints` near the `group.length !== 3` check).
- **Top 3 / bottom 3 championship split** — the `championship` branch hardcodes `slice(0, 3)` and `slice(3, 6)`.
- **Specific scoring constants** — 5/3/1 hole points, 12/8/4 placement, 15 pts for best-ball/scramble, +1 match bonus. These *define* each format; changing them means designing a new format.

If a forker has a different player count, point them at these spots.

## DB schema

`db/schema.sql` is the canonical end-state schema. Fresh installs run `schema.sql` then `seed_courses.sql`; the `migration_*.sql` files are historical only. When changing how data is stored, edit `schema.sql` (not the migrations) and add a new migration for users upgrading from an existing install. The push notification triggers (birdie/eagle on score insert, message fan-out) live in `schema.sql` — not in App.jsx — so DB-side scoring changes may need trigger updates too.

Players table is **a duplicate of the PLAYERS array in tournament.config.js** — when a forker changes players, they must update both. The README has a copy-paste seed SQL snippet for this.

## Known gaps

- **Lint baseline is dirty** — the original code has ~12 pre-existing lint errors (unused vars, hook deps). Don't try to fix them as part of unrelated changes; flag them in a separate cleanup.

## Commands

```bash
npm install
npm run dev       # local dev server
npm run build     # production build (verify before opening a PR)
npm run lint      # eslint — note pre-existing baseline
```

## Working principles for this repo

- **Don't refactor for its own sake.** This is a fork-and-customize template; keep `src/App.jsx` legible to a casual forker. New abstraction layers raise the bar to customize.
- **The config file is the customization seam.** Resist the urge to add more "configurable" knobs in App.jsx — if a user needs more than the config provides, they can edit App.jsx directly. Don't pre-build a tournament builder UI.
- **Two-step lookups (UI label + DB engine key) are intentional.** Don't try to unify them without changing the DB schema.
