import { createGame, step, hudInfo, VEHICLES, EXAM_LEVELS, MODE_INFO, MAPS, WEATHERS } from './sim.js';
import { laneCenter, LANES, lightState } from './road.js';
import { World } from './render.js';
import { loadModels } from './models.js';
import { Sound } from './audio.js';
import { Input } from './input.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- 存档 ----------
const DEFAULT = () => ({
  coins: 0, owned: ['sedan'], vehicle: 'sedan', exam: {}, best: { king: 0, rampage: 0 }, runs: 0, map: 'city', weather: 'clear',
  settings: { control: 'wheel', sens: 1, cam: 'fp', volume: 0.7 },
  mods: { invincible: false, speed: false, empty: false },
});
let profile = DEFAULT();
let saveTimer = 0;

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 隐私模式 */ } }

async function loadProfile() {
  let name = lsGet('rk_name');
  if (!name) { name = '车手' + Math.floor(1000 + Math.random() * 9000); lsSet('rk_name', name); }
  let p = null;
  try { const r = await fetch('/api/profile/' + encodeURIComponent(name)); if (r.ok) p = await r.json(); } catch { /* 服务不在就用本地 */ }
  if (!p) { try { p = JSON.parse(lsGet('rk_profile') || 'null'); } catch { p = null; } }
  const d = DEFAULT();
  profile = { ...d, ...(p || {}), name, settings: { ...d.settings, ...(p?.settings || {}) }, mods: { ...d.mods, ...(p?.mods || {}) }, best: { ...d.best, ...(p?.best || {}) } };
}

function saveProfile() {
  lsSet('rk_profile', JSON.stringify(profile));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/profile/' + encodeURIComponent(profile.name), { method: 'PUT', body: JSON.stringify(profile) }).catch(() => {});
  }, 400);
}

// ---------- 全局 ----------
const world = new World($('#gl'));
const sound = new Sound();
const input = new Input();
let game = null;          // 当前对局
let demo = null;          // 菜单背景自动驾驶
let state = 'menu';       // menu | brief | play | pause | result
let current = null;       // {mode, level}
let cam = 'fp';
let lastT = performance.now();
let tickT = 0;
let hintShown = false;

function show(id) {
  for (const s of $$('.screen')) s.hidden = s.id !== id;
  $('#hud').hidden = !(state === 'play' || state === 'pause' || (state === 'result' && game));
}

// ---------- 菜单演示：自动驾驶 ----------
function newDemo() {
  demo = createGame({ mode: 'king', seed: (Math.random() * 1e6) | 0 });
  demo.player.v = 70 / 3.6;
  demo.autoLane = 1;
  demo.nextLane = 6;
}

function autopilot(g) {
  const P = g.player;
  if (g.t > g.nextLane) { g.nextLane = g.t + 5 + Math.random() * 6; g.autoLane = Math.max(0, Math.min(LANES - 1, g.autoLane + (Math.random() < 0.5 ? -1 : 1))); }
  let gap = Infinity;
  for (const c of g.cars) {
    if (c.wreck) continue;
    const d = c.s - P.s;
    if (d > 0 && Math.abs(c.x - P.x) < 2.8) gap = Math.min(gap, d - (c.cross ? c.w : c.l) / 2 - P.l / 2);
  }
  const h = hudInfo(g);
  if (h.light && h.light.state !== 'green' && h.light.dist < 70) gap = Math.min(gap, h.light.dist);
  const brake = gap < (P.v * P.v) / 12 + 8 ? 1 : 0;
  const steer = Math.max(-1, Math.min(1, (laneCenter(g.autoLane) - P.x) * 0.5 - P.xv * 0.35));
  return { throttle: !brake && P.v < 80 / 3.6 ? 0.8 : 0, brake, steer, analog: true };
}

