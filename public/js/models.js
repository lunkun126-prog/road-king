// 外部 3D 模型：读 models/manifest.json，按目标车长/高度自动缩放、贴地、车头朝 -z。
// 缺模型或加载失败时对应接口返回 null，渲染层退回代码画的车/人/树。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skinClone } from 'three/addons/utils/SkeletonUtils.js';

const TEMPLATES = {};   // id -> Group（车、人）
const TREES = {};       // id -> [{parts:[{geometry, material}]}]（每棵树一个变体，几何已烘焙好变换）
let manifest = {};

// 车漆反光用的环境贴图（World 建好渲染器后注入）；VEHICLE_MATS 记下所有车材质，昼夜切换时统一调反光强度
let ENV = null, ENV_K = 1;
const VEHICLE_MATS = new Set();
function track(mt) {
  mt.envMapIntensity = ENV_K * (mt.userData.envK ?? 1);
  VEHICLE_MATS.add(mt);
  return mt;
}
export function setEnvMap(tex) { ENV = tex; }
export function setVehicleEnvIntensity(k) {
  ENV_K = k;
  for (const mt of VEHICLE_MATS) mt.envMapIntensity = k * (mt.userData.envK ?? 1);
}
// 渲染层自己建的材质(内饰/司机)也挂上同一张环境贴图、跟着昼夜调强度
export function envMaterial(mt, k = 1) {
  mt.envMap = ENV;
  mt.userData.envK = k;
  return track(mt);
}

export async function loadModels(onProgress) {
  try {
    const r = await fetch('models/manifest.json');
    if (!r.ok) return;
    manifest = await r.json();
  } catch { return; }
  const loader = new GLTFLoader();
  const ids = Object.keys(manifest).filter((k) => !k.startsWith('_'));
  const cache = {};
  let done = 0;
  await Promise.all(ids.map(async (id) => {
    const m = manifest[id];
    try {
      cache[m.file] ||= loader.loadAsync('models/' + m.file);
      const gltf = await cache[m.file];
      if (m.split) TREES[id] = prepareTrees(gltf.scene, m);
      else TEMPLATES[id] = prepare(gltf, m);
    } catch (e) {
      console.warn('模型加载失败', id, e?.message || e);
    }
    onProgress?.(++done, ids.length);
  }));
}

function fixMaterial(mt) {
  if (!mt) return mt;
  // 没有环境贴图时高金属度会发黑
  if ('metalness' in mt && mt.metalness > 0.5 && !mt.envMap) mt.metalness = 0.35;
  if ('roughness' in mt && mt.roughness < 0.3) mt.roughness = 0.35;
  return mt;
}

// 贴图色相旋转（同一台摩托做出蓝 / 绿两种涂装）
function hueTexture(tex, deg) {
  const img = tex.image;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.filter = `hue-rotate(${deg}deg) saturate(1.15)`;
  g.drawImage(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = tex.colorSpace; t.flipY = tex.flipY; t.wrapS = tex.wrapS; t.wrapT = tex.wrapT;
  return t;
}

// ---------- 车辆材质：换成带清漆的 PBR，车漆/玻璃/橡胶分开处理 ----------
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

function isGlass(mt, m) {
  const name = mt.name || '';
  if (m.glass && new RegExp(m.glass, 'i').test(name)) return true;
  return /glass|window/i.test(name) || (mt.transparent && mt.opacity < 0.97);
}

function vehicleMaterial(src, m) {
  const p = new THREE.MeshPhysicalMaterial({
    name: src.name, map: src.map || null, normalMap: src.normalMap || null,
    emissive: src.emissive, emissiveMap: src.emissiveMap || null, emissiveIntensity: src.emissiveIntensity,
    vertexColors: src.vertexColors, envMap: ENV,
  });
  p.color.copy(src.color);
  if (isGlass(src, m)) {
    // 敞篷只剩一块前挡：做成通透的浅茶色玻璃；非敞篷车(公交/货车)车窗保持不透
    p.color.setHex(0x18222c);
    Object.assign(p, { metalness: 0, roughness: 0.04, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      opacity: m.convertible ? 0.3 : 0.88, clearcoat: 1, clearcoatRoughness: 0.02 });
    p.userData.glass = true;
    p.userData.envK = 1.3;
  } else if (/light|lamp/i.test(src.name || '')) {
    Object.assign(p, { metalness: 0, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03 });
  } else if (!src.map && lum(src.color) < 0.02) {
    // 轮胎、黑色塑料件：哑光
    Object.assign(p, { metalness: 0, roughness: 0.78 });
    p.userData.envK = 0.5;
  } else if (src.metalness > 0.6 && lum(src.color) > 0.3) {
    Object.assign(p, { metalness: 0.9, roughness: 0.22 }); // 镀铬
  } else {
    // 车漆：底色 + 一层清漆高光
    Object.assign(p, { metalness: src.map ? 0.1 : 0.35, roughness: src.map ? 0.5 : 0.38, clearcoat: src.map ? 0.5 : 1, clearcoatRoughness: 0.06 });
  }
  p.userData.vehicle = true;
  return track(p);
}

// 敞篷车厢内壁：双面渲染，背面(看到的车门/车身内侧)压暗成内饰色
function interiorShade(mt) {
  mt.side = THREE.DoubleSide;
  mt.userData.interior = true;
  mt.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>',
      '#include <color_fragment>\n\tif ( ! gl_FrontFacing ) diffuseColor.rgb *= 0.22;');
  };
  mt.customProgramCacheKey = () => 'interiorShade';
  return mt;
}

