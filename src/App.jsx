import { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { createClient } from '@supabase/supabase-js';
import {
  Trophy, MessageCircle, BarChart3, Award, LogOut, Send,
  Flag, Target, Zap, ChevronRight, ChevronDown, ChevronUp, Settings, Bell, BellOff, Lock, Check, X, RefreshCw,
} from 'lucide-react';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

const PLAYER_LIST = [
  { id: 'dustin', name: 'Dustin', emoji: '🦅', initials: 'DC' },
  { id: 'cliff',  name: 'Cliff',  emoji: '🐅', initials: 'CG' },
  { id: 'andrew', name: 'Andrew', emoji: '🦁', initials: 'AK' },
  { id: 'kushel', name: 'Kushel', emoji: '🐺', initials: 'DK' },
  { id: 'robert', name: 'Robert', emoji: '🦊', initials: 'RH' },
  { id: 'conner', name: 'Conner', emoji: '🐻', initials: 'CW' },
];

const ROUND_INFO = {
  1: { name: 'R1 · Oxmoor Valley, Ridge', format: 'Individual Stroke Play', desc: 'Each hole in your 3-some: 5/3/1 pts for low/mid/high net (ties split). Sum hole points → 12/8/4 to 1st/2nd/3rd in group (ties split). +1 each to the team that wins the 18-hole best-ball match vs the other 3-some (field handicaps); tied match is a wash.' },
  2: { name: 'R2 · Ross Bridge', format: '3-Man Best Ball', desc: 'Everyone plays own ball. Each hole, team score = best net score among 3. Winning team: 15 pts each.' },
  3: { name: 'R3 · Grand National, Lake', format: 'Individual Stroke Play', desc: 'Same as R1. Per hole: 5/3/1 in your 3-some (ties split). 12/8/4 for round placement (ties split). +1 each for winning best-ball match vs the other team; tied match is a wash.' },
  4: { name: 'R4 · Grand National, Links', format: '3-Man Scramble', desc: 'All tee off, pick best drive, all play from there. Lowest team score wins. 15 pts each.' },
  5: { name: 'R5 · Capitol Hill, Senator', format: 'Championship Final', desc: 'Individual stroke play. Starting strokes based on overall standings: 1st -3, 2nd -2, 3rd -1, 4th E, 5th +1, 6th +2.' },
};

const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
};

// ============== HELPERS ==============
const getStrokesOnHole = (totalStrokes, strokeIndex) => {
  if (!strokeIndex || totalStrokes <= 0) return 0;
  const fullRound = Math.floor(totalStrokes / 18);
  const remainder = totalStrokes % 18;
  return fullRound + (strokeIndex <= remainder ? 1 : 0);
};

// Given strokes-table entries (each containing { handicap, group_assignment }) and a round
// format, derive each player's "effective strokes received" for that round:
// - individual_stroke: handicap minus min handicap in their 3-some
// - best_ball / scramble / championship: handicap minus min handicap across the field of 6
// Returns: { [pid]: number }
const deriveStrokesForFormat = (strokesMap, formatKey) => {
  const out = {};
  const allHandicaps = Object.values(strokesMap || {}).map(s => Number(s?.handicap) || 0);
  if (allHandicaps.length === 0) return out;
  const fieldMin = Math.min(...allHandicaps);
  const groupMin = (g) => {
    const hcps = Object.values(strokesMap)
      .filter(s => s?.group_assignment === g)
      .map(s => Number(s?.handicap) || 0);
    return hcps.length ? Math.min(...hcps) : 0;
  };
  const groupMins = { A: groupMin('A'), B: groupMin('B') };
  const fieldRelative = formatKey === 'best_ball' || formatKey === 'scramble' || formatKey === 'championship';
  for (const [pid, s] of Object.entries(strokesMap)) {
    if (!s) continue;
    const hcp = Number(s.handicap) || 0;
    const ref = fieldRelative ? fieldMin : (groupMins[s.group_assignment] ?? 0);
    out[pid] = Math.max(0, hcp - ref);
  }
  return out;
};

// Per-hole hole-winner lookup (lowest net wins, tied = halved).
// effectiveStrokes is a flat map { pid: derivedStrokesForRound }.
const computeHoleWinners = (players, sortedHoles, scores, effectiveStrokes) => {
  const result = {};
  for (const h of sortedHoles) {
    const nets = [];
    let allEntered = true;
    for (const p of players) {
      const s = scores.find(sc => sc.player_id === p.id && sc.hole === h.hole);
      if (!s) { allEntered = false; break; }
      const so = getStrokesOnHole(effectiveStrokes[p.id] || 0, h.stroke_index);
      nets.push({ pid: p.id, net: s.gross - so });
    }
    if (!allEntered) continue;
    const minNet = Math.min(...nets.map(n => n.net));
    const lowest = nets.filter(n => n.net === minNet);
    if (lowest.length === 1) result[h.hole] = { winner: lowest[0].pid, tiedPids: null };
    else result[h.hole] = { winner: null, tiedPids: lowest.map(l => l.pid) };
  }
  return result;
};

// Live match-play state: per-hole low net wins +1; ties don't count.
const computeMatchPlayState = (players, sortedHoles, scores, effectiveStrokes) => {
  const wins = Object.fromEntries(players.map(p => [p.id, 0]));
  let halved = 0;
  let throughHole = 0;
  for (const h of sortedHoles) {
    const nets = [];
    let allEntered = true;
    for (const p of players) {
      const s = scores.find(sc => sc.player_id === p.id && sc.hole === h.hole);
      if (!s) { allEntered = false; break; }
      const so = getStrokesOnHole(effectiveStrokes[p.id] || 0, h.stroke_index);
      nets.push({ pid: p.id, net: s.gross - so });
    }
    if (!allEntered) break;
    const minNet = Math.min(...nets.map(n => n.net));
    const winners = nets.filter(n => n.net === minNet);
    if (winners.length === 1) wins[winners[0].pid] += 1;
    else halved += 1;
    throughHole = h.hole;
  }
  const sorted = Object.entries(wins).sort((a, b) => b[1] - a[1]);
  let summary = null;
  if (throughHole > 0) {
    if (sorted.length >= 2 && sorted[0][1] > sorted[1][1]) {
      const leader = PLAYER_LIST.find(p => p.id === sorted[0][0]);
      summary = { kind: 'leader', leader, margin: sorted[0][1] - sorted[1][1], throughHole };
    } else {
      summary = { kind: 'tied', throughHole };
    }
  }
  return { wins, halved, throughHole, summary };
};

// "5 min ago" / "2h ago" / short date for older
const relTime = (iso) => {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric' });
};

const scoreLabel = (gross, par) => {
  if (!gross) return '';
  const diff = gross - par;
  if (diff <= -2) return 'eagle';
  if (diff === -1) return 'birdie';
  if (diff === 0) return 'par';
  if (diff === 1) return 'bogey';
  return 'double';
};

// Per-group hole-point standings for R1/R3 (individual stroke). Awards 5/3/1 per hole with
// tied players averaging adjacent prizes (T1 → 4/4/1, T-last → 5/2/2, all tied → 3/3/3).
// Stops counting at the first hole not all 3 players have entered.
// Returns { totals: { [pid]: number }, thruHole: number }.
const computeHolePointStandings = (group, sortedHoles, scores, effectiveStrokes) => {
  const totals = Object.fromEntries(group.map(pid => [pid, 0]));
  let thruHole = 0;
  if (group.length !== 3) return { totals, thruHole };
  for (const h of sortedHoles) {
    const entries = [];
    let allEntered = true;
    for (const pid of group) {
      const s = scores.find(sc => sc.player_id === pid && sc.hole === h.hole);
      if (!s) { allEntered = false; break; }
      const so = getStrokesOnHole(effectiveStrokes[pid] || 0, h.stroke_index);
      entries.push({ pid, value: s.gross - so });
    }
    if (!allEntered) break;
    const alloc = allocate3WaySplit(entries, [5, 3, 1], true);
    for (const pid of Object.keys(alloc)) totals[pid] += alloc[pid];
    thruHole = h.hole;
  }
  return { totals, thruHole };
};

// Team A vs Team B best-ball match play using field-relative handicaps. Per hole, lowest
// net in each group is the team's score; +1 to the side whose net is lower, ties don't count.
// Stops at first hole either team hasn't fully entered. Returns { aHolesUp, thruHole } where
// aHolesUp is positive when A leads, negative when B leads.
const computeTeamBestBallMatch = (groupA, groupB, sortedHoles, scores, fieldStrokes) => {
  let aHolesUp = 0;
  let thruHole = 0;
  if (groupA.length === 0 || groupB.length === 0) return { aHolesUp, thruHole };
  for (const h of sortedHoles) {
    const bestNet = (group) => {
      const nets = [];
      for (const pid of group) {
        const s = scores.find(sc => sc.player_id === pid && sc.hole === h.hole);
        if (!s) return null;
        const so = getStrokesOnHole(fieldStrokes[pid] || 0, h.stroke_index);
        nets.push(s.gross - so);
      }
      return nets.length ? Math.min(...nets) : null;
    };
    const aNet = bestNet(groupA);
    const bNet = bestNet(groupB);
    if (aNet == null || bNet == null) break;
    if (aNet < bNet) aHolesUp += 1;
    else if (bNet < aNet) aHolesUp -= 1;
    thruHole = h.hole;
  }
  return { aHolesUp, thruHole };
};

// Split a 3-tier prize pool among 3 entries; tied entries average the prizes they collectively cover.
// entries: [{ pid, value }] length 3. prizes: [first, second, third].
// betterIsLower=true → smallest value wins (use for net scores); false → largest wins (use for point totals).
const allocate3WaySplit = (entries, prizes, betterIsLower) => {
  const sorted = [...entries].sort((a, b) => betterIsLower ? a.value - b.value : b.value - a.value);
  const out = {};
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j].value === sorted[i].value) j++;
    const slice = prizes.slice(i, j);
    const avg = slice.reduce((s, v) => s + v, 0) / slice.length;
    for (let k = i; k < j; k++) out[sorted[k].pid] = avg;
    i = j;
  }
  return out;
};

