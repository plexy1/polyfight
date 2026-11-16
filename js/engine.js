// Turns raw Polymarket data into fighters, scored rounds, a verdict and a fighting style.

import { cleanName } from './api.js';

/* ───────────── formatting ───────────── */

const MINUS = '−';

export function fmtMoney(v, { signed = false } = {}) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  let body;
  if (a >= 1e9) body = `${(a / 1e9).toFixed(2)}B`;
  else if (a >= 1e6) body = `${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  else if (a >= 1e4) body = `${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  else body = Math.round(a).toLocaleString('en-US');
  const sign = v < 0 ? MINUS : signed && v > 0 ? '+' : '';
  return `${sign}$${body}`;
}

export const fmtInt = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));

export function fmtPct(v, { signed = false, digits = 0 } = {}) {
  if (v == null || !isFinite(v)) return '—';
  const sign = v < 0 ? MINUS : signed && v > 0 ? '+' : '';
  return `${sign}${Math.abs(v * 100).toFixed(digits)}%`;
}

export function fmtRatio(v) {
  if (v == null) return '—';
  if (!isFinite(v)) return '∞';
  return `${v >= 100 ? Math.round(v) : v.toFixed(2)}×`;
}

export const fmtDate = (epoch) =>
  epoch ? new Date(epoch * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—';

const truncate = (s, n = 46) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s || '');

/* ───────────── fighter model ───────────── */

const WEIGHT_CLASSES = [
  [1e3, 'Strawweight'],
  [1e4, 'Flyweight'],
  [5e4, 'Bantamweight'],
  [2.5e5, 'Featherweight'],
  [1e6, 'Lightweight'],
  [5e6, 'Welterweight'],
  [2.5e7, 'Middleweight'],
  [1e8, 'Light Heavyweight'],
  [Infinity, 'Heavyweight'],
];

export function buildFighter(raw) {
  const s = raw.stats || {};
  const atp = s.all_time_pnl || {};
  const board = raw.board || {};
  const profile = raw.profile || {};
  const recent = raw.recent || [];

  const markets = s.trades || 0;
  const tradeCount = atp.trade_count || 0;
  if (!markets && !tradeCount && !board.volume) {
    const err = new Error('has no trading record on Polymarket.');
    err.noRecord = true;
    throw err;
  }

  const pnl = atp.economic_pnl ?? board.pnl ?? 0;
  const volume = atp.volume ?? board.volume ?? 0;
  const joined = s.join_date || (profile.createdAt ? Date.parse(profile.createdAt) / 1000 : null);

  // Resolved-position sample (most recent first).
  let wins = 0, losses = 0, grossWin = 0, grossLoss = 0, entrySum = 0, entryN = 0;
  for (const p of recent) {
    if (p.realized_pnl > 0) { wins++; grossWin += p.realized_pnl; }
    else if (p.realized_pnl < 0) { losses++; grossLoss -= p.realized_pnl; }
    if (p.avg_price > 0 && p.avg_price < 1) { entrySum += p.avg_price; entryN++; }
  }
  const decided = wins + losses;
  const winRate = decided >= 5 ? wins / decided : null;
  const damageRatio = decided >= 5 ? (grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null) : null;
  const avgEntry = entryN >= 5 ? entrySum / entryN : null;

  let streak = 0;
  for (const p of recent) {
    const sign = Math.sign(p.realized_pnl);
    if (!sign) continue;
    if (!streak) streak = sign;
    else if (Math.sign(streak) === sign) streak += sign;
    else break;
  }

  const bestRow = raw.best?.[0];
  const worstRow = raw.worst?.[0];
  const best = bestRow && bestRow.realized_pnl > 0
    ? { pnl: bestRow.realized_pnl, title: bestRow.title, outcome: bestRow.outcome } : null;
  const worst = worstRow && worstRow.realized_pnl < 0
    ? { pnl: worstRow.realized_pnl, title: worstRow.title, outcome: worstRow.outcome } : null;

  const openRows = raw.open?.data || [];
  const open = {
    count: openRows.length,
    more: Boolean(raw.open?.pagination?.has_more),
    top: openRows[0] ? { title: openRows[0].title, value: openRows[0].current_value } : null,
  };

  // Equity curve + deepest drawdown.
  const series = (raw.pnl?.points || []).map((p) => [p.timestamp, p.economic_pnl ?? 0]);
  let peak = 0, maxDrawdown = 0, run = 0;
  for (const [, v] of series) {
    if (v > run) run = v;
    if (run - v > maxDrawdown) maxDrawdown = run - v;
    if (v > peak) peak = v;
  }

  const f = {
    address: raw.address,
    name: cleanName(profile.name || board.user_name || recent[0]?.name, raw.address),
    nickname: profile.pseudonym || '',
    avatar: profile.profileImage || board.profile_image || '',
    verified: Boolean(profile.verifiedBadge || board.verified),
    joined,
    years: joined ? (Date.now() / 1000 - joined) / (365.25 * 86400) : 0,
    pnl,
    volume,
    tradeCount,
    markets,
    biggestWin: s.biggest_win || best?.pnl || 0,
    views: s.views || 0,
    value: raw.value?.value ?? 0,
    rank: board.rank_pnl || null,
    roi: volume > 0 ? pnl / volume : null,
    wins, losses, winRate, damageRatio, avgEntry, streak,
    sample: decided,
    best, worst, open,
    series, peak, maxDrawdown,
    weightClass: WEIGHT_CLASSES.find(([cap]) => volume < cap)[1],
  };
  f.attrs = attributes(f);
  f.style = fightingStyle(f);
  return f;
}

