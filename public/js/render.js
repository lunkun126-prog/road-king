// three.js 渲染层：按 100 米一块生成道路/楼房/树/路灯/红绿灯，同步 NPC 车辆，控制相机与昼夜。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROAD_HALF, LANE_W, LANES, STEP, lightState, rng } from './road.js';
import { cloneModel, hasModel, treeVariants, setEnvMap, setVehicleEnvIntensity, envMaterial, instanceMaterial } from './models.js';

// 车型 → 模型 id（没有对应 glb 时 buildVehicle 退回代码画的车）
const PLAYER_MODEL = { sedan: 'sedan', quadri: 'quadri', stoccarda: 'stoccarda', sport: 'sport', woking: 'woking', toro: 'toro', moto: 'moto_r1', ninja: 'moto_zx' };
const PLAYER_KIND = { truck: 'playertruck', moto: 'moto', ninja: 'moto', sedan: 'sedan' };
const RIDER_SUIT = { moto: 0x1e4fd6, ninja: 0x2fa84f };
const NPC_MODELS = { car: ['npc_car1', 'npc_car2', 'npc_sport1', 'npc_sport2', 'npc_hatch', 'npc_wagon', 'npc_car1', 'npc_police'], van: ['npc_suv', 'npc_pickup'], bus: ['npc_bus'], truck: ['npc_truck'], moto: ['npc_moto'] };
function npcModel(c) {
  const list = (NPC_MODELS[c.kind] || []).filter(hasModel);
  return list.length ? list[c.id % list.length] : null;
}

const CH = 100; // 块长
const RW = ROAD_HALF + 0.4; // 路面半宽
const _p = {}, _q = {};

