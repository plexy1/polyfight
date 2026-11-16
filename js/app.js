import { searchProfiles, resolveInput, topTraders, fetchFighterData, shortAddress } from './api.js';
import { buildFighter, scoreFight, ATTRIBUTES, fmtMoney, fmtInt, fmtDate } from './engine.js';
import { prankIndex, applyPrank, showPrank } from './prank.js';

const CORNERS = ['Red', 'Blue', 'Green', 'Violet'];
const MAX_FIGHTERS = 4;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Tiny DOM builder. Text always goes through textContent, never innerHTML. */
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid);
  }
  return node;
}
const corner = (i) => `--c: var(--c${i})`;

/* ───────────── sound ───────────── */

let audioCtx = null;
let soundOn = true;
try { soundOn = localStorage.getItem('polyfight-sound') !== 'off'; } catch { /* storage unavailable */ }

function tone({ freq, at = 0, dur = 1.2, gain = 0.2, type = 'sine', slideTo }) {
  const t0 = audioCtx.currentTime + at;
  const osc = audioCtx.createOscillator();
  const amp = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  amp.gain.setValueAtTime(gain, t0);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(amp).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}
function sound(kind) {
  if (!soundOn) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (kind === 'thud') return tone({ freq: 150, slideTo: 50, dur: 0.16, gain: 0.35 });
    const rings = kind === 'final' ? 3 : 1;
    for (let k = 0; k < rings; k++) {
      [[1, 0.22], [2.76, 0.1], [5.4, 0.05]].forEach(([mult, gain]) =>
        tone({ freq: 1180 * mult, at: k * 0.34, dur: 1.4, gain }));
    }
  } catch { /* audio is a nicety */ }
}
function syncSoundButton() {
  const btn = $('soundBtn');
  btn.textContent = soundOn ? 'Sound on' : 'Sound off';
  btn.setAttribute('aria-pressed', String(soundOn));
}
$('soundBtn').addEventListener('click', () => {
  soundOn = !soundOn;
  try { localStorage.setItem('polyfight-sound', soundOn ? 'on' : 'off'); } catch { /* ignore */ }
  syncSoundButton();
});
syncSoundButton();

/* ───────────── screens ───────────── */

function show(id) {
  for (const s of ['setup', 'weighin', 'arena']) $(s).hidden = s !== id;
  window.scrollTo({ top: 0 });
}

/* ───────────── setup: corners ───────────── */

const slots = [{ text: '', picked: null }, { text: '', picked: null }];

function renderCorners() {
  const wrap = $('corners');
  wrap.dataset.n = slots.length;
  wrap.replaceChildren(...slots.map(cornerCard));
  $('addCorner').hidden = slots.length >= MAX_FIGHTERS;
}

