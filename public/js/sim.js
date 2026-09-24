// 游戏模拟：玩家物理、NPC 交通、红绿灯、碰撞、计分、驾考规则。纯逻辑，不碰 DOM / three.js。
import { Road, LANES, LANE_W, ROAD_HALF, laneCenter, laneOf, rng, lightState } from './road.js';

const KMH = 3.6;

// 致敬款：外形参考真车，名字虚构（公开仓库不用品牌名）。model 为 public/models 下的 glb，没有就用代码画的车
export const VEHICLES = {
  sedan: { id: 'sedan', name: '家用轿车', ref: '日系家轿', price: 0, maxV: 220 / KMH, accel: 5, brake: 10, mass: 1, w: 1.85, l: 4.5, hp: 100, steer: 1, armor: 1, desc: '均衡，新手友好' },
  quadri: { id: 'quadri', name: '四叶草 GTA', ref: '阿尔法·罗密欧 Giulia GTA 风格', price: 1200, maxV: 305 / KMH, accel: 7.2, brake: 11, mass: 1, w: 1.9, l: 4.6, hp: 95, steer: 1.12, armor: 0.95, desc: '意式四门猛兽，好开又够快' },
  stoccarda: { id: 'stoccarda', name: '斯图加特 GT', ref: '保时捷 911 GT3 风格', price: 2200, maxV: 318 / KMH, accel: 8, brake: 12.5, mass: 1, w: 1.85, l: 4.55, hp: 95, steer: 1.22, armor: 0.95, desc: '刹车最强，过弯最稳' },
  sport: { id: 'sport', name: '跃马 F8', ref: '法拉利 F8 风格', price: 3000, maxV: 340 / KMH, accel: 8.8, brake: 12, mass: 1, w: 1.98, l: 4.6, hp: 90, steer: 1.15, armor: 0.9, desc: '中置 V8，擦肩分更高' },
  woking: { id: 'woking', name: '沃金 720', ref: '迈凯伦 720S 风格', price: 3800, maxV: 341 / KMH, accel: 9.2, brake: 12.5, mass: 1, w: 1.93, l: 4.55, hp: 88, steer: 1.18, armor: 0.88, desc: '碳纤维轻量化，加速最猛之一' },
  toro: { id: 'toro', name: '公牛 V12', ref: '兰博基尼 Aventador 风格', price: 5000, maxV: 355 / KMH, accel: 9, brake: 11.5, mass: 1.1, w: 2.05, l: 4.8, hp: 100, steer: 1.05, armor: 1, desc: '极速 355，全场最快' },
  moto: { id: 'moto', name: '蓝焰 R1', ref: '雅马哈 YZF-R1 风格仿赛', price: 1500, maxV: 299 / KMH, accel: 10, brake: 11, mass: 0.35, w: 0.8, l: 2.1, hp: 60, steer: 1.45, armor: 0.6, rider: true, desc: '千元级仿赛，能钻车缝；很脆' },
  ninja: { id: 'ninja', name: '绿忍 ZX', ref: '川崎 Ninja ZX-10R 风格仿赛', price: 1800, maxV: 299 / KMH, accel: 10.3, brake: 11, mass: 0.35, w: 0.8, l: 2.1, hp: 65, steer: 1.4, armor: 0.62, rider: true, desc: '川崎绿，出弯更猛' },
  truck: { id: 'truck', name: '大运重卡', ref: '重型牵引车', price: 1500, maxV: 170 / KMH, accel: 3.2, brake: 6.5, mass: 6, w: 2.5, l: 9.5, hp: 320, steer: 0.8, armor: 4, smash: true, desc: '撞谁谁飞；刹车很长' },
};

// 地图：公路之王可选。车少的路给你放开跑
export const MAPS = {
  city: { id: 'city', name: '城市主干道', desc: '车多、红绿灯、施工、行人', traffic: 1, curveMax: 1 / 140, hillAmp: 1, lights: { first: 450, every: [650, 1100] }, ai: [55, 90], cones: true, peds: true, coinGap: [160, 360] },
  highway: { id: 'highway', name: '滨海高速', desc: '车少、没有红绿灯，长直道大弯放开跑', traffic: 0.3, curveMax: 1 / 700, hillAmp: 0.6, lights: null, ai: [95, 135], cones: false, peds: false, coinGap: [90, 220] },
  mountain: { id: 'mountain', name: '盘山公路', desc: '几乎没车，急弯连坡，最刺激', traffic: 0.16, curveMax: 1 / 115, hillAmp: 2.4, lights: null, ai: [60, 90], cones: false, peds: false, coinGap: [110, 260] },
};

export const WEATHERS = {
  clear: { id: 'clear', name: '晴天', grip: 1 },
  rain: { id: 'rain', name: '雨天', grip: 0.78 },
  snow: { id: 'snow', name: '下雪', grip: 0.45 },
};

export const CAR_TYPES = {
  car: { w: 1.85, l: 4.4, mass: 1, vMul: 1 },
  van: { w: 2.0, l: 5.2, mass: 1.6, vMul: 0.92 },
  bus: { w: 2.5, l: 11, mass: 5, vMul: 0.72 },
  truck: { w: 2.5, l: 9, mass: 5, vMul: 0.75 },
  moto: { w: 0.8, l: 2.1, mass: 0.3, vMul: 1.08 },
  cones: { w: 3.0, l: 40, mass: 99, vMul: 0 },
};

