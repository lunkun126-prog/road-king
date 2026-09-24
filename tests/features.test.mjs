import test from 'node:test';
import assert from 'node:assert/strict';
import { laneCenter, lightState } from '../public/js/road.js';
import { createGame, step, VEHICLES, MAPS, EXAM_LEVELS } from '../public/js/sim.js';

const DT = 1 / 60;
const run = (g, sec, inp) => { for (let i = 0; i < sec / DT && !g.over; i++) step(g, typeof inp === 'function' ? inp(g) : inp, DT); };
const keepLane = (lane, thr = 1) => (g) => ({ throttle: thr, brake: 0, steer: Math.max(-1, Math.min(1, (laneCenter(lane) - g.player.x) * 0.8 - g.player.xv * 0.4)), analog: true });

test('路上有金币，开过去能捡到，结算加金币', () => {
  const g = createGame({ mode: 'king', map: 'highway', seed: 8, mods: { empty: true } });
  run(g, 3, keepLane(1, 0.6));
  const c = g.coins.find((c) => !c.taken && c.s > g.player.s + 20);
  assert.ok(c, '前方应生成金币');
  g.player.x = c.x;
  const lane = Math.round(c.x / 3.6 + 1.5);
  for (let i = 0; i < 3000 && g.player.s < c.s + 5; i++) step(g, keepLane(lane)(g), DT);
  assert.ok(g.coinCount > 0, `捡到 ${g.coinCount} 枚`);
  g.player.hp = 0.1;
  g.mods = {};
  // 撞护栏报废触发结算
  run(g, 5, { throttle: 1, brake: 0, steer: 1 });
  assert.ok(g.over);
  assert.ok(g.result.coinPickup === g.coinCount && g.result.coins >= g.coinCount * 5);
});

test('雪天刹车距离更长、打方向更滑', () => {
  const brakeDist = (weather) => {
    const g = createGame({ mode: 'king', map: 'highway', weather, seed: 3, mods: { empty: true } });
    Object.assign(g.player, { v: 30 });
    const s0 = g.player.s;
    run(g, 8, { throttle: 0, brake: 1, steer: 0 });
    return g.player.s - s0;
  };
  const dry = brakeDist('clear'), snow = brakeDist('snow');
  assert.ok(snow > dry * 1.3, `雪地 ${snow.toFixed(1)}m vs 晴天 ${dry.toFixed(1)}m`);
  const latAfter = (weather) => {
    const g = createGame({ mode: 'king', map: 'highway', weather, seed: 3, mods: { empty: true } });
    g.player.v = 25;
    run(g, 0.3, { throttle: 0.3, brake: 0, steer: 1, analog: true });
    return Math.abs(g.player.xv);
  };
  assert.ok(latAfter('snow') < latAfter('clear') * 0.6, '雪地横向响应明显变慢');
});

test('高速没有红绿灯、车少；盘山路车更少', () => {
  const hw = createGame({ mode: 'king', map: 'highway', seed: 1 });
  const city = createGame({ mode: 'king', map: 'city', seed: 1 });
  const mt = createGame({ mode: 'king', map: 'mountain', seed: 1 });
  hw.road.at(8000);
  assert.equal(hw.road.nextLightAfter(0), null);
  assert.ok(hw.cars.length < city.cars.length / 2, `高速 ${hw.cars.length} 辆 vs 城市 ${city.cars.length}`);
  assert.ok(mt.cars.length <= hw.cars.length);
  assert.ok(Object.keys(MAPS).length >= 3);
});

test('驾考撞到行人直接不合格；NPC 会给过马路的行人停车', () => {
  const g = createGame({ mode: 'exam', level: 2, seed: 4 });
  g.cars = [];
  const p = { id: 999, kind: 'cross', s: g.player.s + 12, x: g.player.x, vs: 0, vx: 0, w: 0.55, l: 0.55, v: 0, hit: null, phase: 0 };
  g.peds.push(p);
  g.player.v = 10;
  run(g, 3, { throttle: 0.4, brake: 0, steer: 0 });
  assert.ok(g.over && !g.result.ok);
  assert.match(g.result.reason, /行人/);
  assert.ok(p.hit, '行人被撞飞');

  const h = createGame({ mode: 'king', seed: 4 });
  h.cars = h.cars.filter((c) => c.lane === 2 && c.s > 60).slice(0, 1);
  const car = h.cars[0];
  assert.ok(car);
  car.v = car.vDes = 12;
  h.peds.push({ id: 998, kind: 'cross', s: car.s + 40, x: car.x, vs: 0, vx: 0, w: 0.55, l: 0.55, v: 0, hit: null, phase: 0 });
  h.player.x = laneCenter(0);
  for (let i = 0; i < 600; i++) { h.peds.at(-1).vx = 0; step(h, { throttle: 0, brake: 1, steer: 0 }, DT); }
  assert.ok(car.s < h.peds.at(-1).s - 1, 'NPC 停在行人前面');
});

test('所有车都能开、提速后极速更高', () => {
  assert.ok(Object.keys(VEHICLES).length >= 8);
  for (const id of Object.keys(VEHICLES)) {
    const g = createGame({ mode: 'king', map: 'highway', vehicle: id, seed: 2, mods: { empty: true } });
    run(g, 20, keepLane(1));
    assert.ok(g.player.v * 3.6 > (id === 'truck' ? 100 : 150), `${id} 20 秒到 ${(g.player.v * 3.6).toFixed(0)} km/h`);
  }
  assert.ok(VEHICLES.toro.maxV * 3.6 >= 350);
});

test('新增驾考关卡：雨夜、冰雪', () => {
  assert.equal(EXAM_LEVELS.length, 8);
  const g = createGame({ mode: 'exam', level: 8, seed: 1 });
  assert.equal(g.weather.id, 'snow');
  assert.ok(g.grip < 0.6);
});