// ---------- 开局 ----------
function start(mode, level = 1) {
  current = { mode, level };
  sound.unlock();
  if (!VEHICLES[profile.vehicle]) profile.vehicle = 'sedan';
  game = createGame({ mode, level, vehicle: profile.vehicle, mods: { ...profile.mods }, seed: (Math.random() * 1e9) | 0, map: profile.map, weather: profile.weather });
  $('#mapLabel').textContent = (mode === 'king' ? game.map.name : mode === 'exam' ? '驾考路线' : '大运路线') + (game.weather.id !== 'clear' ? ' · ' + game.weather.name : '');
  $('#coinHud').hidden = mode === 'exam';
  cam = profile.settings.cam;
  state = 'play';
  show(null);
  applyControlMode();
  $('#limit').hidden = !game.lv;
  if (game.lv) $('#limit').textContent = game.lv.limit;
  $('#dash').classList.toggle('fp', cam === 'fp');
  big(mode === 'exam' ? '开始考试' : mode === 'rampage' ? '大运之力！' : 'GO!');
  if (!hintShown && !matchMedia('(pointer: coarse)').matches) {
    hintShown = true;
    const k = $('#keyhint'); k.classList.remove('gone'); k.hidden = false;
    setTimeout(() => k.classList.add('gone'), 6000);
  } else $('#keyhint').hidden = true;
}

function brief(level) {
  const lv = EXAM_LEVELS[level - 1];
  current = { mode: 'exam', level };
  $('#briefTag').textContent = `驾考 · 第 ${level} 关 · ${lv.dist} 米 · 限速 ${lv.limit}${lv.time ? ` · 限时 ${lv.time} 秒` : ''}`;
  $('#briefTitle').textContent = lv.name;
  $('#briefTip').textContent = lv.tip;
  state = 'brief';
  show('brief');
}

function toMenu() {
  game = null;
  state = 'menu';
  if (!demo) newDemo();
  refreshMenu();
  show('menu');
  sound.engine(0, 1, 0, false, false);
}

// ---------- HUD ----------
function toast(text, cls = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.textContent = text;
  const box = $('#toasts');
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.remove(), 1800);
}
function big(text) {
  const el = $('#bigText');
  el.textContent = text;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}
function hit() {
  const v = $('#vignette');
  v.classList.add('hit');
  setTimeout(() => v.classList.remove('hit'), 80);
}

let hudCache = {};
function setText(sel, v) { if (hudCache[sel] !== v) { hudCache[sel] = v; $(sel).textContent = v; } }
function setHTML(sel, v) { if (hudCache[sel] !== v) { hudCache[sel] = v; $(sel).innerHTML = v; } }

function drawHud(g) {
  const h = hudInfo(g);
  setText('#speed', String(h.kmh));
  const hp = Math.max(0, h.hp);
  const bar = $('#hpBar');
  bar.style.width = hp * 100 + '%';
  bar.style.background = hp > 0.6 ? 'var(--green)' : hp > 0.3 ? 'var(--gold)' : 'var(--red)';
  // 红绿灯导航条
  const tl = $('#nav .tl');
  if (h.light) {
    tl.dataset.s = h.light.state;
    setText('#navDist', h.light.dist + ' m');
    setText('#navSec', h.light.remain + 's');
  } else { tl.dataset.s = ''; setText('#navDist', g.lv ? `终点 ${Math.max(0, g.lv.dist - h.dist)} m` : `${(h.dist / 1000).toFixed(2)} km`); setText('#navSec', ''); }
  // 左上
  let html;
  const combo = h.combo > 1 && h.comboT > 0 ? `<div class="combo">连击 ×${h.combo}</div>` : '';
  if (g.mode === 'exam') {
    const E = h.exam;
    html = `考试分<div class="v ${E.points < 90 ? '' : 'gold'}">${E.points}</div>${g.lv.time ? `剩余 ${Math.max(0, Math.ceil(h.timeLeft))} 秒` : g.lv.name}<div class="bar"><i style="width:${Math.min(100, (h.dist / E.dist) * 100)}%"></i></div>`;
    $('#limit').classList.toggle('over', h.kmh > E.limit);
  } else if (g.mode === 'rampage') {
    html = `剩余<div class="v gold">${Math.ceil(h.timeLeft)}″</div>得分 ${h.score} · 创飞 ${g.stats.smash}${combo}`;
  } else {
    html = `得分<div class="v gold">${h.score}</div>${(h.dist / 1000).toFixed(2)} km · 擦肩 ${g.stats.nearMiss}${combo}`;
  }
  setHTML('#hudLeft', html);
  setText('#coinNum', String(h.coins));
  drawMinimap(g);
  const blink = Math.floor(g.t * 2.6) % 2 === 0;
  $('#sigL').classList.toggle('on', h.signal === 'L' && blink);
  $('#sigR').classList.toggle('on', h.signal === 'R' && blink);
  $('#bSigL').classList.toggle('on', h.signal === 'L');
  $('#bSigR').classList.toggle('on', h.signal === 'R');
  $('#bLights').classList.toggle('on', h.lightsOn);
  $('#wheel').style.transform = `rotate(${(input.touch.steerHeld || Math.abs(input.wheelAngle) > 2) ? input.wheelAngle : g.player.steer * 120}deg)`;
}