export const EXAM_LEVELS = [
  { id: 1, name: '起步上路', dist: 900, limit: 60, traffic: 0.45, aggro: 0, curves: false, hills: false, lights: { first: 380, every: [9e9, 9e9] }, tip: '限速 60。红灯要停在停止线前，绿灯再走。' },
  { id: 2, name: '城市路口', dist: 1600, limit: 60, traffic: 0.7, aggro: 0.05, curves: false, hills: false, lights: { first: 300, every: [380, 480] }, tip: '连续三个路口。黄灯来得及就停。' },
  { id: 3, name: '规范变道', dist: 1900, limit: 70, traffic: 0.75, aggro: 0.1, curves: true, curveMax: 1 / 260, cones: true, lights: { first: 900, every: [9e9, 9e9] }, tip: '前方施工占道。变道前先打转向灯（Q / E）。' },
  { id: 4, name: '夜间驾驶', dist: 2000, limit: 70, traffic: 0.7, aggro: 0.12, curves: true, curveMax: 1 / 220, night: true, requireLights: true, lights: { first: 500, every: [600, 800] }, tip: '天黑了，记得开大灯（L）。' },
  { id: 5, name: '大雾天气', dist: 2000, limit: 50, traffic: 0.6, aggro: 0.1, curves: true, curveMax: 1 / 240, fog: true, lights: { first: 450, every: [550, 750] }, tip: '能见度很低，限速 50，看清红绿灯倒计时。' },
  { id: 6, name: '限时通勤', dist: 3000, limit: 80, time: 190, traffic: 1.25, aggro: 0.3, curves: true, curveMax: 1 / 180, cones: true, lights: { first: 450, every: [600, 850] }, tip: '190 秒内到公司！路上有路怒族，按喇叭（H）能吓退加塞。' },
  { id: 7, name: '雨夜行车', dist: 2200, limit: 60, traffic: 0.7, aggro: 0.12, curves: true, curveMax: 1 / 220, night: true, requireLights: true, weather: 'rain', lights: { first: 500, every: [600, 800] }, tip: '下雨路滑，刹车距离变长。开大灯，早点减速。' },
  { id: 8, name: '冰雪路面', dist: 2200, limit: 50, traffic: 0.55, aggro: 0.05, curves: true, curveMax: 1 / 240, weather: 'snow', lights: { first: 500, every: [600, 800] }, tip: '雪地非常滑！转向和刹车都要提前，别猛打方向。' },
];

export const MODE_INFO = {
  exam: { name: '驾考模式', desc: '8 关驾照考试，100 分起扣，90 分及格' },
  king: { name: '公路之王', desc: '无尽车流，弯道坡道红绿灯；擦肩连击冲榜' },
  rampage: { name: '大运狂飙', desc: '75 秒开重卡横冲直撞，创飞越多分越高' },
};

const PALETTE = [0xd94c4c, 0x3d6fd9, 0xe8e8e8, 0x2b2b2b, 0xf0c33c, 0x3fa66b, 0x8a5cc7, 0xe07a2f, 0x9aa5b1, 0x5ac8d8];

export function createGame({ mode = 'king', level = 1, vehicle = 'sedan', mods = {}, seed = Date.now() & 0xffffff, map = 'city', weather = 'clear' } = {}) {
  const lv = mode === 'exam' ? EXAM_LEVELS[level - 1] : null;
  const vid = mode === 'rampage' ? 'truck' : VEHICLES[vehicle] ? vehicle : 'sedan';
  const V = VEHICLES[vid];
  const M = MAPS[mode === 'king' ? map : 'city'] || MAPS.city;
  const W = WEATHERS[lv ? lv.weather || 'clear' : weather] || WEATHERS.clear;
  let roadOpts;
  if (lv) roadOpts = { curves: lv.curves, hills: lv.hills ?? true, curveMax: lv.curveMax, lights: lv.lights };
  else if (mode === 'rampage') roadOpts = { curves: true, curveMax: 1 / 200, lights: null };
  else roadOpts = { curves: true, curveMax: M.curveMax, hillAmp: M.hillAmp, lights: M.lights };
  const g = {
    mode, level, lv, V, mods, seed, map: M, weather: W, grip: W.grip,
    coins: [], coinAt: 120, coinCount: 0, peds: [], pedTimers: {}, jayAt: 700,
    road: new Road(seed, roadOpts),
    rand: rng(seed ^ 0x5bd1e995),
    t: 0, over: false, result: null,
    player: { s: 0, x: laneCenter(1), v: 0, xv: 0, steer: 0, hp: V.hp, signal: null, sigOnT: -9, sigDir: 0, sigOffT: 0,
      lightsOn: !!lv?.night, lane: 1, scrapeT: 0, hornT: 0, w: V.w, l: V.l, mass: V.mass },
    cars: [], nextId: 1, crossTimers: {}, conesAt: 0,
    events: [],
    score: 0, combo: 0, comboT: 0, best: { combo: 0 },
    stats: { nearMiss: 0, overtake: 0, smash: 0, crash: 0, redRun: 0, maxKmh: 0, dist: 0, coins: 0, pedHit: 0 },
    exam: lv ? { points: 100, flags: {}, log: [], failed: null } : null,
    timeLeft: mode === 'rampage' ? 75 : lv?.time ?? 0,
  };
  if (mode !== 'rampage') g.player.v = 0; else g.player.v = 60 / KMH;
  fillTraffic(g);
  for (let i = 0; i < 14; i++) spawnWalker(g, g.player.s - 60 + g.rand() * 480);
  return g;
}

// ---------- 工具 ----------
const exS = (o) => (o.cross ? o.w / 2 : o.l / 2);
const exX = (o) => (o.cross ? o.l / 2 : o.w / 2);
const emit = (g, type, data = {}) => g.events.push({ type, t: g.t, ...data });