/* ───────────── rounds & scoring ───────────── */

export const ROUNDS = [
  {
    key: 'markets', name: 'Cardio', sub: 'Distinct markets fought in',
    fmt: fmtInt,
    note: (f) => (f.joined ? `Active since ${fmtDate(f.joined)}` : ''),
  },
  {
    key: 'volume', name: 'Output', sub: 'Total volume thrown',
    fmt: (v) => fmtMoney(v),
    note: (f) => (f.tradeCount ? `${fmtInt(f.tradeCount)} trades` : ''),
  },
  {
    key: 'winRate', name: 'Accuracy', sub: 'Win rate on recent resolved positions',
    fmt: (v) => fmtPct(v),
    note: (f) => (f.sample ? `${f.wins}–${f.losses} in last ${f.sample}` : 'No resolved positions'),
  },
  {
    key: 'biggestWin', name: 'Knockout Power', sub: 'Biggest single win',
    fmt: (v) => fmtMoney(v),
    note: (f) => (f.best ? truncate(f.best.title) : ''),
  },
  {
    key: 'damageRatio', name: 'Damage Ratio', sub: 'Dollars landed per dollar absorbed',
    fmt: fmtRatio,
    note: (f) => (f.worst ? `Worst hit ${fmtMoney(f.worst.pnl)}` : f.sample ? 'Never been hurt' : ''),
  },
  {
    key: 'roi', name: 'Fight IQ', sub: 'Profit per dollar traded',
    fmt: (v) => fmtPct(v, { signed: true, digits: 1 }),
    note: () => '',
  },
  {
    key: 'pnl', name: 'The Purse', sub: 'All-time profit and loss',
    fmt: (v) => fmtMoney(v, { signed: true }),
    note: (f) => (f.rank ? `#${fmtInt(f.rank)} all-time` : 'Unranked'),
  },
];

const cmp = (a, b) => (a === b ? 0 : a > b ? 1 : -1);

