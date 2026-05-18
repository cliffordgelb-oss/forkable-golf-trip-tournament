# Forkable Golf Trip Tournament

A self-hosted scoring app for a multi-round golf trip. Fork it, change the players and rounds to match your trip, deploy it, share the URL with your group.

Originally built for a 6-player / 5-round trip on the Robert Trent Jones Trail. Round formats included:

- **Individual stroke play** — 5/3/1 per hole + 12/8/4 round placement + best-ball match bonus
- **3-man best ball** — 15 points to the winning team
- **3-man scramble** — 15 points to the winning team
- **Championship final** — stroke play with starting strokes seeded from overall standings

A live PGA-style leaderboard, push notifications, and a trash-talk feed come included.

## Tech

- React 19 + Vite (PWA, installable to home screen on iOS/Android)
- Supabase (Postgres + Edge Functions)
- Web Push for notifications

## Quick start

```bash
npm install
cp .env.example .env  # fill in the values below
npm run dev
```

You need a Supabase project and a VAPID key pair before the app is fully functional.

### Environment variables

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here
VITE_VAPID_PUBLIC_KEY=your-vapid-public-key
```

### Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. Enable the `pg_net` extension: **Database → Extensions → pg_net → Enable**.
3. In the SQL editor, edit [`db/schema.sql`](db/schema.sql) to replace `YOUR_PROJECT_REF` (one occurrence, inside `fn_dispatch_notification`) with your Supabase project ref, then run the whole file.
4. Run [`db/seed_courses.sql`](db/seed_courses.sql) — seeds rounds 1-5 + their hole data. Edit this file before running if you have your own courses.
5. Manually seed the `players` table to match `PLAYERS` in [`src/tournament.config.js`](src/tournament.config.js):
   ```sql
   insert into players (id, name, emoji, initials) values
     ('dustin', 'Dustin', '🦅', 'DC'),
     ('cliff',  'Cliff',  '🐅', 'CG');
     -- ...one row per player...
   ```
6. Update [`supabase/config.toml`](supabase/config.toml) — replace `your-project-ref` with your real ref.
7. Deploy the edge function: `supabase functions deploy send-push`.

The `db/migration_*.sql` files describe how the original schema evolved and are kept for reference. **You don't need to run them on a fresh install** — `db/schema.sql` is already the post-migration state.

### Web Push (VAPID) setup

```bash
npx web-push generate-vapid-keys
```

Set the keys as Supabase function secrets:

```bash
supabase secrets set VAPID_PUBLIC_KEY=...
supabase secrets set VAPID_PRIVATE_KEY=...
supabase secrets set VAPID_SUBJECT=mailto:you@example.com
```

And add the public key to your `.env` as `VITE_VAPID_PUBLIC_KEY`.

## Customizing for your trip

Most customization lives in one file:

- **Players, rounds, title, admin, scoring:** [`src/tournament.config.js`](src/tournament.config.js) — edit `PLAYERS`, `ROUNDS`, `TOURNAMENT_TITLE`, `ADMIN_PLAYER_ID`, `CHAMPIONSHIP_ROUND_ID`, `SCORING`
- **Course par + stroke index:** [`db/seed_courses.sql`](db/seed_courses.sql)
- **Branding (app title, PWA manifest, push notification text):** see [`CLAUDE.md`](CLAUDE.md) for the full list

If you use [Claude Code](https://claude.com/claude-code), [`CLAUDE.md`](CLAUDE.md) tells the agent exactly where the customization seams are. Just open the repo in Claude Code and ask it to "swap in our players and rounds" — it will know what to do.

### Recipes for common group sizes

The engine supports **any number of equally-sized groups** (set `NUM_GROUPS`). Tweak `SCORING` so prize arrays match your group size.

**4 players, two 2-somes** — `NUM_GROUPS = 2`, `CHAMPIONSHIP_TIER_SIZE = 2`:
```js
export const SCORING = {
  individual_stroke: { holePoints: [3, 1], placement: [8, 4], matchPlayBonus: 1 },
  best_ball:    { winnerPoints: 10 },
  scramble:     { winnerPoints: 10 },
  championship: { placement: [8, 4] },
};
```

**6 players, two 3-somes (default)** — `NUM_GROUPS = 2`, `CHAMPIONSHIP_TIER_SIZE = 3`:
```js
export const SCORING = {
  individual_stroke: { holePoints: [5, 3, 1], placement: [12, 8, 4], matchPlayBonus: 1 },
  best_ball:    { winnerPoints: 15 },
  scramble:     { winnerPoints: 15 },
  championship: { placement: [12, 8, 4] },
};
```

**8 players, two 4-somes** — `NUM_GROUPS = 2`, `CHAMPIONSHIP_TIER_SIZE = 4`:
```js
export const SCORING = {
  individual_stroke: { holePoints: [6, 4, 2, 0], placement: [16, 10, 6, 2], matchPlayBonus: 2 },
  best_ball:    { winnerPoints: 20 },
  scramble:     { winnerPoints: 20 },
  championship: { placement: [16, 10, 6, 2] },
};
```

**12 players, three 4-somes** — `NUM_GROUPS = 3`, `CHAMPIONSHIP_TIER_SIZE = 4`:
```js
export const SCORING = {
  // Round-robin match play: max 2 wins per team (3 pairs of groups → 3 matches).
  individual_stroke: { holePoints: [6, 4, 2, 0], placement: [16, 10, 6, 2], matchPlayBonus: 2 },
  // Winner takes all across all three teams; ties split.
  best_ball:    { winnerPoints: 20 },
  scramble:     { winnerPoints: 20 },
  // Three tiers of 4 by pre-championship rank.
  championship: { placement: [16, 10, 6, 2] },
};
```

**4 players, single foursome (individual stroke only):** assign all four players to group A in the round setup; leave group B empty. Use the 4-player scoring above. The `best_ball` and `scramble` formats won't award points without two groups, so stick to `individual_stroke` rounds. The championship round still works (top 2 vs bottom 2).

Issues and PRs welcome.

## License

MIT — fork freely.