function handleEvents(g, events) {
  for (const e of events) {
    switch (e.type) {
      case 'combo': toast(e.text, 'gold'); sound.whoosh(e.combo); break;
      case 'penalty': toast(e.text, 'red'); sound.penalty(); break;
      case 'crash': hit(); sound.crash(e.impact); if (!g.exam && e.impact > 25) toast(`追尾 -${Math.round(e.dmg)} 完好度`, 'red'); break;
      case 'smash': hit(); sound.smash(); if (g.mode !== 'rampage' && g.stats.smash === 1) big('创飞！'); break;
      case 'scrape': sound.scrape(); break;
      case 'coin': { sound.coin(); const c = $('#coinHud'); c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); break; }
      case 'ped': hit(); sound.crash(20); toast(e.text, 'red'); break;
      case 'cones': sound.scrape(); break;
      case 'yield': toast(e.text, 'info'); break;
      case 'angry': toast(e.text, 'red'); break;
      case 'redrun': if (!g.exam) toast('闯红灯！小心横向来车', 'red'); break;
      case 'horn': sound.horn(g.V.id === 'truck'); break;
      case 'signal': sound.tick(); break;
      case 'over': onOver(g, e.result); break;
    }
  }
}

// ---------- 结算 ----------
async function onOver(g, R) {
  const mode = g.mode;
  profile.runs++;
  profile.coins += R.coins;
  let newBest = false;
  if (mode === 'exam') {
    const prev = profile.exam[g.level] || 0;
    if (R.stars > prev) profile.exam[g.level] = R.stars;
  } else if (!R.modded && R.score > (profile.best[mode] || 0)) { profile.best[mode] = R.score; newBest = true; }
  saveProfile();
  R.ok ? sound.win() : sound.fail();
  setTimeout(() => { if (state === 'play') showResult(g, R, newBest); }, R.ok ? 600 : 1300);
  // 上榜
  if (mode !== 'exam' && !R.modded && R.score > 0) {
    try {
      const r = await fetch('/api/leaderboard/' + mode, { method: 'POST', body: JSON.stringify({ name: profile.name, score: R.score, vehicle: g.V.name, dist: R.stats.dist, map: mode === 'king' ? g.map.name + (g.weather.id !== 'clear' ? '·' + g.weather.name : '') : '' }) });
      const j = await r.json();
      if (j.rank) { R.rank = j.rank; if (state === 'result') $('#rReward').textContent += ` · 排行榜第 ${j.rank} 名`; }
    } catch { /* 离线 */ }
  }
}