// ---------- 纹理 ----------
function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function roadTexture(plain) {
  return canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#3b3e44'; g.fillRect(0, 0, w, h);
    const r = rng(7);
    for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},${0.03 + r() * 0.05})`; g.fillRect(r() * w, r() * h, 2, 2); }
    if (plain) return;
    const px = (lat) => ((lat + RW) / (2 * RW)) * w;
    g.fillStyle = '#e9e9e2';
    const edge = (LANES * LANE_W) / 2;
    for (const lat of [-edge, edge]) g.fillRect(px(lat) - 4, 0, 8, h);
    for (let i = 1; i < LANES; i++) {
      const lat = -edge + i * LANE_W;
      g.fillRect(px(lat) - 3, 0, 6, h * 0.4); // 虚线：10 米一周期，画 4 米
    }
  });
}

function windowTexture(emissive) {
  // 一格 = 5m × 4m，中间一扇窗
  return canvasTex(256, 256, (g, w, h) => {
    const r = rng(emissive ? 3 : 4);
    g.fillStyle = emissive ? '#000' : '#fff'; g.fillRect(0, 0, w, h);
    const n = 4;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = (i / n) * w, y = (j / n) * h, cw = w / n, chh = h / n;
      if (emissive) {
        if (r() < 0.55) { g.fillStyle = r() < 0.8 ? '#ffd88a' : '#bfe3ff'; g.fillRect(x + cw * 0.18, y + chh * 0.22, cw * 0.64, chh * 0.5); }
      } else {
        g.fillStyle = r() < 0.5 ? '#2c3a4d' : '#3a4b60';
        g.fillRect(x + cw * 0.18, y + chh * 0.22, cw * 0.64, chh * 0.5);
      }
    }
  });
}

// ---------- 几何工具 ----------
function withColor(geo, color) {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

// 沿道路的条带：cols = [{x, y(yRoad)=>y, u}]
function ribbon(road, s0, s1, cols, vScale = 10, color = 0xffffff) {
  const rows = Math.max(1, Math.round((s1 - s0) / STEP));
  const pos = [], uv = [], idx = [];
  for (let r = 0; r <= rows; r++) {
    const s = s0 + ((s1 - s0) * r) / rows;
    road.at(s, _p);
    const ch = Math.cos(_p.h), sh = Math.sin(_p.h);
    for (const c of cols) {
      pos.push(_p.x + ch * c.x, c.y ? c.y(_p.y) : _p.y, _p.z + sh * c.x);
      uv.push(c.u ?? 0, s / vScale);
    }
  }
  const n = cols.length;
  for (let r = 0; r < rows; r++) for (let i = 0; i < n - 1; i++) {
    const a = r * n + i, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return withColor(g, color);
}

function placed(geo, road, s, x, y, rotY = 0) {
  road.toWorld(s, x, _q);
  geo.rotateY(-_q.h + rotY);
  geo.translate(_q.x, _q.y + y, _q.z);
  return geo;
}

function boxUV(bw, bh, bd) {
  const g = new THREE.BoxGeometry(bw, bh, bd);
  const uv = g.attributes.uv;
  // 面顺序 +x -x +y -y +z -z，每面 4 个顶点
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const i = f * 4 + k;
    if (f === 2 || f === 3) { uv.setXY(i, 0.02, 0.02); continue; }
    // 贴图一张 4×4 扇窗，一扇窗对应 5m 宽 × 4m 高
    const su = f < 2 ? bd / 20 : bw / 20;
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * (bh / 16));
  }
  return g;
}

// ---------- 场景剖面 ----------
// 每列 {d: 离路边距离, y: (路面高度)=>高度, c: 颜色}，d 从 0 往外
function sideProfile(scenery, sg, snow) {
  const W = (c, sc) => (snow ? sc : c);
  const walk = W(0xa9acae, 0xdfe4ea), grass = W(0x7da35c, 0xf1f4f7), far = W(0x6f8f5a, 0xe4e9ee);
  if (scenery === 'highway') {
    if (sg < 0) return [ // 左侧：沙滩 → 海
      { d: 0, y: (y) => y + 0.05, c: 0x8a8d90 }, { d: 2.5, y: (y) => y + 0.05, c: 0x8a8d90 },
      { d: 7, y: (y) => y - 1.2, c: W(0xd9c38f, 0xeef1f4) }, { d: 16, y: () => -5.2, c: W(0xe3cf9d, 0xe8ecef) },
      { d: 40, y: () => -6.2, c: W(0xcdb57f, 0xdfe5ea) },
    ];
    return [
      { d: 0, y: (y) => y + 0.05, c: 0x8a8d90 }, { d: 2.5, y: (y) => y + 0.05, c: 0x8a8d90 },
      { d: 2.51, y: (y) => y, c: grass }, { d: 70, y: (y) => y * 0.6 - 0.5, c: W(0x94b35e, 0xeef1f4) }, { d: 200, y: () => -9, c: far },
    ];
  }
  if (scenery === 'mountain') {
    const rock = W(0x7d7466, 0x9a9690), rockHi = W(0x8e8577, 0xf3f5f7);
    if (sg > 0) return [ // 右侧：山壁
      { d: 0, y: (y) => y + 0.05, c: 0x8d8a83 }, { d: 1.5, y: (y) => y + 0.25, c: 0x8d8a83 },
      { d: 4, y: (y) => y + 6, c: rock }, { d: 14, y: (y) => y + 22, c: rock }, { d: 45, y: (y) => y + 48, c: rockHi },
    ];
    return [ // 左侧：下坡的松林
      { d: 0, y: (y) => y + 0.05, c: 0x8d8a83 }, { d: 2, y: (y) => y, c: W(0x5f7f45, 0xeef2f5) },
      { d: 12, y: (y) => y - 9, c: W(0x4d6b3a, 0xe6ebef) }, { d: 60, y: (y) => y - 38, c: W(0x3f5a30, 0xdde3e8) }, { d: 220, y: () => -70, c: W(0x3a522c, 0xd8dfe5) },
    ];
  }
  return [
    { d: 0, y: (y) => y + 0.05, c: walk }, { d: 4, y: (y) => y + 0.05, c: walk },
    { d: 4.01, y: (y) => y, c: grass }, { d: 60, y: (y) => y * 0.6 - 0.5, c: grass }, { d: 180, y: () => -9, c: far },
  ];
}

// 剖面上离路边 d 米处的地面高度
function profileY(prof, d, y) {
  for (let i = 1; i < prof.length; i++) {
    if (d <= prof[i].d) {
      const a = prof[i - 1], b = prof[i], t = (d - a.d) / Math.max(1e-6, b.d - a.d);
      return a.y(y) + (b.y(y) - a.y(y)) * t;
    }
  }
  return prof[prof.length - 1].y(y);
}

// ---------- 树（多层松树 / 团簇阔叶树）----------
function treeGeo(r, kind, snow) {
  const parts = [];
  const trunkC = new THREE.Color(0x5b4030);
  if (kind === 'pine') {
    const h = 6 + r() * 6, rad = 1.4 + r() * 0.9;
    parts.push(withColor(new THREE.CylinderGeometry(0.18, 0.28, h * 0.35, 6).translate(0, h * 0.17, 0), trunkC));
    const tiers = 4;
    for (let i = 0; i < tiers; i++) {
      const k = i / tiers, th = h * 0.38, rr = rad * (1 - k * 0.7);
      const c = new THREE.Color().setHSL(0.3 + r() * 0.04, 0.4, 0.2 + r() * 0.06 + k * 0.04);
      if (snow) c.lerp(new THREE.Color(0xf4f7fa), 0.55 - k * 0.2);
      parts.push(withColor(new THREE.ConeGeometry(rr, th, 8).translate(0, h * 0.25 + i * h * 0.17 + th / 2, 0), c));
    }
  } else {
    const h = 3 + r() * 3;
    parts.push(withColor(new THREE.CylinderGeometry(0.16, 0.26, h, 6).translate(0, h / 2, 0), trunkC));
    const n = 4 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const rr = 1 + r() * 0.9;
      const c = new THREE.Color().setHSL(0.24 + r() * 0.08, 0.42 + r() * 0.15, 0.26 + r() * 0.12);
      if (snow) c.lerp(new THREE.Color(0xeef2f5), 0.6);
      const a = r() * 6.28, rd = i ? 0.9 + r() * 0.6 : 0;
      parts.push(withColor(new THREE.IcosahedronGeometry(rr, 0).translate(Math.cos(a) * rd, h + 0.3 + r() * 1.4, Math.sin(a) * rd), c));
    }
  }
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
}

// ---------- 车辆模型 ----------
const GEO = {};
function geo(key, make) { return GEO[key] || (GEO[key] = make()); }
const MAT = {};
function mat(key, make) { return MAT[key] || (MAT[key] = make()); }

function lambert(color, extra = {}) { return new THREE.MeshLambertMaterial({ color, ...extra }); }

function addBox(group, m, w, h, l, x, y, z) {
  const mesh = new THREE.Mesh(geo(`b${w}_${h}_${l}`, () => new THREE.BoxGeometry(w, h, l)), m);
  mesh.position.set(x, y, z);
  group.add(mesh);
  return mesh;
}

function addWheels(group, w, l, r = 0.36, n = 2) {
  const wm = mat('wheel', () => lambert(0x151515));
  const g = geo(`wh${r}`, () => new THREE.CylinderGeometry(r, r, 0.28, 12).rotateZ(Math.PI / 2));
  const zs = n === 2 ? [-l * 0.33, l * 0.33] : [-l * 0.38, -l * 0.18, l * 0.36];
  for (const z of zs) for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(g, wm); m.position.set((sx * w) / 2, r, z); group.add(m);
  }
}

// 骑手(代码画，趴在仿赛上)
function addRider(G, suit, y, z) {
  const m = lambert(suit), dark = mat('riderDark', () => lambert(0x1c1f24));
  const torso = new THREE.Mesh(geo('rtorso', () => new THREE.BoxGeometry(0.42, 0.62, 0.3)), m);
  torso.position.set(0, y + 0.42, z + 0.05); torso.rotation.x = -0.9; G.add(torso);
  const helm = new THREE.Mesh(geo('rhelm', () => new THREE.SphereGeometry(0.17, 12, 10)), m);
  helm.position.set(0, y + 0.72, z - 0.3); G.add(helm);
  const visor = new THREE.Mesh(geo('rvisor', () => new THREE.SphereGeometry(0.175, 12, 10, Math.PI * 0.6, Math.PI * 0.8, Math.PI * 0.35, Math.PI * 0.35)), mat('visor', () => lambert(0x111822)));
  visor.position.copy(helm.position); G.add(visor);
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(geo('rarm', () => new THREE.BoxGeometry(0.11, 0.11, 0.55)), m);
    arm.position.set(sx * 0.22, y + 0.5, z - 0.38); arm.rotation.x = 0.5; G.add(arm);
    const thigh = new THREE.Mesh(geo('rthigh', () => new THREE.BoxGeometry(0.15, 0.15, 0.5)), dark);
    thigh.position.set(sx * 0.2, y + 0.12, z + 0.1); thigh.rotation.x = -0.3; G.add(thigh);
    const shin = new THREE.Mesh(geo('rshin', () => new THREE.BoxGeometry(0.13, 0.45, 0.13)), dark);
    shin.position.set(sx * 0.21, y - 0.1, z + 0.38); shin.rotation.x = 0.6; G.add(shin);
  }
}

// ---------- 敞篷内饰 + 司机 ----------
function stdMat(key, color, extra = {}, envK = 0.6) {
  return mat(key, () => envMaterial(new THREE.MeshPhysicalMaterial({ color, roughness: 0.6, metalness: 0, ...extra }), envK));
}

// 两点之间的圆杆(前挡边框、手臂)：单位高圆柱，按两点摆放
const _up = new THREE.Vector3(0, 1, 0), _dir = new THREE.Vector3();
function placeRod(mesh, a, b) {
  _dir.subVectors(b, a);
  const len = _dir.length();
  mesh.position.copy(a).addScaledVector(_dir, 0.5);
  mesh.quaternion.setFromUnitVectors(_up, _dir.divideScalar(len || 1));
  mesh.scale.set(1, len, 1);
}
function rod(group, a, b, r0, r1, m) {
  const mesh = new THREE.Mesh(geo(`rod${r0}_${r1}`, () => new THREE.CylinderGeometry(r1, r0, 1, 12)), m);
  placeRod(mesh, a, b);
  group.add(mesh);
  return mesh;
}

// 座椅布局(同一车型所有实例共用)
const LAYOUT = new WeakMap();
function cabinLayout(cab) {
  if (LAYOUT.has(cab)) return LAYOUT.get(cab);
  const X0 = cab.x0 + 0.09, X1 = cab.x1 - 0.09, cw = X1 - X0;
  const dashD = Math.min(0.42, (cab.z1 - cab.z0) * 0.25);
  const seatZ = Math.min(cab.z0 + dashD + 0.72, cab.z1 - 0.34); // 前排坐垫中心
  const seatTop = cab.floorY + Math.min(0.34, (cab.cutY - cab.floorY) * 0.55);
  const L = {
    X0, X1, cw, dashD, seatZ, seatTop,
    seatX: [X0 + cw * 0.27, X0 + cw * 0.73], // 左驾右副
    seatW: Math.min(0.52, cw * 0.42),
    rearZ: seatZ + 0.95,
    wheel: new THREE.Vector3(X0 + cw * 0.27, cab.cutY + 0.07, cab.z0 + dashD + 0.1),
  };
  L.rear = L.rearZ + 0.32 < cab.z1;
  // 座椅后面：先是 0.45m 折叠软顶，再往后(溜背车会空出一大块)铺车身同色盖板
  L.back = (L.rear ? L.rearZ : L.seatZ) + 0.42;
  L.stack = Math.min(0.45, cab.z1 - L.back);
  L.deck = cab.z1 - (L.back + L.stack) > 0.1 ? [L.back + Math.max(0, L.stack), cab.z1] : null;
  LAYOUT.set(cab, L);
  return L;
}

// 内饰合成一个网格(顶点色)：地毯、仪表台、中控、前排桶椅、后排长椅、收起的软顶
const CABIN_GEO = new WeakMap();
function cabinGeometry(cab) {
  if (CABIN_GEO.has(cab)) return CABIN_GEO.get(cab);
  const L = cabinLayout(cab), parts = [];
  const box = (w, h, d, x, y, z, color, rx = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    parts.push(withColor(g.translate(x, y, z), color));
  };
  const midX = (L.X0 + L.X1) / 2, len = cab.z1 - cab.z0;
  const leather = 0x6e4630, trim = 0x1c1d20;
  box(L.cw, 0.04, len, midX, cab.floorY, (cab.z0 + cab.z1) / 2, 0x2b2c2f);                       // 地毯
  box(L.cw + 0.1, 0.2, L.dashD, midX, cab.cutY - 0.03, cab.z0 + L.dashD / 2, trim);               // 仪表台
  box(0.2, L.seatTop - cab.floorY, 0.9, midX, (L.seatTop + cab.floorY) / 2, L.seatZ - 0.2, trim); // 中控
  for (const sx of L.seatX) {
    box(L.seatW * 0.85, L.seatTop - cab.floorY - 0.1, 0.45, sx, (L.seatTop - 0.1 + cab.floorY) / 2, L.seatZ, trim);
    box(L.seatW, 0.12, 0.5, sx, L.seatTop - 0.06, L.seatZ, leather);                                 // 坐垫
    box(L.seatW, 0.5, 0.13, sx, L.seatTop + 0.24, L.seatZ + 0.3, leather, 0.18);                     // 靠背(后仰；不做头枕，免得从车后挡住司机)
  }
  if (L.rear) {
    box(L.cw * 0.94, 0.12, 0.5, midX, L.seatTop - 0.08, L.rearZ, leather);
    box(L.cw * 0.94, 0.55, 0.13, midX, L.seatTop + 0.24, L.rearZ + 0.3, leather, 0.15);
  }
  if (L.stack > 0.12) box(L.cw + 0.1, 0.13, L.stack, midX, cab.cutY - 0.02, L.back + L.stack / 2, 0x151517); // 折叠起来的软顶
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  CABIN_GEO.set(cab, g);
  return g;
}

const DECK_GEO = new WeakMap();

// 方向盘：pivot(倾斜 25°，上沿朝司机) → spin(随转向绕轴转)
function addSteeringWheel(G, L) {
  const m = stdMat('swheel', 0x141518, { roughness: 0.45 });
  const pivot = new THREE.Group();
  pivot.position.copy(L.wheel);
  pivot.rotation.x = 0.45;
  const spin = new THREE.Group();
  spin.add(new THREE.Mesh(geo('swRing', () => new THREE.TorusGeometry(0.17, 0.022, 10, 28)), m));
  const hub = new THREE.Mesh(geo('swHub', () => new THREE.CylinderGeometry(0.05, 0.05, 0.04, 16).rotateX(Math.PI / 2)), m);
  spin.add(hub);
  for (const a of [0, Math.PI, -Math.PI / 2]) {
    const s = new THREE.Mesh(geo('swSpoke', () => new THREE.BoxGeometry(0.15, 0.022, 0.018).translate(0.075, 0, 0)), m);
    s.rotation.z = a; spin.add(s);
  }
  pivot.add(spin);
  G.add(pivot);
  return { pivot, spin };
}

// 握点：方向盘 9 点 / 3 点，转向角 turn 时的车内坐标
function gripPos(L, side, turn, out) {
  const a = 0.45, R = 0.17;
  const x = side * R * Math.cos(turn), y = side * R * Math.sin(turn);
  return out.set(L.wheel.x + x, L.wheel.y + y * Math.cos(a), L.wheel.z + y * Math.sin(a));
}

// 小黄人：软胶质感的梨形身体 + 绿圈大眼 + 鼻梁鼓包 + 细线微笑；坐姿，只做腰以上会露出来的部分
const BUDDY_PROFILE = [[0, 0], [0.22, 0.005], [0.33, 0.04], [0.4, 0.12], [0.42, 0.24], [0.41, 0.34], [0.39, 0.44],
  [0.355, 0.53], [0.315, 0.61], [0.29, 0.68], [0.28, 0.75], [0.27, 0.82], [0.25, 0.88], [0.205, 0.94], [0.13, 0.985], [0, 1]];
function buddyRadius(y) {
  const P = BUDDY_PROFILE;
  for (let i = 1; i < P.length; i++) if (y <= P[i][1]) {
    const t = (y - P[i - 1][1]) / (P[i][1] - P[i - 1][1]);
    return P[i - 1][0] + (P[i][0] - P[i - 1][0]) * t;
  }
  return 0;
}
const BUDDY_DEPTH = 0.92; // 前后略扁

function buildBuddy() {
  const B = new THREE.Group();
  // 天光偏蓝，底色要比照片更暖一点，渲染出来才是奶黄色
  const skin = stdMat('buddySkin', 0xf0d664, { roughness: 0.62, sheen: 0.3, sheenColor: new THREE.Color(0xffe7a0), sheenRoughness: 0.8, clearcoat: 0.1, clearcoatRoughness: 0.6 }, 0.45);
  const body = new THREE.Mesh(geo('buddyBody', () => {
    const curve = new THREE.CatmullRomCurve3(BUDDY_PROFILE.map(([r, y]) => new THREE.Vector3(r, y, 0)));
    const pts = curve.getPoints(60).map((p) => new THREE.Vector2(Math.max(0, p.x), p.y));
    return new THREE.LatheGeometry(pts, 56).scale(1, 1, BUDDY_DEPTH);
  }), skin);
  B.add(body);
  // 脸朝 -z：θ 从正前方算起，表面点 = (r·sinθ, y, -r·cosθ·depth)
  const onSurface = (theta, y, out = 0) => {
    const r = buddyRadius(y) + out;
    return new THREE.Vector3(r * Math.sin(theta), y, -r * Math.cos(theta) * BUDDY_DEPTH);
  };
  const normalAt = (theta) => new THREE.Vector3(Math.sin(theta), 0.12, -Math.cos(theta)).normalize();
  const ringOuter = stdMat('buddyEyeRim', 0xa9c187, { roughness: 0.5 }, 0.6);
  const ring = stdMat('buddyEye', 0xc9dca6, { roughness: 0.45, clearcoat: 0.3 }, 0.7);
  const pupil = stdMat('buddyPupil', 0x0b0b0b, { roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.02 }, 1.4);
  const sph = geo('sph', () => new THREE.SphereGeometry(1, 24, 16));
  for (const side of [-1, 1]) {
    const th = side * 0.6, y = 0.79, n = normalAt(th);
    const c = onSurface(th, y, -0.012);
    const add = (m, sx, sz, push) => {
      const e = new THREE.Mesh(sph, m);
      e.position.copy(c).addScaledVector(n, push);
      e.scale.set(sx, sx, sz);
      e.lookAt(e.position.clone().add(n));
      B.add(e);
    };
    add(ringOuter, 0.088, 0.026, 0);
    add(ring, 0.077, 0.03, 0.004);
    add(pupil, 0.037, 0.02, 0.026);
  }
  // 鼻梁鼓包
  const snout = new THREE.Mesh(sph, skin);
  snout.position.copy(onSurface(0, 0.72, -0.045));
  snout.scale.set(0.075, 0.1, 0.06);
  B.add(snout);
  // 嘴：贴着脸的一道细线，两端微微上翘
  const mouth = new THREE.Mesh(geo('buddyMouth', () => {
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16 * 2 - 1, th = t * 0.42, y = 0.635 + 0.012 * t * t;
      pts.push(onSurface(th, y, 0.003));
    }
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32, 0.0045, 6);
  }), stdMat('buddyMouth', 0x4d3d2a, { roughness: 0.7 }, 0.3));
  B.add(mouth);
  B.userData.skin = skin;
  B.userData.shoulder = (side) => new THREE.Vector3(side * 0.3, 0.56, -0.03);
  B.userData.arm = [0.075, 0.055]; // 肩部/手腕粗细(身高比例)
  return B;
}

// 内饰 + 方向盘 + 司机(双手握方向盘)；返回 steer(turn) 用来每帧转方向盘、带动手臂
function addCabin(G, cab, driver) {
  const L = cabinLayout(cab);
  G.add(new THREE.Mesh(cabinGeometry(cab), stdMat('cabin', 0xffffff, { vertexColors: true, roughness: 0.7 }, 0.35)));
  if (cab.frame) {
    const fm = stdMat('wsFrame', 0x1a1c1f, { metalness: 0.6, roughness: 0.3 }, 1);
    const { tl, tr, bl, br } = cab.frame;
    rod(G, tl, tr, 0.022, 0.022, fm);
    if (bl) rod(G, bl, tl, 0.024, 0.02, fm);
    if (br) rod(G, br, tr, 0.024, 0.02, fm);
  }
  if (L.deck) {
    // 车身同色盖板：用切顶时认出的车漆材质(带涂装色)；贴图车认不出就用深色
    let paint = null;
    if (cab.paint) G.traverse((o) => { if (!paint && o.isMesh && !Array.isArray(o.material) && o.material.name === cab.paint) paint = o.material; });
    const [d0, d1] = L.deck;
    if (!DECK_GEO.has(cab)) DECK_GEO.set(cab, new THREE.BoxGeometry(L.cw + 0.12, 0.05, d1 - d0).translate((L.X0 + L.X1) / 2, cab.cutY - 0.03, (d0 + d1) / 2));
    G.add(new THREE.Mesh(DECK_GEO.get(cab), paint || stdMat('deckDark', 0x151517, { roughness: 0.8 }, 0.3)));
  }
  const wheel = addSteeringWheel(G, L);
  if (!driver) return null;
  const D = buildBuddy();
  // 小黄人按车高缩放：头顶高出窗沿 0.64m 左右，腰以上露在外面
  const k = cab.cutY + 0.64 - L.seatTop;
  D.scale.setScalar(k);
  D.position.set(L.seatX[0], L.seatTop - 0.02, L.seatZ - 0.06);
  G.add(D);
  const [r0, r1] = D.userData.arm;
  const skinMat = D.userData.skin;
  const sph = geo('sph', () => new THREE.SphereGeometry(1, 24, 16));
  const arms = [-1, 1].map((side) => {
    const arm = new THREE.Mesh(geo(`rod${r0 * k}_${r1 * k}`, () => new THREE.CylinderGeometry(r1 * k, r0 * k, 1, 14)), skinMat);
    const hand = new THREE.Mesh(sph, skinMat);
    hand.scale.setScalar(0.06 * k);
    G.add(arm, hand);
    return { side, arm, hand, shoulder: D.userData.shoulder(side).multiplyScalar(k).add(D.position) };
  });
  const grip = new THREE.Vector3();
  const steer = (turn) => {
    wheel.spin.rotation.z = -turn;
    for (const a of arms) {
      gripPos(L, a.side, -turn, grip);
      a.hand.position.copy(grip);
      placeRod(a.arm, a.shoulder, grip);
    }
  };
  steer(0);
  return { steer, driver: D };
}

// 真实车模的灯：让模型自带的尾灯/大灯材质本身发光(每辆车一份，刹车各亮各的)；
// 转向灯用叠加混合的小块贴在尾灯/大灯外侧——不亮时完全透明，只有打灯时才看得见
function useModelLamps(G, model, parts) {
  const L = model.userData.lamps || {};
  const glow = (names, emissive, key) => {
    let m = null;
    if (names?.length) model.traverse((o) => {
      if (!o.isMesh || Array.isArray(o.material) || !names.includes(o.material.name)) return;
      m ||= Object.assign(instanceMaterial(o.material), { emissive: new THREE.Color(emissive) });
      o.material = m;
    });
    parts[key] = m || new THREE.MeshLambertMaterial({ emissive }); // 认不出灯的模型：给个不上场的材质，逻辑照常设亮度
  };
  glow(L.tail, 0xff2020, 'tail');
  glow(L.head, 0xfff4c0, 'head');
  const bl = new THREE.MeshLambertMaterial({ color: 0x000000, emissive: 0xffa000, emissiveIntensity: 0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  const br = bl.clone();
  parts.blinkL = bl; parts.blinkR = br;
  const b = model.userData.box;
  const g = geo('blinker', () => new THREE.BoxGeometry(0.12, 0.1, 0.05));
  for (const [lamp, z] of [[L.tailBox, b.max.z], [L.headBox, b.min.z]]) {
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(g, sx < 0 ? bl : br);
      if (lamp) m.position.set(sx < 0 ? lamp.min.x + 0.06 : lamp.max.x - 0.06, (lamp.min.y + lamp.max.y) / 2, z < 0 ? lamp.min.z - 0.01 : lamp.max.z + 0.01);
      else m.position.set(sx * ((b.max.x - b.min.x) / 2 - 0.3), b.min.y + (b.max.y - b.min.y) * 0.38, z + Math.sign(z) * 0.01);
      G.add(m);
    }
  }
}

// 返回 {group, body, tail, blinkL, blinkR, head}；modelId 有对应 glb 时用真实模型
// opts.driver：true = 敞篷车驾驶座上坐一只小黄人
export function buildVehicle(kind, color, modelId, riderSuit, opts = {}) {
  const G = new THREE.Group();
  const body = lambert(color);
  const glass = mat('glass', () => lambert(0x1b2633));
  const tail = new THREE.MeshLambertMaterial({ color: 0x550000, emissive: 0xff2020, emissiveIntensity: 0.5 });
  const blinkL = new THREE.MeshLambertMaterial({ color: 0x553300, emissive: 0xffa000, emissiveIntensity: 0 });
  const blinkR = blinkL.clone();
  const head = new THREE.MeshLambertMaterial({ color: 0xdddddd, emissive: 0xfff4c0, emissiveIntensity: 0.3 });
  const parts = { group: G, body, tail, blinkL, blinkR, head };
  let w = 1.85, l = 4.4, lampY = 0.75;
  const model = modelId ? cloneModel(modelId, color) : null;
  if (model) {
    G.add(model);
    const b = model.userData.box;
    w = b.max.x - b.min.x; l = b.max.z - b.min.z;
    const h = b.max.y - b.min.y;
    lampY = b.min.y + h * (kind === 'moto' ? 0.5 : 0.38);
    parts.model = true;
    if (kind === 'moto') {
      if (riderSuit != null) addRider(G, riderSuit, b.min.y + h * 0.62, 0.05);
      addBox(G, tail, 0.16, 0.08, 0.04, 0, lampY, b.max.z + 0.01);
      addBox(G, head, 0.18, 0.12, 0.04, 0, lampY + 0.1, b.min.z - 0.01);
      addBox(G, blinkL, 0.06, 0.06, 0.04, -0.14, lampY, b.max.z + 0.01);
      addBox(G, blinkR, 0.06, 0.06, 0.04, 0.14, lampY, b.max.z + 0.01);
      return parts;
    }
    if (model.userData.cabin) {
      const c = addCabin(G, model.userData.cabin, opts.driver);
      if (c) parts.steer = c.steer;
    }
    useModelLamps(G, model, parts);
    return parts;
  } else if (kind === 'car' || kind === 'sedan' || kind === 'sport') {
    const low = kind === 'sport';
    w = low ? 1.95 : 1.85; l = low ? 4.5 : 4.4;
    addBox(G, body, w, low ? 0.55 : 0.7, l, 0, low ? 0.5 : 0.62, 0);
    addBox(G, glass, w * 0.84, low ? 0.42 : 0.55, l * (low ? 0.42 : 0.5), 0, low ? 1.0 : 1.22, l * 0.06);
    addBox(G, body, w * 0.86, 0.06, l * (low ? 0.42 : 0.5), 0, low ? 1.24 : 1.52, l * 0.06);
    if (low) addBox(G, mat('wing', () => lambert(0x111111)), w, 0.08, 0.4, 0, 1.05, l * 0.47);
    addWheels(G, w, l);
    lampY = low ? 0.6 : 0.72;
  } else if (kind === 'van') {
    w = 2.0; l = 5.2;
    addBox(G, body, w, 1.6, l, 0, 1.15, 0.2);
    addBox(G, glass, w * 0.9, 0.6, 0.9, 0, 1.4, -l / 2 + 0.2);
    addWheels(G, w, l);
    lampY = 0.8;
  } else if (kind === 'bus') {
    w = 2.5; l = 11;
    addBox(G, body, w, 2.6, l, 0, 1.7, 0);
    addBox(G, glass, w + 0.02, 0.8, l * 0.9, 0, 2.2, 0);
    addWheels(G, w, l, 0.5);
    lampY = 0.9;
  } else if (kind === 'truck') {
    w = 2.5; l = 9;
    addBox(G, mat('cargo', () => lambert(0xdde3ea)), w, 2.8, l * 0.72, 0, 2.0, l * 0.13);
    addBox(G, body, w, 2.1, l * 0.24, 0, 1.55, -l * 0.37);
    addBox(G, glass, w * 0.9, 0.7, 0.1, 0, 2.05, -l / 2 - 0.02);
    addWheels(G, w, l, 0.5, 3);
    lampY = 0.9;
  } else if (kind === 'playertruck') {
    // 大运：红车头 + 蓝白货箱
    w = 2.5; l = 9.5;
    addBox(G, mat('cargo2', () => lambert(0x2f6fd6)), w, 3.0, l * 0.7, 0, 2.1, l * 0.15);
    addBox(G, mat('stripe', () => lambert(0xffffff)), w + 0.02, 0.35, l * 0.7, 0, 1.6, l * 0.15);
    addBox(G, body, w, 2.3, l * 0.27, 0, 1.65, -l * 0.36);
    addBox(G, glass, w * 0.9, 0.8, 0.1, 0, 2.2, -l / 2 - 0.02);
    addBox(G, mat('chrome', () => lambert(0xc9ccd1)), w * 0.8, 0.5, 0.1, 0, 0.9, -l / 2 - 0.03);
    addWheels(G, w, l, 0.55, 3);
    lampY = 0.95;
  } else if (kind === 'moto') {
    w = 0.8; l = 2.1;
    addBox(G, body, 0.4, 0.5, 1.6, 0, 0.7, 0);
    addBox(G, mat('rider', () => lambert(0x333a44)), 0.5, 0.7, 0.45, 0, 1.3, 0.15);
    const helm = new THREE.Mesh(geo('helm', () => new THREE.SphereGeometry(0.2, 10, 8)), body);
    helm.position.set(0, 1.8, 0.05); G.add(helm);
    const wg = geo('mw', () => new THREE.CylinderGeometry(0.32, 0.32, 0.12, 12).rotateZ(Math.PI / 2));
    for (const z of [-0.75, 0.75]) { const m = new THREE.Mesh(wg, mat('wheel', () => lambert(0x151515))); m.position.set(0, 0.32, z); G.add(m); }
    addBox(G, tail, 0.2, 0.1, 0.05, 0, 0.9, l / 2 - 0.2);
    addBox(G, head, 0.2, 0.15, 0.05, 0, 1.0, -l / 2 + 0.2);
    addBox(G, blinkL, 0.08, 0.08, 0.05, -0.25, 0.9, l / 2 - 0.2);
    addBox(G, blinkR, 0.08, 0.08, 0.05, 0.25, 0.9, l / 2 - 0.2);
    return parts;
  }
  // 灯组：车尾 +z，车头 -z
  for (const sx of [-1, 1]) {
    addBox(G, tail, 0.36, 0.16, 0.05, sx * (w / 2 - 0.3), lampY, l / 2 + 0.01);
    addBox(G, head, 0.36, 0.16, 0.05, sx * (w / 2 - 0.3), lampY, -l / 2 - 0.01);
    const bm = sx < 0 ? blinkL : blinkR;
    addBox(G, bm, 0.14, 0.14, 0.06, sx * (w / 2 - 0.05), lampY, l / 2 + 0.02);
    addBox(G, bm, 0.14, 0.14, 0.06, sx * (w / 2 - 0.05), lampY, -l / 2 - 0.02);
  }
  return parts;
}

function buildPed(p) {
  const mid = ['ped_man', 'ped_woman'].filter(hasModel)[p.id % 2] || ['ped_man', 'ped_woman'].find(hasModel);
  const model = mid ? cloneModel(mid) : null;
  if (model) {
    const G = new THREE.Group();
    const k = p.h / 1.7;
    model.scale.setScalar(k);
    G.add(model);
    let mixer = null;
    if (model.userData.anim) {
      mixer = new THREE.AnimationMixer(model);
      const act = mixer.clipAction(model.userData.anim);
      act.play();
      act.time = Math.random() * act.getClip().duration;
    }
    return { group: G, mixer };
  }
  const G = new THREE.Group();
  const s = p.h / 1.7;
  const skin = mat('skin', () => lambert(0xe0b594));
  const shirt = lambert(p.shirt), pants = lambert(p.pants);
  const limb = (m, w, h, x, y) => {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(geo(`limb${w}_${h}`, () => new THREE.BoxGeometry(w, h, w).translate(0, -h / 2, 0)), m);
    pivot.add(mesh); G.add(pivot); return pivot;
  };
  const legL = limb(pants, 0.16 * s, 0.85 * s, -0.1 * s, 0.85 * s), legR = limb(pants, 0.16 * s, 0.85 * s, 0.1 * s, 0.85 * s);
  const torso = new THREE.Mesh(geo('torso' + s.toFixed(2), () => new THREE.BoxGeometry(0.42 * s, 0.62 * s, 0.24 * s)), shirt);
  torso.position.y = 1.16 * s; G.add(torso);
  const armL = limb(shirt, 0.12 * s, 0.62 * s, -0.28 * s, 1.44 * s), armR = limb(shirt, 0.12 * s, 0.62 * s, 0.28 * s, 1.44 * s);
  const head = new THREE.Mesh(geo('head', () => new THREE.SphereGeometry(0.13, 10, 8)), skin);
  head.position.y = 1.62 * s; head.scale.setScalar(s); G.add(head);
  const hair = new THREE.Mesh(geo('hair', () => new THREE.SphereGeometry(0.135, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)), mat('hairM', () => lambert(0x2b1d14)));
  hair.position.y = 1.64 * s; hair.scale.setScalar(s); G.add(hair);
  return { group: G, legL, legR, armL, armR };
}

function buildCones(len) {
  const G = new THREE.Group();
  const cm = mat('cone', () => lambert(0xff6a00));
  const g = geo('cone', () => new THREE.ConeGeometry(0.28, 0.75, 10).translate(0, 0.375, 0));
  const cones = [];
  for (let z = -len / 2; z <= len / 2; z += 3.2) for (const x of [-1.2, 1.2]) {
    const m = new THREE.Mesh(g, cm);
    m.position.set(x, 0, z);
    G.add(m);
    cones.push({ m, vx: 0, vy: 0, vz: 0, flying: false, x0: x, z0: z });
  }
  // 箭头牌
  const sign = new THREE.Mesh(geo('sign', () => new THREE.BoxGeometry(2.2, 1.2, 0.1)), mat('signm', () => new THREE.MeshLambertMaterial({ color: 0x222222, emissive: 0xffc000, emissiveIntensity: 0.6 })));
  sign.position.set(0, 1.3, len / 2);
  G.add(sign);
  return { group: G, cones, sign };
}

// 车漆/玻璃反光用的户外环境：天空渐变 + 地面 + 一颗很亮的太阳，预滤波成 PMREM
function skyEnvMap(renderer) {
  const s = new THREE.Scene();
  const R = 50, g = new THREE.SphereGeometry(R, 48, 24);
  const top = new THREE.Color(0x7fb8ea), hor = new THREE.Color(0xf4f7fa), gnd = new THREE.Color(0x55584f);
  const p = g.attributes.position, col = [], c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / R;
    if (y >= 0) c.copy(hor).lerp(top, Math.pow(y, 0.55));
    else c.copy(hor).lerp(gnd, Math.min(1, -y * 5));
    col.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  s.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sun = new THREE.Mesh(new THREE.SphereGeometry(3.5, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.97, 0.9).multiplyScalar(12) }));
  sun.position.set(28, 36, 18);
  s.add(sun);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(s, 0.015).texture;
  pm.dispose();
  return tex;
}

// ---------- 世界 ----------
export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    setEnvMap(skyEnvMap(this.renderer)); // 须在 loadModels 之前：车材质建好时就挂上
    this.envK = -1;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1200);
    this.scene.fog = new THREE.Fog(0x9fd3f0, 60, 420);
    this.hemi = new THREE.HemisphereLight(0xdfefff, 0x4a5a3a, 1.0);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.2);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.head = new THREE.SpotLight(0xfff2cc, 0, 110, 0.62, 0.45, 1);
    this.scene.add(this.head, this.head.target);

    this.tex = { road: roadTexture(false), plain: roadTexture(true), win: windowTexture(false), winE: windowTexture(true) };
    this.m = {
      road: lambert(0xffffff, { map: this.tex.road }),
      plain: lambert(0xffffff, { map: this.tex.plain, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      ground: lambert(0xffffff, { vertexColors: true }),
      rail: lambert(0xb9c0c8, { side: THREE.DoubleSide }),
      bld: new THREE.MeshLambertMaterial({ map: this.tex.win, vertexColors: true, emissive: 0xffffff, emissiveMap: this.tex.winE, emissiveIntensity: 0 }),
      tree: lambert(0xffffff, { vertexColors: true, flatShading: true }),
      water: new THREE.MeshLambertMaterial({ color: 0x2c7fb8, emissive: 0x0b3a5c, emissiveIntensity: 0.35, vertexColors: true }),
      pole: lambert(0x6b737c),
      lamp: new THREE.MeshLambertMaterial({ color: 0x888888, emissive: 0xffe2a0, emissiveIntensity: 0 }),
      paint: lambert(0xf2f2ea, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      finish: lambert(0xffffff, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, map: canvasTex(64, 64, (g) => { for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#fff'; g.fillRect(i * 8, j * 8, 8, 8); } }) }),
    };
    this.chunks = new Map();
    this.cars = new Map();
    this.pool = {};
    this.lightObjs = [];
    this.shake = 0;
    this.camMode = 'fp';
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camInit = false;
    this.far = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), lambert(0x6f8f5a));
    this.far.position.y = -9;
    this.scene.add(this.far);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  reset(game) {
    for (const [, c] of this.chunks) this.disposeChunk(c);
    this.chunks.clear();
    for (const [, o] of this.cars) this.scene.remove(o.group);
    this.cars.clear();
    this.pool = {};
    this.lightObjs = [];
    if (this.player) this.scene.remove(this.player.group);
    const id = game.V.id;
    const vk = PLAYER_KIND[id] || 'sport';
    this.player = buildVehicle(vk, { sedan: 0xf4f4f0, truck: 0xd8342c }[id] ?? 0xffc400, PLAYER_MODEL[id], RIDER_SUIT[id], { driver: true });
    this.steerVis = 0;
    this.scene.add(this.player.group);
    this.game = game;
    this.camInit = false;
    this.finishMesh = null;
    this.scenery = game.mode === 'king' ? game.map.id : 'city';
    this.snow = game.weather.id === 'snow';
    this.m.road.color.set(game.weather.id === 'rain' ? 0x8e939b : this.snow ? 0xd6dbe0 : 0xffffff);
    for (const [, o] of this.coinMeshes || []) this.scene.remove(o);
    for (const [, o] of this.pedMeshes || []) this.scene.remove(o.group);
    this.coinMeshes = new Map();
    this.pedMeshes = new Map();
    this.setupWeather(game.weather.id);
  }

  setupWeather(kind) {
    if (this.precip) { this.scene.remove(this.precip); this.precip.geometry.dispose(); this.precip = null; }
    this.precipKind = kind;
    if (kind === 'clear') return;
    const n = kind === 'rain' ? 4000 : 3000;
    const pos = new Float32Array(n * (kind === 'rain' ? 6 : 3));
    for (let i = 0; i < n; i++) {
      const x = (Math.random() - 0.5) * 70, y = Math.random() * 30, z = (Math.random() - 0.5) * 70;
      if (kind === 'rain') pos.set([x, y, z, x, y - 0.7, z], i * 6); else pos.set([x, y, z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.precip = kind === 'rain'
      ? new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xaec4d8, transparent: true, opacity: 0.55 }))
      : new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0.95, depthWrite: false, map: canvasTex(32, 32, (c) => { const gr = c.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = gr; c.fillRect(0, 0, 32, 32); }, false) }));
    this.precip.frustumCulled = false;
    this.scene.add(this.precip);
  }

  updateWeather(dt, speed) {
    if (!this.precip) return;
    const a = this.precip.geometry.attributes.position, arr = a.array;
    const rain = this.precipKind === 'rain', stride = rain ? 6 : 3;
    const fall = rain ? 26 : 1.6, n = arr.length / stride, t = performance.now() / 1000;
    const c = this.camera.position;
    for (let i = 0; i < n; i++) {
      const o = i * stride;
      arr[o + 1] -= fall * dt;
      if (!rain) { arr[o] += Math.sin(t + i) * 0.6 * dt; arr[o + 2] += Math.cos(t * 0.7 + i) * 0.6 * dt; }
      // 以相机为中心的 70m 盒子里循环
      let x = arr[o] - c.x, z = arr[o + 2] - c.z, y = arr[o + 1] - c.y;
      if (y < -4) y += 30;
      if (x < -35) x += 70; if (x > 35) x -= 70; if (z < -35) z += 70; if (z > 35) z -= 70;
      arr[o] = c.x + x; arr[o + 1] = c.y + y; arr[o + 2] = c.z + z;
      if (rain) { arr[o + 3] = arr[o] - 0.02 * speed; arr[o + 4] = arr[o + 1] - 0.8; arr[o + 5] = arr[o + 2]; }
    }
    a.needsUpdate = true;
  }

  syncCoins(g, dt) {
    const seen = new Set(), t = g.t;
    for (const c of g.coins) {
      seen.add(c.id);
      let m = this.coinMeshes.get(c.id);
      if (!m) {
        m = new THREE.Mesh(geo('coin', () => new THREE.CylinderGeometry(0.42, 0.42, 0.09, 20).rotateX(Math.PI / 2)), mat('coinM', () => new THREE.MeshLambertMaterial({ color: 0xffc21a, emissive: 0x7a4f00, emissiveIntensity: 0.9 })));
        this.scene.add(m); this.coinMeshes.set(c.id, m);
      }
      g.road.toWorld(c.s, c.x, _p);
      const up = c.taken ? (t - c.takenT) * 6 : 0;
      m.position.set(_p.x, _p.y + 1 + Math.sin(t * 3 + c.id) * 0.12 + up, _p.z);
      m.rotation.y = t * 3 + c.id;
      m.scale.setScalar(c.taken ? Math.max(0.01, 1 - (t - c.takenT) * 2) : 1);
    }
    for (const [id, m] of this.coinMeshes) if (!seen.has(id)) { this.scene.remove(m); this.coinMeshes.delete(id); }
  }

  syncPeds(g, dt) {
    const seen = new Set();
    for (const p of g.peds) {
      seen.add(p.id);
      let o = this.pedMeshes.get(p.id);
      if (!o) { o = buildPed(p); this.scene.add(o.group); this.pedMeshes.set(p.id, o); }
      g.road.toWorld(p.s, p.x, _p);
      const G = o.group;
      G.position.set(_p.x, _p.y + (this.scenery === 'city' && Math.abs(p.x) > RW ? 0.05 : 0), _p.z);
      const face = p.kind === 'walk' ? (p.vs > 0 ? 0 : Math.PI) : p.vx > 0 ? -Math.PI / 2 : Math.PI / 2;
      G.rotation.set(0, -_p.h + face, 0);
      if (o.mixer) {
        if (p.hit) { G.position.y += p.hit.y; G.rotation.x = p.hit.rx; G.rotation.z = p.hit.rz; }
        else o.mixer.update(dt * (Math.abs(p.vs || p.vx) / 1.3));
        continue;
      }
      if (p.hit) {
        G.position.y += p.hit.y;
        G.rotation.x = p.hit.rx; G.rotation.z = p.hit.rz;
        o.legL.rotation.x = o.legR.rotation.x = 0.3; o.armL.rotation.x = -1.2; o.armR.rotation.x = 1.4;
      } else {
        const sw = Math.sin(p.phase) * 0.6;
        o.legL.rotation.x = sw; o.legR.rotation.x = -sw; o.armL.rotation.x = -sw * 0.8; o.armR.rotation.x = sw * 0.8;
      }
    }
    for (const [id, o] of this.pedMeshes) if (!seen.has(id)) { this.scene.remove(o.group); this.pedMeshes.delete(id); }
  }

  disposeChunk(c) {
    this.scene.remove(c.group);
    c.group.traverse((o) => { if (o.geometry && !o.userData.shared) o.geometry.dispose(); });
    this.lightObjs = this.lightObjs.filter((l) => l.chunk !== c);
  }

  buildChunk(ci) {
    const road = this.game.road, s0 = ci * CH, s1 = s0 + CH;
    const G = new THREE.Group();
    const chunk = { group: G };
    const r = rng((this.game.seed * 31 + ci * 977) >>> 0);
    const lights = road.lightsNear(s0 - 60, s1 + 60);
    const nearLight = (s, d) => lights.some((L) => Math.abs(L.s - s) < d);

    // 路面
    G.add(new THREE.Mesh(ribbon(road, s0, s1, [{ x: -RW, u: 0 }, { x: RW, u: 1 }], 10), this.m.road));
    // 路边地面：剖面随地图变化(城市人行道草地 / 高速海滩 / 盘山山壁与松林)
    const sc = this.scenery, snow = this.snow;
    const profs = {};
    for (const sg of [-1, 1]) {
      const prof = (profs[sg] = sideProfile(sc, sg, snow));
      let cols = prof.map((p) => ({ x: sg * (RW + p.d), y: p.y }));
      if (sg < 0) cols = cols.reverse();
      const g = ribbon(road, s0, s1, cols, 10);
      const col = g.attributes.color, n = cols.length, c = new THREE.Color();
      for (let i = 0; i < col.count; i++) {
        const k = sg < 0 ? n - 1 - (i % n) : i % n;
        c.set(prof[k].c); col.setXYZ(i, c.r, c.g, c.b);
      }
      G.add(new THREE.Mesh(g, this.m.ground));
    }
    if (sc === 'highway') G.add(new THREE.Mesh(ribbon(road, s0, s1, [{ x: -(RW + 700), y: () => -5.6 }, { x: -(RW + 13), y: () => -5.6 }], 40), this.m.water));
    const groundAt = (s, sg, d) => { road.at(s, _p); return profileY(profs[sg], d, _p.y) - _p.y; };

    // 护栏(路口断开)
    const runs = [];
    let a = null;
    for (let s = s0; s <= s1 + 0.01; s += STEP) {
      const gap = nearLight(s, 10);
      if (!gap && a === null) a = s;
      if ((gap || s >= s1) && a !== null) { if (s - a >= STEP) runs.push([a, s]); a = null; }
    }
    const rails = [];
    for (const [ra, rb] of runs) for (const sg of [-1, 1]) {
      const x = sg * (ROAD_HALF + 0.05);
      rails.push(ribbon(road, ra, rb, [{ x, y: (y) => y + 0.45 }, { x, y: (y) => y + 0.85 }], 10));
    }
    if (rails.length) G.add(new THREE.Mesh(mergeGeometries(rails), this.m.rail));

    // 路口：横向道路、停止线、斑马线、红绿灯龙门架
    for (const L of lights) {
      if (L.s < s0 || L.s >= s1) continue;
      road.at(L.s, _p);
      const cross = new THREE.PlaneGeometry(120, 14).rotateX(-Math.PI / 2);
      G.add(new THREE.Mesh(placed(cross, road, L.s, 0, 0.07), this.m.plain));
      const paints = [];
      paints.push(placed(new THREE.PlaneGeometry(LANES * LANE_W, 0.5).rotateX(-Math.PI / 2), road, L.stopS, 0, 0.09));
      for (let i = 0; i < 9; i++) {
        const x = -LANES * LANE_W / 2 + 0.8 + i * 1.6;
        paints.push(placed(new THREE.PlaneGeometry(0.8, 3).rotateX(-Math.PI / 2), road, L.stopS + 3, x, 0.09));
        paints.push(placed(new THREE.PlaneGeometry(0.8, 3).rotateX(-Math.PI / 2), road, L.s + 8.5, x, 0.09));
      }
      G.add(new THREE.Mesh(mergeGeometries(paints), this.m.paint));
      // 龙门架
      const poles = [];
      for (const sg of [-1, 1]) poles.push(placed(new THREE.CylinderGeometry(0.18, 0.2, 7, 8).translate(0, 3.5, 0), road, L.stopS + 1, sg * (ROAD_HALF + 1.2), 0));
      poles.push(placed(new THREE.BoxGeometry(2 * ROAD_HALF + 2.4, 0.35, 0.35).translate(0, 6.6, 0), road, L.stopS + 1, 0, 0));
      G.add(new THREE.Mesh(mergeGeometries(poles), this.m.pole));
      const mats = { red: new THREE.MeshLambertMaterial({ color: 0x330000, emissive: 0xff2a2a }), yellow: new THREE.MeshLambertMaterial({ color: 0x332200, emissive: 0xffc21a }), green: new THREE.MeshLambertMaterial({ color: 0x002a10, emissive: 0x20e070 }) };
      const housing = mat('housing', () => lambert(0x1a1a1a));
      for (let i = 0; i < LANES; i++) {
        const x = (i - (LANES - 1) / 2) * LANE_W;
        const hb = new THREE.Mesh(geo('housingG', () => new THREE.BoxGeometry(1.6, 0.6, 0.35)), housing);
        road.toWorld(L.stopS + 1, x, _q);
        hb.position.set(_q.x, _q.y + 6.1, _q.z); hb.rotation.y = -_q.h; G.add(hb);
        ['red', 'yellow', 'green'].forEach((k, j) => {
          const b = new THREE.Mesh(geo('bulb', () => new THREE.CircleGeometry(0.19, 14)), mats[k]);
          b.position.set((j - 1) * 0.5, 0, 0.18); // 灯面朝 +z，即朝向驶来的车
          hb.add(b);
        });
      }
      this.lightObjs.push({ L, mats, chunk });
    }

    // 楼房 / 树 / 路灯
    const blds = [], trees = [], poles = [], lamps = [];
    const bldP = sc === 'city' ? 0.8 : sc === 'highway' ? 0.12 : 0;
    const variants = snow ? [] : treeVariants();
    const inst = new Map(); // variant -> [Matrix4]
    const addTrees = (s, sg, d0, d1, n, kind) => {
      for (let k = 0; k < n; k++) {
        const ss = s + (r() - 0.5) * 14, d = d0 + r() * (d1 - d0);
        const kd = kind || (r() < 0.45 ? 'pine' : 'broad');
        if (kd === 'broad' && variants.length) {
          const v = variants[Math.floor(r() * variants.length)];
          road.toWorld(ss, sg * (RW + d), _q);
          const sc = 0.75 + r() * 0.5;
          const m4 = new THREE.Matrix4().compose(new THREE.Vector3(_q.x, _q.y + groundAt(ss, sg, d) - 0.1, _q.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28), new THREE.Vector3(sc, sc, sc));
          if (!inst.has(v)) inst.set(v, []);
          inst.get(v).push(m4);
        } else trees.push(placed(treeGeo(r, kd, snow), road, ss, sg * (RW + d), groundAt(ss, sg, d) - 0.1, r() * 6.28));
      }
    };
    for (const sg of [-1, 1]) {
      let s = s0 + r() * 8;
      while (s < s1) {
        const bw = 10 + r() * 12;
        if (!nearLight(s + bw / 2, 22 + bw / 2)) {
          if (sc === 'highway' && sg < 0) { if (r() < 0.25) addTrees(s, sg, 4, 7, 1, 'broad'); }
          else if (sc === 'mountain') addTrees(s, sg, sg > 0 ? 2.5 : 4, sg > 0 ? 3.5 : 40, sg > 0 ? (r() < 0.3 ? 1 : 0) : 3 + Math.floor(r() * 3), 'pine');
          else if (r() < bldP) {
            // x=横向进深 bd，z=沿路长度 bw
            const bh = sc === 'city' ? 12 + r() * r() * 70 : 6 + r() * 10, bd = 10 + r() * 12;
            const gb = withColor(boxUV(bd, bh, bw).translate(0, bh / 2 - 1, 0), new THREE.Color().setHSL([0.08, 0.1, 0.55, 0.58, 0.5, 0.02, 0.62][Math.floor(r() * 7)] + r() * 0.03, 0.18 + r() * 0.3, 0.5 + r() * 0.25));
            const d = (sc === 'city' ? 12 + r() * 10 : 30 + r() * 40) + bd / 2;
            blds.push(placed(gb, road, s + bw / 2, sg * (RW + d), groundAt(s + bw / 2, sg, d)));
          } else addTrees(s + bw / 2, sg, sc === 'city' ? 5.5 : 5, sc === 'city' ? 11 : 45, sc === 'city' ? 3 : 4);
        }
        s += bw + 4 + r() * 8;
      }
    }
    const lampGap = sc === 'city' ? 45 : sc === 'highway' ? 60 : 0;
    for (let s = lampGap ? Math.ceil(s0 / lampGap) * lampGap : s1; s < s1; s += lampGap) {
      if (nearLight(s, 14)) continue;
      for (const sg of sc === 'highway' ? [1] : [-1, 1]) {
        poles.push(placed(new THREE.CylinderGeometry(0.1, 0.13, 8, 6).translate(0, 4, 0), road, s, sg * (RW + 1.2), 0));
        poles.push(placed(new THREE.BoxGeometry(2.4, 0.12, 0.12).translate(-sg * 1.1, 7.9, 0), road, s, sg * (RW + 1.2), 0));
        lamps.push(placed(new THREE.BoxGeometry(0.8, 0.18, 0.4).translate(-sg * 2.1, 7.8, 0), road, s, sg * (RW + 1.2), 0));
      }
    }
    if (blds.length) G.add(new THREE.Mesh(mergeGeometries(blds), this.m.bld));
    if (trees.length) G.add(new THREE.Mesh(mergeGeometries(trees), this.m.tree));
    for (const [v, mats] of inst) for (const part of v.parts) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, mats.length);
      mats.forEach((m4, i) => im.setMatrixAt(i, m4));
      im.computeBoundingSphere();
      im.userData.shared = true; // 几何是模型共享的，拆块时别 dispose
      G.add(im);
    }
    if (poles.length) G.add(new THREE.Mesh(mergeGeometries(poles), this.m.pole));
    if (lamps.length) G.add(new THREE.Mesh(mergeGeometries(lamps), this.m.lamp));

    // 驾考终点线
    const lv = this.game.lv;
    if (lv && lv.dist >= s0 && lv.dist < s1) {
      G.add(new THREE.Mesh(placed(new THREE.PlaneGeometry(LANES * LANE_W, 3).rotateX(-Math.PI / 2), road, lv.dist, 0, 0.035), this.m.finish));
      const arch = [];
      for (const sg of [-1, 1]) arch.push(placed(new THREE.BoxGeometry(0.5, 6, 0.5).translate(0, 3, 0), road, lv.dist, sg * (ROAD_HALF + 0.8), 0));
      arch.push(placed(new THREE.BoxGeometry(2 * ROAD_HALF + 2, 1.2, 0.4).translate(0, 6, 0), road, lv.dist, 0, 0));
      G.add(new THREE.Mesh(mergeGeometries(arch), mat('arch', () => new THREE.MeshLambertMaterial({ color: 0x1e7a3c, emissive: 0x1e7a3c, emissiveIntensity: 0.4 }))));
    }
    this.scene.add(G);
    return chunk;
  }

  syncChunks(s) {
    const c0 = Math.floor((s - 120) / CH), c1 = Math.floor((s + 520) / CH);
    for (const [ci, c] of this.chunks) if (ci < c0 || ci > c1) { this.disposeChunk(c); this.chunks.delete(ci); }
    for (let ci = c0; ci <= c1; ci++) if (!this.chunks.has(ci)) this.chunks.set(ci, this.buildChunk(ci));
  }

  carObj(c) {
    let o = this.cars.get(c.id);
    if (o) return o;
    const mid = c.kind === 'cones' ? null : npcModel(c);
    const key = c.kind === 'cones' ? null : c.kind + ':' + (mid || '') + (mid ? ':' + c.color : '');
    if (c.kind === 'cones') o = buildCones(c.l);
    else if (this.pool[key]?.length) { o = this.pool[key].pop(); o.body.color.setHex(c.color); }
    else o = buildVehicle(c.kind, c.color, mid, c.kind === 'moto' ? 0x333a44 + (c.id % 5) * 0x221100 : null, { driver: true });
    o.kind = key;
    this.scene.add(o.group);
    this.cars.set(c.id, o);
    return o;
  }

  syncCars(g, dt) {
    const road = g.road, seen = new Set();
    const blinkOn = Math.floor(g.t * 2.6) % 2 === 0;
    for (const c of g.cars) {
      seen.add(c.id);
      const o = this.carObj(c);
      const G = o.group;
      if (c.cross) {
        road.toWorld(c.s, c.x, _p);
        G.position.set(_p.x, _p.y, _p.z);
        G.rotation.set(0, -_p.h - Math.sign(c.vx) * Math.PI / 2, 0);
      } else {
        road.toWorld(c.s, c.x, _p);
        G.position.set(_p.x, _p.y, _p.z);
        let yaw = -_p.h;
        if (c.lc && c.lc.phase === 'move') yaw -= c.lc.dir * 0.08;
        G.rotation.set(0, yaw, 0);
      }
      if (c.wreck) {
        G.position.y += c.wreck.y;
        G.rotation.x = c.wreck.rx; G.rotation.z = c.wreck.rz; G.rotation.y += c.wreck.ry;
      }
      if (o.cones) { this.animCones(o, dt); continue; }
      o.tail.emissiveIntensity = c.braking || c.stalled ? 2.2 : 0.5;
      const sig = c.lc ? c.lc.dir : 0;
      o.blinkL.emissiveIntensity = blinkOn && (sig < 0 || c.hazard) ? 2.5 : 0;
      o.blinkR.emissiveIntensity = blinkOn && (sig > 0 || c.hazard) ? 2.5 : 0;
      o.head.emissiveIntensity = 0.3 + this.night * 1.5;
    }
    for (const [id, o] of this.cars) {
      if (seen.has(id)) continue;
      this.scene.remove(o.group);
      this.cars.delete(id);
      if (o.kind && !o.cones) {
        o.group.rotation.set(0, 0, 0);
        (this.pool[o.kind] ||= []).push(o);
      }
    }
  }

  knockCones(ev) {
    const g = this.game;
    const o = this.cars.get(ev.id);
    const c = g.cars.find((x) => x.id === ev.id);
    if (!o || !c) return;
    for (const k of o.cones) {
      if (k.flying) continue;
      const ds = c.s - k.z0 - ev.s; // 锥桶的道路 s 坐标 = c.s - z(局部 +z 朝车尾)
      if (Math.abs(ds) < 3.5 && Math.abs(c.x + k.x0 - ev.x) < 2.2) {
        k.flying = true; k.vy = 3 + Math.random() * 4; k.vz = -(ev.v * 0.6 + 2); k.vx = (Math.random() - 0.5) * 6;
      }
    }
  }

  animCones(o, dt) {
    for (const k of o.cones) {
      if (!k.flying) continue;
      const m = k.m;
      k.vy -= 16 * dt;
      m.position.x += k.vx * dt; m.position.y = Math.max(0, m.position.y + k.vy * dt); m.position.z += k.vz * dt;
      m.rotation.x += 8 * dt; m.rotation.z += 5 * dt;
      if (m.position.y === 0) { k.vx *= 0.9; k.vz *= 0.9; k.vy = Math.abs(k.vy) * 0.3; }
    }
  }

  setEnv(g) {
    // night 0..1, fog 0..1
    let night = 0, fog = 0, dusk = 0;
    if (g.lv) { night = g.lv.night ? 1 : 0; fog = g.lv.fog ? 1 : 0; }
    else if (g.mode === 'rampage') { dusk = 1; night = 0.35; }
    else {
      const p = (g.player.s % 6000) / 6000;
      night = p < 0.4 ? 0 : p < 0.5 ? (p - 0.4) / 0.1 : p < 0.9 ? 1 : 1 - (p - 0.9) / 0.1;
      dusk = p > 0.35 && p < 0.55 ? 1 - Math.abs(p - 0.45) / 0.1 : 0;
      fog = p > 0.62 && p < 0.72 ? 0.5 : 0;
    }
    this.night = night;
    // 夜里车漆别再反射白天的天空；变化超过一点才重设，免得每帧遍历材质
    const envK = Math.round((1 - 0.85 * night - 0.2 * fog) * 50) / 50;
    if (envK !== this.envK) { this.envK = envK; setVehicleEnvIntensity(envK); }
    const day = new THREE.Color(0x9fd3f0), nightC = new THREE.Color(0x0c1426), duskC = new THREE.Color(0xf09a62), fogC = new THREE.Color(0xc4cad0);
    const sky = day.clone().lerp(nightC, night).lerp(duskC, dusk * 0.6);
    if (fog) sky.lerp(night > 0.5 ? new THREE.Color(0x2a2f38) : fogC, fog);
    this.scene.background = sky;
    this.scene.fog.color.copy(sky);
    this.scene.fog.near = fog ? 8 + (1 - fog) * 60 : 60 - night * 20;
    this.scene.fog.far = fog ? 70 + (1 - fog) * 300 : 430 - night * 130;
    this.hemi.intensity = 1.05 - night * 0.8;
    this.sun.intensity = 1.3 * (1 - night) + 0.05;
    this.sun.color.set(dusk > 0.3 ? 0xffc49a : 0xffffff);
    this.m.bld.emissiveIntensity = night * 1.1;
    this.m.lamp.emissiveIntensity = night * 2;
    const wx = g.weather.id;
    if (wx !== 'clear') {
      const wc = new THREE.Color(wx === 'rain' ? 0x5d6570 : 0xd5dbe2);
      if (night > 0.5) wc.multiplyScalar(0.35);
      sky.lerp(wc, 0.75);
      this.scene.background = sky; this.scene.fog.color.copy(sky);
      this.scene.fog.near = Math.min(this.scene.fog.near, 25); this.scene.fog.far = Math.min(this.scene.fog.far, wx === 'rain' ? 260 : 200);
      this.hemi.intensity *= 0.8; this.sun.intensity *= 0.35;
    }
    const farC = this.snow ? 0xe4e9ee : this.scenery === 'highway' ? 0x2c7fb8 : this.scenery === 'mountain' ? 0x3a522c : 0x6f8f5a;
    this.far.material.color.set(farC).multiplyScalar(night > 0.5 ? 0.3 : 1);
    this.far.position.y = this.scenery === 'mountain' ? -70 : this.scenery === 'highway' ? -5.8 : -9;
  }

  updateLights(g) {
    for (const o of this.lightObjs) {
      const st = lightState(o.L, g.t).main;
      for (const k of ['red', 'yellow', 'green']) o.mats[k].emissiveIntensity = st === k ? 2.2 : 0.05;
    }
  }

  update(g, dt, view = {}) {
    if (g !== this.game) this.reset(g);
    const P = g.player, road = g.road;
    this.setEnv(g);
    this.syncChunks(P.s);
    this.updateLights(g);
    this.syncCars(g, dt);
    this.syncCoins(g, dt);
    this.syncPeds(g, dt);
    for (const ev of view.events || []) {
      if (ev.type === 'crash') this.shake = Math.min(1.2, 0.3 + ev.impact / 60);
      if (ev.type === 'smash') this.shake = Math.min(1, 0.25 + ev.impact / 100);
      if (ev.type === 'scrape') this.shake = Math.max(this.shake, 0.25);
      if (ev.type === 'cones') this.knockCones(ev);
    }
    // 玩家
    const lean = Math.atan2(P.xv, Math.max(P.v, 3));
    road.toWorld(P.s, P.x, _p);
    const pg = this.player.group;
    pg.position.set(_p.x, _p.y, _p.z);
    pg.rotation.set(0, -_p.h - lean, g.V.id === 'moto' ? -P.steer * 0.35 : 0);
    if (this.player.steer) {
      // 方向盘(和握着它的手)跟着转向走，平滑一下免得抖
      this.steerVis += (P.steer * 1.9 - this.steerVis) * Math.min(1, dt * 10);
      this.player.steer(this.steerVis);
    }
    const blinkOn = Math.floor(g.t * 2.6) % 2 === 0;
    this.player.blinkL.emissiveIntensity = blinkOn && P.signal === 'L' ? 2.5 : 0;
    this.player.blinkR.emissiveIntensity = blinkOn && P.signal === 'R' ? 2.5 : 0;
    this.player.tail.emissiveIntensity = view.braking ? 2.2 : 0.5;
    this.player.head.emissiveIntensity = P.lightsOn ? 2 : 0.2;
    // 大灯
    this.head.intensity = P.lightsOn ? 150 + this.night * 450 : 0;
    road.toWorld(P.s + 1, P.x, _q);
    this.head.position.set(_q.x, _q.y + 1.2, _q.z);
    road.toWorld(P.s + 40, P.x + P.xv * 1.5, _q);
    this.head.target.position.set(_q.x, _q.y, _q.z);
    this.sun.position.set(_p.x + 60, _p.y + 120, _p.z + 40);
    this.sun.target.position.set(_p.x, _p.y, _p.z);

    // 相机
    const mode = view.cam || this.camMode;
    const fp = mode === 'fp';
    pg.visible = !fp;
    const eye = { sedan: 1.2, sport: 1.0, moto: 1.75, truck: 2.7 }[g.V.id];
    const pos = new THREE.Vector3(), look = new THREE.Vector3();
    if (fp) {
      road.toWorld(P.s - g.V.l * 0.05, P.x - (g.V.id === 'moto' ? 0 : 0.35), _q);
      pos.set(_q.x, _q.y + eye, _q.z);
      road.toWorld(P.s + 30, P.x - 0.35 + P.xv * 1.6, _q);
      look.set(_q.x, _q.y + eye * 0.85, _q.z);
    } else {
      const back = g.V.id === 'truck' ? 15 : 8;
      road.toWorld(P.s - back, P.x * 0.85, _q);
      pos.set(_q.x, Math.max(_q.y, _p.y) + (g.V.id === 'truck' ? 5.5 : 3.1), _q.z);
      road.toWorld(P.s + 14, P.x, _q);
      look.set(_q.x, _q.y + 1.2, _q.z);
    }
    if (!this.camInit || view.snap) { this.camPos.copy(pos); this.camLook.copy(look); this.camInit = true; }
    const k = fp ? 1 : 1 - Math.pow(0.0005, dt);
    this.camPos.lerp(pos, k); this.camLook.lerp(look, fp ? 1 : 1 - Math.pow(0.0001, dt));
    this.camera.position.copy(this.camPos);
    if (this.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.5;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.4;
      this.shake = Math.max(0, this.shake - dt * 2);
    }
    this.camera.lookAt(this.camLook);
    if (fp) this.camera.rotateZ(-P.steer * 0.03);
    const kmh = P.v * 3.6;
    this.camera.fov = (fp ? 66 : 62) + Math.min(24, kmh / 11);
    this.camera.updateProjectionMatrix();
    this.updateWeather(dt, P.v);
    this.far.position.x = _p.x; this.far.position.z = _p.z;
    this.renderer.render(this.scene, this.camera);
  }
}
