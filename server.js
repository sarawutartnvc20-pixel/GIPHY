// KlipFox server — keeps the GIPHY / Pixabay API keys on the server and downloads clips from links (yt-dlp).
// No packages needed (Node.js 20+). Run:  node server.js   (reads .env next to this file if it exists)
//
//   GET /api/gifs?q=&offset=&limit=       GIFs (no q = trending)
//   GET /api/stickers?q=&offset=&limit=   transparent stickers (no q = trending)
//   GET /api/pixabay?q=&page=&per_page=   Pixabay green-screen videos (cached 24 h, as Pixabay requires)
//   GET /api/media?url=https://media.giphy.com/... or https://cdn.pixabay.com/...   the file itself (with CORS, for the editor)
//   GET /api/dl/info?url=           title / length / picture of a YouTube · TikTok · Facebook · Instagram link (needs yt-dlp)
//   GET /api/dl/start?url=&fmt=mp4|mp3&h=1080   start downloading on the server -> { id }
//   GET /api/dl/status?id=          { state: queued | downloading | merging | ready | error, pct, size, error }
//   GET /api/dl/file?id=            the finished file (deleted from the server 10 minutes later)
//   GET /health
import http from 'node:http';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
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
const PX_KEY = (process.env.PIXABAY_API_KEY || '').trim();
const PX_BASE = (process.env.PIXABAY_BASE || 'https://pixabay.com/api').replace(/\/+$/, '');
const PX_TTL_MS = (Number(process.env.PIXABAY_CACHE_SECONDS) || 86400) * 1000;   // Pixabay asks for 24 h caching
const PORT = Number(process.env.PORT) || 8000;
const TTL_MS = (Number(process.env.CACHE_SECONDS) || 300) * 1000;          // 5 minutes
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
const UPSTREAM = (process.env.GIPHY_BASE || 'https://api.giphy.com/v1').replace(/\/+$/, '');
const RATING = process.env.GIPHY_RATING || 'pg-13';
const PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 120;            // per visitor IP
const MAX_CACHE = 500;

// ------------------------------------------------------------------ link downloader (yt-dlp + ffmpeg on the server)
const YTDLP = (process.env.YTDLP_PATH || 'yt-dlp').trim();
const DL_ON = process.env.DOWNLOADER !== 'off';
const DL_MAX_S = Number(process.env.DL_MAX_SECONDS) || 900;          // longest clip, 15 min
const DL_MAX_MB = Number(process.env.DL_MAX_MB) || 400;
const DL_PARALLEL = Number(process.env.DL_PARALLEL) || 2;
const DL_HOSTS = (process.env.DL_HOSTS || 'youtube.com,youtu.be,tiktok.com,facebook.com,fb.watch,instagram.com,x.com,twitter.com,vimeo.com').split(',').map((x) => x.trim()).filter(Boolean);
let DL_VER = '';
if (DL_ON) { try { const r = spawnSync(YTDLP, ['--version'], { timeout: 15000, encoding: 'utf8' }); if (r.status === 0) DL_VER = r.stdout.trim(); } catch (_) {} }
if (DL_ON && !DL_VER) console.warn('yt-dlp not found: /api/dl/* will answer 503 (install yt-dlp + ffmpeg, or use the Dockerfile).');
else if (DL_VER) console.log('link downloader: yt-dlp ' + DL_VER);

if (!KEY && !PX_KEY && !DL_VER) { console.error('Nothing to serve. Copy .env.example to .env and put GIPHY_API_KEY and/or PIXABAY_API_KEY in it, or install yt-dlp.'); process.exit(1); }
if (!KEY) console.warn('GIPHY_API_KEY is not set: /api/gifs and /api/stickers will answer 503.');
if (!PX_KEY) console.warn('PIXABAY_API_KEY is not set: /api/pixabay will answer 503.');

// ------------------------------------------------------------------ cache (in memory, oldest out first)
const cache = new Map();        // key -> { at, body }
const inflight = new Map();     // key -> Promise (same request at the same time = one call to GIPHY)
function cacheGet(k, ttl = TTL_MS) {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) { cache.delete(k); return null; }
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

