import test from 'node:test';
import assert from 'node:assert/strict';
import { Road, laneCenter, lightState, STEP } from '../public/js/road.js';
import { createGame, step, hudInfo, EXAM_LEVELS } from '../public/js/sim.js';

const DT = 1 / 60;

// 简单自动驾驶：保持车道，前车近就刹，红灯停
function autopilot(g, { lane = 1, cruiseKmh = 60, obeyLights = true } = {}) {
  const P = g.player;
  let gap = Infinity;
  for (const c of g.cars) {
    if (c.wreck) continue;
    const d = c.s - P.s;
    if (d > 0 && Math.abs(c.x - P.x) < 2.6) gap = Math.min(gap, d - (c.cross ? c.w : c.l) / 2 - P.l / 2);
  }
  const h = hudInfo(g);
  if (obeyLights && h.light && h.light.state !== 'green' && h.light.dist < 60) gap = Math.min(gap, h.light.dist);
  const want = cruiseKmh / 3.6;
  const stopDist = (P.v * P.v) / (2 * 6) + 6;
  const brake = gap < stopDist ? 1 : 0;
  const throttle = !brake && P.v < want ? 1 : 0;
  const steer = Math.max(-1, Math.min(1, (laneCenter(lane) - P.x) * 0.8 - P.xv * 0.4));
  return { throttle, brake, steer, analog: true };
}

function run(g, seconds, pilot, extra = () => ({})) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n && !g.over; i++) step(g, { ...pilot(g), ...extra(i) }, DT);
}

test('道路连续、有限、红绿灯在直道平路上', () => {
  const r = new Road(123);
  let prev = r.at(0);
  for (let s = STEP; s < 20000; s += STEP) {
    const p = r.at(s);
    for (const k of ['x', 'y', 'z', 'h']) assert.ok(Number.isFinite(p[k]), `${k} @ ${s}`);
    const d = Math.hypot(p.x - prev.x, p.z - prev.z);
    assert.ok(Math.abs(d - STEP) < 0.01, `步长 ${d} @ ${s}`);
    prev = p;
  }
  assert.ok(r.lights.length > 10, '20km 至少十几个路口');
  for (const L of r.lights) {
    for (const ds of [-30, 0, 30]) assert.equal(r.kAt(L.s + ds), 0, `路口 ${L.s} 附近必须是直道`);
    assert.ok(Math.abs(r.yAt(L.s)) < 1e-6, '路口必须平');
  }
});

test('同种子道路完全一致', () => {
  const a = new Road(7), b = new Road(7);
  a.at(5000);
  for (let s = 0; s < 5000; s += 97) assert.deepEqual(a.at(s), b.at(s));
});

test('公路之王：自动驾驶 3 分钟不出 NaN，车流在跑', () => {
  const g = createGame({ mode: 'king', seed: 42 });
  run(g, 180, (g) => autopilot(g, { lane: 1, cruiseKmh: 70 }));
  const P = g.player;
  for (const k of ['s', 'x', 'v', 'hp']) assert.ok(Number.isFinite(P[k]), k);
  assert.ok(P.s > 1500, `跑了 ${P.s}m`);
  assert.ok(g.cars.length > 5, '车流还在');
  for (const c of g.cars) assert.ok(Number.isFinite(c.s) && Number.isFinite(c.x), 'npc 坐标有限');
});

test('红灯前正常停车，后车不会追尾', () => {
  let rear = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const g = createGame({ mode: 'exam', level: 2, seed });
    run(g, 120, (g) => autopilot(g, { lane: 1, cruiseKmh: 55 }));
    rear += g.events.filter((e) => e.type === 'crash').length;
    assert.equal(g.stats.redRun, 0, `seed ${seed} 自动驾驶不该闯红灯`);
  }
  assert.equal(rear, 0, '守规矩开车不该被撞');
});

