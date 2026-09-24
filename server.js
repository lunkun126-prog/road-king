// 公路之王 Plus 本地服务：静态文件 + 存档 + 排行榜。零依赖。
// 用法：node server.js      （默认 127.0.0.1:8321；手机同局域网玩：HOST=0.0.0.0 node server.js）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const THREE = path.join(ROOT, 'node_modules', 'three');
const DB_FILE = process.env.ROAD_KING_DB || path.join(ROOT, 'data', 'db.json');
const PORT = Number(process.env.PORT || 8321);
const HOST = process.env.HOST || '127.0.0.1';
const MODES = new Set(['king', 'rampage', 'exam']);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { profiles: {}, boards: {} }; }
}
let db = loadDb();
function saveDb() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>"'&\\/]/g, '').trim().slice(0, 16);

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

function serveFile(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep) && file !== base) return send(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', kind, key]
  const [, kind, key] = parts.map(decodeURIComponent);
  if (kind === 'profile') {
    const name = cleanName(key);
    if (!name) return send(res, 400, { error: '名字不能为空' });
    if (req.method === 'GET') return send(res, 200, db.profiles[name] || null);
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'bad profile' });
      db.profiles[name] = { ...body, name, updated: new Date().toISOString() };
      saveDb();
      return send(res, 200, { ok: true });
    }
  }
  if (kind === 'leaderboard') {
    if (!MODES.has(key)) return send(res, 400, { error: 'bad mode' });
    const board = (db.boards[key] ||= []);
    if (req.method === 'GET') return send(res, 200, board.slice(0, 20));
    if (req.method === 'POST') {
      const b = await readBody(req, 4096);
      const name = cleanName(b.name);
      const score = Number(b.score);
      if (!name || !Number.isFinite(score) || score < 0 || score > 1e8) return send(res, 400, { error: 'bad score' });
      if (b.modded) return send(res, 400, { error: '开了 MOD 的成绩不上榜' });
      const entry = { name, score: Math.round(score), vehicle: String(b.vehicle || '').slice(0, 12), dist: Math.round(Number(b.dist) || 0), level: Number(b.level) || 0, at: new Date().toISOString() };
      board.push(entry);
      board.sort((a, z) => z.score - a.score);
      board.length = Math.min(board.length, 50);
      saveDb();
      return send(res, 200, { ok: true, rank: board.indexOf(entry) + 1 });
    }
  }
  return send(res, 404, { error: 'no such api' });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname.startsWith('/vendor/three/')) return serveFile(res, THREE, decodeURIComponent(url.pathname.slice('/vendor/three/'.length)));
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      return serveFile(res, PUBLIC, rel);
    } catch (e) {
      send(res, 400, { error: String(e.message || e) });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const srv = createServer();
  srv.listen(PORT, HOST, () => console.log(`公路之王 Plus → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${srv.address().port}`));
}