function showResult(g, R, newBest) {
  state = 'result';
  show('result');
  const card = $('#result .card');
  card.classList.toggle('fail', !R.ok);
  card.classList.toggle('win', !!R.ok);
  const S = R.stats;
  $('#rTag').textContent = g.mode === 'exam' ? `驾考 · 第 ${g.level} 关 · ${g.lv.name}` : MODE_INFO[g.mode].name + ' · ' + g.V.name;
  $('#rStars').hidden = g.mode !== 'exam';
  $('#rLog').hidden = g.mode !== 'exam' || !R.log.length;
  $('#rNext').hidden = !(g.mode === 'exam' && R.ok && g.level < EXAM_LEVELS.length);
  if (g.mode === 'exam') {
    $('#rTitle').textContent = R.ok ? '考试合格' : '不合格';
    $('#rStars').innerHTML = [1, 2, 3].map((i) => (i <= R.stars ? '<b>★</b>' : '★')).join('');
    $('#rScore').textContent = R.points + ' 分';
    $('#rLog').innerHTML = R.log.map((l) => `<li>-${l.pts} ${l.text}</li>`).join('');
    $('#rStats').innerHTML = stat('用时', S.time + 's') + stat('最高时速', Math.round(S.maxKmh)) + stat('原因', R.ok ? '顺利到达' : R.reason);
  } else {
    $('#rTitle').textContent = g.mode === 'rampage' ? (R.reason === '时间到' ? '时间到！' : '车毁了') : '车辆报废';
    $('#rScore').textContent = R.score.toLocaleString();
    $('#rStats').innerHTML = stat('里程', (S.dist / 1000).toFixed(2) + 'km') + stat('最高时速', Math.round(S.maxKmh)) +
      (g.mode === 'rampage' ? stat('创飞', S.smash) : stat('擦肩', S.nearMiss)) + stat('最高连击', '×' + S.bestCombo) + stat('捡金币', S.coins) + stat('撞行人', S.pedHit);
    if (g.mode === 'king') $('#rTag').textContent += ` · ${g.map.name}${g.weather.id !== 'clear' ? ' · ' + g.weather.name : ''}`;
  }
  $('#rReward').textContent = `+${R.coins} 金币${newBest ? ' · 新纪录！' : ''}${R.modded ? ' · MOD 成绩不上榜' : ''}${R.rank ? ` · 排行榜第 ${R.rank} 名` : ''}`;
}
const stat = (k, v) => `<div><b>${v}</b>${k}</div>`;

// ---------- 出发前：选路线 / 天气 ----------
let garageFromSetup = false;
const MAP_ICON = { city: '🏙️', highway: '🌊', mountain: '⛰️' };
const WX_NOTE = { clear: '', rain: '雨天：路面湿滑，刹车距离变长。', snow: '下雪：路面很滑！转向跟手慢、刹车距离接近翻倍。' };
function openSetup() {
  state = 'menu';
  const box = $('#mapList');
  box.innerHTML = '';
  for (const m of Object.values(MAPS)) {
    const b = document.createElement('button');
    b.className = 'map' + (profile.map === m.id ? ' sel' : '');
    b.innerHTML = `<em>${MAP_ICON[m.id]}</em><b>${m.name}</b><small>${m.desc}</small>`;
    b.onclick = () => { profile.map = m.id; saveProfile(); openSetup(); };
    box.appendChild(b);
  }
  for (const b of $$('#setupWeather button')) b.classList.toggle('on', b.dataset.v === profile.weather);
  $('#weatherNote').textContent = WX_NOTE[profile.weather] || '';
  $('#setupCar').textContent = (VEHICLES[profile.vehicle] || VEHICLES.sedan).name;
  show('setup');
}

// ---------- 小地图：以车头朝上，显示前方 ~450 米 ----------
function drawMinimap(g) {
  const cv = $('#minimap'), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  const P = g.player, road = g.road;
  const me = road.toWorld(P.s, P.x), h = road.at(P.s).h;
  const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
  const k = W / 560, oy = H * 0.72;
  const map = (wx, wz) => { const dx = wx - me.x, dz = wz - me.z; return [W / 2 + (dx * rx + dz * rz) * k, oy - (dx * fx + dz * fz) * k]; };
  const at = (s, x) => { const q = road.toWorld(s, x); return map(q.x, q.z); };
  ctx.clearRect(0, 0, W, H);
  // 路
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const [w, c] of [[Math.max(10, 18 * k * 2.2), '#5d6778'], [Math.max(6, 14 * k * 1.6), '#2f3642']]) {
    ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath();
    for (let s = P.s - 160; s <= P.s + 460; s += 10) { const [x, y] = at(s, 0); s === P.s - 160 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke();
  }
  // 路口红绿灯
  for (const L of road.lightsNear(P.s - 60, P.s + 460)) {
    const st = hudLight(L, g.t);
    const [x, y] = at(L.stopS, 0);
    ctx.fillStyle = st === 'red' ? '#ff4d4d' : st === 'yellow' ? '#ffc93c' : '#35d07f';
    ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
  }
  // 驾考终点
  if (g.lv && g.lv.dist < P.s + 460) { const [x, y] = at(g.lv.dist, 0); ctx.fillStyle = '#fff'; ctx.fillRect(x - 14, y - 3, 28, 6); }
  // 金币
  ctx.fillStyle = '#ffc93c';
  for (const c of g.coins) if (!c.taken) { const [x, y] = at(c.s, c.x); ctx.fillRect(x - 2, y - 2, 4, 4); }
  // 车
  for (const c of g.cars) {
    if (c.wreck) continue;
    const [x, y] = at(c.s, c.x);
    if (y < -10 || y > H + 10) continue;
    ctx.fillStyle = c.kind === 'cones' ? '#ff7a1a' : c.aggro ? '#ff6b6b' : c.cross ? '#ffb347' : '#dfe6ee';
    const len = c.kind === 'cones' ? c.l : c.cross ? c.w : c.l;
    ctx.fillRect(x - 3, y - (len * k) / 2 - 1, 6, len * k + 2);
  }
  // 行人
  ctx.fillStyle = '#9fd3ff';
  for (const p of g.peds) if (!p.hit && p.kind !== 'walk') { const [x, y] = at(p.s, p.x); ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill(); }
  // 自己
  ctx.fillStyle = '#ffc93c'; ctx.strokeStyle = '#3a2a00'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W / 2, oy - 12); ctx.lineTo(W / 2 - 8, oy + 9); ctx.lineTo(W / 2 + 8, oy + 9); ctx.closePath(); ctx.fill(); ctx.stroke();
}
function hudLight(L, t) { return lightState(L, t).main; }

