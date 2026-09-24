// 外部 3D 模型：读 models/manifest.json，按目标车长自动缩放、贴地、车头朝 -z。
// 缺模型或加载失败时返回 null，渲染层退回代码画的车。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TEMPLATES = {};
let manifest = {};

export async function loadModels(onProgress) {
  try {
    const r = await fetch('models/manifest.json');
    if (!r.ok) return;
    manifest = await r.json();
  } catch { return; }
  const loader = new GLTFLoader();
  const ids = Object.keys(manifest).filter((k) => !k.startsWith('_'));
  let done = 0;
  await Promise.all(ids.map(async (id) => {
    const m = manifest[id];
    try {
      const gltf = await loader.loadAsync('models/' + m.file);
      TEMPLATES[id] = prepare(gltf.scene, m);
    } catch (e) {
      console.warn('模型加载失败', id, e?.message || e);
    }
    onProgress?.(++done, ids.length);
  }));
}

function prepare(root, m) {
  const g = new THREE.Group();
  root.rotation.y = ((m.rotY || 0) * Math.PI) / 180;
  g.add(root);
  root.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const len = Math.max(size.z, 1e-3);
  const k = (m.len || len) / len;
  root.scale.multiplyScalar(k);
  root.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  root.position.x -= c.x; root.position.z -= c.z; root.position.y -= box.min.y - (m.lift || 0);
  root.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(root);
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false; o.receiveShadow = false;
    // 统一成 Lambert/Standard 都行；保留原材质，只把过于金属化的调暗一点避免没有环境贴图时发黑
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mt of mats) {
      if (mt && 'metalness' in mt && mt.metalness > 0.6 && !mt.envMap) mt.metalness = 0.45;
      if (mt && 'roughness' in mt && mt.roughness < 0.25) mt.roughness = 0.3;
    }
  });
  g.userData.box = box;
  g.userData.tint = m.tint || null; // 需要换色的材质名(NPC 车随机颜色)
  return g;
}

export function hasModel(id) { return !!TEMPLATES[id]; }
export function modelInfo(id) { return manifest[id] || null; }
export function credits() { return Object.entries(manifest).filter(([k]) => !k.startsWith('_')).map(([k, v]) => ({ id: k, ...v })); }

// 克隆一份；tintColor 给定时，名字匹配 tint 的材质换成该颜色(克隆材质，不影响模板)
export function cloneModel(id, tintColor) {
  const t = TEMPLATES[id];
  if (!t) return null;
  const g = t.clone(true);
  if (tintColor != null && t.userData.tint) {
    const re = new RegExp(t.userData.tint, 'i');
    g.traverse((o) => {
      if (!o.isMesh) return;
      const swap = (mt) => (mt && re.test(mt.name || '') ? tinted(mt, tintColor) : mt);
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
  }
  g.userData.box = t.userData.box;
  return g;
}

function tinted(mt, color) {
  const c = mt.clone();
  c.color = new THREE.Color(color);
  return c;
}