function trafficLevel(g) {
  if (g.mods.empty) return 0;
  if (g.lv) return g.lv.traffic;
  if (g.mode === 'rampage') return 1.9;
  return g.map.traffic * Math.min(1.7, 0.7 + g.player.s / 9000);
}
function aggroRatio(g) {
  if (g.lv) return g.lv.aggro;
  if (g.mode === 'rampage') return 0.1;
  return Math.min(0.35, 0.08 + g.player.s / 25000);
}
function aiSpeedKmh(g) {
  const wx = g.grip < 0.6 ? 0.8 : g.grip < 0.9 ? 0.92 : 1;
  if (g.lv) return [g.lv.limit * 0.7, g.lv.limit * 0.95];
  if (g.mode === 'rampage') return [50, 80];
  const up = Math.min(40, g.player.s / 250);
  const [lo, hi] = g.map.ai;
  return [(lo + up) * wx, (hi + up) * wx];
}

function makeCar(g, s, lane, kind) {
  const r = g.rand;
  const T = CAR_TYPES[kind];
  const [lo, hi] = aiSpeedKmh(g);
  const vDes = ((lo + r() * (hi - lo)) / KMH) * T.vMul;
  const aggro = kind !== 'bus' && kind !== 'truck' && r() < aggroRatio(g);
  return {
    id: g.nextId++, kind, s, x: laneCenter(lane), lane, w: T.w, l: T.l, mass: T.mass,
    v: vDes * 0.9, vDes, baseV: vDes, vx: 0, aggro, color: PALETTE[Math.floor(r() * PALETTE.length)],
    lc: null, thinkT: 1 + r() * 3, cd: 0, brakeT: 0, braking: false, hazard: false, stalled: false,
    wreck: null, passed: null, hitCD: 0, headway: aggro ? 0.8 : 1.2 + r() * 0.5, cutCD: 0,
  };
}

function pickKind(g) {
  const r = g.rand();
  if (r < 0.66) return 'car';
  if (r < 0.8) return 'van';
  if (r < 0.87) return 'bus';
  if (r < 0.95) return 'truck';
  return 'moto';
}

function spotFree(g, s, lane, margin = 22) {
  const x = laneCenter(lane);
  const P = g.player;
  if (Math.abs(P.s - s) < margin + 6 && Math.abs(P.x - x) < 3) return false;
  for (const c of g.cars) if (!c.cross && Math.abs(c.s - s) < margin + exS(c) && Math.abs(c.x - x) < 3) return false;
  return true;
}

function fillTraffic(g) {
  const n = Math.round(trafficLevel(g) * 26);
  for (let i = 0; i < n * 2; i++) {
    if (g.cars.length >= n) break;
    const s = 40 + g.rand() * 380, lane = Math.floor(g.rand() * LANES);
    if (spotFree(g, s, lane)) g.cars.push(makeCar(g, s, lane, pickKind(g)));
  }
}

function spawnTraffic(g, dt) {
  const P = g.player;
  // 回收
  g.cars = g.cars.filter((c) => {
    if (c.wreck) return c.wreck.t < 3.5;
    if (c.cross) return Math.abs(c.x) < 55 && c.s > P.s - 150;
    return c.s > P.s - 170 && c.s < P.s + 650;
  });
  const want = Math.round(trafficLevel(g) * 26);
  const live = g.cars.filter((c) => !c.cross && !c.wreck && c.kind !== 'cones').length;
  if (live < want) {
    const ahead = P.v > 22 || g.rand() < 0.75;
    const s = ahead ? P.s + 320 + g.rand() * 120 : P.s - 120;
    const lane = Math.floor(g.rand() * LANES);
    const light = g.road.nextLightAfter(s - 40);
    const nearStop = light && Math.abs(light.stopS - s) < 45;
    if (!nearStop && spotFree(g, s, lane)) {
      const c = makeCar(g, s, lane, pickKind(g));
      if (!ahead) { c.vDes = c.baseV = Math.max(c.vDes, P.v + 6); c.v = c.vDes; }
      g.cars.push(c);
    }
  }
  // 施工占道
  const wantCones = g.lv ? g.lv.cones : g.mode === 'king' && g.map.cones;
  if (wantCones && P.s + 420 > g.conesAt) {
    const s = Math.max(P.s + 380, g.conesAt);
    const light = g.road.nextLightAfter(s - 80);
    if (!light || Math.abs(light.s - s) > 120) {
      const lane = g.rand() < 0.5 ? 0 : LANES - 1 - Math.floor(g.rand() * 2);
      const c = makeCar(g, s, lane, 'cones');
      c.v = c.vDes = c.baseV = 0;
      g.cars = g.cars.filter((o) => o.cross || Math.abs(o.s - s) > 40 || Math.abs(o.x - c.x) > 3);
      g.cars.push(c);
    }
    g.conesAt = s + (g.lv ? 500 : 700 + g.rand() * 900);
  }
  // 路口横向车流
  for (const L of g.road.lightsNear(P.s - 60, P.s + 380)) {
    const st = lightState(L, g.t);
    g.crossTimers[L.id] = (g.crossTimers[L.id] ?? 0) - dt;
    if (st.cross && g.crossTimers[L.id] <= 0) {
      g.crossTimers[L.id] = 1.1 + g.rand() * 1.4;
      const dir = g.rand() < 0.5 ? 1 : -1;
      const c = makeCar(g, L.s - dir * 3.2, 0, g.rand() < 0.85 ? 'car' : 'van');
      Object.assign(c, { cross: true, x: -dir * 26, vx: dir * (11 + g.rand() * 4), v: 0, vDes: 0, aggro: false });
      g.cars.push(c);
    }
  }
}