// ---------- 车灯：认出模型自带的尾灯/大灯，渲染层让它们本身发光(不再额外贴悬空的灯块) ----------
// 尾灯 = 车尾 0.7m 内、名字带 taillight/brake 或偏红的小件；大灯 = 车头 0.7m 内、名字带 head/front 或偏亮偏暖的小件
// 同一材质的所有网格都得落在灯区才算(否则发光会连带车身其它部件)；没名字可依据的还得是灯的大小
function findLamps(src, m) {
  src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src, true);
  const byMat = new Map(); // 材质名 -> {mt, boxes}
  src.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material)) return;
    const mt = o.material, name = mt.name || '';
    if (!byMat.has(name)) byMat.set(name, { mt, boxes: [] });
    byMat.get(name).boxes.push(new THREE.Box3().setFromObject(o, true));
  });
  const out = { tail: [], head: [], tailBox: null, headBox: null };
  for (const [name, { mt, boxes }] of byMat) {
    if (mt.map || mt.userData.glass || (m.tint && new RegExp(m.tint, 'i').test(name))) continue;
    const c = mt.color;
    const small = (b) => b.max.y - b.min.y < 0.35 && b.max.z - b.min.z < 0.5;
    const all = (f) => boxes.every(f);
    const atRear = all((b) => (b.min.z + b.max.z) / 2 > box.max.z - 0.7);
    const atFront = all((b) => (b.min.z + b.max.z) / 2 < box.min.z + 0.7);
    const union = () => boxes.reduce((u, b) => u.union(b), new THREE.Box3());
    // 名字不能只认 tail："detail" 里也有
    if (atRear && (/tail_?light|brake/i.test(name) || (c.r > 0.35 && c.g < 0.2 && c.b < 0.25 && all(small)))) {
      out.tail.push(name); out.tailBox = (out.tailBox || new THREE.Box3()).union(union());
    } else if (atFront && (/head|front/i.test(name) || (lum(c) > 0.25 && c.r >= c.b && all(small)))) {
      out.head.push(name); out.headBox = (out.headBox || new THREE.Box3()).union(union());
    }
  }
  return out;
}

// 每辆车单独一份材质(尾灯要各自刹车时亮)：clone 丢了 onBeforeCompile，重新挂内壁压暗，并纳入反光强度管理
export function instanceMaterial(mt) {
  const x = mt.clone();
  if (x.userData.interior) interiorShade(x);
  if (x.userData.vehicle) track(x);
  return x;
}

// ---------- 敞篷：沿窗沿水平切掉车顶/车窗，只留一块矮前挡 ----------
const COMP = ['getX', 'getY', 'getZ', 'getW'];

