// 游戏模拟：玩家物理、NPC 交通、红绿灯、碰撞、计分、驾考规则。纯逻辑，不碰 DOM / three.js。
import { Road, LANES, LANE_W, ROAD_HALF, laneCenter, laneOf, rng, lightState } from './road.js';

const KMH = 3.6;

export const VEHICLES = {
  sedan: { id: 'sedan', name: '小轿车', price: 0, maxV: 190 / KMH, accel: 4.6, brake: 10, mass: 1, w: 1.85, l: 4.4, hp: 100, steer: 1, armor: 1, desc: '均衡，新手友好' },
  moto: { id: 'moto', name: '摩托', price: 800, maxV: 215 / KMH, accel: 6.8, brake: 10, mass: 0.35, w: 0.8, l: 2.1, hp: 60, steer: 1.4, armor: 0.6, desc: '车身窄，能钻车缝；很脆' },
  sport: { id: 'sport', name: '跑车', price: 2000, maxV: 285 / KMH, accel: 8, brake: 12, mass: 1, w: 1.95, l: 4.5, hp: 90, steer: 1.15, armor: 0.9, desc: '极速 285，擦肩分更高' },
  truck: { id: 'truck', name: '大运重卡', price: 1500, maxV: 150 / KMH, accel: 2.9, brake: 6.5, mass: 6, w: 2.5, l: 9.5, hp: 320, steer: 0.8, armor: 4, smash: true, desc: '撞谁谁飞；刹车很长' },
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
];

export const MODE_INFO = {
  exam: { name: '驾考模式', desc: '6 关驾照考试，100 分起扣，90 分及格' },
  king: { name: '公路之王', desc: '无尽车流，弯道坡道红绿灯；擦肩连击冲榜' },
  rampage: { name: '大运狂飙', desc: '75 秒开重卡横冲直撞，创飞越多分越高' },
};

const PALETTE = [0xd94c4c, 0x3d6fd9, 0xe8e8e8, 0x2b2b2b, 0xf0c33c, 0x3fa66b, 0x8a5cc7, 0xe07a2f, 0x9aa5b1, 0x5ac8d8];

export function createGame({ mode = 'king', level = 1, vehicle = 'sedan', mods = {}, seed = Date.now() & 0xffffff } = {}) {
  const lv = mode === 'exam' ? EXAM_LEVELS[level - 1] : null;
  const vid = mode === 'rampage' ? 'truck' : vehicle;
  const V = VEHICLES[vid];
  let roadOpts;
  if (lv) roadOpts = { curves: lv.curves, hills: lv.hills ?? true, curveMax: lv.curveMax, lights: lv.lights };
  else if (mode === 'rampage') roadOpts = { curves: true, curveMax: 1 / 200, lights: null };
  else roadOpts = { curves: true, lights: { first: 450, every: [650, 1100] } };
  const g = {
    mode, level, lv, V, mods, seed,
    road: new Road(seed, roadOpts),
    rand: rng(seed ^ 0x5bd1e995),
    t: 0, over: false, result: null,
    player: { s: 0, x: laneCenter(1), v: 0, xv: 0, steer: 0, hp: V.hp, signal: null, sigOnT: -9, sigDir: 0, sigOffT: 0,
      lightsOn: !!lv?.night, lane: 1, scrapeT: 0, hornT: 0, w: V.w, l: V.l, mass: V.mass },
    cars: [], nextId: 1, crossTimers: {}, conesAt: 0,
    events: [],
    score: 0, combo: 0, comboT: 0, best: { combo: 0 },
    stats: { nearMiss: 0, overtake: 0, smash: 0, crash: 0, redRun: 0, maxKmh: 0, dist: 0 },
    exam: lv ? { points: 100, flags: {}, log: [], failed: null } : null,
    timeLeft: mode === 'rampage' ? 75 : lv?.time ?? 0,
  };
  if (mode !== 'rampage') g.player.v = 0; else g.player.v = 60 / KMH;
  fillTraffic(g);
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
  return Math.min(1.7, 0.7 + g.player.s / 9000);
}
function aggroRatio(g) {
  if (g.lv) return g.lv.aggro;
  if (g.mode === 'rampage') return 0.1;
  return Math.min(0.35, 0.08 + g.player.s / 25000);
}
function aiSpeedKmh(g) {
  if (g.lv) return [g.lv.limit * 0.7, g.lv.limit * 0.95];
  if (g.mode === 'rampage') return [50, 80];
  const up = Math.min(40, g.player.s / 250);
  return [55 + up, 90 + up];
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
  const wantCones = g.lv ? g.lv.cones : g.mode === 'king';
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
  const a0 = 2.2, b = 3.2, s0 = 2.4;
  let acc = vDes > 0.1 ? a0 * (1 - Math.pow(c.v / vDes, 4)) : -4;
  if (lead.gap < Infinity) {
    const sStar = s0 + Math.max(0, c.v * c.headway + (c.v * (c.v - lead.lv)) / (2 * Math.sqrt(a0 * b)));
    acc -= a0 * Math.pow(sStar / Math.max(lead.gap, 0.1), 2);
  }
  acc = Math.max(-9, Math.min(a0, acc));
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
  const latMax = Math.min(P.v * 0.42, 5.6) * V.steer * sens;
  const want = P.steer * latMax - k * P.v * P.v * 0.3;
  P.xv += (want - P.xv) * Math.min(1, dt * 7);
  P.x += P.xv * dt;
  // 油门/刹车
  const thr = inp.cruise && !inp.brake ? Math.max(inp.throttle || 0, P.v < inp.cruise ? 0.6 : 0) : inp.throttle || 0;
  let acc = thr * V.accel * (M.speed ? 2.2 : 1) * Math.max(0, 1 - Math.pow(P.v / maxV, 2));
  acc -= (inp.brake || 0) * V.brake;
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
  };
}