function cornerCard(slot, i) {
  const input = el('input', {
    id: `fighter${i}`, type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    placeholder: 'Username, wallet or profile link', value: slot.text,
    role: 'combobox', 'aria-expanded': 'false', 'aria-controls': `suggest${i}`, 'aria-autocomplete': 'list',
  });
  const list = el('ul', { class: 'suggest', id: `suggest${i}`, role: 'listbox', hidden: true });
  const hint = el('p', { class: 'corner-hint', text: slot.picked ? shortAddress(slot.picked.address) : '' });
  const card = el('div', { class: `corner${slot.picked ? ' picked' : ''}`, style: corner(i) },
    el('label', { class: 'corner-tag', for: `fighter${i}` }, el('small', { text: `Fighter ${i + 1}` }), `${CORNERS[i]} corner`),
    el('div', { class: 'field' }, input, list),
    hint,
    slots.length > 2 && el('button', {
      type: 'button', class: 'remove', 'aria-label': `Remove ${CORNERS[i]} corner`, text: '×',
      onclick: () => { slots.splice(i, 1); renderCorners(); },
    }),
  );
  slot.card = card;
  slot.hint = hint;

  let seq = 0, timer = 0, active = -1, options = [];

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const choose = (p) => {
    slot.picked = p;
    slot.text = input.value = p.name;
    card.classList.add('picked');
    card.classList.remove('bad');
    hint.textContent = shortAddress(p.address);
    close();
  };
  const paint = () => {
    list.replaceChildren(...options.map((p, k) => el('li', {
      role: 'option', 'aria-selected': String(k === active),
      // mousedown so the pick lands before the input's blur closes the list
      onmousedown: (e) => { e.preventDefault(); choose(p); },
    }, el('b', { text: p.name }), el('span', { text: shortAddress(p.address) }))));
    list.hidden = !options.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
  };

  input.addEventListener('input', () => {
    slot.text = input.value;
    slot.picked = null;
    card.classList.remove('picked', 'bad');
    hint.textContent = '';
    clearTimeout(timer);
    const q = input.value.trim();
    const mine = ++seq;
    if (q.length < 2 || /0x[a-fA-F0-9]{6,}/.test(q) || q.includes('/')) { options = []; close(); return; }
    timer = setTimeout(async () => {
      try {
        const found = await searchProfiles(q);
        if (mine !== seq) return;
        options = found;
        active = -1;
        paint();
      } catch { /* suggestions are optional; submit still resolves the name */ }
    }, 260);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      paint();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(options[active]);
    } else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => { seq++; clearTimeout(timer); setTimeout(close, 120); });
  return card;
}

$('addCorner').addEventListener('click', () => {
  if (slots.length >= MAX_FIGHTERS) return;
  slots.push({ text: '', picked: null });
  renderCorners();
  $(`fighter${slots.length - 1}`).focus();
});

$('card').addEventListener('submit', (e) => {
  e.preventDefault();
  $('formError').textContent = '';
  const filled = slots.filter((s) => s.text.trim());
  if (filled.length < 2) {
    $('formError').textContent = 'A fight needs at least two fighters. Fill in both corners.';
    slots.find((s) => !s.text.trim())?.card.querySelector('input').focus();
    return;
  }
  // drop empty extra corners
  for (let i = slots.length - 1; i >= 0 && slots.length > 2; i--) if (!slots[i].text.trim()) slots.splice(i, 1);
  renderCorners();
  runFight(slots.map((s) => (s.picked ? { ...s.picked } : { text: s.text })));
});

/* ───────────── setup: booked fights ───────────── */

async function loadPresets() {
  try {
    const [allTime, today] = await Promise.all([topTraders('all', 4), topTraders('day', 2)]);
    const presets = [];
    if (allTime.length >= 2) presets.push({ label: 'All-time #1 vs #2', fighters: allTime.slice(0, 2) });
    if (today.length >= 2) presets.push({ label: "Today's two hottest", fighters: today });
    if (allTime.length >= 4) presets.push({ label: 'All-time top four', fighters: allTime });
    if (!presets.length) return;
    $('presets').replaceChildren(...presets.map((p) => {
      const names = el('b');
      p.fighters.forEach((f, i) => {
        if (i) names.append(el('i', { text: 'vs' }));
        names.append(f.name);
      });
      return el('button', {
        type: 'button', class: 'preset',
        onclick: () => {
          slots.splice(0, slots.length, ...p.fighters.map((f) => ({ text: f.name, picked: { address: f.address, name: f.name } })));
          renderCorners();
          runFight(p.fighters.map((f) => ({ address: f.address, name: f.name })));
        },
      }, el('small', { text: p.label }), names);
    }));
    $('booked').hidden = false;
  } catch { /* presets are optional */ }
}

/* ───────────── weigh-in: load everyone ───────────── */

let fighters = [];
let fight = null;