// 把一个网格按模板空间里的高度上限切开；limitOf(tri) 返回该三角形允许的最高 y
function sliceMesh(o, limitOf, removed, removedPts, keptPts) {
  const geom = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
  const P = geom.attributes.position, M = o.matrixWorld;
  const names = Object.keys(geom.attributes).filter((n) => !n.startsWith('skin'));
  const out = Object.fromEntries(names.map((n) => [n, []]));
  const emit = (i, j, t) => {
    for (const n of names) {
      const at = geom.attributes[n];
      for (let c = 0; c < at.itemSize; c++) {
        const x = at[COMP[c]](i);
        out[n].push(j < 0 ? x : x + (at[COMP[c]](j) - x) * t);
      }
    }
  };
  const T = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const d = [0, 0, 0], tmp = new THREE.Vector3();
  for (let f = 0; f + 2 < P.count; f += 3) {
    for (let k = 0; k < 3; k++) T[k].fromBufferAttribute(P, f + k).applyMatrix4(M);
    const { limit, tag } = limitOf(T);
    let inside = 0;
    for (let k = 0; k < 3; k++) {
      d[k] = limit - T[k].y;
      if (d[k] >= 0) inside++;
      else if (!tag) { removed.expandByPoint(T[k]); removedPts.push(T[k].clone()); }
    }
    if (inside === 0) continue;
    if (inside === 3) {
      for (let k = 0; k < 3; k++) { emit(f + k, -1, 0); if (tag) keptPts.push(T[k].clone()); }
      continue;
    }
    // 三角形跨过切面：Sutherland–Hodgman 裁成 1~2 个三角形
    const poly = [];
    for (let k = 0; k < 3; k++) {
      const kn = (k + 1) % 3;
      if (d[k] >= 0) poly.push([f + k, -1, 0, T[k].clone()]);
      if ((d[k] >= 0) !== (d[kn] >= 0)) {
        const t = d[k] / (d[k] - d[kn]);
        poly.push([f + k, f + kn, t, tmp.copy(T[k]).lerp(T[kn], t).clone()]);
      }
    }
    for (let q = 1; q + 1 < poly.length; q++) for (const v of [poly[0], poly[q], poly[q + 1]]) emit(v[0], v[1], v[2]);
    if (tag) for (const v of poly) keptPts.push(v[3]);
  }
  const g = new THREE.BufferGeometry();
  for (const n of names) g.setAttribute(n, new THREE.Float32BufferAttribute(out[n], geom.attributes[n].itemSize));
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

function makeConvertible(g, src, m) {
  g.updateMatrixWorld(true);
  const meshes = [];
  src.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const mats = (o) => (Array.isArray(o.material) ? o.material : [o.material]);
  const glassy = (o) => mats(o).some((mt) => mt.userData.glass);
  const box = new THREE.Box3().setFromObject(src, true);
  const midZ = (box.min.z + box.max.z) / 2;
  const T = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const nrm = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const faceN = () => nrm.crossVectors(e1.subVectors(T[1], T[0]), e2.subVectors(T[2], T[0])).normalize();

  // 窗沿高度：侧窗玻璃(法线朝左右)的最低点；贴图车没有独立玻璃材质，用 manifest.cut(车高比例)
  let cutY = m.cut != null ? box.min.y + m.cut * (box.max.y - box.min.y) : Infinity;
  if (m.cut == null) {
    for (const o of meshes) {
      if (!glassy(o)) continue;
      const P = o.geometry.attributes.position, idx = o.geometry.index;
      const n = idx ? idx.count : P.count;
      for (let f = 0; f + 2 < n; f += 3) {
        for (let k = 0; k < 3; k++) T[k].fromBufferAttribute(P, idx ? idx.getX(f + k) : f + k).applyMatrix4(o.matrixWorld);
        if (Math.abs(faceN().x) > 0.55) cutY = Math.min(cutY, T[0].y, T[1].y, T[2].y);
      }
    }
  }
  if (!Number.isFinite(cutY)) return null;
  cutY += m.cutAdj || 0;
  const wsTop = cutY + (m.ws ?? 0.4);

  const removed = new THREE.Box3(), removedPts = [], wsPts = [];
  const cutCount = new Map(); // 材质名 -> 被切掉的顶点数：切得最多的(车顶)就是车漆
  for (const o of meshes) {
    const glass = glassy(o);
    const before = removedPts.length;
    // 玻璃里朝前(-z)、在车身前半段的三角形 = 前挡风，留到 wsTop；其余一律切到窗沿
    const limitOf = (tri) => {
      if (glass) {
        tri.forEach((v, k) => T[k].copy(v));
        const cz = (tri[0].z + tri[1].z + tri[2].z) / 3;
        if (Math.abs(faceN().z) > 0.3 && cz < midZ) return { limit: wsTop, tag: true }; // 有的模型法线朝里，只看朝向不看正负
      }
      return { limit: cutY, tag: false };
    };
    const geom = sliceMesh(o, limitOf, removed, removedPts, wsPts);
    const mt0 = mats(o)[0];
    if (!glass && mt0 && !mt0.map) cutCount.set(mt0.name, (cutCount.get(mt0.name) || 0) + removedPts.length - before);
    if (!geom.attributes.position.count) { o.removeFromParent(); continue; }
    o.geometry = geom;
    if (!glass) o.material = Array.isArray(o.material) ? o.material.map(interiorShade) : interiorShade(o.material);
  }
  if (removed.isEmpty()) return null;

  // 前挡边框：上沿左右两端 + 窗沿处左右两端；车厢前沿 = 前挡在窗沿高度处的位置
  // (前挡根部常比侧窗沿低，所以立柱从窗沿高度起，不从玻璃最低点起)
  let frame = null;
  const low = wsPts.filter((p) => Math.abs(p.y - cutY) < 0.08);
  if (wsPts.length) {
    const wsMax = Math.max(...wsPts.map((p) => p.y));
    const top = wsPts.filter((p) => p.y > wsMax - 0.03);
    const ext = (arr, s) => arr.reduce((a, p) => (!a || s * p.x > s * a.x ? p : a), null);
    if (top.length >= 2 && low.length >= 2) frame = { tl: ext(top, -1), tr: ext(top, 1), bl: ext(low, -1), br: ext(low, 1) };
  }
  // 车厢开口：左右用车顶(窗沿以上 0.25m 的部分)的宽度——整体包围盒会把后视镜算进去；
  // 前后用车顶宽度以内、贴近窗沿的点(= 前挡根部到后窗根部)
  const roof = removedPts.filter((p) => p.y > cutY + 0.25);
  const rx0 = roof.length ? Math.min(...roof.map((p) => p.x)) : removed.min.x;
  const rx1 = roof.length ? Math.max(...roof.map((p) => p.x)) : removed.max.x;
  const nearCut = removedPts.filter((p) => p.y < cutY + 0.12 && p.x > rx0 - 0.05 && p.x < rx1 + 0.05);
  const zs = nearCut.length ? nearCut.map((p) => p.z) : [removed.min.z, removed.max.z];
  const z1 = Math.max(...zs);
  const z0 = low.length ? low.reduce((s, p) => s + p.z, 0) / low.length : Math.min(...zs);
  return {
    cutY, floorY: Math.max(box.min.y + 0.26, cutY - 0.6),
    x0: rx0, x1: rx1,
    z0: Math.min(z0, z1 - 1), z1, frame,
    paint: [...cutCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  };
}

function prepare(gltf, m) {
  const src = m.anim ? skinClone(gltf.scene) : gltf.scene.clone(true);
  const g = new THREE.Group();
  const root = new THREE.Group();
  root.add(src);
  src.rotation.y = ((m.rotY || 0) * Math.PI) / 180;
  g.add(root);
  g.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(src, true);
  const size = box.getSize(new THREE.Vector3());
  const k = m.height ? m.height / Math.max(size.y, 1e-3) : (m.len || size.z) / Math.max(size.z, 1e-3);
  root.scale.setScalar(k);
  g.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(src, true);
  const c = box.getCenter(new THREE.Vector3());
  root.position.set(-c.x, -box.min.y + (m.lift || 0), -c.z);
  g.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(src, true);
  const vehicle = !m.height && !m.split; // 车辆按车长缩放，人按身高
  src.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = !o.isSkinnedMesh;
    const one = (mt) => {
      const x = vehicle ? vehicleMaterial(mt, m) : fixMaterial(mt.clone());
      if (m.hue && x.map) x.map = hueTexture(x.map, m.hue);
      return x;
    };
    o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
  });
  // box 仍是切顶前的外形：车灯高度等按原车算
  const lamps = vehicle ? findLamps(src, m) : null;
  const cabin = vehicle && m.convertible ? makeConvertible(g, src, m) : null;
  if (vehicle && m.convertible && !cabin) console.warn('敞篷切顶失败(找不到窗沿)', m.file);
  g.userData = { box, cabin, lamps, tint: m.tint || null, anim: m.anim ? gltf.animations.find((a) => a.name.endsWith(m.anim)) || null : null, skinned: !!m.anim };
  return g;
}