// ---------- NPC ----------
function leaderOf(g, c, laneX) {
  let gap = Infinity, lv = 0, who = null;
  const P = g.player;
  const check = (o) => {
    if (o === c || o.wreck) return;
    const d = o.s - c.s;
    if (d <= 0 || d > 160) return;
    const hw = exX(o) + c.w / 2 + 0.35;
    if (Math.abs(o.x - c.x) >= hw && (laneX === undefined || Math.abs(o.x - laneX) >= hw)) return;
    const gp = d - exS(o) - c.l / 2;
    if (gp < gap) { gap = gp; lv = o.cross ? 0 : o.v; who = o; }
  };
  for (const o of g.cars) check(o);
  check(P);
  for (const p of g.peds) if (!p.hit && p.kind !== 'walk' && Math.abs(p.x) < ROAD_HALF + 1.5) check(p);
  // 停止线
  const L = g.road.nextLightAfter(c.s + c.l / 2 - 0.5);
  if (L) {
    const d = L.stopS - c.s - c.l / 2;
    if (d < 170) {
      const st = lightState(L, g.t);
      const stop = st.main === 'red' ? d > -0.5 && c.v * c.v / (2 * Math.max(d, 0.1)) < 8
        : st.main === 'yellow' ? c.v * c.v / (2 * Math.max(d, 0.1)) < 3.5
        : st.remain < 1.5 && d > 12 && c.v * c.v / (2 * d) < 2.5;
      if (stop && d < gap) { gap = Math.max(d, 0.05); lv = 0; who = 'light'; }
    }
  }
  return { gap, lv, who };
}

function laneSafe(g, c, lane, strict) {
  const x = laneCenter(lane);
  const P = g.player;
  const test = (o) => {
    if (o === c || o.wreck || o.cross) return true;
    if (Math.abs(o.x - x) > 2.6) return true;
    const d = o.s - c.s, len = exS(o) + c.l / 2;
    if (d >= 0) return d - len > Math.max(strict ? 12 : 5, (c.v - o.v) * 2 + (strict ? 8 : 3));
    return -d - len > Math.max(strict ? 9 : 4, (o.v - c.v) * 2.5 + (strict ? 6 : 1));
  };
  for (const o of g.cars) if (!test(o)) return false;
  return test(P);
}

function startLaneChange(c, dir, signalT, dur) {
  c.lc = { phase: 'signal', dir, t: 0, signalT, dur, from: c.lane, to: c.lane + dir };
}

function think(g, c, lead) {
  const P = g.player;
  c.thinkT = 0.8 + g.rand() * 2.2;
  if (c.lc || c.stalled || c.kind === 'cones') return;
  // 路怒族：玩家在相邻车道身后且更快 → 打灯加塞
  if (c.aggro && c.cutCD <= 0) {
    const behind = c.s - P.s;
    const pl = laneOf(P.x);
    if (behind > (c.l + P.l) / 2 + 5 && behind < 38 && Math.abs(pl - c.lane) === 1 && P.v > c.v - 1 && g.rand() < 0.55) {
      startLaneChange(c, pl - c.lane, 0.75, 1.05);
      c.lc.cut = true;
      c.cutCD = 9;
      return;
    }
  }
  const blocked = lead.who && lead.who !== 'light' && lead.gap < 45 && lead.lv < c.vDes - 3;
  if (blocked || g.rand() < 0.04) {
    const dirs = g.rand() < 0.5 ? [-1, 1] : [1, -1];
    for (const d of dirs) {
      const to = c.lane + d;
      if (to < 0 || to >= LANES) continue;
      if (laneSafe(g, c, to, !c.aggro)) { startLaneChange(c, d, c.aggro ? 0.8 : 1.4, c.aggro ? 1.2 : 1.8); return; }
    }
    if (blocked) c.thinkT = 0.6;
  }
}

function updateCar(g, c, dt) {
  if (c.wreck) {
    const w = c.wreck;
    w.t += dt; w.y += w.vy * dt; w.vy -= 16 * dt;
    if (w.y < 0) { w.y = 0; w.vy = Math.abs(w.vy) * 0.3; c.v *= 0.6; c.vx *= 0.6; }
    c.s += c.v * dt; c.x += c.vx * dt;
    w.rx += w.sx * dt; w.rz += w.sz * dt; w.ry += w.sy * dt;
    return;
  }
  if (c.cross) { c.x += c.vx * dt; return; }
  if (c.kind === 'cones') return;
  c.hitCD -= dt; c.cutCD -= dt;
  const lead = leaderOf(g, c, c.lc?.phase === 'move' ? laneCenter(c.lc.to) : undefined);
  c.thinkT -= dt;
  if (c.thinkT <= 0) think(g, c, lead);

  // 变道状态机
  if (c.lc) {
    const lc = c.lc;
    lc.t += dt;
    if (lc.phase === 'signal' && lc.t >= lc.signalT) {
      if (lc.to < 0 || lc.to >= LANES || (!lc.cut && !laneSafe(g, c, lc.to, true)) || (lc.cut && !laneSafe(g, c, lc.to, false) && !cutStillValid(g, c))) c.lc = null;
      else { lc.phase = 'move'; lc.t = 0; }
    } else if (lc.phase === 'move') {
      const k = Math.min(1, lc.t / lc.dur);
      const e = k * k * (3 - 2 * k);
      c.x = laneCenter(lc.from) + (laneCenter(lc.to) - laneCenter(lc.from)) * e;
      if (k > 0.5) c.lane = lc.to;
      if (k >= 1) {
        if (lc.cut) { c.brakeT = 1.6; }
        c.lc = null;
      }
    }
  }

  // IDM 跟车
  const vDes = c.stalled ? 0 : c.brakeT > 0 ? Math.max(0, g.player.v * 0.55) : c.vDes;
  c.brakeT -= dt;
  const a0 = 2.2, b = 3.2 * g.grip, s0 = 2.4;
  let acc = vDes > 0.1 ? a0 * (1 - Math.pow(c.v / vDes, 4)) : -4;
  if (lead.gap < Infinity) {
    const sStar = s0 + Math.max(0, (c.v * c.headway) / Math.sqrt(g.grip) + (c.v * (c.v - lead.lv)) / (2 * Math.sqrt(a0 * b)));
    acc -= a0 * Math.pow(sStar / Math.max(lead.gap, 0.1), 2);
  }
  acc = Math.max(-9 * (0.35 + 0.65 * g.grip), Math.min(a0, acc));
  c.braking = acc < -1.2;
  c.v = Math.max(0, c.v + acc * dt);
  c.s += c.v * dt;
}