/** 10-point must: best in the round takes 10, each place below loses a point. */
function scoreRound(round, fighters) {
  const values = fighters.map((f) => f[round.key]);
  const known = values.filter((v) => v != null);
  if (!known.length) {
    return { values, points: fighters.map(() => 10), winners: [], bars: fighters.map(() => 0), noContest: true };
  }
  const distinct = [...new Set(known)].sort((a, b) => cmp(b, a));
  const top = distinct[0];
  const points = values.map((v) => (v == null ? 10 - distinct.length : 10 - distinct.indexOf(v)));

  // A lopsided two-way round is a 10–8.
  if (fighters.length === 2 && distinct.length === 2) {
    const low = distinct[1];
    const lopsided = top > 0 && isFinite(top) ? low <= top * 0.5 : !isFinite(top);
    if (lopsided) points[values.indexOf(low)] = 8;
  }
  if (known.length < values.length) {
    values.forEach((v, i) => { if (v == null) points[i] = Math.min(points[i], 9); });
  }

  const winners = distinct.length > 1 || known.length < values.length
    ? values.map((v, i) => (v === top ? i : -1)).filter((i) => i >= 0)
    : [];

  // Bar length = how good the number is, on a shared scale that includes zero.
  const finite = known.filter(isFinite);
  const lo = Math.min(0, ...finite);
  const hi = Math.max(0, ...finite);
  const bars = values.map((v) => {
    if (v == null) return 0;
    if (!isFinite(v)) return 1;
    if (hi === lo) return 0;
    return Math.max(0.03, (v - lo) / (hi - lo));
  });
  return { values, points, winners, bars, noContest: false };
}

export function scoreFight(fighters) {
  const rounds = ROUNDS.map((r) => ({ round: r, ...scoreRound(r, fighters) }));
  const totals = fighters.map((_, i) => rounds.reduce((sum, r) => sum + r.points[i], 0));
  const roundsWon = fighters.map((_, i) => rounds.filter((r) => r.winners.length === 1 && r.winners[0] === i).length);

  const order = fighters.map((_, i) => i).sort((a, b) => totals[b] - totals[a] || roundsWon[b] - roundsWon[a]);
  const [first, second] = order;
  const margin = totals[first] - totals[second];
  const draw = margin === 0 && roundsWon[first] === roundsWon[second];

  let method;
  if (draw) method = 'Draw';
  else if (roundsWon[first] === rounds.length) method = 'Knockout';
  else if (margin >= (fighters.length === 2 ? 6 : 8)) method = 'TKO';
  else if (margin >= 3) method = 'Unanimous Decision';
  else method = 'Split Decision';

  return { rounds, totals, roundsWon, order, winner: draw ? null : first, method, margin };
}

/* ───────────── fighting style ───────────── */

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (v, lo, hi) => clamp01((v - lo) / (hi - lo));
const log10 = (v) => Math.log10(Math.max(v, 1));

export const ATTRIBUTES = [
  ['power', 'Power'],
  ['accuracy', 'Accuracy'],
  ['output', 'Output'],
  ['cardio', 'Cardio'],
  ['chin', 'Chin'],
  ['iq', 'Fight IQ'],
];

function attributes(f) {
  const roi = f.roi ?? 0;
  const ratioPart = f.damageRatio == null ? 0.4
    : !isFinite(f.damageRatio) ? 1 : lerp(Math.log2(Math.max(f.damageRatio, 0.01)), -1, 1.5);
  const drawdownPart = f.peak > 0 ? 1 - clamp01(f.maxDrawdown / f.peak) : f.pnl < 0 ? 0.1 : 0.5;
  return {
    power: lerp(log10(f.biggestWin), 1.5, 6.5),
    accuracy: f.winRate == null ? 0.4 : lerp(f.winRate, 0.3, 0.8),
    output: lerp(log10(f.tradeCount), 1, 5),
    cardio: lerp(log10(f.markets), 0.7, 3.7),
    chin: 0.5 * ratioPart + 0.5 * drawdownPart,
    iq: roi < 0 ? 0.35 * (1 - clamp01(-roi / 0.1)) : 0.35 + 0.65 * clamp01(roi / 0.15),
  };
}