async function runFight(inputs) {
  playToken++;
  show('weighin');
  const rows = inputs.map((inp, i) => {
    const who = el('span', { class: 'who', text: inp.name || inp.text || shortAddress(inp.address) });
    const state = el('span', { class: 'state', text: 'Pulling tape' });
    return { who, state, li: el('li', { class: 'wait', style: corner(i) }, who, state) };
  });
  $('weighList').replaceChildren(...rows.map((r) => r.li));

  const minBeat = wait(reducedMotion ? 0 : 900);
  const results = await Promise.all(inputs.map(async (inp, i) => {
    const row = rows[i];
    let label = inp.name || inp.text;
    try {
      const who = inp.address ? inp : await resolveInput(inp.text);
      if (who.name) { label = who.name; row.who.textContent = who.name; }
      const fighter = buildFighter(await fetchFighterData(who.address));
      row.who.textContent = fighter.name;
      row.state.textContent = `${fighter.weightClass} · on weight`;
      row.li.className = 'ok';
      return { fighter };
    } catch (err) {
      row.state.textContent = 'Missed weight';
      row.li.className = 'fail';
      const message = err.noRecord ? `${label || 'This wallet'} ${err.message}`
        : err.name === 'AbortError' || err instanceof TypeError ? 'Could not reach Polymarket. Check your connection and try again.'
        : err.message;
      return { error: message };
    }
  }));
  await minBeat;

  const seen = new Set();
  results.forEach((r) => {
    if (!r.fighter) return;
    if (seen.has(r.fighter.address)) { r.error = `${r.fighter.name} is already in another corner.`; delete r.fighter; }
    else seen.add(r.fighter.address);
  });

  if (results.some((r) => r.error)) {
    await wait(reducedMotion ? 0 : 500);
    show('setup');
    results.forEach((r, i) => {
      const slot = slots[i];
      if (!slot || !r.error) return;
      slot.card.classList.add('bad');
      slot.hint.textContent = r.error;
    });
    $('formError').textContent = 'The fight is off until every corner makes weight.';
    return;
  }

  fighters = results.map((r) => r.fighter);
  fight = scoreFight(fighters);
  slots.splice(0, slots.length, ...fighters.map((f) => ({ text: f.name, picked: { address: f.address, name: f.name } })));
  renderCorners();
  history.replaceState(null, '', `?fight=${fighters.map((f) => f.address).join(',')}`);
  renderArena();
  show('arena');
}

/* ───────────── arena ───────────── */

function renderArena() {
  const n = fighters.length;
  for (const id of ['fighters', 'tape', 'rounds', 'styles']) {
    $(id).dataset.n = n;
    $(id).style.setProperty('--n', n);
  }

  // sticky score bar
  $('scorebar').replaceChildren(
    el('div', { class: 'sb-round', id: 'sbRound', text: 'Tale of the tape' }),
    el('div', { class: 'sb-chips', 'data-n': n, style: `--n: ${n}` },
      fighters.map((f, i) => el('div', { class: 'sb-chip', style: corner(i) },
        el('span', { class: 'n', text: f.name }), el('span', { class: 's', text: '0' })))),
  );

  $('fighters').replaceChildren(...fighters.map(fighterPanel));
  $('tape').replaceChildren(...tapeRows());
  $('rounds').replaceChildren(...fight.rounds.map(roundRow));
  resetFight();
}

