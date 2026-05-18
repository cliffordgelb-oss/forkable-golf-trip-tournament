// ============================================================
// Tournament configuration
// ------------------------------------------------------------
// This is the main file to edit when forking the app for your
// own trip. Change the players and rounds here. Course par +
// stroke index live in db/seed_courses.sql.
//
// Each player needs:
//   id       short slug, lowercase, unique (used as DB key)
//   name     display name
//   emoji    one emoji that represents them on the leaderboard
//   initials 2-3 chars shown when space is tight
//
// Each round needs:
//   id     integer, 1..N, must match the rounds table row id
//   name   shown as the round heading in the app
//   format display label only — the *scoring engine* reads
//          the format key from the rounds table (rounds.format
//          must be one of: 'individual_stroke', 'best_ball',
//          'scramble', 'championship'). Keep them in sync.
//   desc   the round's scoring rules, shown on the Formats tab
//
// ADMIN_PLAYER_ID gates admin-only UI (course setup, round
// lock override, etc.). Must match one of the PLAYERS ids
// above, or null to disable admin features entirely.
//
// CHAMPIONSHIP_ROUND_ID is the round that uses the
// 'championship' format — cumulative points from every other
// round feed its starting-stroke adjustments. Set to null if
// your tournament doesn't have a championship final; the
// pre-championship leaderboard then spans every round and the
// starting-strokes card hides.
// ============================================================

export const ADMIN_PLAYER_ID = 'cliff';

export const CHAMPIONSHIP_ROUND_ID = 5;

// Two-part app title rendered in the header and on the login
// screen as: `${primary} · ${accent}` (with the dot styled).
export const TOURNAMENT_TITLE = { primary: 'GOLF', accent: 'TRIP' };

// Scoring values for each format. All point arrays are ranked
// from first prize to last; ties split the affected prizes
// (e.g. T1 in a 3-some with [5,3,1] = both get 4). If a group
// has more players than the array has entries, the extra ranks
// get 0 — so [5, 3, 1] is fine for 3-somes and for 4-somes
// where the 4th place earns nothing, or use [5, 3, 1, 0]
// explicitly. Recipes for common sizes are in the README.
//
// Engine assumptions still in force: best_ball and scramble
// require exactly two groups (A and B). Tournaments with one
// group can only use individual_stroke (and optionally
// championship). Three or more groups are not yet supported by
// the engine — see CLAUDE.md for the structural limits.
export const SCORING = {
  individual_stroke: {
    holePoints:     [5, 3, 1],   // per-hole rank within group
    placement:      [12, 8, 4],  // round placement within group
    matchPlayBonus: 1,           // +N to each player on team winning the A-vs-B 18-hole best-ball match
  },
  best_ball:    { winnerPoints: 15 },
  scramble:     { winnerPoints: 15 },
  championship: {
    placement: [12, 8, 4],       // within each half (championship tier + consolation tier)
  },
};

export const PLAYERS = [
  { id: 'dustin', name: 'Dustin', emoji: '🦅', initials: 'DC' },
  { id: 'cliff',  name: 'Cliff',  emoji: '🐅', initials: 'CG' },
  { id: 'andrew', name: 'Andrew', emoji: '🦁', initials: 'AK' },
  { id: 'kushel', name: 'Kushel', emoji: '🐺', initials: 'DK' },
  { id: 'robert', name: 'Robert', emoji: '🦊', initials: 'RH' },
  { id: 'conner', name: 'Conner', emoji: '🐻', initials: 'CW' },
];

export const ROUNDS = [
  {
    id: 1,
    name: 'R1 · Oxmoor Valley, Ridge',
    format: 'Individual Stroke Play',
    desc: 'Each hole in your 3-some: 5/3/1 pts for low/mid/high net (ties split). Sum hole points → 12/8/4 to 1st/2nd/3rd in group (ties split). +1 each to the team that wins the 18-hole best-ball match vs the other 3-some (field handicaps); tied match is a wash.',
  },
  {
    id: 2,
    name: 'R2 · Ross Bridge',
    format: '3-Man Best Ball',
    desc: 'Everyone plays own ball. Each hole, team score = best net score among 3. Winning team: 15 pts each.',
  },
  {
    id: 3,
    name: 'R3 · Grand National, Lake',
    format: 'Individual Stroke Play',
    desc: 'Same as R1. Per hole: 5/3/1 in your 3-some (ties split). 12/8/4 for round placement (ties split). +1 each for winning best-ball match vs the other team; tied match is a wash.',
  },
  {
    id: 4,
    name: 'R4 · Grand National, Links',
    format: '3-Man Scramble',
    desc: 'All tee off, pick best drive, all play from there. Lowest team score wins. 15 pts each.',
  },
  {
    id: 5,
    name: 'R5 · Capitol Hill, Senator',
    format: 'Championship Final',
    desc: 'Individual stroke play. Starting strokes based on overall standings: 1st -3, 2nd -2, 3rd -1, 4th E, 5th +1, 6th +2.',
  },
];