function cutStillValid(g, c) {
  const P = g.player;
  return c.s - P.s > (c.l + P.l) / 2 + 3;
}

// 喇叭：前方打灯要挤进来的车取消变道；同车道慢车让行；路怒族有概率急刹报复
function honk(g) {
  const P = g.player;
  let best = null, bd = 40;
  for (const c of g.cars) {
    if (c.wreck || c.cross || c.kind === 'cones') continue;
    const d = c.s - P.s;
    if (d > 0 && d < bd && Math.abs(c.x - P.x) < 5.5) { best = c; bd = d; }
  }
  if (!best) return;
  const c = best;
  const pl = laneOf(P.x);
  if (c.lc && c.lc.to === pl && c.lc.phase === 'signal') {
    c.lc = null; c.cutCD = 12; c.thinkT = 4;
    emit(g, 'yield', { id: c.id, text: '对方被喇叭劝退' });
  } else if (!c.lc && c.lane === pl) {
    if (c.aggro && g.rand() < 0.35) { c.brakeT = 1.2; emit(g, 'angry', { id: c.id, text: '路怒！对方急刹' }); return; }
    for (const d of [1, -1]) {
      const to = c.lane + d;
      if (to >= 0 && to < LANES && laneSafe(g, c, to, false)) { startLaneChange(c, d, 0.6, 1.4); emit(g, 'yield', { id: c.id, text: '前车让行' }); return; }
    }
  }
}

// ---------- 玩家 ----------
function penalize(g, key, pts, text, once = true) {
  const E = g.exam;
  if (!E || E.failed) return;
  if (once && E.flags[key]) return;
  E.flags[key] = true;
  E.points -= pts;
  E.log.push({ t: g.t, text, pts });
  emit(g, 'penalty', { text: `-${pts} ${text}` });
}

function fail(g, reason) {
  if (g.over) return;
  if (g.exam) g.exam.failed = reason;
  finish(g, false, reason);
}

function finish(g, ok, reason) {
  if (g.over) return;
  g.over = true;
  const E = g.exam;
  let stars = 0, coins;
  if (E) {
    const pass = ok && E.points >= 90;
    stars = pass ? (E.points >= 100 ? 3 : E.points >= 95 ? 2 : 1) : 0;
    coins = pass ? 100 + stars * 60 : 10;
    g.result = { ok: pass, reason: pass ? '考试合格' : reason || `得分 ${E.points} 不足 90`, points: E.points, stars, coins, log: E.log };
  } else {
    coins = Math.floor(g.score / 40);
    g.result = { ok, reason, score: Math.round(g.score), coins };
  }
  g.result.coins += g.coinCount * 5;
  g.result.coinPickup = g.coinCount;
  if (g.mods && Object.values(g.mods).some(Boolean)) g.result.modded = true;
  g.result.stats = { ...g.stats, dist: Math.round(g.player.s), bestCombo: g.best.combo, time: Math.round(g.t) };
  emit(g, 'over', { result: g.result });
}

function damage(g, amt, reason) {
  if (g.mods.invincible) return;
  const P = g.player;
  P.hp = Math.max(0, P.hp - amt);
  if (P.hp <= 0) finish(g, g.mode === 'rampage', reason || '车辆报废');
}

function addCombo(g, pts, label) {
  g.combo = g.comboT > 0 ? Math.min(10, g.combo + 1) : 1;
  g.comboT = g.mode === 'rampage' ? 3 : 4;
  g.best.combo = Math.max(g.best.combo, g.combo);
  const gain = pts * g.combo;
  if (!g.exam) g.score += gain;
  emit(g, 'combo', { text: `${label} ×${g.combo}  +${gain}`, combo: g.combo });
}

function collide(g, c) {
  const P = g.player, V = g.V;
  if (c.hitCD > 0) return;
  c.hitCD = 0.7;
  const cvx = c.cross ? c.vx : 0;
  const impact = Math.hypot(P.v - c.v, P.xv - cvx) * KMH;
  const side = Math.sign(c.x - P.x) || 1;
  if (c.kind === 'cones') {
    // 施工区不整体飞走：冲进去会撞飞锥桶(渲染层按位置处理)、掉速掉血
    c.hitCD = 0.25;
    P.v *= V.smash ? 0.98 : 0.93;
    damage(g, V.smash ? 1 : 3, '撞上施工区');
    emit(g, 'cones', { id: c.id, s: P.s, x: P.x, v: P.v });
    penalize(g, 'cones', 10, '撞倒锥桶');
    return;
  }
  const smash = V.smash || g.mods.invincible || (V.mass / c.mass >= 3 && impact > 20) || impact > 95;
  if (smash) {
    const f = Math.min(2.2, 0.6 + impact / 60);
    c.wreck = { t: 0, y: 0, vy: 4 + 5 * f, rx: 0, ry: 0, rz: 0, sx: (g.rand() - 0.5) * 8, sy: (g.rand() - 0.5) * 5, sz: side * (2 + 3 * f) };
    c.v = c.s > P.s ? Math.max(c.v, P.v) * 1.05 + 4 : c.v * 0.5;
    c.vx = side * (3 + 4 * f) + cvx * 0.3;
    c.lc = null;
    P.v *= V.smash || g.mods.invincible ? 0.95 : 0.6;
    g.stats.smash++;
    emit(g, 'smash', { id: c.id, impact });
    if (g.mode === 'rampage') { g.timeLeft += 1.5; addCombo(g, 100, '创飞'); }
    else if (!g.exam) addCombo(g, 60, '创飞');
    damage(g, V.smash ? impact * 0.04 : 6 + impact * 0.35 / V.armor, '撞车报废');
  } else {
    // 一维动量交换(沿 s)，横向推开
    const m1 = P.mass, m2 = c.mass, e = 0.25;
    if (!c.cross) {
      const v1 = P.v, v2 = c.v, vcm = (m1 * v1 + m2 * v2) / (m1 + m2);
      P.v = Math.max(0, vcm - (e * (v1 - v2) * m2) / (m1 + m2));
      c.v = Math.max(0, vcm + (e * (v1 - v2) * m1) / (m1 + m2));
    } else {
      P.v *= 0.35;
    }
    const penS = exS(c) + P.l / 2 - Math.abs(c.s - P.s);
    const penX = exX(c) + P.w / 2 - Math.abs(c.x - P.x);
    if (penX < penS) { P.x -= side * (penX + 0.05); P.xv = -side * 2; }
    else if (c.s > P.s) P.s -= penS + 0.05; else P.s += penS + 0.05;
    if (!c.cross) { c.stalled = true; c.hazard = true; c.lc = null; }
    g.stats.crash++;
    g.combo = 0; g.comboT = 0;
    const dmg = (4 + impact * 0.6) / V.armor;
    emit(g, 'crash', { id: c.id, impact, dmg });
    if (g.exam) {
      if (impact < 15) penalize(g, 'bump' + c.id, 20, '轻微碰撞', true);
      else fail(g, '发生碰撞');
    }
    damage(g, dmg, '追尾报废');
  }
}

