// 养成系统：两种货币（🪙金币 / 💎钻石）、7 天签到、车手、改装、每日任务 —— 纯逻辑，改的都是 profile 对象
import { VEHICLES } from './sim.js';

export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- 签到：累计天数（断签不清零），第 7 天大奖 + 送车；7 天以后每天都按大档给 ----------
export const SIGN_TABLE = [
  { coins: 100, gems: 2 },
  { coins: 200, gems: 3 },
  { coins: 300, gems: 5 },
  { coins: 500, gems: 8 },
  { coins: 800, gems: 12 },
  { coins: 1200, gems: 18 },
  { coins: 3000, gems: 50, car: true },
];
export const SIGN_AFTER = { coins: 2000, gems: 30 };   // 第 8 天起每天
export const GIFT_CARS = ['quadri', 'stoccarda', 'sport', 'woking', 'toro', 'ninja', 'moto']; // 每逢第 7/14/21… 天按顺序送一台没有的
export const GIFT_FALLBACK_GEMS = 200;                  // 车全有了就折成钻石

export function signReward(day, owned = []) {
  const base = day <= 7 ? SIGN_TABLE[day - 1] : SIGN_AFTER;
  const r = { coins: base.coins, gems: base.gems, car: null };
  if (day % 7 === 0) {
    r.car = GIFT_CARS.find((id) => !owned.includes(id)) || null;
    if (!r.car) r.gems += GIFT_FALLBACK_GEMS;
  }
  return r;
}
export const canSign = (p, now = new Date()) => (p.sign?.last || '') !== today(now);
export function doSign(p, now = new Date()) {
  if (!canSign(p, now)) return null;
  const s = (p.sign ||= { days: 0, last: '' });
  s.days++; s.last = today(now);
  const r = signReward(s.days, p.owned);
  p.coins += r.coins; p.gems = (p.gems || 0) + r.gems;
  if (r.car) p.owned.push(r.car);
  return { day: s.days, ...r };
}

// ---------- 车手：各带一个被动加成 ----------
export const DRIVERS = {
  ajie:  { id: 'ajie',  name: '阿杰',   face: '🧑', color: '#5a8dee', title: '新手车手',   perk: '没有加成，稳稳开',          cost: null },
  xue:   { id: 'xue',   name: '小雪',   face: '👩', color: '#ff7eb6', title: '飙车女王',   perk: '极速 +6%',                cost: { coins: 800 },  tune: { maxV: 1.06 } },
  wang:  { id: 'wang',  name: '王师傅', face: '👨‍🦳', color: '#6fbf73', title: '二十年老司机', perk: '完好度 +30%，蹭车不心疼',   cost: { coins: 1200 }, tune: { hp: 1.3 } },
  pang:  { id: 'pang',  name: '小胖',   face: '🧒', color: '#ffc93c', title: '金币收集家', perk: '结算金币 +30%',            cost: { gems: 30 },    tune: { coinMul: 1.3 } },
  fei:   { id: 'fei',   name: '阿飞',   face: '😎', color: '#39c5d8', title: '擦肩之王',   perk: '擦肩 / 连击得分 +25%',       cost: { gems: 50 },    tune: { comboMul: 1.25 } },
  dayun: { id: 'dayun', name: '大运哥', face: '🧔', color: '#e07a2f', title: '大运车队长', perk: '大运狂飙多 10 秒，操控 +8%',  cost: { gems: 80 },    tune: { rampageTime: 10, steer: 1.08 } },
  lin:   { id: 'lin',   name: '林教练', face: '👩‍🏫', color: '#a77bf3', title: '驾校金牌教练', perk: '加速 +8%，驾考通关金币 +50%', cost: { gems: 120 },   tune: { accel: 1.08, examCoinMul: 1.5 } },
};

// ---------- 改装：每台车 4 项，各 5 级 ----------
export const PARTS = {
  engine: { name: '引擎', icon: '🔥', stat: '极速', per: 0.03 },
  turbo:  { name: '涡轮', icon: '🌀', stat: '加速', per: 0.06 },
  chassis:{ name: '悬挂', icon: '🛞', stat: '操控', per: 0.04 },
  armor:  { name: '车身', icon: '🛡️', stat: '耐撞', per: 0.10 },
};
export const MAX_LV = 5;
// 1~4 级花金币（越贵的车越贵），第 5 级花钻石
export function upgradeCost(vid, lv) {
  if (lv >= MAX_LV) return null;
  if (lv === MAX_LV - 1) return { gems: 20 };
  const price = VEHICLES[vid]?.price || 0;
  return { coins: Math.round(((150 + price * 0.08) * (lv + 1)) / 10) * 10 };
}
export const partLv = (p, vid, part) => p.upgrades?.[vid]?.[part] || 0;

export const afford = (p, cost) => !cost || ((p.coins >= (cost.coins || 0)) && ((p.gems || 0) >= (cost.gems || 0)));
function pay(p, cost) { p.coins -= cost.coins || 0; p.gems = (p.gems || 0) - (cost.gems || 0); }
export const costText = (c) => (c ? [c.coins ? `🪙 ${c.coins}` : '', c.gems ? `💎 ${c.gems}` : ''].filter(Boolean).join(' ') : '');

