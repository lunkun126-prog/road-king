// 外部 3D 模型：读 models/manifest.json，按目标车长/高度自动缩放、贴地、车头朝 -z。
// 缺模型或加载失败时对应接口返回 null，渲染层退回代码画的车/人/树。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skinClone } from 'three/addons/utils/SkeletonUtils.js';

const TEMPLATES = {};   // id -> Group（车、人）
const TREES = {};       // id -> [{parts:[{geometry, material}]}]（每棵树一个变体，几何已烘焙好变换）
let manifest = {};

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
  src.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = !o.isSkinnedMesh;
    const one = (mt) => {
      const x = fixMaterial(mt.clone());
      if (m.hue && x.map) x.map = hueTexture(x.map, m.hue);
      return x;
    };
    o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
  });
  g.userData = { box, tint: m.tint || null, anim: m.anim ? gltf.animations.find((a) => a.name.endsWith(m.anim)) || null : null, skinned: !!m.anim };
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
      const swap = (mt) => (mt && re.test(mt.name || '') ? Object.assign(mt.clone(), { color: new THREE.Color(tintColor) }) : mt);
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
  }
  g.userData = { ...t.userData };
  return g;
}