function updatePlayer(g, inp, dt) {
  const P = g.player, V = g.V, M = g.mods;
  const sens = inp.sens ?? 1;
  const speedMul = M.speed ? 3.6 : 1;
  const maxV = V.maxV * speedMul;
  // 转向
  P.steer += (Math.max(-1, Math.min(1, inp.steer || 0)) - P.steer) * Math.min(1, dt * (inp.analog ? 14 : 7));
  const k = g.road.kAt(P.s);
  const grip = g.grip;
  const latMax = Math.min(P.v * 0.42, 5.6 + P.v * 0.03) * V.steer * sens * (0.7 + 0.3 * grip);
  const want = P.steer * latMax - (k * P.v * P.v * 0.3) / (0.6 + 0.4 * grip);
  // 抓地力越低，横向速度跟得越慢 = 打滑
  P.xv += (want - P.xv) * Math.min(1, dt * 7 * grip * grip);
  P.slip = want - P.xv;
  P.x += P.xv * dt;
  // 油门/刹车
  const thr = inp.cruise && !inp.brake ? Math.max(inp.throttle || 0, P.v < inp.cruise ? 0.6 : 0) : inp.throttle || 0;
  let acc = thr * V.accel * (M.speed ? 2.2 : 1) * (0.5 + 0.5 * g.grip) * Math.max(0, 1 - Math.pow(P.v / maxV, 2));
  acc -= (inp.brake || 0) * V.brake * (0.35 + 0.65 * g.grip);
  acc -= 0.25 + 0.0011 * P.v * P.v / speedMul;
  P.v = Math.max(0, P.v + acc * dt);
  const ds = P.v * dt;
  P.s += ds;
  // 护栏
  const lim = ROAD_HALF - P.w / 2;
  P.scrapeT -= dt;
  if (Math.abs(P.x) > lim) {
    const lat = Math.abs(P.xv);
    P.x = Math.sign(P.x) * lim;
    P.xv = -Math.sign(P.x) * Math.min(lat * 0.3, 1.5);
    P.v -= P.v * 0.7 * dt;
    if (P.scrapeT <= 0) {
      P.scrapeT = 0.35;
      emit(g, 'scrape', { side: Math.sign(P.x) });
      damage(g, (1.5 + lat * 1.2 + P.v * 0.04) / V.armor, '撞护栏报废');
      penalize(g, 'rail', 10, '碰擦护栏');
    }
  }
  // 转向灯：变道完成后自动熄灭
  if (inp.signal !== undefined) {
    P.signal = P.signal === inp.signal ? null : inp.signal;
    if (P.signal) { P.sigOnT = g.t; P.sigDir = P.signal === 'L' ? -1 : 1; }
    emit(g, 'signal', { on: P.signal });
  }
  if (P.signal && P.sigOffT && g.t > P.sigOffT) { P.signal = null; P.sigOffT = 0; }
  // 变道判定(带迟滞)
  const raw = P.x / LANE_W + (LANES - 1) / 2;
  if (Math.abs(raw - P.lane) > 0.62) {
    const dir = Math.sign(raw - P.lane);
    P.lane = Math.max(0, Math.min(LANES - 1, P.lane + dir));
    const signaled = (P.signal && P.sigDir === dir) || (P.sigDir === dir && g.t - P.sigOnT < 5);
    if (!signaled) penalize(g, 'lane' + Math.floor(g.t / 4), 10, '变道未打转向灯', true);
    if (P.signal) P.sigOffT = g.t + 1.2;
  }
  if (inp.horn) { honk(g); emit(g, 'horn'); }
  if (inp.lights) { P.lightsOn = !P.lightsOn; emit(g, 'lights', { on: P.lightsOn }); }

  // 统计 / 计分
  const kmh = P.v * KMH;
  g.stats.maxKmh = Math.max(g.stats.maxKmh, kmh);
  if (g.mode === 'king') g.score += ds * (1 + Math.max(0, kmh - 60) / 60) * (V.id === 'sport' ? 1.15 : 1);
  if (g.mode === 'rampage') g.score += ds / 4;
  g.comboT -= dt;
  if (g.comboT <= 0 && g.combo) g.combo = 0;
  return ds;
}

