// Easter egg: certain profiles fight a perfectly normal fight, then get the result
// overturned at the very end. Everything before the decision is untouched.

const TARGET_NAMES = new Set(['iliatopurialover']);
const TARGET_ADDRESSES = new Set(['0xf7000fc15a2f34445b242f9eb6361f20b8238530']);

const VIDEO = { src: 'm2-res_720p.mp4', start: 7.5 }; // the celebration dance runs from here to the end
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Index of the fighter to prank, or -1. */
export function prankIndex(fighters) {
  return fighters.findIndex((f) => TARGET_ADDRESSES.has(f.address) || TARGET_NAMES.has(f.name.toLowerCase()));
}

const TOMATO_CAN = {
  id: 'can',
  name: 'The Tomato Can',
  discipline: 'Professional opponent',
  tag: 'Shows up. Falls down. Collects the cheque.',
  blurb: 'Booked to make the other fighter look good, and delivers every time. The commission reviewed the tape, looked at the dancing, and voided whatever happened in the cage.',
  comps: [],
  match: 100,
  shades: null,
  receipts: [
    'Result overturned: disqualified for excessive celebration',
    'Scouting report sealed by the commission for everyone’s safety',
    'Dance moves: undefeated. Everything else: see above',
  ],
};

/**
 * Rewrites the verdict so the victim loses by disqualification and is scouted as a
 * Tomato Can. Returns an undo function that restores the honest result.
 */
export function applyPrank(fight, fighters, victim) {
  const f = fighters[victim];
  const honest = {
    order: fight.order, winner: fight.winner, method: fight.method, dq: fight.dq,
    style: f.style, attrs: f.attrs,
  };
  const rest = fight.order.filter((i) => i !== victim);
  fight.order = [...rest, victim];
  fight.winner = rest[0];
  fight.method = 'Disqualification';
  fight.dq = victim;
  f.style = TOMATO_CAN;
  f.attrs = Object.fromEntries(Object.keys(f.attrs).map((k) => [k, 0.01]));
  return () => {
    Object.assign(fight, { order: honest.order, winner: honest.winner, method: honest.method, dq: honest.dq });
    f.style = honest.style;
    f.attrs = honest.attrs;
  };
}

/* ───────────── sound ───────────── */

let ctx = null;
function airhorn() {
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  const blasts = [[0, 0.22], [0.3, 0.22], [0.6, 0.9]];
  for (const [at, dur] of blasts) {
    for (const freq of [466, 470, 587, 698]) {
      const t0 = ctx.currentTime + at;
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.linearRampToValueAtTime(freq * 0.97, t0 + dur);
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.exponentialRampToValueAtTime(0.09, t0 + 0.02);
      amp.gain.setValueAtTime(0.09, t0 + dur - 0.05);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(amp).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    }
  }
}

function announce(text) {
  if (!('speechSynthesis' in window)) return;
  const say = new SpeechSynthesisUtterance(text);
  say.rate = 0.8;
  say.pitch = 0.5;
  say.volume = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(say);
}

/* ───────────── confetti ───────────── */

function confetti(canvas) {
  const colors = ['#e5383b', '#3d7bff', '#f2c14e', '#f4f1ea'];
  const g = canvas.getContext('2d');
  let w = 0, h = 0, raf = 0, alive = true;
  const size = () => {
    w = canvas.width = canvas.clientWidth * devicePixelRatio;
    h = canvas.height = canvas.clientHeight * devicePixelRatio;
  };
  size();
  window.addEventListener('resize', size);
  const piece = (anywhere) => ({
    x: Math.random() * w,
    y: anywhere ? Math.random() * h : -20,
    vx: (Math.random() - 0.5) * 2.4,
    vy: 1.6 + Math.random() * 3.4,
    s: (5 + Math.random() * 8) * devicePixelRatio,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.25,
    c: colors[(Math.random() * colors.length) | 0],
  });
  const pieces = Array.from({ length: 140 }, () => piece(true));
  const frame = () => {
    if (!alive) return;
    g.clearRect(0, 0, w, h);
    for (const p of pieces) {
      p.x += p.vx * devicePixelRatio;
      p.y += p.vy * devicePixelRatio;
      p.r += p.vr;
      if (p.y > h + 20) Object.assign(p, piece(false));
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.r);
      g.fillStyle = p.c;
      g.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      g.restore();
    }
    raf = requestAnimationFrame(frame);
  };
  frame();
  return () => { alive = false; cancelAnimationFrame(raf); window.removeEventListener('resize', size); };
}

/* ───────────── the overlay ───────────── */

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Full-screen "result overturned" takeover with the dance clip. Resolves when dismissed. */
export function showPrank({ victimName, winnerName, soundOn }) {
  return new Promise((resolve) => {
    const overlay = node('div', 'prank');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Result overturned');

    const canvas = node('canvas', 'prank-confetti');
    canvas.setAttribute('aria-hidden', 'true');

    const video = node('video', 'prank-video');
    video.src = `${VIDEO.src}#t=${VIDEO.start}`;
    video.playsInline = true;
    video.preload = 'auto';
    video.muted = !soundOn;
    video.volume = 0.6;
    const restart = () => { video.currentTime = VIDEO.start; video.play().catch(() => {}); };
    video.addEventListener('loadedmetadata', restart, { once: true });
    video.addEventListener('ended', restart);
    // Autoplay with sound can be refused; fall back to muted rather than a frozen frame.
    video.addEventListener('canplay', () => {
      video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
    }, { once: true });

    const stage = node('div', 'prank-stage');
    stage.append(video, node('div', 'prank-lights'), node('p', 'prank-stamp', 'Knocked out cold'));

    const lose = node('p', 'prank-lose');
    lose.append('You lose, ', node('b', '', victimName));

    const close = node('button', 'cta prank-close', 'Accept defeat');
    close.type = 'button';

    const inner = node('div', 'prank-inner');
    inner.append(
      node('p', 'prank-kicker', 'Hold on. The commission has reviewed the tape'),
      node('h2', 'prank-title', 'Result overturned'),
      stage,
      lose,
      node('p', 'prank-sub', `Disqualified for excessive celebration. ${winnerName} takes the win.`),
      close,
    );
    overlay.append(canvas, inner);
    document.body.append(overlay);
    document.body.classList.add('prank-open');

    const stopConfetti = reducedMotion ? () => {} : confetti(canvas);
    if (soundOn) {
      try { airhorn(); } catch { /* audio is a nicety */ }
      setTimeout(() => announce('You lose!'), 1300);
    }

    const dismiss = () => {
      stopConfetti();
      video.pause();
      window.speechSynthesis?.cancel();
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('prank-open');
      overlay.remove();
      resolve();
    };
    const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
    document.addEventListener('keydown', onKey);
    close.addEventListener('click', dismiss);
    close.focus({ preventScroll: true });
  });
}
