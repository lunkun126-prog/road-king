import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/js/meta.js';
import { createGame, step, VEHICLES } from '../public/js/sim.js';

const fresh = () => ({ coins: 0, gems: 0, owned: ['sedan'], drivers: ['ajie'], driver: 'ajie', upgrades: {}, sign: { days: 0, last: '' }, tasks: null });
const day = (n) => new Date(2026, 8, 25 + n, 10);

test('签到：一天一次，奖励递增，第 7 天两种货币都多并送车，之后每天仍是大档', () => {
  const p = fresh();
  const got = [];
  for (let i = 0; i < 9; i++) {
    const r = M.doSign(p, day(i));
    assert.ok(r, `第 ${i + 1} 天能签`);
    assert.equal(M.doSign(p, day(i)), null, '同一天不能签两次');
    got.push(r);
  }
  for (let i = 1; i < 7; i++) { assert.ok(got[i].coins > got[i - 1].coins); assert.ok(got[i].gems > got[i - 1].gems); }
  assert.equal(got[0].car, null);
  assert.ok(got[6].car && VEHICLES[got[6].car], '第 7 天送车');
  assert.ok(p.owned.includes(got[6].car));
  assert.ok(got[6].coins >= 10 * got[0].coins && got[6].gems >= 10 * got[0].gems, '第 7 天很多');
  assert.ok(got[7].coins > got[5].coins && got[8].gems > got[5].gems, '第 8 天起仍然很多');
  assert.equal(got[7].car, null);
  assert.equal(p.coins, got.reduce((a, r) => a + r.coins, 0));
});

test('签到：断签不清零；车全有了第 7 天折成钻石', () => {
  const p = fresh();
  M.doSign(p, day(0)); M.doSign(p, day(5));
  assert.equal(p.sign.days, 2);
  p.owned = Object.keys(VEHICLES);
  const r = M.signReward(7, p.owned);
  assert.equal(r.car, null);
  assert.equal(r.gems, M.SIGN_TABLE[6].gems + M.GIFT_FALLBACK_GEMS);
});

test('改装：金币买 1~4 级、钻石买满级，钱不够买不了，加成进 sim', () => {
  const p = fresh();
  assert.equal(M.buyUpgrade(p, 'sedan', 'engine'), false, '没钱');
  p.coins = 1e6;
  for (let i = 0; i < 4; i++) assert.ok(M.buyUpgrade(p, 'sedan', 'engine'));
  assert.equal(M.buyUpgrade(p, 'sedan', 'engine'), false, '第 5 级要钻石');
  p.gems = 20;
  assert.ok(M.buyUpgrade(p, 'sedan', 'engine'));
  assert.equal(p.gems, 0);
  assert.equal(M.upgradeCost('sedan', 5), null);
  assert.equal(M.buyUpgrade(p, 'toro', 'engine'), false, '没买的车不能改');
  const T = M.tuneFor(p, 'sedan');
  assert.ok(Math.abs(T.maxV - 1.15) < 1e-9);
  const g = createGame({ mode: 'king', vehicle: 'sedan', tune: T, seed: 1, mods: { empty: true } });
  assert.ok(Math.abs(g.V.maxV - VEHICLES.sedan.maxV * 1.15) < 1e-9);
  assert.equal(VEHICLES.sedan.maxV, 220 / 3.6, '原表不被改');
  // 改装后的车真的跑得更快
  const top = (tune) => { const q = createGame({ mode: 'king', vehicle: 'sedan', tune, seed: 1, mods: { empty: true, invincible: true } }); for (let i = 0; i < 60 * 90; i++) step(q, { throttle: 1, brake: 0, steer: 0 }, 1 / 60); return q.stats.maxKmh; };
  assert.ok(top(T) > top(null) + 10);
});

test('车手：招募扣对应货币，加成生效', () => {
  const p = fresh();
  assert.equal(M.buyDriver(p, 'pang'), false);
  p.gems = 30;
  assert.ok(M.buyDriver(p, 'pang'));
  assert.equal(p.gems, 0); assert.equal(p.driver, 'pang');
  assert.equal(M.buyDriver(p, 'pang'), false, '不能重复买');
  assert.equal(M.tuneFor(p, 'sedan').coinMul, 1.3);
  p.coins = 800; assert.ok(M.buyDriver(p, 'xue')); assert.equal(p.coins, 0);
  const g = createGame({ mode: 'rampage', tune: M.tuneFor({ ...p, driver: 'dayun' }, 'truck'), seed: 2 });
  assert.equal(g.timeLeft, 85);
});

test('每日任务：同一天固定 3 个，进度累计，完成才能领，全领完送奖励，跨天重置', () => {
  const p = fresh();
  const L = M.taskList(p, day(0));
  assert.equal(L.length, 3);
  assert.equal(new Set(L.map((t) => t.id)).size, 3);
  assert.deepEqual(M.taskList(p, day(0)).map((t) => t.id), L.map((t) => t.id));
  assert.equal(M.claimTask(p, L[0].id, day(0)), null, '没完成不能领');
  const big = { mode: 'king', dist: 9000, nearMiss: 50, coins: 50, smash: 0, examPass: true, bestCombo: 10 };
  for (const mode of ['king', 'rampage', 'exam']) M.recordRun(p, { ...big, mode, smash: 50 }, day(0));
  for (const t of M.taskList(p, day(0))) assert.ok(t.done, t.id);
  const before = { c: p.coins, g: p.gems };
  for (const t of L) assert.ok(M.claimTask(p, t.id, day(0)));
  assert.equal(M.claimTask(p, L[0].id, day(0)), null, '不能重复领');
  assert.ok(p.coins + p.gems > before.c + before.g);
  assert.deepEqual(M.claimBonus(p, day(0)), M.ALL_DONE_BONUS);
  assert.equal(M.claimBonus(p, day(0)), null);
  const L2 = M.taskList(p, day(1));
  assert.ok(L2.every((t) => !t.done && !t.claimed), '第二天重置');
});

test('钻石结算：MOD 不给；驾考首次三星、破纪录、每 5 公里', () => {
  assert.equal(M.runGems({ mode: 'king', newBest: true, dist: 20000, modded: true }), 0);
  assert.equal(M.runGems({ mode: 'king', newBest: true, dist: 10500 }), 5 + 4);
  assert.equal(M.runGems({ mode: 'exam', firstThreeStar: true, dist: 800 }), 10);
});