const STYLES = {
  prospect: {
    name: 'The Prospect',
    discipline: 'Unproven, undefeated in the gym',
    tag: 'Still on the prelims. The tape is too short to scout.',
    comps: [],
    blurb: 'A handful of fights is not a career. The raw tools might be there, but nobody knows what happens when the lights get bright and a position goes against them.',
  },
  goat: {
    name: 'The Pound-for-Pound King',
    discipline: 'Complete mixed martial artist',
    tag: 'No holes. Wins everywhere the fight goes.',
    comps: ['Georges St-Pierre', 'Demetrious Johnson'],
    blurb: 'Size, accuracy, pace and discipline all at once. This trader does not need a single big night to look good; the whole game is elite, and the record shows it across hundreds of markets.',
  },
  knockout: {
    name: 'The Knockout Artist',
    discipline: 'One-punch power',
    tag: 'Does not need many shots. Needs one.',
    comps: ['Francis Ngannou', 'Derrick Lewis'],
    blurb: 'A career defined by a single enormous bet that landed clean. Long quiet stretches, then one position sized so heavily it ends the night and pays for everything else.',
  },
  striker: {
    name: 'The Volume Striker',
    discipline: 'Relentless pace',
    tag: 'Death by a thousand jabs.',
    comps: ['Max Holloway', 'Sean Strickland'],
    blurb: 'Never stops throwing. Small trades, constantly, in every market on the card. No single shot does the damage; the sheer count of them does.',
  },
  counter: {
    name: 'The Counter-Striker',
    discipline: 'Precision striking',
    tag: 'Waits. Reads. Lands the one that matters.',
    comps: ['Israel Adesanya', 'Anderson Silva'],
    blurb: 'Picks spots instead of chasing action. A high hit rate and a fat return on every dollar risked say this trader only steps in when the market has made a mistake.',
  },
  wrestler: {
    name: 'The Pressure Wrestler',
    discipline: 'Top control and grinding',
    tag: 'Takes the favourite down and holds it there.',
    comps: ['Khabib Nurmagomedov', 'Merab Dvalishvili'],
    blurb: 'Not here for highlights. Buys the likely outcome at a high price, collects a few cents, and does it again with serious size. Boring to watch, miserable to fight.',
  },
  submission: {
    name: 'The Submission Specialist',
    discipline: 'Opportunistic finisher',
    tag: 'Looks beaten, then the underdog taps the market out.',
    comps: ['Charles Oliveira', 'Demian Maia'],
    blurb: 'Lives on cheap, unlikely outcomes. Loses plenty of exchanges on the feet, but when a longshot catch locks in, the payout is many times the stake.',
  },
  brawler: {
    name: 'The Brawler',
    discipline: 'All action, no defence',
    tag: 'Bites down on the mouthpiece and swings.',
    comps: ['Justin Gaethje', 'Robbie Lawler'],
    blurb: 'Trades blow for blow with the market and gives back most of what it takes. Enormous activity, wild swings, and a bottom line that sits close to even. Fight of the Night every time.',
  },
  zombie: {
    name: 'The Zombie',
    discipline: 'Pure durability',
    tag: 'Keeps walking forward through the damage.',
    comps: ['Chan Sung Jung', 'Tony Ferguson'],
    blurb: 'Down on the scorecards and still marching. The losses are real, but so is the refusal to stop showing up. Heart is not the problem. Defence is.',
  },
  veteran: {
    name: 'The Veteran',
    discipline: 'Seen it all',
    tag: 'Years on the roster, still making weight.',
    comps: ['Jim Miller', 'Andrei Arlovski'],
    blurb: 'A long career with the ledger near level. Not chasing a belt any more; knows every trick, survives every cycle, and tests whoever is coming up next.',
  },
};