const computeRoundPoints = (roundId, scores, strokes, holes, format, cumulativePreR5 = null) => {
  const points = {};
  PLAYER_LIST.forEach(p => points[p.id] = 0);
  const groupA = Object.entries(strokes).filter(([_, s]) => s?.group_assignment === 'A').map(([id]) => id);
  const groupB = Object.entries(strokes).filter(([_, s]) => s?.group_assignment === 'B').map(([id]) => id);
  const effectiveStrokes = deriveStrokesForFormat(strokes, format);

  if (format === 'individual_stroke') {
    const sortedHoles = [...holes].sort((a, b) => a.hole - b.hole);
    // Per-hole 5/3/1 within each group (group-relative handicaps) — used only to rank placement; not added to leaderboard.
    const aStandings = computeHolePointStandings(groupA, sortedHoles, scores, effectiveStrokes);
    const bStandings = computeHolePointStandings(groupB, sortedHoles, scores, effectiveStrokes);

    // Round placement: 12/8/4 within each group by total hole-points (ties split). Only fires when all 18 played.
    const awardRoundPlaces = (group, standings) => {
      if (group.length !== 3 || standings.thruHole !== 18) return;
      const entries = group.map(pid => ({ pid, value: standings.totals[pid] }));
      const alloc = allocate3WaySplit(entries, [12, 8, 4], false);
      for (const pid of Object.keys(alloc)) points[pid] += alloc[pid];
    };
    awardRoundPlaces(groupA, aStandings);
    awardRoundPlaces(groupB, bStandings);

    // Team match-play +1: A vs B best-ball, field-relative handicaps. Tied match = wash.
    if (aStandings.thruHole === 18 && bStandings.thruHole === 18) {
      const fieldStrokes = deriveStrokesForFormat(strokes, 'best_ball');
      const match = computeTeamBestBallMatch(groupA, groupB, sortedHoles, scores, fieldStrokes);
      const winners = match.aHolesUp > 0 ? groupA : (match.aHolesUp < 0 ? groupB : []);
      winners.forEach(pid => { points[pid] += 1; });
    }
  } else if (format === 'best_ball') {
    let aTotal = 0, bTotal = 0; let allHolesPlayed = true;
    for (let h = 1; h <= 18; h++) {
      const hole = holes.find(hh => hh.hole === h);
      const aNets = groupA.map(pid => {
        const s = scores.find(sc => sc.player_id === pid && sc.hole === h);
        if (!s) return null;
        return s.gross - getStrokesOnHole(effectiveStrokes[pid] || 0, hole?.stroke_index);
      }).filter(v => v !== null);
      const bNets = groupB.map(pid => {
        const s = scores.find(sc => sc.player_id === pid && sc.hole === h);
        if (!s) return null;
        return s.gross - getStrokesOnHole(effectiveStrokes[pid] || 0, hole?.stroke_index);
      }).filter(v => v !== null);
      if (aNets.length === 0 || bNets.length === 0) { allHolesPlayed = false; break; }
      aTotal += Math.min(...aNets);
      bTotal += Math.min(...bNets);
    }
    if (allHolesPlayed) {
      const winners = aTotal < bTotal ? groupA : groupB;
      winners.forEach(pid => { points[pid] += 15; });
    }
  } else if (format === 'scramble') {
    const aCaptain = groupA[0], bCaptain = groupB[0];
    const aScores = scores.filter(s => s.player_id === aCaptain);
    const bScores = scores.filter(s => s.player_id === bCaptain);
    if (aScores.length === 18 && bScores.length === 18) {
      let aTotal = 0, bTotal = 0;
      // Team handicap = lowest field-relative strokes on the team (most generous interpretation)
      const teamMinA = Math.min(...groupA.map(pid => effectiveStrokes[pid] || 0));
      const teamMinB = Math.min(...groupB.map(pid => effectiveStrokes[pid] || 0));
      aScores.forEach(s => { const hole = holes.find(h => h.hole === s.hole); aTotal += s.gross - getStrokesOnHole(teamMinA, hole?.stroke_index); });
      bScores.forEach(s => { const hole = holes.find(h => h.hole === s.hole); bTotal += s.gross - getStrokesOnHole(teamMinB, hole?.stroke_index); });
      const winners = aTotal < bTotal ? groupA : groupB;
      winners.forEach(pid => { points[pid] += 15; });
    }
  } else if (format === 'championship') {
    // R5: each player's R5 net + position-based starting strokes from R1-R4 standings.
    // Top 3 by going-in cumulative form a championship trio; bottom 3 form consolation.
    // 12/8/4 awarded within each trio by lowest adjusted net.
    if (!cumulativePreR5) return points;
    const ranked = PLAYER_LIST.slice().sort((a, b) =>
      (cumulativePreR5[b.id] || 0) - (cumulativePreR5[a.id] || 0)
    );
    const ladder = [-3, -2, -1, 0, 1, 2];
    const adjustment = {};
    ranked.forEach((p, i) => { adjustment[p.id] = ladder[i] ?? 0; });
    const championshipIds = ranked.slice(0, 3).map(p => p.id);
    const consolationIds = ranked.slice(3, 6).map(p => p.id);

    const adjustedNet = {};
    PLAYER_LIST.forEach(p => {
      const playerScores = scores.filter(s => s.player_id === p.id);
      if (playerScores.length !== 18) return;
      const totalStrokes = effectiveStrokes[p.id] || 0;
      let net = 0;
      playerScores.forEach(s => {
        const hole = holes.find(h => h.hole === s.hole);
        net += s.gross - getStrokesOnHole(totalStrokes, hole?.stroke_index);
      });
      adjustedNet[p.id] = net + (adjustment[p.id] || 0);
    });

    const rankAndAward = (groupIds) => {
      const sorted = groupIds
        .filter(pid => adjustedNet[pid] !== undefined)
        .sort((a, b) => adjustedNet[a] - adjustedNet[b]);
      const pts = [12, 8, 4];
      sorted.forEach((pid, i) => { points[pid] += pts[i] || 0; });
    };
    rankAndAward(championshipIds);
    rankAndAward(consolationIds);
  }
  return points;
};

// ============== APP ==============
export default function App() {
  const supabase = useMemo(() => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: { params: { eventsPerSecond: 10 } },
    });
  }, []);

  const [user, setUser] = useState(() => {
    try {
      const raw = localStorage.getItem('bama_user');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.user && parsed.expiresAt && Date.now() < parsed.expiresAt) {
        return parsed.user;
      }
      localStorage.removeItem('bama_user');
      return null;
    } catch { return null; }
  });

  const persistUser = (u) => {
    setUser(u);
    try {
      if (u) {
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
        localStorage.setItem('bama_user', JSON.stringify({ user: u, expiresAt }));
      } else {
        localStorage.removeItem('bama_user');
      }
    } catch { /* ignore */ }
  };

  if (!supabase) {
    return (
      <div className="login-bg">
        <div className="login-card">
          <h1>BAMA <span style={{color:'var(--gold)'}}>·</span> GOLF</h1>
          <div className="sub">Missing Supabase config.</div>
          <p style={{fontSize:'0.9rem', color:'var(--green-mid)'}}>
            Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in <code>.env.local</code>, then restart the dev server.
          </p>
        </div>
      </div>
    );
  }

  if (!user) return <Login supabase={supabase} onLogin={persistUser} />;
  return <Main supabase={supabase} user={user} onLogout={() => persistUser(null)} />;
}

// ============== NOTIFICATION TOGGLE ==============
function NotificationToggle({ supabase, user }) {
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      if (typeof window === 'undefined') return;
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        setSupported(false); return;
      }
      setSupported(true);
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        setSubscribed(!!sub && Notification.permission === 'granted');
      } catch { /* ignore */ }
    })();
  }, []);

  const enable = async () => {
    if (!VAPID_PUBLIC_KEY) {
      alert('VAPID public key missing. Set VITE_VAPID_PUBLIC_KEY and redeploy.');
      return;
    }
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setBusy(false); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      const json = sub.toJSON();
      await supabase.from('push_subscriptions').upsert({
        player_id: user.id,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      }, { onConflict: 'endpoint' });
      setSubscribed(true);
    } catch (err) {
      console.error('push subscribe failed', err);
      alert('Could not enable notifications. ' + (err?.message || ''));
    } finally { setBusy(false); }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch (err) {
      console.error('push unsubscribe failed', err);
    } finally { setBusy(false); }
  };

  if (!supported) return null;

  return (
    <button
      className="btn ghost sm"
      style={{borderColor:'var(--cream)', color:'var(--cream)', opacity: busy ? 0.5 : 1}}
      onClick={subscribed ? disable : enable}
      disabled={busy}
      aria-label={subscribed ? 'Notifications on (tap to disable)' : 'Enable notifications'}
      title={subscribed ? 'Notifications on' : 'Enable notifications'}
    >
      {subscribed ? <Bell size={14} /> : <BellOff size={14} />}
    </button>
  );
}