// Pixabay videos (green screen). Same idea as search(): the key stays here, results are cached.
const slimPx = (h) => {
  const v = h.videos || {};
  const pick = (x) => (x && x.url ? { url: x.url, width: Number(x.width) || 0, height: Number(x.height) || 0, thumbnail: x.thumbnail || '' } : null);
  return { id: h.id, tags: h.tags || '', duration: Number(h.duration) || 0, picture_id: h.picture_id || '', videos: { large: pick(v.large), medium: pick(v.medium), small: pick(v.small), tiny: pick(v.tiny) } };
};
async function pixabay(q, page, perPage) {
  const key = ['px', q.toLowerCase(), page, perPage].join('|');
  const hit = cacheGet(key, PX_TTL_MS);
  if (hit) return { body: hit.body, cached: true };
  if (inflight.has(key)) return { body: await inflight.get(key), cached: true };
  const p = (async () => {
    const u = new URL(`${PX_BASE}/videos/`);
    u.searchParams.set('key', PX_KEY);
    u.searchParams.set('q', q);
    u.searchParams.set('per_page', String(perPage));
    u.searchParams.set('page', String(page));
    u.searchParams.set('safesearch', 'true');
    const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) { const e = new Error('upstream ' + r.status); e.status = r.status; throw e; }
    const j = await r.json();
    const body = JSON.stringify({ totalHits: Number(j.totalHits) || 0, hits: (j.hits || []).map(slimPx) });
    cacheSet(key, body);
    return body;
  })();
  inflight.set(key, p);
  try { return { body: await p, cached: false }; } finally { inflight.delete(key); }
}

const MEDIA_HOST = /^((media\d?|i)\.giphy\.com|cdn\.pixabay\.com)$/;
// extra media hosts for local testing only, e.g. GIPHY_MEDIA_HOSTS=localhost:9900 (plain http allowed for localhost)
const EXTRA_HOSTS = (process.env.GIPHY_MEDIA_HOSTS || '').split(',').map((x) => x.trim()).filter(Boolean);
async function media(req, res, raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return json(res, 400, { error: 'bad_url' }); }
  const giphy = u.protocol === 'https:' && MEDIA_HOST.test(u.hostname);
  const extra = EXTRA_HOSTS.includes(u.host) && (u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (!giphy && !extra) return json(res, 400, { error: 'only GIPHY / Pixabay media is allowed' });
  const r = await fetch(u, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok || !r.body) return json(res, 502, { error: 'media ' + r.status });
  res.writeHead(200, {
    'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
    ...(r.headers.get('content-length') ? { 'Content-Length': r.headers.get('content-length') } : {}),
    'Cache-Control': 'public, max-age=86400, immutable',
  });
  Readable.fromWeb(r.body).pipe(res);
}