function fightingStyle(f) {
  const a = f.attrs;
  const roi = f.roi ?? 0;
  const profitable = f.pnl > 0;
  const vals = Object.values(a);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const concentration = profitable && f.biggestWin > 0 ? clamp01(f.biggestWin / f.pnl) : 0;
  const favourite = f.avgEntry == null ? 0 : lerp(f.avgEntry, 0.5, 0.8);
  const longshot = f.avgEntry == null ? 0 : lerp(0.5 - f.avgEntry, 0, 0.25);
  const avgTrade = f.tradeCount ? f.volume / f.tradeCount : 0;
  const smallTrades = 1 - lerp(log10(avgTrade), 1.5, 4);
  const breakeven = 1 - clamp01(Math.abs(roi) / 0.03);

  const scores = {
    prospect: f.markets < 12 && f.tradeCount < 200 ? 2 : 0,
    goat: profitable ? mean * (Math.min(...vals) >= 0.45 ? 1.25 : 0.8) : 0,
    knockout: profitable
      ? (0.55 * concentration + 0.3 * a.power + 0.15 * (1 - a.cardio)) * (concentration >= 0.4 ? 1.2 : 0.8) : 0,
    striker: (0.5 * a.output + 0.3 * a.cardio + 0.2 * smallTrades) * (profitable ? 1 : 0.75),
    counter: profitable
      ? (0.4 * a.accuracy + 0.4 * a.iq + 0.2 * (1 - a.output)) * (a.accuracy >= 0.6 && a.iq >= 0.5 ? 1.2 : 0.8) : 0,
    wrestler: profitable
      ? (0.45 * favourite + 0.25 * a.accuracy + 0.3 * lerp(log10(f.volume), 4, 8)) * (favourite >= 0.3 ? 1.15 : 0.6) : 0,
    submission: (0.6 * longshot + 0.25 * a.iq + 0.15 * a.power) * (longshot >= 0.3 && profitable ? 1.25 : 0.5),
    brawler: (0.35 * a.output + 0.35 * (1 - a.chin) + 0.3 * breakeven) * (roi < 0.02 ? 1.1 : 0.6),
    zombie: !profitable ? (0.5 * lerp(-roi, 0, 0.15) + 0.3 * a.cardio + 0.2 * a.output) * 1.3 + 0.2 : 0,
    veteran: (0.45 * lerp(f.years, 0.5, 3) + 0.55 * breakeven) * 0.9,
  };

  const ranked = Object.entries(scores).sort((x, y) => y[1] - x[1]);
  const [id, top] = ranked[0];
  const [runnerId, runnerScore] = ranked[1];

  return {
    id,
    ...STYLES[id],
    match: Math.min(99, Math.round(55 + 45 * clamp01(top))),
    shades: runnerScore > 0.35 && id !== 'prospect' ? STYLES[runnerId].name : null,
    receipts: receipts(id, f, { concentration, avgTrade }),
  };
}

/** The numbers behind the verdict, most relevant first. */
function receipts(id, f, { concentration, avgTrade }) {
  const lines = {
    concentration: concentration > 0 && f.best
      ? `${fmtPct(concentration)} of career profit came from one position: ${truncate(f.best.title, 60)}` : null,
    ko: f.biggestWin > 0 ? `Biggest win: ${fmtMoney(f.biggestWin)}` : null,
    pace: f.tradeCount ? `${fmtInt(f.tradeCount)} trades across ${fmtInt(f.markets)} markets` : null,
    size: avgTrade ? `Average trade size ${fmtMoney(avgTrade)}` : null,
    accuracy: f.winRate != null ? `Won ${fmtPct(f.winRate)} of the last ${f.sample} resolved positions` : null,
    roi: f.roi != null ? `${fmtPct(f.roi, { signed: true, digits: 1 })} return on ${fmtMoney(f.volume)} traded` : null,
    entry: f.avgEntry != null ? `Average entry price ${Math.round(f.avgEntry * 100)}¢` : null,
    ratio: f.damageRatio != null ? `Lands ${fmtRatio(f.damageRatio)} for every $1 absorbed` : null,
    worst: f.worst ? `Worst single loss: ${fmtMoney(f.worst.pnl)} on ${truncate(f.worst.title, 50)}` : null,
    drawdown: f.maxDrawdown > 0 ? `Deepest drawdown: ${fmtMoney(f.maxDrawdown)}` : null,
    tenure: f.joined ? `On the roster since ${fmtDate(f.joined)}` : null,
    pnl: `All-time PnL ${fmtMoney(f.pnl, { signed: true })}`,
    selective: `Only ${fmtInt(f.markets)} markets entered`,
  };
  const pick = {
    prospect: ['selective', 'pace', 'tenure'],
    goat: ['pnl', 'accuracy', 'roi', 'pace'],
    knockout: ['concentration', 'ko', 'selective'],
    striker: ['pace', 'size', 'accuracy'],
    counter: ['accuracy', 'roi', 'ratio', 'selective'],
    wrestler: ['entry', 'accuracy', 'roi'],
    submission: ['entry', 'ko', 'roi'],
    brawler: ['pace', 'roi', 'drawdown', 'worst'],
    zombie: ['pnl', 'worst', 'pace'],
    veteran: ['tenure', 'roi', 'pace'],
  }[id];
  return pick.map((k) => lines[k]).filter(Boolean).slice(0, 3);
}