export function buyUpgrade(p, vid, part) {
  const lv = partLv(p, vid, part);
  const cost = upgradeCost(vid, lv);
  if (!cost || !afford(p, cost) || !p.owned.includes(vid)) return false;
  pay(p, cost);
  ((p.upgrades ||= {})[vid] ||= {})[part] = lv + 1;
  return true;
}
export function buyDriver(p, id) {
  const d = DRIVERS[id];
  if (!d || (p.drivers || []).includes(id) || !afford(p, d.cost)) return false;
  pay(p, d.cost);
  (p.drivers ||= ['ajie']).push(id);
  p.driver = id;
  return true;
}

// 开局时交给 sim 的加成：车手 × 改装
export function tuneFor(p, vid) {
  const d = DRIVERS[p.driver]?.tune || {};
  const u = (part) => 1 + partLv(p, vid, part) * PARTS[part].per;
  return {
    maxV: (d.maxV || 1) * u('engine'), accel: (d.accel || 1) * u('turbo'), steer: (d.steer || 1) * u('chassis'), hp: (d.hp || 1) * u('armor'),
    coinMul: d.coinMul || 1, comboMul: d.comboMul || 1, rampageTime: d.rampageTime || 0, examCoinMul: d.examCoinMul || 1,
  };
}

// ---------- 每日任务：按日期从池里挑 3 个，进度当天累计 ----------
export const TASK_POOL = [
  { id: 'km',    text: '公路之王累计跑 5 公里', need: 5000, key: 'dist',   reward: { coins: 300 } },
  { id: 'near',  text: '擦肩 20 次',          need: 20,   key: 'nearMiss', reward: { gems: 5 } },
  { id: 'coin',  text: '路上捡 30 枚金币',      need: 30,   key: 'coins',  reward: { coins: 250 } },
  { id: 'exam',  text: '通过 1 次驾考',        need: 1,    key: 'examPass', reward: { gems: 5 } },
  { id: 'smash', text: '大运狂飙创飞 15 辆',    need: 15,   key: 'smash',  reward: { coins: 300 } },
  { id: 'runs',  text: '开 3 局（任意模式）',   need: 3,    key: 'runs',   reward: { coins: 150 } },
  { id: 'combo', text: '单局打出 ×5 连击',      need: 5,    key: 'bestCombo', max: true, reward: { gems: 8 } },
];
export const ALL_DONE_BONUS = { gems: 10 };

function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
export function ensureTasks(p, now = new Date()) {
  const d = today(now);
  if (p.tasks?.date === d) return p.tasks;
  const pool = [...TASK_POOL];
  let h = hash(d);
  const ids = [];
  while (ids.length < 3) { ids.push(pool.splice(h % pool.length, 1)[0].id); h = Math.imul(h, 2654435761) >>> 3; }
  p.tasks = { date: d, ids, prog: {}, claimed: [], bonus: false };
  return p.tasks;
}
// 一局结束后记进度：run = { mode, dist, nearMiss, coins, smash, examPass, bestCombo }
export function recordRun(p, run, now = new Date()) {
  const T = ensureTasks(p, now);
  const add = { runs: 1, dist: run.mode === 'king' ? run.dist : 0, nearMiss: run.nearMiss, coins: run.coins, smash: run.mode === 'rampage' ? run.smash : 0, examPass: run.examPass ? 1 : 0 };
  for (const t of TASK_POOL) {
    if (!T.ids.includes(t.id)) continue;
    const v = t.max ? Math.max(T.prog[t.id] || 0, run[t.key] || 0) : (T.prog[t.id] || 0) + (add[t.key] || 0);
    T.prog[t.id] = Math.min(t.need, v);
  }
}
export const taskList = (p, now) => ensureTasks(p, now).ids.map((id) => {
  const t = TASK_POOL.find((x) => x.id === id), T = p.tasks;
  return { ...t, prog: T.prog[id] || 0, done: (T.prog[id] || 0) >= t.need, claimed: T.claimed.includes(id) };
});
function give(p, r) { p.coins += r.coins || 0; p.gems = (p.gems || 0) + (r.gems || 0); }
export function claimTask(p, id, now) {
  const t = taskList(p, now).find((x) => x.id === id);
  if (!t || !t.done || t.claimed) return null;
  p.tasks.claimed.push(id); give(p, t.reward);
  return t.reward;
}
export function claimBonus(p, now) {
  const L = taskList(p, now);
  if (p.tasks.bonus || !L.every((t) => t.claimed)) return null;
  p.tasks.bonus = true; give(p, ALL_DONE_BONUS);
  return ALL_DONE_BONUS;
}
export const hasTodo = (p, now) => taskList(p, now).some((t) => t.done && !t.claimed) || (!p.tasks.bonus && taskList(p, now).every((t) => t.claimed));

// ---------- 结算送钻石：驾考首次三星 +10，刷新纪录 +5，公路之王每满 5 公里 +2 ----------
export function runGems({ mode, firstThreeStar, newBest, dist, modded }) {
  if (modded) return 0;
  return (firstThreeStar ? 10 : 0) + (newBest ? 5 : 0) + (mode === 'king' ? Math.floor(dist / 5000) * 2 : 0);
}