// ============== LOGIN ==============
function Login({ supabase, onLogin }) {
  const [selected, setSelected] = useState(null);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!selected || !password) return;
    setBusy(true); setErr('');
    const { data, error } = await supabase
      .from('players').select('*').eq('id', selected).single();
    setBusy(false);
    if (error || !data) { setErr('Could not find player.'); return; }
    if (data.password !== password) { setErr('Wrong password.'); return; }
    onLogin({ id: data.id, name: data.name, emoji: data.emoji });
  };

  return (
    <div className="login-bg">
      <div className="login-card">
        <h1>BAMA <span style={{color:'var(--gold)'}}>·</span> GOLF</h1>
        <div className="sub">Pick your name, then enter your password.</div>
        <div className="player-grid">
          {PLAYER_LIST.map(p => (
            <div key={p.id}
              className={`player-tile ${selected === p.id ? 'selected' : ''}`}
              onClick={() => setSelected(p.id)}>
              <span className="emo">{p.emoji}</span>
              <div className="nm">{p.name}</div>
            </div>
          ))}
        </div>
        {selected && (
          <>
            <label>Password <span style={{textTransform:'none', letterSpacing:0, fontWeight:400, color:'var(--green-mid)', opacity:0.85}}>(hint: UNI)</span></label>
            <input type="password" value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
              autoFocus />
            {err && <div style={{color:'var(--red-flag)', marginTop:'0.5rem', fontSize:'0.9rem'}}>{err}</div>}
            <div style={{marginTop:'1rem', display:'flex', gap:'0.5rem'}}>
              <button className="btn gold" onClick={submit} disabled={busy}>
                Tee off <ChevronRight size={16} style={{verticalAlign:'middle'}} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============== MAIN ==============
function Main({ supabase, user, onLogout }) {
  const [tab, setTab] = useState('leaderboard');
  const [rounds, setRounds] = useState([]);
  const [allScores, setAllScores] = useState([]);
  const [allStrokes, setAllStrokes] = useState({});
  const [allHoles, setAllHoles] = useState({});
  const [allRoundPoints, setAllRoundPoints] = useState({});
  const [messages, setMessages] = useState([]);
  const [toast, setToast] = useState(null);
  const [celebration, setCelebration] = useState(null);
  const [resumeTick, setResumeTick] = useState(0);
  const lastBirdieIdRef = useRef(null);
  const allStrokesRef = useRef({});
  const allHolesRef = useRef({});
  const roundsRef = useRef([]);

  useEffect(() => { allStrokesRef.current = allStrokes; }, [allStrokes]);
  useEffect(() => { allHolesRef.current = allHoles; }, [allHoles]);
  useEffect(() => { roundsRef.current = rounds; }, [rounds]);

  useEffect(() => {
    (async () => {
      const [rRes, sRes, stRes, hRes, rpRes, mRes] = await Promise.all([
        supabase.from('rounds').select('*').order('id'),
        supabase.from('scores').select('*'),
        supabase.from('round_strokes').select('*'),
        supabase.from('holes').select('*'),
        supabase.from('round_points').select('*'),
        supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(100),
      ]);
      setRounds(rRes.data || []);
      setAllScores(sRes.data || []);
      const st = {};
      (stRes.data || []).forEach(r => { st[r.round_id] = st[r.round_id] || {}; st[r.round_id][r.player_id] = r; });
      setAllStrokes(st);
      const h = {};
      (hRes.data || []).forEach(hole => { h[hole.round_id] = h[hole.round_id] || []; h[hole.round_id].push(hole); });
      setAllHoles(h);
      const rp = {};
      (rpRes.data || []).forEach(r => { rp[r.round_id] = rp[r.round_id] || {}; rp[r.round_id][r.player_id] = Number(r.points); });
      setAllRoundPoints(rp);
      setMessages((mRes.data || []).reverse());
      lastBirdieIdRef.current = sRes.data && sRes.data.length ? Math.max(...sRes.data.map(s => s.id)) : 0;
    })();
  }, [supabase, resumeTick]);

  useEffect(() => {
    const checkBirdieAndAlert = (score) => {
      const holesForRound = allHolesRef.current[score.round_id] || [];
      const hole = holesForRound.find(h => h.hole === score.hole);
      if (!hole) return;
      const round = roundsRef.current.find(r => r.id === score.round_id);
      const roundStrokes = allStrokesRef.current[score.round_id] || {};
      const effective = deriveStrokesForFormat(roundStrokes, round?.format);
      const so = getStrokesOnHole(effective[score.player_id] || 0, hole.stroke_index);
      const net = score.gross - so;
      const player = PLAYER_LIST.find(p => p.id === score.player_id);
      if (!player) return;
      if (net <= hole.par - 2) setCelebration({ kind: 'eagle', player, hole: score.hole, key: score.id });
      else if (net <= hole.par - 1) setCelebration({ kind: 'birdie', player, hole: score.hole, key: score.id });
    };

    const chan = supabase.channel('bama-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scores' }, payload => {
        setAllScores(prev => {
          if (payload.eventType === 'INSERT') {
            if (payload.new.id > (lastBirdieIdRef.current || 0)) { lastBirdieIdRef.current = payload.new.id; checkBirdieAndAlert(payload.new); }
            if (prev.find(s => s.id === payload.new.id)) return prev;
            return [...prev, payload.new];
          }
          if (payload.eventType === 'UPDATE') return prev.map(s => s.id === payload.new.id ? payload.new : s);
          if (payload.eventType === 'DELETE') return prev.filter(s => s.id !== payload.old.id);
          return prev;
        });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, payload => {
        if (payload.eventType === 'INSERT') setMessages(prev => [...prev, payload.new]);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'round_points' }, payload => {
        if (payload.new) setAllRoundPoints(prev => ({ ...prev, [payload.new.round_id]: { ...(prev[payload.new.round_id] || {}), [payload.new.player_id]: Number(payload.new.points) } }));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'round_strokes' }, payload => {
        if (payload.new) setAllStrokes(prev => ({ ...prev, [payload.new.round_id]: { ...(prev[payload.new.round_id] || {}), [payload.new.player_id]: payload.new } }));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds' }, payload => {
        if (payload.new) setRounds(prev => prev.map(r => r.id === payload.new.id ? payload.new : r));
      })
      .subscribe();
    return () => supabase.removeChannel(chan);
  }, [supabase, resumeTick]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setResumeTick(t => t + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(null), 4500); return () => clearTimeout(t); }
  }, [toast]);

  useEffect(() => {
    if (celebration) { const t = setTimeout(() => setCelebration(null), 3200); return () => clearTimeout(t); }
  }, [celebration?.key]);

  const cumulative = useMemo(() => {
    const totals = {};
    PLAYER_LIST.forEach(p => totals[p.id] = 0);
    Object.values(allRoundPoints).forEach(roundPts => {
      Object.entries(roundPts).forEach(([pid, pts]) => { totals[pid] = (totals[pid] || 0) + pts; });
    });
    return totals;
  }, [allRoundPoints]);

  // Going-into-R5 standings = sum of R1-R4 points only.
  // Drives R5 starting strokes (-3 / -2 / -1 / E / +1 / +2 by rank).
  const cumulativePreR5 = useMemo(() => {
    const totals = {};
    PLAYER_LIST.forEach(p => totals[p.id] = 0);
    [1, 2, 3, 4].forEach(r => {
      const pts = allRoundPoints[r] || {};
      PLAYER_LIST.forEach(p => { totals[p.id] += pts[p.id] || 0; });
    });
    return totals;
  }, [allRoundPoints]);

  // R5 starting-stroke adjustments by ranking (1st = -3, 6th = +2).
  const r5Adjustments = useMemo(() => {
    const ranked = PLAYER_LIST.slice().sort((a, b) =>
      (cumulativePreR5[b.id] || 0) - (cumulativePreR5[a.id] || 0)
    );
    const out = {};
    const ladder = [-3, -2, -1, 0, 1, 2];
    ranked.forEach((p, i) => { out[p.id] = ladder[i] ?? 0; });
    return out;
  }, [cumulativePreR5]);

  const isAdmin = user.id === 'cliff';

  return (
    <div className="app-root">
      <div className="hdr-stack">
        <div className="hdr">
          <h1>BAMA <span className="accent">·</span> GOLF</h1>
          <div className="hdr-user">
            <span style={{fontSize:'1.4rem'}}>{user.emoji}</span>
            <span>{user.name}</span>
            <NotificationToggle supabase={supabase} user={user} />
            <button className="btn ghost sm" style={{borderColor:'var(--cream)', color:'var(--cream)'}} onClick={onLogout}>
              <LogOut size={14} />
            </button>
          </div>
        </div>

        <nav className="nav">
          <button className={tab==='leaderboard'?'active':''} onClick={()=>setTab('leaderboard')}><Trophy size={16}/> Board</button>
          <button className={tab==='live'?'active':''} onClick={()=>setTab('live')}><Flag size={16}/> Live</button>
          <button className={tab==='heatmap'?'active':''} onClick={()=>setTab('heatmap')}><BarChart3 size={16}/> Heatmap</button>
          <button className={tab==='trash'?'active':''} onClick={()=>setTab('trash')}><MessageCircle size={16}/> Talk</button>
          <button className={tab==='awards'?'active':''} onClick={()=>setTab('awards')}><Award size={16}/> Awards</button>
          <button className={tab==='formats'?'active':''} onClick={()=>setTab('formats')}><Target size={16}/> Rules</button>
        </nav>
      </div>

      <div className="container">
        {tab === 'leaderboard' && <Leaderboard cumulative={cumulative} user={user} allRoundPoints={allRoundPoints} />}
        {tab === 'live' && <LivePanel supabase={supabase} user={user} rounds={rounds} allScores={allScores} allStrokes={allStrokes} allHoles={allHoles} isAdmin={isAdmin} cumulativePreR5={cumulativePreR5} r5Adjustments={r5Adjustments} onRefresh={() => setResumeTick(t => t + 1)} />}
        {tab === 'heatmap' && <Heatmap allScores={allScores} allHoles={allHoles} allStrokes={allStrokes} rounds={rounds} />}
        {tab === 'trash' && <TrashTalk supabase={supabase} user={user} messages={messages} />}
        {tab === 'awards' && <Awards allScores={allScores} allHoles={allHoles} allStrokes={allStrokes} allRoundPoints={allRoundPoints} rounds={rounds} />}
        {tab === 'formats' && <Formats />}
      </div>

      {toast && (
        <div className="alert-toast">
          <Zap size={20} color="var(--gold-bright)" />
          <span>{toast.text}</span>
        </div>
      )}

      {celebration && <CelebrationOverlay key={celebration.key} celebration={celebration} />}
    </div>
  );
}

// ============== CELEBRATION OVERLAY (90s arcade style) ==============
function CelebrationOverlay({ celebration }) {
  const isEagle = celebration.kind === 'eagle';
  const title = isEagle ? 'EAGLE!' : 'BIRDIE!';
  return (
    <div className={`celebration-overlay ${isEagle ? 'is-eagle' : 'is-birdie'}`} aria-live="polite">
      <div className="celebration-sparkles">
        {[...Array(8)].map((_, i) => (
          <span key={i} className="celebration-sparkle" style={{
            top: `${10 + (i * 79) % 80}%`,
            left: `${5 + (i * 47) % 90}%`,
            animationDelay: `${i * 0.1}s`,
            fontSize: `${1.6 + (i % 3) * 0.4}rem`,
          }}>{isEagle ? '⭐' : '✨'}</span>
        ))}
      </div>
      <div className="celebration-banner">
        <div className="celebration-text">
          {title.split('').map((c, i) => (
            <span key={i} style={{ animationDelay: `${i * 0.04}s` }}>{c}</span>
          ))}
        </div>
        <div className="celebration-subtitle">
          <span className="celebration-emoji">{celebration.player.emoji}</span>
          <strong>{celebration.player.name}</strong>
          <span className="celebration-sep">·</span>
          <span>Hole {celebration.hole}</span>
        </div>
      </div>
    </div>
  );
}

// ============== LEADERBOARD ==============
function Leaderboard({ cumulative, user, allRoundPoints }) {
  const ranked = useMemo(() =>
    PLAYER_LIST.map(p => ({ ...p, total: cumulative[p.id] || 0 })).sort((a, b) => b.total - a.total),
  [cumulative]);

  return (
    <>
      <div className="card featured">
        <h2>Tournament Leaderboard</h2>
        <div style={{opacity: 0.85, fontSize: '0.95rem', marginBottom: '1rem'}}>
          Cumulative points across rounds 1–4. Going into Round 5, the top finisher starts at -3 strokes.
        </div>
        <table className="leaderboard">
          <thead>
            <tr>
              <th>Player</th>
              <th>R1</th><th>R2</th><th>R3</th><th>R4</th>
              <th style={{textAlign:'right'}}>Total</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((p, i) => (
              <tr key={p.id} className={`rank-${i+1} ${p.id === user.id ? 'you' : ''}`}>
                <td style={{color: 'var(--cream)'}}>
                  <span style={{fontSize:'1.2rem', marginRight:'0.4rem'}}>{p.emoji}</span>{p.name}
                </td>
                {[1,2,3,4].map(r => (
                  <td key={r} style={{color:'var(--cream)', fontFamily:'JetBrains Mono, monospace'}}>
                    {allRoundPoints[r]?.[p.id] != null ? allRoundPoints[r][p.id] : '·'}
                  </td>
                ))}
                <td style={{textAlign:'right', color:'var(--gold-bright)', fontWeight:800, fontSize:'1.2rem', fontFamily:'JetBrains Mono, monospace'}}>{p.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Projected R5 Starting Strokes</h3>
        <div style={{fontSize: '0.9rem', color: 'var(--green-mid)', marginBottom: '1rem'}}>Based on current standings.</div>
        <table className="leaderboard">
          <tbody>
            {ranked.map((p, i) => {
              const strokes = [-3, -2, -1, 0, 1, 2][i];
              return (
                <tr key={p.id} className={p.id === user.id ? 'you' : ''}>
                  <td>{i+1}.</td>
                  <td><span style={{marginRight:'0.4rem'}}>{p.emoji}</span>{p.name}</td>
                  <td style={{textAlign:'right', fontFamily:'JetBrains Mono, monospace', fontWeight:700, color: strokes < 0 ? 'var(--green-deep)' : strokes > 0 ? 'var(--red-flag)' : 'var(--ink)'}}>
                    {strokes === 0 ? 'E' : (strokes > 0 ? '+' : '') + strokes}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ============== LIVE / SCORING ==============
// PGA-style live leaderboard for R5: net-to-par including R5 starting-strokes adjustment, thru X holes.
// "Thru" counts the longest consecutive prefix of holes a player has entered (so out-of-order entries
// don't inflate progress). Score for unstarted players shows their starting-strokes adjustment.
function LiveR5Board({ scores, strokes, holes, r5Adjustments, user }) {
  const sortedHoles = useMemo(() => [...holes].sort((a, b) => a.hole - b.hole), [holes]);
  const effectiveStrokes = useMemo(() => deriveStrokesForFormat(strokes, 'championship'), [strokes]);

  const rows = useMemo(() => {
    const computed = PLAYER_LIST.map(p => {
      let netOverPar = 0;
      let thru = 0;
      for (const h of sortedHoles) {
        const s = scores.find(sc => sc.player_id === p.id && sc.hole === h.hole);
        if (!s) break;
        const so = getStrokesOnHole(effectiveStrokes[p.id] || 0, h.stroke_index);
        netOverPar += (s.gross - so) - h.par;
        thru = h.hole;
      }
      const adj = r5Adjustments?.[p.id] ?? 0;
      return { player: p, score: netOverPar + adj, thru };
    });
    return computed.sort((a, b) =>
      a.score - b.score ||
      b.thru - a.thru ||
      a.player.name.localeCompare(b.player.name)
    );
  }, [scores, sortedHoles, effectiveStrokes, r5Adjustments]);

  const fmt = (n) => n === 0 ? 'E' : (n > 0 ? '+' : '') + n;

  return (
    <div className="card featured">
      <h3 style={{marginBottom:'0.5rem'}}>Live Leaderboard</h3>
      <p style={{fontSize:'0.85rem', color:'var(--green-mid)', marginBottom:'0.85rem'}}>
        Net to par, including R5 starting strokes. Updates live as scores come in.
      </p>
      <table className="leaderboard">
        <thead>
          <tr>
            <th></th>
            <th>Player</th>
            <th style={{textAlign:'right'}}>Score</th>
            <th style={{textAlign:'right'}}>Thru</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.player.id} className={`rank-${i+1} ${r.player.id === user.id ? 'you' : ''}`}>
              <td style={{fontFamily:'JetBrains Mono, monospace', color:'var(--green-mid)'}}>{i+1}.</td>
              <td style={{color:'var(--cream)'}}><span style={{marginRight:'0.4rem'}}>{r.player.emoji}</span>{r.player.name}</td>
              <td style={{textAlign:'right', fontFamily:'JetBrains Mono, monospace', fontWeight:700, fontSize:'1.1rem', color: r.score < 0 ? 'var(--gold-bright)' : r.score > 0 ? 'var(--red-flag)' : 'var(--cream)'}}>
                {fmt(r.score)}
              </td>
              <td style={{textAlign:'right', fontFamily:'JetBrains Mono, monospace', color:'var(--cream)', opacity:0.8}}>
                {r.thru === 0 ? '—' : r.thru === 18 ? 'F' : r.thru}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LivePanel({ supabase, user, rounds, allScores, allStrokes, allHoles, isAdmin, cumulativePreR5, r5Adjustments, onRefresh }) {
  const [selectedRound, setSelectedRound] = useState(1);
  const [spinning, setSpinning] = useState(false);
  const handleRefresh = () => {
    if (spinning) return;
    setSpinning(true);
    onRefresh?.();
    setTimeout(() => setSpinning(false), 600);
  };
  const round = rounds.find(r => r.id === selectedRound);
  const strokes = allStrokes[selectedRound] || {};
  const holes = allHoles[selectedRound] || [];
  const scores = allScores.filter(s => s.round_id === selectedRound);
  const iAmScorekeeperA = round?.scorekeeper_a === user.id;
  const iAmScorekeeperB = round?.scorekeeper_b === user.id;
  const canSetupRound = iAmScorekeeperA || iAmScorekeeperB || isAdmin;
  const skA = round?.scorekeeper_a;
  const skB = round?.scorekeeper_b;
  const skAName = PLAYER_LIST.find(p => p.id === skA)?.name;
  const skBName = PLAYER_LIST.find(p => p.id === skB)?.name;

  return (
    <>
      <div className="card">
        <div style={{display:'flex', gap:'0.5rem', alignItems:'center', marginBottom: '1rem'}}>
          <div style={{display:'flex', gap:'0.5rem', flexWrap:'wrap', flex:1}}>
            {[1,2,3,4,5].map(r => (
              <button key={r}
                className={`btn ${selectedRound === r ? 'gold' : 'ghost'} sm`}
                onClick={() => setSelectedRound(r)}>R{r}</button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            aria-label="Refresh scores"
            style={{background:'transparent', border:'none', padding:'0.4rem', color:'var(--ink)', cursor:'pointer', opacity:0.7, display:'flex'}}
          >
            <RefreshCw size={18} style={{animation: spinning ? 'spin 0.6s linear' : 'none'}} />
          </button>
        </div>
        <div>
          <h2>{ROUND_INFO[selectedRound].name}</h2>
          <span className="pill">{ROUND_INFO[selectedRound].format}</span>
          {round?.status === 'complete' && <span className="pill dark" style={{marginLeft:'0.4rem'}}>complete</span>}
        </div>
        <p style={{marginTop:'0.75rem', fontSize:'0.95rem', lineHeight: 1.5, color:'var(--ink)'}}>
          {ROUND_INFO[selectedRound].desc}
        </p>
      </div>

      <RoundSetup
        supabase={supabase} roundId={selectedRound} round={round}
        strokes={strokes} holes={holes} canEdit={canSetupRound} isAdmin={isAdmin} user={user}
        cumulativePreR5={cumulativePreR5}
      />

      {selectedRound === 5 && Object.keys(strokes).length > 0 && holes.length > 0 && (
        <LiveR5Board scores={scores} strokes={strokes} holes={holes} r5Adjustments={r5Adjustments} user={user} />
      )}

      {Object.keys(strokes).length > 0 && holes.length > 0 && (
        <ScoringGrid
          supabase={supabase} roundId={selectedRound} formatKey={round?.format}
          roundStatus={round?.status}
          holes={holes} strokes={strokes} scores={scores} user={user}
          isAdmin={isAdmin} iAmScorekeeperA={iAmScorekeeperA} iAmScorekeeperB={iAmScorekeeperB}
          cumulativePreR5={cumulativePreR5}
        />
      )}
    </>
  );
}

function RoundSetup({ supabase, roundId, round, strokes, holes, canEdit, cumulativePreR5 }) {
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [localStrokes, setLocalStrokes] = useState({});
  const [scorekeeperA, setScorekeeperA] = useState(round?.scorekeeper_a || '');
  const [scorekeeperB, setScorekeeperB] = useState(round?.scorekeeper_b || '');

  // Reset transient UI state when navigating to a different round.
  useEffect(() => {
    setEditing(false);
    setCollapsed(true);
  }, [roundId]);

  useEffect(() => {
    const out = {};
    PLAYER_LIST.forEach(p => {
      out[p.id] = {
        handicap: strokes[p.id]?.handicap ?? '',
        group: strokes[p.id]?.group_assignment ?? '',
      };
    });
    setLocalStrokes(out);
    setScorekeeperA(round?.scorekeeper_a || '');
    setScorekeeperB(round?.scorekeeper_b || '');
  }, [strokes, round?.scorekeeper_a, round?.scorekeeper_b]);

  // Live preview: derive group-relative and field-relative strokes from the form's current handicap inputs
  const previewStrokes = useMemo(() => {
    const fakeStrokes = {};
    PLAYER_LIST.forEach(p => {
      fakeStrokes[p.id] = {
        handicap: parseInt(localStrokes[p.id]?.handicap) || 0,
        group_assignment: localStrokes[p.id]?.group || null,
      };
    });
    return {
      groupRelative: deriveStrokesForFormat(fakeStrokes, 'individual_stroke'),
      fieldRelative: deriveStrokesForFormat(fakeStrokes, 'best_ball'),
    };
  }, [localStrokes]);

  const saveSetup = async () => {
    if (scorekeeperA !== round?.scorekeeper_a || scorekeeperB !== round?.scorekeeper_b) {
      await supabase.from('rounds').update({
        scorekeeper_a: scorekeeperA || null,
        scorekeeper_b: scorekeeperB || null,
      }).eq('id', roundId);
    }
    const rows = PLAYER_LIST.map(p => ({
      round_id: roundId,
      player_id: p.id,
      handicap: parseInt(localStrokes[p.id]?.handicap) || 0,
      group_assignment: localStrokes[p.id]?.group || null,
    }));
    await supabase.from('round_strokes').upsert(rows);

    if (holes.length === 0) {
      const holeRows = Array.from({length: 18}, (_, i) => ({
        round_id: roundId, hole: i + 1, par: 4, stroke_index: i + 1,
      }));
      await supabase.from('holes').upsert(holeRows);
    }
    setEditing(false);
  };

  const allSet = PLAYER_LIST.every(p => strokes[p.id]?.group_assignment);

  if (!editing && allSet) {
    const groupAEmojis = PLAYER_LIST.filter(p => strokes[p.id]?.group_assignment === 'A').map(p => p.emoji).join(' ');
    const groupBEmojis = PLAYER_LIST.filter(p => strokes[p.id]?.group_assignment === 'B').map(p => p.emoji).join(' ');
    return (
      <div className="card setup-card">
        <button
          type="button"
          className="setup-header"
          onClick={() => setCollapsed(c => !c)}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          <span className="setup-header-label">Setup</span>
          {collapsed && (
            <span className="setup-header-summary">
              <span>A: {groupAEmojis}</span>
              <span style={{margin:'0 0.4rem', opacity:0.5}}>·</span>
              <span>B: {groupBEmojis}</span>
            </span>
          )}
        </button>
        {canEdit && (
          <button className="btn ghost sm setup-edit-btn" onClick={() => setEditing(true)}>
            <Settings size={14} /> Edit
          </button>
        )}
        {!collapsed && (() => {
          const groupRel = deriveStrokesForFormat(strokes, 'individual_stroke');
          const fieldRel = deriveStrokesForFormat(strokes, 'best_ball');
          const skId = (g) => g === 'A' ? round?.scorekeeper_a : round?.scorekeeper_b;
          const skName = (g) => PLAYER_LIST.find(p => p.id === skId(g))?.name;
          return (
            <div className="setup-groups" style={{marginTop:'0.85rem'}}>
              {['A','B'].map(g => (
                <div key={g}>
                  <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:'0.5rem', gap:'0.5rem', flexWrap:'wrap'}}>
                    <div className="pill setup-group-pill" style={{margin:0}}>Group {g}</div>
                    {skId(g) && (
                      <span style={{fontSize:'0.72rem', fontFamily:'JetBrains Mono, monospace', color:'var(--green-mid)'}}>
                        SK: <strong style={{color:'var(--green-deep)'}}>{skName(g)}</strong>
                      </span>
                    )}
                  </div>
                  {PLAYER_LIST.filter(p => strokes[p.id]?.group_assignment === g).map(p => (
                    <div key={p.id} className="setup-roster-row">
                      <span className="setup-name">
                        <span className="setup-emoji">{p.emoji}</span>{p.name}
                      </span>
                      <span className="setup-numbers">
                        <span className="hcp-line">Hcp {strokes[p.id]?.handicap || 0}</span>
                        <span className="derived-line">grp {groupRel[p.id] ?? 0} · field {fieldRel[p.id] ?? 0}</span>
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          );
        })()}
      </div>
    );
  }

  if (!canEdit && !allSet) {
    return (
      <div className="card">
        <h3>Setup pending</h3>
        <p style={{color:'var(--green-mid)'}}>Scorekeepers for this round haven't entered groups and strokes yet.</p>
      </div>
    );
  }

  const isChampionship = round?.format === 'championship';
  const autoAssignByLeaderboard = () => {
    if (!cumulativePreR5) return;
    const ranked = PLAYER_LIST.slice().sort((a, b) =>
      (cumulativePreR5[b.id] || 0) - (cumulativePreR5[a.id] || 0)
    );
    const championshipIds = new Set(ranked.slice(0, 3).map(p => p.id));
    setLocalStrokes(prev => {
      const out = { ...prev };
      PLAYER_LIST.forEach(p => {
        out[p.id] = {
          ...(out[p.id] || {}),
          group: championshipIds.has(p.id) ? 'A' : 'B',
        };
      });
      return out;
    });
  };

  return (
    <div className="card">
      <h3>Round Setup {canEdit && '(scorekeeper)'}</h3>
      <p style={{fontSize:'0.85rem', color:'var(--green-mid)', marginBottom:'1rem'}}>
        Assign each player a group (A or B) and their <strong>raw handicap</strong> (an absolute number, e.g. 0, 8, 14). The app derives this round's strokes automatically.
      </p>

      {isChampionship && cumulativePreR5 && (
        <div style={{padding:'0.6rem 0.85rem', background:'var(--cream)', borderLeft:'3px solid var(--gold)', borderRadius:'3px', marginBottom:'1rem', fontSize:'0.78rem', color:'var(--green-mid)', display:'flex', justifyContent:'space-between', alignItems:'center', gap:'0.5rem', flexWrap:'wrap'}}>
          <span><strong style={{color:'var(--green-deep)'}}>Championship grouping:</strong> top 3 by R1-R4 standings → Group A, bottom 3 → Group B.</span>
          <button type="button" className="btn ghost sm" onClick={autoAssignByLeaderboard}>Auto-assign by leaderboard</button>
        </div>
      )}

      <div className="sk-row">
        <div>
          <label className="sk-label">Group A scorekeeper</label>
          <select value={scorekeeperA} onChange={e => setScorekeeperA(e.target.value)}>
            <option value="">— pick scorekeeper —</option>
            {PLAYER_LIST.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="sk-label">Group B scorekeeper</label>
          <select value={scorekeeperB} onChange={e => setScorekeeperB(e.target.value)}>
            <option value="">— pick scorekeeper —</option>
            {PLAYER_LIST.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      <div style={{display:'grid', gap:'0.5rem'}}>
        {PLAYER_LIST.map(p => {
          const grpHcp = previewStrokes.groupRelative[p.id];
          const fieldHcp = previewStrokes.fieldRelative[p.id];
          return (
            <div key={p.id} style={{display:'grid', gridTemplateColumns:'1fr 80px 80px 1fr', gap:'0.5rem', alignItems:'center'}}>
              <div style={{fontWeight:600}}>
                <span style={{marginRight:'0.4rem'}}>{p.emoji}</span>{p.name}
              </div>
              <select
                value={localStrokes[p.id]?.group || ''}
                onChange={e => setLocalStrokes({...localStrokes, [p.id]: {...localStrokes[p.id], group: e.target.value}})}
              >
                <option value="">Group</option>
                <option value="A">A</option>
                <option value="B">B</option>
              </select>
              <input
                type="number" min="0" max="54" placeholder="Hcp"
                value={localStrokes[p.id]?.handicap || ''}
                onChange={e => setLocalStrokes({...localStrokes, [p.id]: {...localStrokes[p.id], handicap: e.target.value}})}
                inputMode="numeric"
              />
              <span style={{fontFamily:'JetBrains Mono, monospace', fontSize:'0.7rem', color:'var(--green-mid)'}}>
                grp {grpHcp ?? 0} · field {fieldHcp ?? 0}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{marginTop:'0.85rem', padding:'0.6rem 0.85rem', background:'var(--cream)', borderLeft:'3px solid var(--gold)', borderRadius:'3px', fontSize:'0.78rem', color:'var(--green-mid)', lineHeight:1.5}}>
        <strong style={{color:'var(--green-deep)'}}>How strokes work:</strong> "grp" = strokes received in R1/R3 (off your group's low handicap). "field" = strokes for R2/R4/R5 (off the entire field's low). Lowest-handicap player gets 0; everyone else gets the differential.
      </div>

      <div style={{marginTop:'1rem', display:'flex', gap:'0.5rem'}}>
        <button className="btn gold" onClick={saveSetup}>Save Setup</button>
        {editing && <button className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>}
      </div>
    </div>
  );
}

function ScoringGrid({ supabase, roundId, formatKey, roundStatus, holes, strokes, scores, user, isAdmin, iAmScorekeeperA, iAmScorekeeperB, cumulativePreR5 }) {
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [nineView, setNineView] = useState('front');

  // Clear active edit + reset to Front 9 when switching rounds.
  useEffect(() => {
    setEditing(null);
    setEditValue('');
    setNineView('front');
  }, [roundId]);
  const [overrideUnlocked, setOverrideUnlocked] = useState(false);
  const isLocked = roundStatus === 'complete' && !overrideUnlocked;
  const editorInputRef = useRef(null);

  // Lock body scroll while the editor is open so iOS Safari can't auto-scroll
  // the page up when the input gains focus.
  const isEditingMode = !!editing;
  useEffect(() => {
    if (!isEditingMode) return;
    const scrollY = window.scrollY;
    const orig = {
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
      overflow: document.body.style.overflow,
    };
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.position = orig.position;
      document.body.style.top = orig.top;
      document.body.style.width = orig.width;
      document.body.style.overflow = orig.overflow;
      window.scrollTo(0, scrollY);
    };
  }, [isEditingMode]);

  // Focus the floating editor's input. preventScroll for browsers that respect it.
  useEffect(() => {
    if (editing && editorInputRef.current) {
      try { editorInputRef.current.focus({ preventScroll: true }); } catch { editorInputRef.current.focus(); }
      const v = editorInputRef.current.value;
      try { editorInputRef.current.setSelectionRange(v.length, v.length); } catch { /* ignore */ }
    }
  }, [editing?.playerId, editing?.hole]);

  // Keep the floating editor pinned above the iOS keyboard via visualViewport.
  useEffect(() => {
    if (!editing) return;
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--keyboard-offset', offset + 'px');
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.documentElement.style.setProperty('--keyboard-offset', '0px');
    };
  }, [editing]);

  const sortedHoles = [...holes].sort((a,b) => a.hole - b.hole);
  const front9 = sortedHoles.slice(0, 9);
  const back9 = sortedHoles.slice(9, 18);
  const isHolePointFormat = formatKey === 'individual_stroke';
  const isChampionshipFormat = formatKey === 'championship';
  // Ring decorations: highlight the low-net player(s) per hole in R1/R3 (5-pt earners) and R5.
  const showHoleWinnerRings = isHolePointFormat || isChampionshipFormat;
  // Per-cell match-play summary (legacy banner) still useful for R5; R1/R3 use hole-point standings + team match instead.
  const showLegacyMatchBanner = isChampionshipFormat;
  const effectiveStrokes = useMemo(() => deriveStrokesForFormat(strokes, formatKey), [strokes, formatKey]);
  const fieldStrokes = useMemo(
    () => isHolePointFormat ? deriveStrokesForFormat(strokes, 'best_ball') : null,
    [strokes, isHolePointFormat]
  );

  const groupA = Object.entries(strokes).filter(([_, s]) => s?.group_assignment === 'A').map(([id]) => id);
  const groupB = Object.entries(strokes).filter(([_, s]) => s?.group_assignment === 'B').map(([id]) => id);
  const teamMatch = isHolePointFormat && fieldStrokes
    ? computeTeamBestBallMatch(groupA, groupB, sortedHoles, scores, fieldStrokes)
    : null;

  const playersInGroup = (g) => {
    if (formatKey === 'scramble') {
      const ids = g === 'A' ? groupA : groupB;
      return PLAYER_LIST.filter(p => p.id === ids[0]);
    }
    return PLAYER_LIST.filter(p => strokes[p.id]?.group_assignment === g);
  };

  const myGroup = strokes[user.id]?.group_assignment;
  const otherGroup = myGroup === 'A' ? 'B' : (myGroup === 'B' ? 'A' : null);
  const groupOrder = myGroup ? [myGroup, otherGroup].filter(Boolean) : ['A', 'B'].filter(g => playersInGroup(g).length);

  const canEditGroup = (g) => {
    if (isLocked) return false;
    if (g === 'A') return iAmScorekeeperA;
    if (g === 'B') return iAmScorekeeperB;
    return false;
  };
  const canEditAny = !isLocked && (iAmScorekeeperA || iAmScorekeeperB);
  const canEditAnyIfUnlocked = iAmScorekeeperA || iAmScorekeeperB;

  const getScore = (pid, hole) => scores.find(s => s.player_id === pid && s.hole === hole);

  const recomputeAndSavePoints = async () => {
    const { data: freshScores } = await supabase.from('scores').select('*').eq('round_id', roundId);
    const points = computeRoundPoints(roundId, freshScores || [], strokes, holes, formatKey, cumulativePreR5);
    const rows = Object.entries(points).map(([pid, pts]) => ({
      round_id: roundId, player_id: pid, points: pts,
    }));
    await supabase.from('round_points').upsert(rows);

    // Auto-flip rounds.status when all expected scores are in (or roll back if a delete drops it).
    const expectedScoreCount = formatKey === 'scramble'
      ? 2 * 18                                                                  // captains only
      : PLAYER_LIST.filter(p => strokes[p.id]?.group_assignment).length * 18;   // every player
    const newStatus = (freshScores?.length || 0) >= expectedScoreCount ? 'complete' : 'active';
    const { data: r } = await supabase.from('rounds').select('status').eq('id', roundId).single();
    if (r?.status !== newStatus) {
      await supabase.from('rounds').update({ status: newStatus }).eq('id', roundId);
    }
  };

  // Auto-advance the cursor: next player on the same hole; or first player of the next hole;
  // or close editing if we're at the very end of the round. Stays within the current player's
  // group (a scorekeeper is locked to their three).
  const advanceToNextCell = (currentPid, currentHole) => {
    const grp = strokes[currentPid]?.group_assignment;
    if (!grp) { setEditing(null); setEditValue(''); return; }
    const groupPlayers = playersInGroup(grp);
    const idx = groupPlayers.findIndex(p => p.id === currentPid);

    let nextPid = null;
    let nextHole = currentHole;
    if (idx >= 0 && idx < groupPlayers.length - 1) {
      nextPid = groupPlayers[idx + 1].id;
    } else {
      const currentHoleIdx = sortedHoles.findIndex(h => h.hole === currentHole);
      const nextHoleObj = sortedHoles[currentHoleIdx + 1];
      if (nextHoleObj && groupPlayers.length > 0) {
        nextPid = groupPlayers[0].id;
        nextHole = nextHoleObj.hole;
      }
    }

    if (nextPid) {
      setEditing({ playerId: nextPid, hole: nextHole });
      setEditValue(getScore(nextPid, nextHole)?.gross?.toString() || '');
      if (nextHole > 9 && nineView === 'front') setNineView('back');
      if (nextHole <= 9 && nineView === 'back') setNineView('front');
    } else {
      setEditing(null);
      setEditValue('');
    }
  };

  const retreatToPrevCell = (currentPid, currentHole) => {
    const grp = strokes[currentPid]?.group_assignment;
    if (!grp) return;
    const groupPlayers = playersInGroup(grp);
    const idx = groupPlayers.findIndex(p => p.id === currentPid);
    let prevPid = null;
    let prevHole = currentHole;
    if (idx > 0) {
      prevPid = groupPlayers[idx - 1].id;
    } else {
      const currentHoleIdx = sortedHoles.findIndex(h => h.hole === currentHole);
      const prevHoleObj = sortedHoles[currentHoleIdx - 1];
      if (prevHoleObj && groupPlayers.length > 0) {
        prevPid = groupPlayers[groupPlayers.length - 1].id;
        prevHole = prevHoleObj.hole;
      }
    }
    if (prevPid) {
      setEditing({ playerId: prevPid, hole: prevHole });
      setEditValue(getScore(prevPid, prevHole)?.gross?.toString() || '');
      if (prevHole > 9 && nineView === 'front') setNineView('back');
      if (prevHole <= 9 && nineView === 'back') setNineView('front');
    }
  };

  // Pure persistence helpers — never touch editing state, fire-and-forget recompute.
  const persistScore = async (pid, hole, gross) => {
    const grossNum = parseInt(gross);
    if (!grossNum || grossNum < 1) return;
    const existing = getScore(pid, hole);
    try {
      if (existing) {
        await supabase.from('scores').update({ gross: grossNum, entered_by: user.id, entered_at: new Date().toISOString() }).eq('id', existing.id);
      } else {
        await supabase.from('scores').insert({ round_id: roundId, player_id: pid, hole, gross: grossNum, entered_by: user.id });
      }
      recomputeAndSavePoints().catch(err => console.error('recompute failed', err));
    } catch (err) {
      console.error('persistScore failed', err);
      alert('Score didn\'t save — ' + (err?.message || 'check your connection'));
    }
  };

  const persistDelete = async (pid, hole) => {
    const existing = getScore(pid, hole);
    if (!existing) return;
    try {
      await supabase.from('scores').delete().eq('id', existing.id);
      recomputeAndSavePoints().catch(err => console.error('recompute failed', err));
    } catch (err) {
      console.error('persistDelete failed', err);
      alert('Couldn\'t delete that score — ' + (err?.message || 'check your connection'));
    }
  };

  // Commit + navigate. Used by the floating editor's input + nav buttons.
  const commitCurrent = (direction = 'next') => {
    if (!editing) return;
    const { playerId, hole } = editing;
    const hadScore = !!getScore(playerId, hole);
    const trimmed = editValue.toString().trim();
    if (trimmed) persistScore(playerId, hole, trimmed);
    else if (hadScore) persistDelete(playerId, hole);
    if (direction === 'next') advanceToNextCell(playerId, hole);
    else if (direction === 'prev') retreatToPrevCell(playerId, hole);
    else { setEditing(null); setEditValue(''); }
  };

  return (
    <div className="card">
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'1rem', flexWrap:'wrap', gap:'0.5rem'}}>
        <h3 style={{margin:0}}>Scoring</h3>
        <div className="nine-toggle">
          <button className={nineView === 'front' ? 'active' : ''} onClick={() => setNineView('front')}>Front 9</button>
          <button className={nineView === 'back' ? 'active' : ''} onClick={() => setNineView('back')}>Back 9</button>
        </div>
      </div>

      {isLocked && (
        <div className="round-lock-banner">
          <span><Lock size={14} style={{verticalAlign:'-2px', marginRight:'0.4rem'}} /> Round complete · scoring locked</span>
          {canEditAnyIfUnlocked && (
            <button className="btn ghost sm" onClick={() => setOverrideUnlocked(true)}>Continue editing</button>
          )}
          {isAdmin && (
            <button className="btn ghost sm" onClick={() => recomputeAndSavePoints().catch(err => { console.error(err); alert('Recompute failed — ' + (err?.message || 'unknown')); })}>Recompute points</button>
          )}
        </div>
      )}
      {overrideUnlocked && (
        <div className="round-unlock-banner">
          Editing unlocked manually — round will re-lock automatically.
        </div>
      )}
      {!canEditAny && !isLocked && <p style={{color:'var(--green-mid)', fontSize:'0.85rem', marginBottom:'1rem'}}>
        View only. Only your group's scorekeeper can enter scores.
      </p>}

      {teamMatch && teamMatch.thruHole > 0 && (
        <div className="match-status team-match">
          <span className="lead">
            {teamMatch.aHolesUp > 0
              ? <>Group <strong>A</strong> · {teamMatch.aHolesUp} UP thru {teamMatch.thruHole}</>
              : teamMatch.aHolesUp < 0
                ? <>Group <strong>B</strong> · {-teamMatch.aHolesUp} UP thru {teamMatch.thruHole}</>
                : <>All Square thru {teamMatch.thruHole}</>}
          </span>
        </div>
      )}

      {groupOrder.map(g => {
        const isYour = myGroup && g === myGroup;
        const players = playersInGroup(g);
        const canEdit = canEditGroup(g);
        const groupIds = players.map(p => p.id);
        const standings = isHolePointFormat
          ? computeHolePointStandings(groupIds, sortedHoles, scores, effectiveStrokes)
          : null;
        const matchState = showLegacyMatchBanner ? computeMatchPlayState(players, sortedHoles, scores, effectiveStrokes) : null;
        const holeWinners = showHoleWinnerRings ? computeHoleWinners(players, sortedHoles, scores, effectiveStrokes) : {};

        const renderNine = (holesRange, label, totalLabel) => {
          const parTotal = holesRange.reduce((s, h) => s + h.par, 0);
          return (
            <div className={`sc-section ${isYour ? '' : 'view-only'}`}>
              <div className="sc-section-label">
                <span>{label}</span>
              </div>
              <div className="sc-table">
                <div className="sc-h"></div>
                {holesRange.map(h => <div key={`hd-${g}-${h.hole}`} className="sc-h">{h.hole}</div>)}
                <div className="sc-h sc-h-total">{totalLabel}</div>

                <div className="sc-par-label">Par</div>
                {holesRange.map(h => <div key={`par-${g}-${h.hole}`} className="sc-par">{h.par}</div>)}
                <div className="sc-par-total">{parTotal}</div>

                {players.map(p => {
                  const totalStrokes = effectiveStrokes[p.id] || 0;
                  const sumNine = holesRange.reduce((s, h) => {
                    const sc = getScore(p.id, h.hole);
                    return s + (sc ? sc.gross : 0);
                  }, 0);
                  const playedNine = holesRange.filter(h => getScore(p.id, h.hole)).length;
                  return (
                    <Fragment key={`${g}-${p.id}-${label}`}>
                      <div className={`sc-name ${formatKey === 'scramble' ? 'sc-team-name' : ''}`}>
                        {formatKey === 'scramble' ? (
                          <span className="sc-name-init" style={{fontSize:'1.1rem'}}>{g}</span>
                        ) : (
                          <>
                            <span className="sc-name-emoji">{p.emoji}</span>
                            <span className="sc-name-init">{p.initials}</span>
                          </>
                        )}
                      </div>
                      {holesRange.map(h => {
                        const s = getScore(p.id, h.hole);
                        const so = getStrokesOnHole(totalStrokes, h.stroke_index);
                        const net = s ? s.gross - so : null;
                        const cls = s ? scoreLabel(net, h.par) : 'empty';
                        const isEditingHere = editing && editing.playerId === p.id && editing.hole === h.hole;
                        const winInfo = holeWinners[h.hole];
                        const isWinner = winInfo?.winner === p.id;
                        const isTied = winInfo?.tiedPids?.includes(p.id);
                        return (
                          <div key={`${p.id}-${h.hole}`}
                            className={`sc-cell ${cls} ${isEditingHere ? 'editing' : ''}`}
                            style={canEdit ? null : { cursor: 'default' }}
                            onClick={() => {
                              if (!canEdit) return;
                              setEditing({ playerId: p.id, hole: h.hole });
                              setEditValue(s?.gross?.toString() || '');
                            }}>
                            {isWinner && <span className="sc-ring winner" />}
                            {isTied && <span className="sc-ring tied" />}
                            {so > 0 && <span className="sc-pip" />}
                            <span>{isEditingHere ? (editValue || '·') : (s ? s.gross : '·')}</span>
                          </div>
                        );
                      })}
                      <div className="sc-total">{playedNine > 0 ? sumNine : '—'}</div>
                    </Fragment>
                  );
                })}

                {formatKey === 'best_ball' && players.length > 0 && (() => {
                  const holeBest = (h) => {
                    const entries = players.map(p => {
                      const sc = getScore(p.id, h.hole);
                      if (!sc) return null;
                      const so = getStrokesOnHole(effectiveStrokes[p.id] || 0, h.stroke_index);
                      return { pid: p.id, net: sc.gross - so };
                    }).filter(Boolean);
                    if (entries.length === 0) return null;
                    return entries.reduce((acc, x) => (acc == null || x.net < acc.net) ? x : acc, null);
                  };
                  const teamTotal = holesRange.reduce((sum, h) => {
                    const b = holeBest(h);
                    return sum + (b?.net ?? 0);
                  }, 0);
                  const teamPlayed = holesRange.filter(h => holeBest(h) != null).length;
                  return (
                    <Fragment>
                      <div className="sc-name sc-team-name">
                        <span>TEAM</span>
                      </div>
                      {holesRange.map(h => {
                        const b = holeBest(h);
                        const cls = b == null ? 'empty' : scoreLabel(b.net, h.par);
                        const contrib = b ? PLAYER_LIST.find(p => p.id === b.pid) : null;
                        return (
                          <div key={`team-${g}-${h.hole}`} className={`sc-cell sc-team-cell ${cls}`}>
                            {contrib && <span className="sc-team-emoji">{contrib.emoji}</span>}
                            <span>{b ? b.net : '·'}</span>
                          </div>
                        );
                      })}
                      <div className="sc-total sc-team-total">
                        {teamPlayed > 0 ? teamTotal : '—'}
                      </div>
                    </Fragment>
                  );
                })()}
              </div>
            </div>
          );
        };

        return (
          <div key={g}>
            <div className={`group-section ${isYour ? 'you' : 'other'}`}>
              <span>{isYour ? `Your Group · ${g}` : `Other Group · ${g}`}</span>
              {!isYour && <span className="view-tag">view only</span>}
            </div>
            {standings && standings.thruHole > 0 && (
              <div className="match-status standings-row">
                <span className="lead">
                  {[...groupIds]
                    .map((pid, idx) => ({ pid, idx, total: standings.totals[pid] || 0 }))
                    .sort((a, b) => b.total - a.total || a.idx - b.idx)
                    .map(({ pid, total }, i) => {
                      const p = PLAYER_LIST.find(pl => pl.id === pid);
                      return (
                        <Fragment key={pid}>
                          {i > 0 && <span className="sep"> · </span>}
                          <span>{p?.emoji} <strong>{total}</strong></span>
                        </Fragment>
                      );
                    })}
                  <span className="sep"> · </span>thru {standings.thruHole}
                </span>
              </div>
            )}
            {matchState?.summary && (
              <div className="match-status">
                <span className="lead">
                  {matchState.summary.kind === 'leader'
                    ? <>{matchState.summary.leader.emoji} <strong>{matchState.summary.leader.name}</strong> up {matchState.summary.margin}</>
                    : <>Tied</>}
                </span>
              </div>
            )}
            {nineView === 'front' && renderNine(front9, 'Front 9', 'OUT')}
            {nineView === 'back' && renderNine(back9, 'Back 9', 'IN')}
          </div>
        );
      })}

      {editing && (() => {
        const ePlayer = PLAYER_LIST.find(p => p.id === editing.playerId);
        const eHole = sortedHoles.find(h => h.hole === editing.hole);
        return (
          <div className="score-editor-bar">
            <span className="se-mini-ctx">
              <span className="se-emoji">{ePlayer?.emoji}</span>
              <strong>{ePlayer?.initials}</strong>
              <span className="se-sep">·</span>
              H{editing.hole}
              {eHole?.par && <span className="se-par">p{eHole.par}</span>}
            </span>
            <button type="button" className="se-nav" aria-label="Previous"
              onMouseDown={e => e.preventDefault()}
              onClick={() => commitCurrent('prev')}>
              <ChevronUp size={16} />
            </button>
            <input
              ref={editorInputRef}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={editValue}
              onChange={e => setEditValue(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitCurrent('next'); }
                if (e.key === 'Escape') { setEditing(null); setEditValue(''); }
              }}
              className="se-input"
            />
            <button type="button" className="se-nav" aria-label="Next"
              onMouseDown={e => e.preventDefault()}
              onClick={() => commitCurrent('next')}>
              <ChevronDown size={16} />
            </button>
            <button type="button" className="se-done" aria-label="Save and close"
              onMouseDown={e => e.preventDefault()}
              onClick={() => commitCurrent('close')}>
              <Check size={16} />
            </button>
            <button type="button" className="se-cancel" aria-label="Cancel"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { setEditing(null); setEditValue(''); }}>
              <X size={16} />
            </button>
          </div>
        );
      })()}
    </div>
  );
}

// ============== BEST BALL TEAM SCORECARD ==============
function BestBallTeamCard({ holes, strokes, scores, user }) {
  const sortedHoles = [...holes].sort((a, b) => a.hole - b.hole);
  const groupA = Object.entries(strokes).filter(([_, s]) => s?.group_assignment === 'A').map(([id]) => id);
  const groupB = Object.entries(strokes).filter(([_, s]) => s?.group_assignment === 'B').map(([id]) => id);
  const effectiveStrokes = useMemo(() => deriveStrokesForFormat(strokes, 'best_ball'), [strokes]);

  const teamHoleData = (group) => sortedHoles.map(hole => {
    const entries = group.map(pid => {
      const s = scores.find(sc => sc.player_id === pid && sc.hole === hole.hole);
      if (!s) return null;
      const so = getStrokesOnHole(effectiveStrokes[pid] || 0, hole.stroke_index);
      return { pid, gross: s.gross, net: s.gross - so };
    }).filter(Boolean);
    if (entries.length === 0) return { hole: hole.hole, par: hole.par, bestNet: null, contributor: null, partial: true };
    const best = entries.reduce((acc, x) => (acc == null || x.net < acc.net) ? x : acc, null);
    const partial = entries.length < group.length;
    return { hole: hole.hole, par: hole.par, bestNet: best.net, contributor: best.pid, partial };
  });

  const myGroup = user && strokes[user.id]?.group_assignment;

  const renderCell = (d) => {
    const diff = d.bestNet != null ? d.bestNet - d.par : null;
    const cls = d.bestNet == null ? 'empty'
      : diff <= -2 ? 'eagle'
      : diff === -1 ? 'birdie'
      : diff === 0 ? 'par'
      : diff === 1 ? 'bogey'
      : 'double';
    const contrib = PLAYER_LIST.find(p => p.id === d.contributor);
    return (
      <div key={d.hole} className={`hole-cell ${cls}`} style={{cursor:'default'}} title={contrib ? `Best: ${contrib.name}${d.partial ? ' (partial)' : ''}` : ''}>
        <div className="hole-num">{d.hole}</div>
        <div className="hole-par">P{d.par}</div>
        {contrib && <div className="stroke-dots" style={{position:'absolute', top:2, right:4, fontSize:'0.85rem'}}>{contrib.emoji}</div>}
        <span>{d.bestNet != null ? d.bestNet : '·'}</span>
      </div>
    );
  };

  const renderTeam = (label, group) => {
    if (group.length === 0) return null;
    const data = teamHoleData(group);
    const front = data.slice(0, 9);
    const back = data.slice(9, 18);
    const total = data.reduce((s, d) => s + (d.bestNet ?? 0), 0);
    const frontTotal = front.reduce((s, d) => s + (d.bestNet ?? 0), 0);
    const backTotal = back.reduce((s, d) => s + (d.bestNet ?? 0), 0);
    const holesPlayed = data.filter(d => d.bestNet != null).length;
    const isYours = myGroup && label === myGroup;
    return (
      <div style={{marginBottom:'1.25rem'}}>
        <div className={`group-section ${isYours ? 'you' : 'other'}`}>
          <span>{isYours ? `Your Team · ${label} · Best Ball` : `Other Team · ${label} · Best Ball`}</span>
          <span style={{fontFamily:'JetBrains Mono, monospace', fontWeight:700, color: isYours ? 'var(--gold-bright)' : 'var(--green-deep)'}}>
            Net {holesPlayed > 0 ? total : '—'} ({holesPlayed}/18)
          </span>
        </div>
        <div className="nine-label"><span>Front 9</span><span className="nine-total">{front.some(d => d.bestNet != null) ? frontTotal : '—'}</span></div>
        <div className="grid-holes">{front.map(renderCell)}</div>
        <div className="nine-label"><span>Back 9</span><span className="nine-total">{back.some(d => d.bestNet != null) ? backTotal : '—'}</span></div>
        <div className="grid-holes">{back.map(renderCell)}</div>
      </div>
    );
  };

  // Order: your team first, then other team
  const yourLabel = myGroup;
  const otherLabel = myGroup === 'A' ? 'B' : (myGroup === 'B' ? 'A' : null);
  const yourGroup = myGroup === 'A' ? groupA : (myGroup === 'B' ? groupB : []);
  const otherGroup = myGroup === 'A' ? groupB : (myGroup === 'B' ? groupA : []);

  return (
    <div className="card">
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.5rem', flexWrap:'wrap', gap:'0.5rem'}}>
        <h2 style={{margin:0}}>Team Scorecards</h2>
        <span style={{fontSize:'0.8rem', color:'var(--green-mid)', fontFamily:'JetBrains Mono, monospace'}}>
          Best net · emoji = whose ball
        </span>
      </div>
      {myGroup ? (
        <>
          {renderTeam(yourLabel, yourGroup)}
          {renderTeam(otherLabel, otherGroup)}
        </>
      ) : (
        <>
          {renderTeam('A', groupA)}
          {renderTeam('B', groupB)}
        </>
      )}
    </div>
  );
}

// ============== HEATMAP ==============
function Heatmap({ allScores, allHoles, allStrokes, rounds }) {
  const [selectedRound, setSelectedRound] = useState(1);
  const holes = (allHoles[selectedRound] || []).slice().sort((a,b) => a.hole - b.hole);
  const strokes = allStrokes[selectedRound] || {};
  const scores = allScores.filter(s => s.round_id === selectedRound);
  const roundFormat = rounds?.find(r => r.id === selectedRound)?.format;
  const effectiveStrokes = useMemo(() => deriveStrokesForFormat(strokes, roundFormat), [strokes, roundFormat]);

  const cellColor = (net, par) => {
    if (net == null) return 'var(--cream)';
    const diff = net - par;
    if (diff <= -2) return '#f4c430';
    if (diff === -1) return '#a8d4b6';
    if (diff === 0) return '#e8dcc0';
    if (diff === 1) return '#f4c4a8';
    if (diff === 2) return '#e89b8a';
    return '#b85c5c';
  };

  return (
    <div className="card">
      <div style={{display:'flex', gap:'0.5rem', flexWrap:'wrap', marginBottom:'1rem'}}>
        {[1,2,3,4,5].map(r => (
          <button key={r}
            className={`btn ${selectedRound === r ? 'gold' : 'ghost'} sm`}
            onClick={() => setSelectedRound(r)}>R{r}</button>
        ))}
      </div>
      <h2>Hole-by-hole performance</h2>
      <p style={{color:'var(--green-mid)', fontSize:'0.85rem', marginBottom:'1rem'}}>
        Net score relative to par. Darker red = worse.
      </p>

      {scores.length === 0 ? (
        <div className="empty">No scores entered for this round yet.</div>
      ) : (
        <div style={{overflowX:'auto'}}>
          <div style={{minWidth:'600px'}}>
            <div className="heatmap-row head">
              <div></div>
              {holes.map(h => <div key={h.hole}>{h.hole}</div>)}
              <div>NET</div>
            </div>
            {PLAYER_LIST.filter(p => strokes[p.id]?.group_assignment).map(p => {
              const totalStrokes = effectiveStrokes[p.id] || 0;
              let netTotal = 0; let played = 0;
              return (
                <div key={p.id} className="heatmap-row">
                  <div className="heatmap-name">
                    <span style={{marginRight:'0.3rem'}}>{p.emoji}</span>{p.name}
                  </div>
                  {holes.map(hole => {
                    const s = scores.find(sc => sc.player_id === p.id && sc.hole === hole.hole);
                    const so = getStrokesOnHole(totalStrokes, hole.stroke_index);
                    const net = s ? s.gross - so : null;
                    if (net != null) { netTotal += net; played++; }
                    return (
                      <div key={hole.hole} className="heatmap-cell" style={{background: cellColor(net, hole.par)}}>
                        {s ? s.gross : '·'}
                      </div>
                    );
                  })}
                  <div className="heatmap-total">{played > 0 ? `${netTotal}` : '—'}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ============== TRASH TALK ==============
function TrashTalk({ supabase, user, messages }) {
  const [text, setText] = useState('');
  const send = async () => {
    if (!text.trim()) return;
    await supabase.from('messages').insert({ player_id: user.id, body: text.trim() });
    setText('');
  };
  const sorted = [...messages].sort((a,b) => new Date(a.created_at) - new Date(b.created_at));

  return (
    <>
      <div className="card">
        <h2>Trash Talk</h2>
        <p style={{color:'var(--green-mid)', fontSize:'0.9rem', marginBottom:'1rem'}}>
          Talk smack. Live for the group.
        </p>
        <div style={{display:'flex', gap:'0.5rem'}}>
          <input value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && send()}
            placeholder="Type something the others will regret..." />
          <button className="btn gold" onClick={send} disabled={!text.trim()}>
            <Send size={14} />
          </button>
        </div>
      </div>

      <div className="card" style={{maxHeight:'60vh', overflowY:'auto'}}>
        {sorted.length === 0 ? (
          <div className="empty">Be the first to start the smack talk.</div>
        ) : (
          sorted.map(m => {
            const sender = PLAYER_LIST.find(p => p.id === m.player_id);
            return (
              <div key={m.id} className={`msg ${m.player_id === user.id ? 'you' : ''}`}>
                <div className="meta">
                  {sender?.emoji} {sender?.name} · {relTime(m.created_at)}
                </div>
                <div>{m.body}</div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// ============== AWARDS ==============
function Awards({ allScores, allHoles, allStrokes, allRoundPoints, rounds }) {
  const stats = useMemo(() => {
    const data = {};
    PLAYER_LIST.forEach(p => data[p.id] = { birdies: 0, eagles: 0, blowups: 0, holes: 0, netSum: 0 });
    // Pre-compute effective strokes per round
    const effectivePerRound = {};
    Object.entries(allStrokes).forEach(([roundId, strokesMap]) => {
      const fmt = rounds?.find(r => String(r.id) === String(roundId))?.format;
      effectivePerRound[roundId] = deriveStrokesForFormat(strokesMap, fmt);
    });
    allScores.forEach(s => {
      // Scramble rounds record one team score under the captain — don't credit it to any individual.
      const fmt = rounds?.find(r => String(r.id) === String(s.round_id))?.format;
      if (fmt === 'scramble') return;
      const holes = allHoles[s.round_id] || [];
      const hole = holes.find(h => h.hole === s.hole);
      if (!hole) return;
      const strokesObj = allStrokes[s.round_id]?.[s.player_id];
      if (!strokesObj) return;
      const so = getStrokesOnHole(effectivePerRound[s.round_id]?.[s.player_id] || 0, hole.stroke_index);
      const net = s.gross - so;
      const diff = net - hole.par;
      data[s.player_id].holes++;
      data[s.player_id].netSum += diff;
      if (diff <= -2) data[s.player_id].eagles++;
      else if (diff === -1) data[s.player_id].birdies++;
      if (diff >= 3) data[s.player_id].blowups++;
    });
    return data;
  }, [allScores, allHoles, allStrokes, rounds]);

  const topBirdies = [...PLAYER_LIST].sort((a,b) => (stats[b.id].birdies + stats[b.id].eagles*2) - (stats[a.id].birdies + stats[a.id].eagles*2))[0];
  const mostBlowups = [...PLAYER_LIST].sort((a,b) => stats[b.id].blowups - stats[a.id].blowups)[0];

  const rankByRound = useMemo(() => {
    const positions = {};
    PLAYER_LIST.forEach(p => positions[p.id] = []);
    const cum = {};
    PLAYER_LIST.forEach(p => cum[p.id] = 0);
    [1,2,3,4].forEach(r => {
      const pts = allRoundPoints[r] || {};
      PLAYER_LIST.forEach(p => { cum[p.id] += pts[p.id] || 0; });
      const ranked = [...PLAYER_LIST].sort((a,b) => cum[b.id] - cum[a.id]);
      ranked.forEach((p, i) => positions[p.id].push(i+1));
    });
    return positions;
  }, [allRoundPoints]);

  const mostClutch = useMemo(() => {
    let best = null; let bestGain = 0;
    PLAYER_LIST.forEach(p => {
      const pos = rankByRound[p.id];
      if (!pos || pos.length < 2) return;
      const gain = pos[0] - pos[pos.length - 1];
      if (gain > bestGain) { bestGain = gain; best = { player: p, gain, from: pos[0], to: pos[pos.length - 1] }; }
    });
    return best;
  }, [rankByRound]);

  const biggestCollapse = useMemo(() => {
    let worst = null; let worstLoss = 0;
    PLAYER_LIST.forEach(p => {
      const pos = rankByRound[p.id];
      if (!pos || pos.length < 2) return;
      const loss = pos[pos.length - 1] - pos[0];
      if (loss > worstLoss) { worstLoss = loss; worst = { player: p, loss, from: pos[0], to: pos[pos.length - 1] }; }
    });
    return worst;
  }, [rankByRound]);

  const totalScores = allScores.length;

  return (
    <>
      <div className="card featured">
        <h2>Awards & Superlatives</h2>
        <div style={{opacity:0.85, fontSize:'0.9rem'}}>Updated live as scores come in.</div>
      </div>

      {totalScores === 0 ? (
        <div className="card empty">Awards unlock as scores get entered. Get out there.</div>
      ) : (
        <>
          <div className="award-card">
            <div className="label">🐦 Birdie Machine</div>
            <div className="name">{topBirdies.emoji} {topBirdies.name}</div>
            <div className="detail">
              {stats[topBirdies.id].birdies} birdies, {stats[topBirdies.id].eagles} eagle{stats[topBirdies.id].eagles === 1 ? '' : 's'}
            </div>
          </div>

          <div className="award-card" style={{background: 'linear-gradient(135deg, #8b2c2c 0%, #5c1d1d 100%)'}}>
            <div className="label" style={{color:'#f4c4a8'}}>💥 Blow-Up King</div>
            <div className="name">{mostBlowups.emoji} {mostBlowups.name}</div>
            <div className="detail">{stats[mostBlowups.id].blowups} double-bogeys or worse</div>
          </div>

          {mostClutch && mostClutch.gain > 0 && (
            <div className="award-card" style={{background: 'linear-gradient(135deg, var(--gold) 0%, #b8902a 100%)', color:'var(--green-deep)'}}>
              <div className="label" style={{color:'var(--green-deep)'}}>⚡ Most Clutch</div>
              <div className="name" style={{color:'var(--green-deep)'}}>{mostClutch.player.emoji} {mostClutch.player.name}</div>
              <div className="detail" style={{color:'var(--green-deep)'}}>
                Climbed {mostClutch.gain} {mostClutch.gain === 1 ? 'spot' : 'spots'} (from {mostClutch.from} to {mostClutch.to})
              </div>
            </div>
          )}

          {biggestCollapse && biggestCollapse.loss > 0 && (
            <div className="award-card" style={{background: 'linear-gradient(135deg, #4a4a4a 0%, #2a2a2a 100%)'}}>
              <div className="label">📉 Biggest Collapse</div>
              <div className="name">{biggestCollapse.player.emoji} {biggestCollapse.player.name}</div>
              <div className="detail">
                Dropped {biggestCollapse.loss} {biggestCollapse.loss === 1 ? 'spot' : 'spots'} (from {biggestCollapse.from} to {biggestCollapse.to})
              </div>
            </div>
          )}

          <div className="card">
            <h3>Stats Detail</h3>
            <table className="leaderboard">
              <thead>
                <tr><th>Player</th><th>Birdies</th><th>Eagles</th><th>Blowups</th><th>Holes</th></tr>
              </thead>
              <tbody>
                {PLAYER_LIST.map(p => (
                  <tr key={p.id}>
                    <td>{p.emoji} {p.name}</td>
                    <td style={{fontFamily:'JetBrains Mono, monospace'}}>{stats[p.id].birdies}</td>
                    <td style={{fontFamily:'JetBrains Mono, monospace'}}>{stats[p.id].eagles}</td>
                    <td style={{fontFamily:'JetBrains Mono, monospace'}}>{stats[p.id].blowups}</td>
                    <td style={{fontFamily:'JetBrains Mono, monospace'}}>{stats[p.id].holes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// ============== FORMATS ==============
function Formats() {
  return (
    <>
      <div className="card featured">
        <h2>Tournament Format</h2>
        <div style={{opacity:0.85, fontSize:'0.95rem'}}>
          Five rounds. Points across R1-R4 set up starting strokes for the championship.
        </div>
      </div>

      {[1,2,3,4,5].map(r => (
        <div key={r} className="card">
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:'0.5rem'}}>
            <h3>{ROUND_INFO[r].name}</h3>
            <span className="pill">{ROUND_INFO[r].format}</span>
          </div>
          <p style={{marginTop:'0.5rem', lineHeight:1.55}}>{ROUND_INFO[r].desc}</p>
        </div>
      ))}

      <div className="card">
        <h3>Points summary</h3>
        <table className="leaderboard">
          <thead>
            <tr><th>Round</th><th>Format</th><th style={{textAlign:'right'}}>Max</th></tr>
          </thead>
          <tbody>
            <tr><td>R1</td><td>Individual stroke</td><td style={{textAlign:'right', fontFamily:'JetBrains Mono, monospace'}}>13</td></tr>
            <tr><td>R2</td><td>Best ball</td><td style={{textAlign:'right', fontFamily:'JetBrains Mono, monospace'}}>15</td></tr>
            <tr><td>R3</td><td>Individual stroke</td><td style={{textAlign:'right', fontFamily:'JetBrains Mono, monospace'}}>13</td></tr>
            <tr><td>R4</td><td>Scramble</td><td style={{textAlign:'right', fontFamily:'JetBrains Mono, monospace'}}>15</td></tr>
            <tr><td><strong>Total</strong></td><td></td><td style={{textAlign:'right', fontFamily:'JetBrains Mono, monospace', fontWeight:700}}>56</td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