function fighterPanel(f, i) {
  const initial = (f.name.match(/[a-z0-9]/i)?.[0] || '?').toUpperCase();
  const avatar = el('div', { class: 'avatar', 'aria-hidden': 'true' }, initial);
  if (/^https:\/\//.test(f.avatar)) {
    const img = el('img', { src: f.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('load', () => avatar.replaceChildren(img));
  }
  return el('article', { class: 'fighter', style: corner(i) },
    el('p', { class: 'tag', text: `${CORNERS[i]} corner` }),
    avatar,
    el('h2', { class: 'name', text: f.name }),
    f.nickname && el('p', { class: 'nick', text: `“${f.nickname.replace(/-/g, ' ')}”` }),
    el('p', { class: 'class' }, el('b', { text: f.weightClass }), f.rank && el('span', { text: `#${fmtInt(f.rank)}` })),
    el('a', { class: 'profile', href: `https://polymarket.com/profile/${f.address}`, target: '_blank', rel: 'noopener', text: 'Polymarket profile ↗' }),
    careerArc(f),
  );
}

/** Career PnL sparkline: one series, own scale, with a hover readout. */
function careerArc(f) {
  const label = el('span', { text: 'Career PnL' });
  const value = el('b', { text: fmtMoney(f.pnl, { signed: true }) });
  const wrap = el('div', { class: 'arc' }, el('div', { class: 'arc-read' }, label, value));
  let pts = f.series;
  if (pts.length < 2) return wrap;
  const step = Math.ceil(pts.length / 180);
  if (step > 1) pts = pts.filter((_, k) => k % step === 0 || k === pts.length - 1);

  const W = 300, H = 64, PAD = 4;
  const vals = pts.map((p) => p[1]);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const x = (k) => (k / (pts.length - 1)) * W;
  const y = (v) => PAD + (1 - (v - lo) / span) * (H - PAD * 2);
  const line = pts.map((p, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)} ${y(p[1]).toFixed(1)}`).join('');
  const zeroY = y(0).toFixed(1);

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${f.name} cumulative profit and loss over time, now ${fmtMoney(f.pnl, { signed: true })}`);
  const add = (tag, attrs) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  };
  add('path', { class: 'area', d: `${line}L${W} ${zeroY}L0 ${zeroY}Z` });
  add('line', { class: 'zero', x1: 0, x2: W, y1: zeroY, y2: zeroY });
  add('path', { class: 'line', d: line });

  const cross = el('i', { class: 'cross', hidden: true });
  const dot = el('i', { class: 'dot', hidden: true });
  const plot = el('div', { class: 'arc-plot' }, svg, cross, dot);
  const move = (e) => {
    const box = plot.getBoundingClientRect();
    const k = Math.round(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * (pts.length - 1));
    const [t, v] = pts[k];
    cross.hidden = dot.hidden = false;
    cross.style.left = dot.style.left = `${(x(k) / W) * 100}%`;
    dot.style.top = `${(y(v) / H) * 100}%`;
    label.textContent = new Date(t * 1000).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
    value.textContent = fmtMoney(v, { signed: true });
  };
  const leave = () => {
    cross.hidden = dot.hidden = true;
    label.textContent = 'Career PnL';
    value.textContent = fmtMoney(f.pnl, { signed: true });
  };
  plot.addEventListener('pointermove', move);
  plot.addEventListener('pointerdown', move);
  plot.addEventListener('pointerleave', leave);
  wrap.append(plot);
  return wrap;
}

function tapeRows() {
  const rows = [
    ['Ranking', (f) => (f.rank ? `#${fmtInt(f.rank)}` : 'Unranked')],
    ['Weight class', (f) => f.weightClass],
    ['Recent record', (f) => (f.sample ? `${f.wins}–${f.losses}` : '—')],
    ['Streak', (f) => (f.streak > 0 ? `W${f.streak}` : f.streak < 0 ? `L${-f.streak}` : '—')],
    ['Pro debut', (f) => fmtDate(f.joined)],
    ['Portfolio', (f) => fmtMoney(f.value)],
    ['Open bets', (f) => `${f.open.count}${f.open.more ? '+' : ''}`],
    ['Profile views', (f) => fmtInt(f.views)],
  ];
  return rows.map(([label, get]) => el('div', { class: 'tape-row', style: `--n: ${fighters.length}` },
    el('span', { class: 'tape-label', text: label }),
    fighters.map((f, i) => el('div', { class: 'tape-val', style: corner(i), text: get(f) }))));
}