// ------------------------------------------------------------------ link downloads
const jobs = new Map();          // id -> { state, pct, size, file, name, type, error, at, proc }
let running = 0;
const queue = [];
const okHost = (u) => { try { const h = new URL(u).hostname.replace(/^(www|m|vm|vt)\./, ''); return (new URL(u).protocol === 'https:' || new URL(u).protocol === 'http:') && DL_HOSTS.some((d) => h === d || h.endsWith('.' + d)); } catch (_) { return false; } };
function ytdlp(args, opt) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const to = setTimeout(() => { p.kill('SIGKILL'); reject(Object.assign(new Error('timeout'), { code: 'timeout' })); }, (opt && opt.timeout) || 45000);
    p.stdout.on('data', (d) => { out += d; if (opt && opt.onLine) String(d).split(/[\r\n]+/).forEach(opt.onLine); });
    p.stderr.on('data', (d) => { err += d; if (opt && opt.onLine) String(d).split(/[\r\n]+/).forEach(opt.onLine); });
    p.on('error', (e) => { clearTimeout(to); reject(e); });
    p.on('close', (code) => { clearTimeout(to); code === 0 ? resolve(out) : reject(Object.assign(new Error(err.split('\n').filter((l) => /ERROR/.test(l)).pop() || ('yt-dlp exit ' + code)), { code: 'ytdlp' })); });
    if (opt && opt.job) opt.job.proc = p;
  });
}
// the reason in words the app can show
function dlReason(msg) {
  const m = String(msg || '');
  if (/confirm you.?re not a bot|Sign in to confirm|429|rate.?limit/i.test(m)) return 'blocked';
  if (/private|login required|log in|cookies|age/i.test(m)) return 'private';
  if (/unsupported url|no video|not available|removed|404/i.test(m)) return 'not_found';
  if (/timeout/i.test(m)) return 'timeout';
  return 'failed';
}
async function dlInfo(u) {
  const key = 'dl|' + u;
  const hit = cacheGet(key, 10 * 60_000);
  if (hit) return hit.body;
  const j = JSON.parse(await ytdlp(['-J', '--no-playlist', '--no-warnings', '--skip-download', u], { timeout: 40000 }));
  const body = JSON.stringify({ title: j.title || '', duration: Number(j.duration) || 0, uploader: j.uploader || j.channel || '', thumbnail: j.thumbnail || '', site: j.extractor_key || '', height: Number(j.height) || 0 });
  cacheSet(key, body);
  return body;
}
function runNext() {
  while (running < DL_PARALLEL && queue.length) {
    const job = queue.shift();
    running++;
    job.state = 'downloading';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kfdl-'));
    job.dir = dir;
    const h = job.h;
    const args = job.fmt === 'mp3'
      ? ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0']
      : ['-f', `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}][ext=mp4]/b[height<=${h}]/b`, '--merge-output-format', 'mp4', '-S', 'vcodec:h264,res,acodec:m4a'];
    args.push('--no-playlist', '--no-warnings', '--newline', '--max-filesize', DL_MAX_MB + 'M', '--match-filter', `duration <= ${DL_MAX_S}`, '-o', path.join(dir, 'clip.%(ext)s'), job.url);
    ytdlp(args, { timeout: 15 * 60_000, job, onLine: (l) => {
      const m = /\[download\]\s+([\d.]+)%/.exec(l);
      if (m) job.pct = Math.max(job.pct, Math.min(99, parseFloat(m[1])));
      if (/\[(Merger|ExtractAudio|VideoConvertor)\]/.test(l)) { job.state = 'merging'; job.pct = 99; }
      if (/does not pass filter|longer than/i.test(l)) job.tooLong = true;
    } }).then(() => {
      const f = fs.readdirSync(dir).find((x) => /^clip\./.test(x) && !/\.part$/.test(x));
      if (!f) throw Object.assign(new Error(job.tooLong ? 'too_long' : 'no file'), { code: job.tooLong ? 'too_long' : 'failed' });
      job.file = path.join(dir, f); job.size = fs.statSync(job.file).size;
      job.type = f.endsWith('.mp3') ? 'audio/mpeg' : f.endsWith('.webm') ? 'video/webm' : f.endsWith('.m4a') ? 'audio/mp4' : 'video/mp4';
      job.ext = f.split('.').pop();
      job.state = 'ready'; job.pct = 100;
    }).catch((e) => {
      job.state = 'error'; job.error = e.code === 'too_long' || job.tooLong ? 'too_long' : dlReason(e.message);
      console.error('download failed:', job.url, e.message);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }).finally(() => { running--; job.proc = null; runNext(); });
  }
}
// finished or failed jobs are forgotten (and their files removed) after 10 minutes
setInterval(() => { const now = Date.now(); for (const [id, j] of jobs) if (now - j.at > 10 * 60_000 && j.state !== 'downloading') { if (j.dir) try { fs.rmSync(j.dir, { recursive: true, force: true }); } catch (_) {} jobs.delete(id); } }, 60_000).unref();
async function dl(req, res, url) {
  if (!DL_VER) return json(res, 503, { error: 'downloader_not_installed' });
  const sub = url.pathname.replace(/^\/api\/dl\/?/, '');
  if (sub === 'info' || sub === 'start') {
    const u = (url.searchParams.get('url') || '').trim();
    if (!okHost(u)) return json(res, 400, { error: 'unsupported_site' });
    if (sub === 'info') {
      try { return json(res, 200, await dlInfo(u)); } catch (e) { return json(res, 502, { error: dlReason(e.message) }); }
    }
    const fmt = url.searchParams.get('fmt') === 'mp3' ? 'mp3' : 'mp4';
    const h = clampInt(url.searchParams.get('h'), 144, 2160, 1080);
    const id = Math.random().toString(36).slice(2, 12);
    const job = { id, url: u, fmt, h, state: 'queued', pct: 0, size: 0, at: Date.now() };
    jobs.set(id, job); queue.push(job); runNext();
    return json(res, 200, { id });
  }
  const job = jobs.get(url.searchParams.get('id') || '');
  if (!job) return json(res, 404, { error: 'no_such_job' });
  if (sub === 'status') return json(res, 200, { state: job.state, pct: Math.round(job.pct), size: job.size, error: job.error || '', queue: job.state === 'queued' ? queue.indexOf(job) + 1 : 0 });
  if (sub === 'file') {
    if (job.state !== 'ready') return json(res, 409, { error: 'not_ready' });
    res.writeHead(200, { 'Content-Type': job.type, 'Content-Length': String(job.size), 'Content-Disposition': 'attachment; filename="clip.' + job.ext + '"', 'Cache-Control': 'no-store', 'Access-Control-Expose-Headers': 'Content-Length' });
    fs.createReadStream(job.file).pipe(res);
    return undefined;
  }
  if (sub === 'cancel') { if (job.proc) job.proc.kill('SIGKILL'); job.state = 'error'; job.error = 'cancelled'; return json(res, 200, { ok: true }); }
  return json(res, 404, { error: 'not_found' });
}

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
  const url = new URL(req.url, 'http://x');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, cached: cache.size, downloader: DL_VER || false });
    if (url.pathname !== '/api/dl/status' && limited(ip)) return json(res, 429, { error: 'too_many_requests' }, { 'Retry-After': '30' });
    const m = url.pathname.match(/^\/api\/(gifs|stickers)\/?$/);
    if (m) {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 50);
      const offset = clampInt(url.searchParams.get('offset'), 0, 4999, 0);
      const limit = clampInt(url.searchParams.get('limit'), 1, 50, 36);
      const lang = /^[a-z]{2}$/.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'th';
      if (!KEY) return json(res, 503, { error: 'giphy_not_configured' });
      const { body, cached } = await search(m[1], q, offset, limit, lang);
      return json(res, 200, body, { 'Cache-Control': `public, max-age=${Math.round(TTL_MS / 1000)}`, 'X-Cache': cached ? 'HIT' : 'MISS' });
    }
    if (url.pathname === '/api/pixabay') {
      if (!PX_KEY) return json(res, 503, { error: 'pixabay_not_configured' });
      const q = (url.searchParams.get('q') || 'green screen').trim().slice(0, 100);
      const page = clampInt(url.searchParams.get('page'), 1, 25, 1);
      const perPage = clampInt(url.searchParams.get('per_page'), 3, 50, 40);
      const { body, cached } = await pixabay(q, page, perPage);
      return json(res, 200, body, { 'Cache-Control': `public, max-age=${Math.round(PX_TTL_MS / 1000)}`, 'X-Cache': cached ? 'HIT' : 'MISS' });
    }
    if (url.pathname === '/api/media') return await media(req, res, url.searchParams.get('url') || '');
    if (url.pathname.startsWith('/api/dl/')) return await dl(req, res, url);
    return json(res, 404, { error: 'not_found' });
  } catch (e) {
    const st = e.status;
    // never send the key or GIPHY's raw error to the app
    const px = url.pathname === '/api/pixabay';
    if (st === 401 || st === 403 || (px && st === 400)) { console.error((px ? 'Pixabay' : 'GIPHY') + ' rejected the API key (check ' + (px ? 'PIXABAY_API_KEY' : 'GIPHY_API_KEY') + ')'); return json(res, 502, { error: 'upstream_auth' }); }
    if (st === 429) return json(res, 429, { error: px ? 'pixabay_quota' : 'giphy_quota' }, { 'Retry-After': '60' });
    console.error('proxy error:', e.message);
    if (!res.headersSent) json(res, 502, { error: 'upstream_unavailable' });
    else res.end();
  }
});
server.listen(PORT, () => console.log(`KlipFox GIF proxy on http://localhost:${PORT}  (cache ${TTL_MS / 1000}s, origins ${ORIGINS.join(' ')})`));