// ---------- 菜单页 ----------
function refreshMenu() {
  $('#nameText').textContent = profile.name;
  for (const el of $$('.coinText')) el.textContent = profile.coins;
  $('#bestKing').textContent = profile.best.king ? '最佳 ' + profile.best.king : '';
  $('#bestRampage').textContent = profile.best.rampage ? '最佳 ' + profile.best.rampage : '';
  const stars = Object.values(profile.exam).reduce((a, b) => a + b, 0);
  $('#bestExam').textContent = stars ? `★ ${stars}/${EXAM_LEVELS.length * 3}` : '';
}

function renderLevels() {
  const box = $('#levelList');
  box.innerHTML = '';
  EXAM_LEVELS.forEach((lv, i) => {
    const unlocked = i === 0 || profile.exam[i] > 0;
    const st = profile.exam[lv.id] || 0;
    const b = document.createElement('button');
    b.className = 'level' + (unlocked ? '' : ' locked');
    b.innerHTML = `<small>第 ${lv.id} 关 · ${lv.dist} m · 限速 ${lv.limit}</small><b>${lv.name}</b><span class="st">${'★'.repeat(st)}${'☆'.repeat(3 - st)}</span><small>${unlocked ? lv.tip : '🔒 通过上一关解锁'}</small>`;
    if (unlocked) b.onclick = () => { sound.click(); brief(lv.id); };
    box.appendChild(b);
  });
}

const CAR_ICON = { sedan: '🚗', quadri: '🚘', stoccarda: '🏎️', sport: '🏎️', woking: '🏎️', toro: '🏎️', moto: '🏍️', ninja: '🏍️', truck: '🚛' };
function renderGarage() {
  const box = $('#carList');
  box.innerHTML = '';
  for (const v of Object.values(VEHICLES)) {
    const owned = profile.owned.includes(v.id);
    const sel = profile.vehicle === v.id;
    const el = document.createElement('div');
    el.className = 'car' + (sel ? ' sel' : '');
    const bar = (k, val) => `<div class="stat">${k}<i style="--w:${Math.round(val * 100)}%"></i></div>`;
    el.innerHTML = `<div class="ico">${CAR_ICON[v.id] || '🚗'}</div><b>${v.name}</b><span class="ref">${v.ref}</span><small>${v.desc} · 极速 ${Math.round(v.maxV * 3.6)}</small>` +
      bar('极速', v.maxV * 3.6 / 355) + bar('加速', v.accel / 10.3) + bar('操控', v.steer / 1.45) + bar('耐撞', Math.min(1, v.hp * v.armor / 400 + 0.15)) +
      `<button class="act ${owned ? '' : profile.coins >= v.price ? 'buy' : 'cant'}">${sel ? '使用中' : owned ? '选用' : `🪙 ${v.price} 购买`}</button>`;
    el.querySelector('.act').onclick = () => {
      if (owned) profile.vehicle = v.id;
      else if (profile.coins >= v.price) { profile.coins -= v.price; profile.owned.push(v.id); profile.vehicle = v.id; sound.coin(); }
      else { toast(`还差 ${v.price - profile.coins} 金币`, 'red'); return; }
      saveProfile(); renderGarage(); refreshMenu();
    };
    box.appendChild(el);
  }
}

