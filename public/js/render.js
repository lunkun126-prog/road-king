// three.js 渲染层：按 100 米一块生成道路/楼房/树/路灯/红绿灯，同步 NPC 车辆，控制相机与昼夜。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROAD_HALF, LANE_W, LANES, STEP, lightState, rng } from './road.js';

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

// 返回 {group, body, tail, blinkL, blinkR, head}
export function buildVehicle(kind, color) {
  const G = new THREE.Group();
  const body = lambert(color);
  const glass = mat('glass', () => lambert(0x1b2633));
  const tail = new THREE.MeshLambertMaterial({ color: 0x550000, emissive: 0xff2020, emissiveIntensity: 0.5 });
  const blinkL = new THREE.MeshLambertMaterial({ color: 0x553300, emissive: 0xffa000, emissiveIntensity: 0 });
  const blinkR = blinkL.clone();
  const head = new THREE.MeshLambertMaterial({ color: 0xdddddd, emissive: 0xfff4c0, emissiveIntensity: 0.3 });
  const parts = { group: G, body, tail, blinkL, blinkR, head };
  let w = 1.85, l = 4.4, lampY = 0.75;
  if (kind === 'car' || kind === 'sedan' || kind === 'sport') {
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

// ---------- 世界 ----------
export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
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
      tree: lambert(0xffffff, { vertexColors: true }),
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
    const vk = game.V.id === 'truck' ? 'playertruck' : game.V.id;
    this.player = buildVehicle(vk, { sedan: 0xf4f4f0, sport: 0xffc400, moto: 0xe23b3b, truck: 0xd8342c }[game.V.id]);
    this.scene.add(this.player.group);
    this.game = game;
    this.camInit = false;
    this.finishMesh = null;
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
    // 人行道 + 地面(外沿逐渐下沉，接上远处平地)
    const side = (sg) => {
      const xs = [RW, RW + 4, RW + 4.01, RW + 60, RW + 180].map((v) => v * sg);
      const ys = [(y) => y + 0.05, (y) => y + 0.05, (y) => y, (y) => y * 0.6 - 0.5, () => -9];
      const cols = xs.map((x, i) => ({ x, y: ys[i] }));
      if (sg < 0) cols.reverse();
      const g = ribbon(road, s0, s1, cols, 10);
      const col = g.attributes.color;
      const n = cols.length;
      for (let i = 0; i < col.count; i++) {
        const k = sg < 0 ? n - 1 - (i % n) : i % n;
        const c = new THREE.Color(k < 2 ? 0xa9acae : k < 4 ? 0x7da35c : 0x6f8f5a);
        col.setXYZ(i, c.r, c.g, c.b);
      }
      G.add(new THREE.Mesh(g, this.m.ground));
    };
    side(1); side(-1);

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
    for (const sg of [-1, 1]) {
      let s = s0 + r() * 8;
      while (s < s1) {
        const bw = 10 + r() * 12;
        if (!nearLight(s + bw / 2, 22 + bw / 2)) {
          if (r() < 0.8) {
            // x=横向进深 bd，z=沿路长度 bw
            const bh = 12 + r() * r() * 70, bd = 10 + r() * 12;
            const gb = withColor(boxUV(bd, bh, bw).translate(0, bh / 2 - 1, 0), new THREE.Color().setHSL([0.08, 0.1, 0.55, 0.58, 0.5, 0.02, 0.62][Math.floor(r() * 7)] + r() * 0.03, 0.18 + r() * 0.3, 0.5 + r() * 0.25));
            const lat = sg * (RW + 12 + r() * 10 + bd / 2);
            road.at(s + bw / 2, _p);
            blds.push(placed(gb, road, s + bw / 2, lat, Math.min(0, _p.y * 0.6 - 0.5 - _p.y)));
          } else {
            for (let k = 0; k < 3; k++) {
              const th = 3 + r() * 3;
              const tg = mergeGeometries([
                withColor(new THREE.CylinderGeometry(0.2, 0.25, 1.4, 6).translate(0, 0.7, 0), 0x6b4a2f),
                withColor(new THREE.ConeGeometry(1.2 + r(), th, 7).translate(0, 1.2 + th / 2, 0), new THREE.Color().setHSL(0.28 + r() * 0.08, 0.45, 0.28 + r() * 0.12)),
              ]);
              trees.push(placed(tg, road, s + (k - 1) * 5, sg * (RW + 6 + r() * 5), 0.1));
            }
          }
        }
        s += bw + 4 + r() * 8;
      }
    }
    for (let s = Math.ceil(s0 / 45) * 45; s < s1; s += 45) {
      if (nearLight(s, 14)) continue;
      for (const sg of [-1, 1]) {
        poles.push(placed(new THREE.CylinderGeometry(0.1, 0.13, 8, 6).translate(0, 4, 0), road, s, sg * (RW + 1.2), 0));
        poles.push(placed(new THREE.BoxGeometry(2.4, 0.12, 0.12).translate(-sg * 1.1, 7.9, 0), road, s, sg * (RW + 1.2), 0));
        lamps.push(placed(new THREE.BoxGeometry(0.8, 0.18, 0.4).translate(-sg * 2.1, 7.8, 0), road, s, sg * (RW + 1.2), 0));
      }
    }
    if (blds.length) G.add(new THREE.Mesh(mergeGeometries(blds), this.m.bld));
    if (trees.length) G.add(new THREE.Mesh(mergeGeometries(trees), this.m.tree));
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
    const key = c.kind === 'cones' ? null : c.kind;
    if (c.kind === 'cones') o = buildCones(c.l);
    else if (this.pool[key]?.length) { o = this.pool[key].pop(); o.body.color.setHex(c.color); }
    else o = buildVehicle(c.kind, c.color);
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
    this.far.material.color.set(night > 0.5 ? 0x1c2618 : 0x6f8f5a);
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
    this.renderer.render(this.scene, this.camera);
  }
}