function roundRow(r, i) {
  return el('li', { class: 'round pending', style: `--n: ${fighters.length}` },
    el('div', { class: 'round-head' }, el('div', {},
      el('p', { class: 'round-no', text: `Round ${i + 1}` }),
      el('h3', { class: 'round-name', text: r.round.name }),
      el('p', { class: 'round-sub', text: r.round.sub }))),
    el('div', { class: 'cells' }, fighters.map((f, k) => el('div', { class: 'cell', style: corner(k) },
      el('div', { class: 'cell-top' },
        el('span', { class: 'value', text: '—' }),
        el('span', { class: 'pts', text: r.points[k] })),
      el('div', { class: 'track' }, el('div', { class: 'bar' })),
      el('p', { class: 'note' })))),
  );
}

/* ───────────── playing the fight ───────────── */

let playToken = 0;
let revealed = 0;
let prankTimer = 0;
let undoPrank = null;

/** Put the honest result back (replays and new fights start clean). */
function clearPrank() {
  clearTimeout(prankTimer);
  undoPrank?.();
  undoPrank = null;
}

function resetFight() {
  playToken++;
  clearPrank();
  revealed = 0;
  for (const li of $('rounds').children) {
    li.className = 'round pending';
    li.querySelectorAll('.cell').forEach((c) => {
      c.classList.remove('won', 'lost');
      c.querySelector('.bar').style.setProperty('--w', 0);
      c.querySelector('.value').textContent = '—';
      c.querySelector('.note').textContent = '';
    });
  }
  for (const id of ['decision', 'scouting', 'after']) $(id).hidden = true;
  $('bell').hidden = false;
  $('bellBtn').hidden = false;
  $('bellBtn').classList.add('pulse');
  $('skipBtn').hidden = true;
  $('sbRound').textContent = 'Tale of the tape';
  updateScorebar();
}

function updateScorebar() {
  const totals = fighters.map((_, i) => fight.rounds.slice(0, revealed).reduce((s, r) => s + r.points[i], 0));
  const best = Math.max(...totals);
  const tied = totals.every((t) => t === best);
  document.querySelectorAll('.sb-chip').forEach((chip, i) => {
    chip.querySelector('.s').textContent = fight.dq === i ? 'DQ' : totals[i];
    chip.classList.toggle('leading', fight.dq != null ? i === fight.winner : revealed > 0 && !tied && totals[i] === best);
  });
}

function countUp(node, to, fmt, ms = 800) {
  if (to == null || !isFinite(to) || reducedMotion) { node.textContent = fmt(to); return; }
  const start = performance.now();
  let done = false;
  const finish = () => { done = true; node.textContent = fmt(to); };
  const tick = (now) => {
    if (done) return;
    const p = Math.min(1, (now - start) / ms);
    if (p >= 1) return finish();
    node.textContent = fmt(to * (1 - (1 - p) ** 3));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(finish, ms + 60); // background tabs throttle rAF; never leave a half-counted number
}

function fillRound(i, animate) {
  const r = fight.rounds[i];
  const li = $('rounds').children[i];
  li.classList.remove('pending');
  li.querySelectorAll('.cell').forEach((cell, k) => {
    cell.querySelector('.bar').style.setProperty('--w', r.bars[k]);
    const value = cell.querySelector('.value');
    if (animate) countUp(value, r.values[k], r.round.fmt);
    else value.textContent = r.round.fmt(r.values[k]);
    cell.querySelector('.note').textContent = r.round.note(fighters[k]);
  });
}

function scoreRoundRow(i) {
  const r = fight.rounds[i];
  const li = $('rounds').children[i];
  li.classList.add('scored');
  li.querySelectorAll('.cell').forEach((cell, k) => {
    cell.classList.toggle('won', r.winners.includes(k));
    cell.classList.toggle('lost', r.winners.length > 0 && !r.winners.includes(k));
  });
  revealed = Math.max(revealed, i + 1);
  updateScorebar();
}

function scrollTo(node, block = 'center') {
  node.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block });
}

