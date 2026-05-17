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

## Status

This is an early public release. The frontend and migrations are here, but a **base database schema file is still missing** — see [Known gaps](#known-gaps) below. Until that lands, expect to do some manual SQL work to stand up your own instance.

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
2. Run the base schema (see [Known gaps](#known-gaps)).
3. Run each migration in `db/` in filename order. **Before running `migration_push.sql`, replace `YOUR_PROJECT_REF`** with your Supabase project ref.
4. Run `db/seed_courses.sql` (or replace with your own course data).
5. Update `supabase/config.toml` — replace `your-project-ref` with your real project ref.
6. Deploy the edge function: `supabase functions deploy send-push`

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

- **Players and rounds:** [`src/tournament.config.js`](src/tournament.config.js) — edit `PLAYERS` and `ROUNDS`
- **Course par + stroke index:** [`db/seed_courses.sql`](db/seed_courses.sql)
- **Branding (app title, PWA manifest, push notification text):** see [`CLAUDE.md`](CLAUDE.md) for the full list

If you use [Claude Code](https://claude.com/claude-code), [`CLAUDE.md`](CLAUDE.md) tells the agent exactly where the customization seams are. Just open the repo in Claude Code and ask it to "swap in our players and rounds" — it will know what to do.

## Known gaps

- **No base schema file** — the migrations under `db/` assume a base schema exists, but it isn't checked in. To stand up the app today, you need to reconstruct the schema from the queries in `src/App.jsx` and `supabase/functions/send-push/index.ts`. A bundled `db/schema.sql` is the next planned addition.

Issues and PRs welcome.

## License

MIT — fork freely.