async function renderBoard(mode) {
  for (const b of $$('.tabs button')) b.classList.toggle('on', b.dataset.board === mode);
  const box = $('#boardList');
  box.innerHTML = '<li class="empty">加载中…</li>';
  try {
    const list = await (await fetch('/api/leaderboard/' + mode)).json();
    box.innerHTML = list.length ? list.map((e) => `<li class="${e.name === profile.name ? 'me' : ''}"><span>${esc(e.name)}<small>${esc(e.vehicle || '')}${e.map ? ' · ' + esc(e.map) : ''} · ${(e.dist / 1000).toFixed(1)} km · ${e.at.slice(5, 10)}</small></span><b>${e.score.toLocaleString()}</b></li>`).join('')
      : '<li class="empty">还没有记录，去跑一把！</li>';
  } catch { box.innerHTML = '<li class="empty">排行榜要开着本地服务（npm start）</li>'; }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderSettings() {
  const S = profile.settings;
  $('#setName').value = profile.name;
  for (const b of $$('#setControl button')) b.classList.toggle('on', b.dataset.v === S.control);
  for (const b of $$('#setCam button')) b.classList.toggle('on', b.dataset.v === S.cam);
  $('#setSens').value = S.sens; $('#sensVal').textContent = S.sens.toFixed(2);
  $('#setVol').value = S.volume;
  for (const c of $$('[data-mod]')) c.checked = !!profile.mods[c.dataset.mod];
}

function applyControlMode() {
  const wheel = profile.settings.control === 'wheel';
  $('#wheel').hidden = !wheel;
  $('#steerBtns').hidden = wheel;
}

// ---------- 绑定 ----------
function bindUI() {
  document.addEventListener('pointerdown', () => sound.unlock(), { once: false });
  for (const c of $$('.mode-card')) c.onclick = () => {
    sound.unlock(); sound.click();
    const m = c.dataset.mode;
    if (m === 'exam') { renderLevels(); show('exam'); } else if (m === 'king') openSetup(); else start(m);
  };
  for (const b of $$('.menu-nav button')) b.onclick = () => {
    sound.unlock(); sound.click();
    const id = b.dataset.go;
    if (id === 'garage') renderGarage();
    if (id === 'board') renderBoard('king');
    if (id === 'settings') renderSettings();
    show(id);
  };
  for (const b of $$('.sheet .back')) b.onclick = () => { sound.click(); if (garageFromSetup && b.closest('#garage')) { garageFromSetup = false; openSetup(); } else toMenu(); };
  $('#setupGo').onclick = () => start('king');
  $('#setupBack').onclick = toMenu;
  $('#setupGarage').onclick = () => { garageFromSetup = true; renderGarage(); show('garage'); };
  for (const b of $$('#setupWeather button')) b.onclick = () => { profile.weather = b.dataset.v; saveProfile(); openSetup(); };
  $('#briefBack').onclick = () => { renderLevels(); state = 'menu'; show('exam'); };
  $('#briefGo').onclick = () => start('exam', current.level);
  $('#nameChip').onclick = () => { renderSettings(); show('settings'); setTimeout(() => $('#setName').focus(), 50); };
  for (const b of $$('.tabs button')) b.onclick = () => renderBoard(b.dataset.board);

  // 设置
  $('#setName').onchange = async (e) => {
    const n = e.target.value.replace(/[\u0000-\u001f<>"'&\\/]/g, '').trim().slice(0, 16);
    if (!n || n === profile.name) { e.target.value = profile.name; return; }
    // 新名字已有存档就读它，否则把当前进度带过去
    let other = null;
    try { const r = await fetch('/api/profile/' + encodeURIComponent(n)); if (r.ok) other = await r.json(); } catch { /* 离线 */ }
    lsSet('rk_name', n);
    if (other) { await loadProfile(); toast('已读取「' + n + '」的存档'); } else { profile.name = n; saveProfile(); }
    refreshMenu(); renderSettings();
  };
  for (const b of $$('#setControl button')) b.onclick = () => { profile.settings.control = b.dataset.v; saveProfile(); renderSettings(); applyControlMode(); };
  for (const b of $$('#setCam button')) b.onclick = () => { profile.settings.cam = b.dataset.v; saveProfile(); renderSettings(); };
  $('#setSens').oninput = (e) => { profile.settings.sens = +e.target.value; $('#sensVal').textContent = (+e.target.value).toFixed(2); saveProfile(); };
  $('#setVol').oninput = (e) => { profile.settings.volume = +e.target.value; sound.setVolume(+e.target.value); saveProfile(); };
  for (const c of $$('[data-mod]')) c.onchange = () => { profile.mods[c.dataset.mod] = c.checked; saveProfile(); };

  // HUD 控件
  input.hold($('#pGas'), 'throttle');
  input.hold($('#pBrake'), 'brake');
  input.hold($('#bLeft'), 'left');
  input.hold($('#bRight'), 'right');
  input.wheel($('#wheel'));
  input.tap($('#bSigL'), 'KeyQ');
  input.tap($('#bSigR'), 'KeyE');
  input.tap($('#bHorn'), 'KeyH');
  input.tap($('#bLights'), 'KeyL');
  input.tap($('#bCam'), 'KeyC');
  $('#btnPause').onclick = pause;
  $('#pResume').onclick = resume;
  $('#pRestart').onclick = () => start(current.mode, current.level);
  $('#pQuit').onclick = toMenu;
  $('#rRetry').onclick = () => start(current.mode, current.level);
  $('#rNext').onclick = () => brief(current.level + 1);
  $('#rMenu').onclick = toMenu;
  document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'play') pause(); });
}

