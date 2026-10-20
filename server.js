// KlipFox GIF proxy — keeps the GIPHY API key on the server.
// No packages needed (Node.js 20+). Run:  node server.js   (reads .env next to this file if it exists)
//
//   GET /api/gifs?q=&offset=&limit=       GIFs (no q = trending)
//   GET /api/stickers?q=&offset=&limit=   transparent stickers (no q = trending)
//   GET /api/media?url=https://media.giphy.com/...   the GIF / MP4 file itself (with CORS, for the editor)
//   GET /health
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

// .env next to this file (values already set by the host, e.g. Render / Railway, win)
try {
  const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (_) { /* no .env file: use the host's environment */ }

const KEY = (process.env.GIPHY_API_KEY || '').trim();
const PORT = Number(process.env.PORT) || 8000;
const TTL_MS = (Number(process.env.CACHE_SECONDS) || 300) * 1000;          // 5 minutes
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
const UPSTREAM = (process.env.GIPHY_BASE || 'https://api.giphy.com/v1').replace(/\/+$/, '');
const RATING = process.env.GIPHY_RATING || 'pg-13';
const PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 120;            // per visitor IP
const MAX_CACHE = 500;

if (!KEY) { console.error('GIPHY_API_KEY is missing. Copy .env.example to .env and put your key in it.'); process.exit(1); }

// ------------------------------------------------------------------ cache (in memory, oldest out first)
const cache = new Map();        // key -> { at, body }
const inflight = new Map();     // key -> Promise (same request at the same time = one call to GIPHY)
function cacheGet(k) {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { cache.delete(k); return null; }
  cache.delete(k); cache.set(k, hit);            // keep recently used at the end
  return hit;
}
function cacheSet(k, body) {
  cache.set(k, { at: Date.now(), body });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

// ------------------------------------------------------------------ small per-IP rate limit
const hits = new Map();
function limited(ip) {
  const now = Date.now(), w = hits.get(ip) || { start: now, n: 0 };
  if (now - w.start > 60_000) { w.start = now; w.n = 0; }
  w.n++; hits.set(ip, w);
  return w.n > PER_MIN;
}
setInterval(() => { const now = Date.now(); for (const [ip, w] of hits) if (now - w.start > 120_000) hits.delete(ip); }, 60_000).unref();

// ------------------------------------------------------------------ helpers
function cors(req, res) {
  const o = req.headers.origin;
  if (ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (o && ORIGINS.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, status, obj, extra) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(extra || {}) });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

// only what the app needs (smaller and faster on a phone)
function slim(g) {
  const im = g.images || {};
  const pick = (x) => (x ? { url: x.url || '', webp: x.webp || '', mp4: x.mp4 || '', width: Number(x.width) || 0, height: Number(x.height) || 0 } : null);
  return {
    id: g.id, title: g.title || '',
    images: {
      fixed_width_small: pick(im.fixed_width_small || im.fixed_width),
      fixed_width: pick(im.fixed_width),
      fixed_height: pick(im.fixed_height),
      original: pick(im.original),
    },
  };
}

async function search(kind, q, offset, limit, lang) {
  const key = [kind, q.toLowerCase(), offset, limit, lang, RATING].join('|');
  const hit = cacheGet(key);
  if (hit) return { body: hit.body, cached: true };
  if (inflight.has(key)) return { body: await inflight.get(key), cached: true };
  const p = (async () => {
    const u = new URL(`${UPSTREAM}/${kind}/${q ? 'search' : 'trending'}`);
    u.searchParams.set('api_key', KEY);
    if (q) { u.searchParams.set('q', q); u.searchParams.set('lang', lang); }
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('offset', String(offset));
    u.searchParams.set('rating', RATING);
    const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) { const e = new Error('upstream ' + r.status); e.status = r.status; throw e; }
    const j = await r.json();
    const body = JSON.stringify({
      data: (j.data || []).map(slim),
      pagination: { total_count: (j.pagination && j.pagination.total_count) || 0, count: (j.pagination && j.pagination.count) || 0, offset },
    });
    cacheSet(key, body);
    return body;
  })();
  inflight.set(key, p);
  try { return { body: await p, cached: false }; } finally { inflight.delete(key); }
}

const MEDIA_HOST = /^(media\d?|i)\.giphy\.com$/;
// extra media hosts for local testing only, e.g. GIPHY_MEDIA_HOSTS=localhost:9900 (plain http allowed for localhost)
const EXTRA_HOSTS = (process.env.GIPHY_MEDIA_HOSTS || '').split(',').map((x) => x.trim()).filter(Boolean);
async function media(req, res, raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return json(res, 400, { error: 'bad_url' }); }
  const giphy = u.protocol === 'https:' && MEDIA_HOST.test(u.hostname);
  const extra = EXTRA_HOSTS.includes(u.host) && (u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (!giphy && !extra) return json(res, 400, { error: 'only GIPHY media is allowed' });
  const r = await fetch(u, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok || !r.body) return json(res, 502, { error: 'media ' + r.status });
  res.writeHead(200, {
    'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
    ...(r.headers.get('content-length') ? { 'Content-Length': r.headers.get('content-length') } : {}),
    'Cache-Control': 'public, max-age=86400, immutable',
  });
  Readable.fromWeb(r.body).pipe(res);
}

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
  const url = new URL(req.url, 'http://x');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, cached: cache.size });
    if (limited(ip)) return json(res, 429, { error: 'too_many_requests' }, { 'Retry-After': '30' });
    const m = url.pathname.match(/^\/api\/(gifs|stickers)\/?$/);
    if (m) {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 50);
      const offset = clampInt(url.searchParams.get('offset'), 0, 4999, 0);
      const limit = clampInt(url.searchParams.get('limit'), 1, 50, 36);
      const lang = /^[a-z]{2}$/.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'th';
      const { body, cached } = await search(m[1], q, offset, limit, lang);
      return json(res, 200, body, { 'Cache-Control': `public, max-age=${Math.round(TTL_MS / 1000)}`, 'X-Cache': cached ? 'HIT' : 'MISS' });
    }
    if (url.pathname === '/api/media') return await media(req, res, url.searchParams.get('url') || '');
    return json(res, 404, { error: 'not_found' });
  } catch (e) {
    const st = e.status;
    // never send the key or GIPHY's raw error to the app
    if (st === 401 || st === 403) { console.error('GIPHY rejected the API key (check GIPHY_API_KEY)'); return json(res, 502, { error: 'upstream_auth' }); }
    if (st === 429) return json(res, 429, { error: 'giphy_quota' }, { 'Retry-After': '60' });
    console.error('proxy error:', e.message);
    if (!res.headersSent) json(res, 502, { error: 'upstream_unavailable' });
    else res.end();
  }
});
server.listen(PORT, () => console.log(`KlipFox GIF proxy on http://localhost:${PORT}  (cache ${TTL_MS / 1000}s, origins ${ORIGINS.join(' ')})`));
