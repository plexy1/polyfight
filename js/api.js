// Polymarket public API client (Data API v2 + Gamma). Both allow direct browser calls.

const DATA = 'https://data-api.polymarket.com/v2';
const GAMMA = 'https://gamma-api.polymarket.com';

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, { timeout = 25000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = Number(res.headers.get('retry-after')) || 0.6 * (attempt + 1);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`Polymarket returned ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= retries || err.message.startsWith('Polymarket returned 4')) throw err;
      await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

const qs = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

const data = (path, params) => getJSON(`${DATA}/${path}?${qs(params)}`).then((r) => r.data);

/** Top of the all-time board, fetched once. Gamma's search often misses well-known traders. */
let boardIndex = null;
function leaderboardIndex() {
  boardIndex ||= data('leaderboard', { time_period: 'all', sort_by: 'PNL', limit: 500 })
    .then((rows) => (rows || [])
      .filter((r) => r.user_name && !ADDRESS_RE.test(r.user_name))
      .map((r) => ({ name: r.user_name, pseudonym: '', address: r.user_id.toLowerCase(), bio: '', rank: r.rank })))
    .catch(() => { boardIndex = null; return []; });
  return boardIndex;
}

/** Username search. Returns [{ name, pseudonym, address, bio }], best matches first. */
export async function searchProfiles(query) {
  const q = query.trim().toLowerCase();
  const [board, res] = await Promise.all([
    leaderboardIndex(),
    getJSON(
      `${GAMMA}/public-search?${qs({ q: query, search_profiles: true, search_tags: false, limit_per_type: 8 })}`,
      { retries: 0, timeout: 12000 },
    ).catch(() => ({ profiles: [] })),
  ]);
  const ranked = board.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 12);
  const found = (res.profiles || [])
    .filter((p) => p.proxyWallet)
    .map((p) => ({
      name: p.name || p.pseudonym || shortAddress(p.proxyWallet),
      pseudonym: p.pseudonym || '',
      address: p.proxyWallet.toLowerCase(),
      bio: p.bio || '',
    }));
  const score = (p) => {
    const n = p.name.toLowerCase();
    return n === q ? 0 : n.startsWith(q) ? 1 : 2;
  };
  const seen = new Set();
  return [...ranked, ...found]
    .filter((p) => !seen.has(p.address) && seen.add(p.address))
    .sort((x, y) => score(x) - score(y) || (x.rank || 1e9) - (y.rank || 1e9))
    .slice(0, 7);
}

export const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A wallet-looking username (Polymarket's default) reads better shortened. */
export function cleanName(name, address) {
  if (!name) return shortAddress(address);
  const m = name.match(ADDRESS_RE);
  return m ? shortAddress(m[0]) : name;
}

/** Turn whatever the user typed (address, profile URL, @handle, username) into an address. */
export async function resolveInput(raw) {
  const input = raw.trim();
  if (!input) throw new Error('Enter a username or wallet address.');
  const addr = input.match(ADDRESS_RE);
  if (addr) return { address: addr[0].toLowerCase() };

  // polymarket.com/@name, polymarket.com/profile/name, @name, name
  const handle = decodeURIComponent(
    input
      .replace(/^https?:\/\//i, '')
      .replace(/^(www\.)?polymarket\.com\//i, '')
      .replace(/^profile\//i, '')
      .replace(/[?#].*$/, '')
      .replace(/^@/, '')
      .replace(/\/+$/, ''),
  );
  const matches = await searchProfiles(handle);
  if (!matches.length) throw new Error(`No Polymarket profile found for “${handle}”.`);
  const exact = matches.find((p) => p.name.toLowerCase() === handle.toLowerCase());
  if (exact) return exact;
  if (matches.length === 1) return matches[0];
  // Never quietly swap in a different trader with a similar name.
  const close = matches.slice(0, 3).map((p) => p.name).join(', ');
  throw new Error(`No exact match for “${handle}”. Closest: ${close}. Pick one from the suggestions or paste a wallet address.`);
}

export async function topTraders(period = 'all', limit = 4) {
  const rows = await data('leaderboard', { time_period: period, sort_by: 'PNL', limit });
  return (rows || []).map((r) => ({
    address: r.user_id.toLowerCase(),
    name: cleanName(r.user_name, r.user_id),
    pnl: r.pnl,
  }));
}

/** Everything we need about one wallet, fetched in parallel. Optional pieces may be null. */
export async function fetchFighterData(address) {
  const user = address.toLowerCase();
  const soft = (p) => p.catch(() => null);
  const closed = (extra) => data('positions', { user, status: 'CLOSED', ...extra });

  const [stats, board, value, profile, recent, best, worst, open, pnl] = await Promise.all([
    data('user-stats', { user }),
    soft(data('leaderboard', { user, time_period: 'all' })),
    soft(data('value', { user })),
    soft(getJSON(`${GAMMA}/public-profile?${qs({ address: user })}`, { retries: 0 })),
    soft(closed({ limit: 500, sort_by: 'TIMESTAMP', sort_direction: 'DESC' })),
    soft(closed({ limit: 1, sort_by: 'REALIZED_PNL', sort_direction: 'DESC' })),
    soft(closed({ limit: 1, sort_by: 'REALIZED_PNL', sort_direction: 'ASC' })),
    soft(getJSON(`${DATA}/positions?${qs({ user, limit: 200, sort_by: 'CURRENT_VALUE' })}`)),
    soft(data('user-pnl', { user, interval: 'all', fidelity: '1d' })),
  ]);

  return { address: user, stats, board, value, profile, recent, best, worst, open, pnl };
}