function pause() { if (state !== 'play') return; state = 'pause'; show('pause'); sound.engine(0, 1, 0, false, false); }
function resume() { if (state !== 'pause') return; state = 'play'; show(null); lastT = performance.now(); }

// ---------- 主循环 ----------
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  const { inp, actions } = input.read(dt, profile.settings);
  for (const a of actions) {
    if (a === 'Escape' || a === 'KeyP') state === 'play' ? pause() : state === 'pause' && resume();
    if (a === 'KeyC' && game) { cam = cam === 'fp' ? 'tp' : 'fp'; $('#dash').classList.toggle('fp', cam === 'fp'); }
    if (a === 'KeyM') toast(sound.toggleMute() ? '已静音' : '声音已开');
    if ((a === 'Enter' || a === 'Space') && state === 'result') start(current.mode, current.level);
  }
  if (state === 'play' && game) {
    game.events.length = 0;
    // 固定步长，保证不同帧率手感一致
    let acc = dt;
    while (acc > 1e-6) {
      const h = Math.min(acc, 1 / 60);
      step(game, inp, h);
      inp.signal = inp.horn = inp.lights = undefined;
      acc -= h;
    }
    const events = game.events.slice();
    handleEvents(game, events);
    world.update(game, dt, { events, cam, braking: inp.brake > 0 });
    drawHud(game);
    sound.engine(game.player.v, game.V.maxV * (game.mods.speed ? 3.6 : 1), inp.throttle, game.V.id === 'truck', !game.over);
    if (game.player.signal) { tickT -= dt; if (tickT <= 0) { tickT = 0.38; sound.tick(); } }
  } else if (state === 'result' || state === 'pause') {
    if (game) {
      if (state === 'result') { game.events.length = 0; for (const c of game.cars) if (c.wreck) c.wreck.t += dt; }
      world.update(game, 0, { cam });
    }
  } else {
    // 菜单 / 关卡说明：背景跑演示
    if (!demo || demo.over || demo.t > 240) newDemo();
    demo.events.length = 0;
    step(demo, autopilot(demo), dt);
    world.update(demo, dt, { cam: 'tp' });
  }
}

await loadProfile();
$('#nameText').textContent = '加载车模…';
await loadModels((n, all) => { $('#nameText').textContent = `加载车模 ${n}/${all}`; });
sound.setVolume(profile.settings.volume);
bindUI();
toMenu();
window.__rk = { get game() { return game; }, get state() { return state; }, start, profile: () => profile }; // 给自动化测试用
requestAnimationFrame(frame);