async function play() {
  const token = ++playToken;
  const alive = () => token === playToken;
  $('bellBtn').hidden = true;
  $('skipBtn').hidden = false;
  sound('bell');

  for (let i = 0; i < fight.rounds.length; i++) {
    const li = $('rounds').children[i];
    $('sbRound').textContent = `Round ${i + 1} of ${fight.rounds.length} · ${fight.rounds[i].round.name}`;
    li.classList.remove('pending');
    li.classList.add('live');
    scrollTo(li);
    await wait(520);
    if (!alive()) return;
    fillRound(i, true);
    await wait(1150);
    if (!alive()) return;
    scoreRoundRow(i);
    sound('thud');
    await wait(900);
    if (!alive()) return;
  }
  $('sbRound').textContent = 'Going to the scorecards';
  await wait(900);
  if (!alive()) return;
  finish(true);
}

function skip() {
  playToken++;
  fight.rounds.forEach((_, i) => { fillRound(i, false); scoreRoundRow(i); });
  finish(false);
}

function finish(animate) {
  $('bell').hidden = true;
  $('sbRound').textContent = fight.winner == null ? 'Final · draw' : `Final · ${fighters[fight.winner].name} wins`;
  renderDecision();
  renderStyles();
  $('decision').hidden = false;
  sound('final');
  scrollTo($('decision'), 'start');

  const reveal = () => {
    $('scouting').hidden = false;
    $('after').hidden = false;
    [...$('styles').children].forEach((card, k) => setTimeout(() => card.classList.add('in'), 80 + k * 220));
  };
  if (animate && !reducedMotion) setTimeout(reveal, 1500);
  else reveal();

  // Easter egg: some profiles get a normal fight, then the result is overturned.
  const victim = prankIndex(fighters);
  if (victim >= 0) {
    const token = playToken;
    prankTimer = setTimeout(() => { if (token === playToken) overturn(victim); }, animate && !reducedMotion ? 4200 : 2600);
  }
}

async function overturn(victim) {
  undoPrank = applyPrank(fight, fighters, victim);
  const winnerName = fighters[fight.winner].name;
  renderDecision();
  renderStyles();
  [...$('styles').children].forEach((card) => card.classList.add('in'));
  $('scouting').hidden = false;
  $('after').hidden = false;
  updateScorebar();
  $('sbRound').textContent = `Overturned · ${winnerName} wins`;
  await showPrank({ victimName: fighters[victim].name, winnerName, soundOn });
  scrollTo($('decision'), 'start');
}

function renderDecision() {
  const total = fight.rounds.length;
  const { order, totals, roundsWon, method } = fight;
  const [first, second] = order;
  const dq = fight.dq ?? null;
  const kids = [el('p', { class: 'pre', text: dq == null ? "The judges' scorecards are in" : 'Result overturned on review' })];

  if (fight.winner == null) {
    kids.push(
      el('p', { class: 'method', text: 'Ruled a' }),
      el('p', { class: 'champ', style: '--c: var(--gold)', text: 'Draw' }),
      el('p', { class: 'final' }, String(totals[first]), el('i', { text: '–' }), String(totals[second])),
      el('p', { class: 'line', text: `Dead level after ${total} rounds. Nobody leaves happy. Run it back.` }),
    );
  } else {
    const w = fighters[first], l = fighters[second];
    const line = {
      Knockout: `${w.name} took every single round. The referee has seen enough.`,
      TKO: `${w.name} won ${roundsWon[first]} of ${total} rounds and it was never close. Corner stoppage.`,
      'Unanimous Decision': `${w.name} banked ${roundsWon[first]} rounds to ${l.name}'s ${roundsWon[second]}. Clear on every card.`,
      'Split Decision': `Razor thin. ${l.name} took ${roundsWon[second]} rounds, and one more swings this fight the other way.`,
      Disqualification: `${dq == null ? '' : fighters[dq].name} has been disqualified for excessive celebration. The original scorecards are void.`,
    }[method];
    kids.push(
      el('p', { class: 'method', text: `Winner by ${method}` }),
      el('p', { class: 'champ', style: corner(first), text: w.name }),
      el('p', { class: 'final' }, String(totals[first]), el('i', { text: '–' }), second === dq ? 'DQ' : String(totals[second])),
      el('p', { class: 'line', text: line }),
    );
  }

  // Full scorecard (also the table view of every round).
  const head = el('tr', {}, el('th', { scope: 'col', text: 'Fighter' }),
    fight.rounds.map((r, i) => el('th', { scope: 'col', title: r.round.name, text: `R${i + 1}` })),
    el('th', { scope: 'col', text: 'Total' }));
  const body = order.map((i) => el('tr', { class: i === dq ? 'dq' : '' },
    el('th', { scope: 'row', style: corner(i), text: fighters[i].name }),
    fight.rounds.map((r) => el('td', { class: r.winners.includes(i) ? 'w' : '', text: r.points[i] })),
    el('td', { class: 't', text: i === dq ? 'DQ' : totals[i] })));
  kids.push(el('div', { class: 'card-wrap' },
    el('table', { class: 'scorecard' }, el('caption', { class: 'sr-only', text: 'Round-by-round scorecard' }),
      el('thead', {}, head), el('tbody', {}, body))));

  $('decision').replaceChildren(...kids);
}