function examRules(g, dt) {
  const E = g.exam, lv = g.lv, P = g.player;
  const kmh = P.v * KMH;
  if (kmh > lv.limit * 1.1) {
    E.overT = (E.overT || 0) + dt;
    if (E.overT > 1 && !E.speeding) { E.speeding = true; penalize(g, 'speed' + Math.floor(g.t), 10, `超速(限速 ${lv.limit})`, true); }
  } else if (kmh < lv.limit) { E.overT = 0; E.speeding = false; }
  if (lv.requireLights && !P.lightsOn && g.t > 4) penalize(g, 'lights', 10, '夜间未开大灯');
  if (lv.time && g.timeLeft <= 0) fail(g, '超时未到达');
  if (P.s >= lv.dist) finish(g, true);
}

function checkLights(g, prevS) {
  const P = g.player;
  for (const L of g.road.lightsNear(prevS - 20, P.s + 20)) {
    const front0 = prevS + P.l / 2, front1 = P.s + P.l / 2;
    if (front0 < L.stopS && front1 >= L.stopS) {
      const st = lightState(L, g.t);
      if (st.main === 'red') {
        g.stats.redRun++;
        emit(g, 'redrun');
        if (g.exam) { penalize(g, 'red' + L.id, 100, '闯红灯'); fail(g, '闯红灯'); }
      }
    }
  }
}

function nearMisses(g) {
  const P = g.player;
  for (const c of g.cars) {
    if (c.wreck || c.kind === 'cones') continue;
    if (c.cross) {
      const rel = Math.sign(c.x - P.x);
      if (c.passed !== null && rel !== c.passed && Math.abs(c.s - P.s) - (c.w / 2 + P.l / 2) < 2.2 && c.hitCD <= 0) {
        g.stats.nearMiss++; addCombo(g, 300, '路口穿越');
      }
      c.passed = rel;
      continue;
    }
    const rel = P.s - c.s > 0;
    if (c.passed === false && rel) {
      g.stats.overtake++;
      const gap = Math.abs(P.x - c.x) - (P.w + c.w) / 2;
      if (gap < 1.0 && P.v - c.v > 4 && c.hitCD <= 0 && !c.stalled) {
        g.stats.nearMiss++;
        addCombo(g, P.v * KMH > 120 ? 180 : 100, gap < 0.45 ? '极限擦肩' : '擦肩');
      }
    }
    c.passed = rel;
  }
}

// ---------- 主步进 ----------
// inp: {throttle, brake, steer, analog, sens, cruise(m/s), signal:'L'|'R'(边沿), horn(边沿), lights(边沿)}
export function step(g, inp, dt) {
  if (g.over) return;
  dt = Math.min(dt, 1 / 20);
  g.t += dt;
  if (g.mode === 'rampage' || g.lv?.time) {
    g.timeLeft -= dt;
    if (g.mode === 'rampage' && g.timeLeft <= 0) { g.timeLeft = 0; finish(g, true, '时间到'); return; }
  }
  const prevS = g.player.s;
  updatePlayer(g, inp, dt);
  if (g.over) return;
  checkLights(g, prevS);
  spawnTraffic(g, dt);
  for (const c of g.cars) updateCar(g, c, dt);
  const P = g.player;
  for (const c of g.cars) {
    if (c.wreck) continue;
    if (Math.abs(c.s - P.s) < exS(c) + P.l / 2 && Math.abs(c.x - P.x) < exX(c) + P.w / 2) collide(g, c);
    if (g.over) return;
  }
  nearMisses(g);
  updateCoins(g);
  updatePeds(g, dt);
  if (g.over) return;
  g.stats.dist = P.s;
  if (g.exam && !g.over) examRules(g, dt);
}

export function hudInfo(g) {
  const P = g.player;
  const L = g.road.nextLightAfter(P.s + P.l / 2);
  let light = null;
  if (L && L.stopS - P.s < 700) {
    const st = lightState(L, g.t);
    light = { dist: Math.max(0, Math.round(L.stopS - P.s - P.l / 2)), state: st.main, remain: Math.ceil(st.remain) };
  }
  return {
    kmh: Math.round(P.v * KMH), hp: P.hp / g.V.hp, score: Math.round(g.score), combo: g.combo, comboT: g.comboT,
    dist: Math.round(P.s), light, signal: P.signal, lightsOn: P.lightsOn, timeLeft: g.timeLeft,
    exam: g.exam ? { points: g.exam.points, limit: g.lv.limit, dist: g.lv.dist } : null,
    coins: g.coinCount, grip: g.grip,
  };
}

// ---------- 金币 ----------
function coinSpotOk(g, s, x) {
  for (const c of g.cars) if (c.kind === 'cones' && Math.abs(c.s - s) < c.l / 2 + 4 && Math.abs(c.x - x) < 2.5) return false;
  const L = g.road.nextLightAfter(s - 30);
  return !L || Math.abs(L.s - s) > 30;
}