test('驾考：闯红灯直接不合格', () => {
  const g = createGame({ mode: 'exam', level: 1, seed: 9 });
  const L = g.road.nextLightAfter(0);
  L.phase = 20; // 周期 14+3+10，t=0 时处于红灯
  assert.equal(lightState(L, 0).main, 'red');
  g.cars = [];
  Object.assign(g.player, { s: L.stopS - 25, v: 12 });
  run(g, 4, () => ({ throttle: 0.5, brake: 0, steer: 0 }));
  assert.ok(g.over);
  assert.equal(g.result.ok, false);
  assert.match(g.result.reason, /闯红灯/);
});

test('驾考：变道不打灯扣 10 分，打灯不扣', () => {
  const mk = () => createGame({ mode: 'exam', level: 1, seed: 11 });
  const g1 = mk();
  run(g1, 8, (g) => autopilot(g, { lane: 1, cruiseKmh: 40 }));
  run(g1, 4, (g) => autopilot(g, { lane: 2, cruiseKmh: 40 }));
  assert.ok(g1.exam.log.some((l) => /转向灯/.test(l.text)), '不打灯应扣分');

  const g2 = mk();
  run(g2, 8, (g) => autopilot(g, { lane: 1, cruiseKmh: 40 }));
  step(g2, { ...autopilot(g2, { lane: 1 }), signal: 'R' }, DT);
  run(g2, 4, (g) => autopilot(g, { lane: 2, cruiseKmh: 40 }));
  assert.ok(!g2.exam.log.some((l) => /转向灯/.test(l.text)), '打了灯不应扣分');
  assert.equal(g2.player.signal, null, '变道后转向灯自动熄灭');
});

test('驾考第 1 关：守规矩开完能及格', () => {
  const g = createGame({ mode: 'exam', level: 1, seed: 5 });
  run(g, 300, (g) => autopilot(g, { lane: 1, cruiseKmh: 55 }));
  assert.ok(g.over, '应到达终点');
  assert.equal(g.result.ok, true, JSON.stringify(g.result));
  assert.ok(g.result.stars >= 1);
});

test('大运狂飙：重卡撞车会创飞并加分加时', () => {
  const g = createGame({ mode: 'rampage', seed: 3 });
  // 往车多的地方直冲，左右扫
  run(g, 40, (g) => ({ throttle: 1, brake: 0, steer: Math.sin(g.t * 0.9) * 0.8, analog: true }));
  assert.ok(g.stats.smash > 0, '至少创飞一辆');
  assert.ok(g.score > 0);
});

test('轻碰只掉一点血，不会一碰就死', () => {
  const g = createGame({ mode: 'king', seed: 21 });
  const P = g.player;
  P.v = 50 / 3.6;
  g.cars = [];
  const c = { id: 999, kind: 'car', s: P.s + 5, x: P.x, lane: 1, w: 1.85, l: 4.4, mass: 1, v: 40 / 3.6, vDes: 40 / 3.6, baseV: 11, vx: 0, lc: null, thinkT: 9, hitCD: 0, headway: 1.2, cutCD: 9, brakeT: 0, passed: null };
  g.cars.push(c);
  for (let i = 0; i < 30; i++) step(g, { throttle: 1, brake: 0, steer: 0 }, DT);
  assert.ok(g.stats.crash >= 1, '应发生碰撞');
  assert.ok(P.hp > 70, `hp=${P.hp}`);
  assert.ok(!g.over);
});

test('红绿灯周期带倒计时', () => {
  const L = { phase: 0 };
  assert.equal(lightState(L, 0).main, 'green');
  assert.equal(lightState(L, 15).main, 'yellow');
  assert.equal(lightState(L, 20).main, 'red');
  assert.ok(lightState(L, 20).remain > 0);
});

test('所有驾考关卡配置可创建', () => {
  for (const lv of EXAM_LEVELS) {
    const g = createGame({ mode: 'exam', level: lv.id, seed: 1 });
    run(g, 5, (g) => autopilot(g, {}));
    assert.ok(Number.isFinite(g.player.s));
  }
});