function renderStyles() {
  $('styles').replaceChildren(...fighters.map((f, i) => {
    const s = f.style;
    return el('article', { class: 'style', style: corner(i) },
      el('p', { class: 'who' }, el('b', { text: f.name }), ' fights as'),
      el('h3', { class: 'archetype', text: s.name }),
      el('p', { class: 'discipline', text: `${s.discipline} · ${s.match}% match` }),
      el('p', { class: 'tagline', text: s.tag }),
      el('p', { class: 'blurb', text: s.blurb }),
      el('div', { class: 'attrs' }, ATTRIBUTES.map(([key, label]) => {
        const v = f.attrs[key];
        return el('div', { class: 'attr' },
          el('span', { text: label }),
          el('div', { class: 'meter' }, el('i', { style: `--w: ${v.toFixed(3)}` })),
          el('b', { text: Math.round(v * 100) }));
      })),
      s.receipts.length > 0 && el('ul', { class: 'receipts' }, s.receipts.map((t) => el('li', { text: t }))),
      el('div', { class: 'comps' },
        s.comps.length > 0 && el('p', {}, 'Fights like ', el('b', { text: s.comps[0] }), ' and ', el('b', { text: s.comps[1] })),
        s.shades && el('p', {}, 'With shades of ', el('b', { text: s.shades }))),
    );
  }));
}

$('bellBtn').addEventListener('click', play);
$('skipBtn').addEventListener('click', skip);
$('replayBtn').addEventListener('click', () => {
  resetFight();
  scrollTo($('bell'));
  play();
});
$('rematchBtn').addEventListener('click', () => {
  playToken++;
  clearPrank();
  history.replaceState(null, '', location.pathname);
  show('setup');
});
$('shareBtn').addEventListener('click', async () => {
  const btn = $('shareBtn');
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = 'Link copied';
  } catch {
    btn.textContent = 'Copy it from the address bar';
  }
  setTimeout(() => { btn.textContent = 'Copy fight link'; }, 2200);
});

/* ───────────── boot ───────────── */

renderCorners();
loadPresets();

const booked = (new URLSearchParams(location.search).get('fight') || '')
  .split(',').map((a) => a.trim()).filter((a) => ADDRESS_RE.test(a)).slice(0, MAX_FIGHTERS);
if (booked.length >= 2) {
  slots.splice(0, slots.length, ...booked.map((a) => ({ text: a, picked: null })));
  renderCorners();
  runFight(booked.map((address) => ({ address: address.toLowerCase() })));
}