function prepareTrees(scene, m) {
  scene.updateMatrixWorld(true);
  // 找到“每棵树”一级：RootNode 下面的各个子节点
  let holder = scene;
  while (holder.children.length === 1 && !holder.children[0].isMesh) holder = holder.children[0];
  const out = [];
  for (const tree of holder.children) {
    const parts = [];
    tree.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(tree);
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const k = m.height / Math.max(size.y, 1e-3);
    const norm = new THREE.Matrix4().makeScale(k, k, k).multiply(new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z));
    tree.traverse((o) => {
      if (!o.isMesh) return;
      const geom = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(norm, o.matrixWorld));
      const mt = fixMaterial(o.material.clone());
      if (mt.map) mt.alphaTest = Math.max(mt.alphaTest || 0, 0.4);
      mt.side = THREE.DoubleSide;
      parts.push({ geometry: geom, material: mt });
    });
    if (parts.length) out.push({ parts });
  }
  return out;
}

export function hasModel(id) { return !!TEMPLATES[id]; }
export function treeVariants() { return Object.values(TREES).flat(); }

// 克隆一份；tintColor 给定时，名字匹配 tint 的材质换成该颜色(克隆材质，不影响模板)
export function cloneModel(id, tintColor) {
  const t = TEMPLATES[id];
  if (!t) return null;
  const g = t.userData.skinned ? skinClone(t) : t.clone(true);
  if (tintColor != null && t.userData.tint) {
    const re = new RegExp(t.userData.tint, 'i');
    g.traverse((o) => {
      if (!o.isMesh) return;
      const swap = (mt) => (mt && re.test(mt.name || '') ? Object.assign(instanceMaterial(mt), { color: new THREE.Color(tintColor) }) : mt);
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
  }
  g.userData = { ...t.userData };
  return g;
}