function updateCoins(g) {
  const P = g.player;
  if (g.exam) return;
  g.coins = g.coins.filter((c) => (c.taken ? g.t - c.takenT < 0.5 : c.s > P.s - 30));
  while (g.coinAt < P.s + 430) {
    const s0 = Math.max(g.coinAt, P.s + 260);
    const n = 5 + Math.floor(g.rand() * 4);
    let lane = Math.floor(g.rand() * LANES);
    const shift = g.rand() < 0.4 ? (lane === 0 ? 1 : lane === LANES - 1 ? -1 : g.rand() < 0.5 ? -1 : 1) : 0;
    for (let i = 0; i < n; i++) {
      // 蛇形：走到一半换一条道，引导你变道
      const t = shift ? Math.min(1, Math.max(0, (i - n / 2 + 1.5) / 3)) : 0;
      const x = laneCenter(lane) + shift * LANE_W * t;
      const s = s0 + i * 7;
      if (coinSpotOk(g, s, x)) g.coins.push({ id: g.nextId++, s, x, taken: false, takenT: 0 });
    }
    const [a, b] = g.mode === 'rampage' ? [140, 300] : g.map.coinGap;
    g.coinAt = s0 + n * 7 + a + g.rand() * (b - a);
  }
  for (const c of g.coins) {
    if (c.taken) continue;
    if (Math.abs(c.s - P.s) < P.l / 2 + 0.8 && Math.abs(c.x - P.x) < P.w / 2 + 0.9) {
      c.taken = true; c.takenT = g.t;
      g.coinCount++; g.stats.coins++;
      if (!g.exam) g.score += 50;
      emit(g, 'coin', { id: c.id, n: g.coinCount });
    }
  }
}

// ---------- 行人 ----------
const PED_COLORS = [0x2f5d9c, 0xc0392b, 0x27ae60, 0xf1c40f, 0x8e44ad, 0x34495e, 0xe67e22, 0xecf0f1, 0x16a085];

function makePed(g, kind, s, x, vs, vx) {
  const r = g.rand;
  return { id: g.nextId++, kind, s, x, vs, vx, w: 0.55, l: 0.55, v: 0, hit: null, phase: r() * 6,
    shirt: PED_COLORS[Math.floor(r() * PED_COLORS.length)], pants: r() < 0.5 ? 0x2c3e50 : 0x5d4037, h: 1.6 + r() * 0.25 };
}

function spawnWalker(g, s) {
  if (!g.map.peds || g.mode === 'rampage') return;
  const side = g.rand() < 0.5 ? -1 : 1;
  const dir = g.rand() < 0.5 ? -1 : 1;
  g.peds.push(makePed(g, 'walk', s, side * (ROAD_HALF + 1.6 + g.rand() * 2.4), dir * (1.1 + g.rand() * 0.5), 0));
}

function updatePeds(g, dt) {
  const P = g.player;
  if (!g.map.peds || g.mode === 'rampage') return;
  g.peds = g.peds.filter((p) => p.s > P.s - 120 && p.s < P.s + 520 && Math.abs(p.x) < 14 && (!p.hit || p.hit.t < 15));
  if (g.peds.filter((p) => p.kind === 'walk').length < 16) spawnWalker(g, P.s + 300 + g.rand() * 180);
  // 红灯时走斑马线过马路
  for (const L of g.road.lightsNear(P.s - 40, P.s + 380)) {
    const st = lightState(L, g.t);
    g.pedTimers[L.id] = (g.pedTimers[L.id] ?? 0) - dt;
    if (st.main === 'red' && st.remain > 7.5 && g.pedTimers[L.id] <= 0) {
      g.pedTimers[L.id] = 0.7 + g.rand() * 1.2;
      const dir = g.rand() < 0.5 ? 1 : -1;
      g.peds.push(makePed(g, 'cross', L.stopS + 2 + g.rand() * 2, -dir * 10, 0, dir * (2 + g.rand() * 0.5)));
    }
  }
  // 公路之王城市图：偶尔有人横穿马路
  if (g.mode === 'king' && !g.mods.empty && P.s + 150 > g.jayAt) {
    const dir = g.rand() < 0.5 ? 1 : -1;
    g.peds.push(makePed(g, 'jay', g.jayAt, -dir * 9.5, 0, dir * (1.7 + g.rand() * 0.6)));
    g.jayAt += 900 + g.rand() * 900;
  }
  for (const p of g.peds) {
    if (p.hit) {
      const h = p.hit;
      h.t += dt; h.y += h.vy * dt; h.vy -= 16 * dt;
      if (h.y < 0) { h.y = 0; h.vy = Math.abs(h.vy) * 0.25; p.vs *= 0.5; p.vx *= 0.5; }
      if (h.y === 0 && Math.abs(h.vy) < 0.5) { p.vs *= Math.pow(0.02, dt); p.vx *= Math.pow(0.02, dt); }
      p.s += p.vs * dt; p.x += p.vx * dt;
      h.rx += h.sx * dt * (h.y > 0 ? 1 : 0.1); h.rz += h.sz * dt * (h.y > 0 ? 1 : 0.1);
      continue;
    }
    p.phase += dt * 6;
    if (p.kind === 'walk') p.s += p.vs * dt;
    else {
      p.x += p.vx * dt;
      if (Math.abs(p.x) > 10.5) { p.kind = 'walk'; p.vx = 0; p.vs = (g.rand() < 0.5 ? -1 : 1) * 1.2; p.x = Math.sign(p.x) * (ROAD_HALF + 2); }
    }
    if (Math.abs(p.s - P.s) < P.l / 2 + p.l / 2 && Math.abs(p.x - P.x) < P.w / 2 + p.w / 2 && P.v > 0.5) hitPed(g, p);
  }
}

function hitPed(g, p) {
  const P = g.player;
  const side = Math.sign(p.x - P.x) || 1;
  p.hit = { t: 0, y: 0.2, vy: 2.5 + P.v * 0.12, rx: 0, rz: 0, sx: -6 - P.v * 0.2, sz: side * (2 + g.rand() * 3) };
  p.vs = P.v * 0.85; p.vx = side * (1 + P.v * 0.05);
  P.v *= 0.88;
  g.stats.pedHit++;
  g.combo = 0; g.comboT = 0;
  emit(g, 'ped', { id: p.id, text: g.exam ? '撞到行人' : '撞到行人！-800' });
  if (g.exam) { penalize(g, 'ped' + p.id, 100, '撞到行人'); fail(g, '撞到行人'); return; }
  g.score = Math.max(0, g.score - 800);
}
