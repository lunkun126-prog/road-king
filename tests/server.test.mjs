import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'test-db.json');
fs.rmSync(DB, { force: true });
process.env.ROAD_KING_DB = DB;
const { createServer } = await import('../server.js');

const srv = createServer();
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
test.after(() => { srv.close(); fs.rmSync(DB, { force: true }); });

test('首页、脚本和 three.js 能访问', async () => {
  for (const p of ['/', '/js/sim.js', '/vendor/three/build/three.module.js']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
  }
});

test('不能越权读项目外文件', async () => {
  for (const p of ['/..%2Fserver.js', '/vendor/three/..%2F..%2Fpackage.json', '/%2e%2e/%2e%2e/package.json']) {
    const r = await fetch(base + p);
    assert.notEqual(r.status, 200, p);
  }
});

test('存档读写', async () => {
  let r = await fetch(base + '/api/profile/' + encodeURIComponent('测试车手'));
  assert.equal(await r.json(), null);
  r = await fetch(base + '/api/profile/' + encodeURIComponent('测试车手'), { method: 'PUT', body: JSON.stringify({ coins: 123, owned: ['sedan'] }) });
  assert.equal(r.status, 200);
  r = await fetch(base + '/api/profile/' + encodeURIComponent('测试车手'));
  const p = await r.json();
  assert.equal(p.coins, 123);
  assert.ok(fs.existsSync(DB), '落盘');
});

test('排行榜排序、拒绝 MOD 成绩和坏数据', async () => {
  const post = (b) => fetch(base + '/api/leaderboard/king', { method: 'POST', body: JSON.stringify(b) });
  assert.equal((await post({ name: 'A', score: 100 })).status, 200);
  assert.equal((await post({ name: 'B', score: 900 })).status, 200);
  assert.equal((await post({ name: 'C', score: 99999, modded: true })).status, 400);
  assert.equal((await post({ name: '', score: 1 })).status, 400);
  assert.equal((await post({ name: 'D', score: 'abc' })).status, 400);
  assert.equal((await fetch(base + '/api/leaderboard/nope')).status, 400);
  const board = await (await fetch(base + '/api/leaderboard/king')).json();
  assert.deepEqual(board.map((e) => e.name), ['B', 'A']);
});
