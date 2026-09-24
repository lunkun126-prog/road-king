// 道路生成：纯逻辑，浏览器和 node 测试共用。
// 坐标约定：道路坐标 (s 沿路程米, x 横向米，向右为正)；世界坐标 xz 平面，起点朝 -z。
// heading h 增大 = 向右转；前进方向 (sin h, -cos h)，右手法向 (cos h, sin h)。

export const LANES = 4;
export const LANE_W = 3.6;
export const ROAD_HALF = (LANES * LANE_W) / 2 + 0.8; // 护栏到中心线的距离
export const STEP = 2; // 采样间隔(米)
export const laneCenter = (i) => (i - (LANES - 1) / 2) * LANE_W;
export const laneOf = (x) => Math.max(0, Math.min(LANES - 1, Math.round(x / LANE_W + (LANES - 1) / 2)));

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// 红绿灯周期(秒)：绿 → 黄 → 红；红灯期间横向车流通行
export const CYCLE = { green: 14, yellow: 3, red: 10 };
const CYCLE_T = CYCLE.green + CYCLE.yellow + CYCLE.red;

export function lightState(light, t) {
  const p = (((t + light.phase) % CYCLE_T) + CYCLE_T) % CYCLE_T;
  if (p < CYCLE.green) return { main: 'green', remain: CYCLE.green - p, cross: false };
  if (p < CYCLE.green + CYCLE.yellow) return { main: 'yellow', remain: CYCLE.green + CYCLE.yellow - p, cross: false };
  const r = p - CYCLE.green - CYCLE.yellow;
  return { main: 'red', remain: CYCLE_T - p, cross: r > 1.2 && r < CYCLE.red - 3.4 };
}

export class Road {
  // opts: curves 是否有弯, hills 是否有坡, lights {first, every:[min,max]} 或 null
  constructor(seed, opts = {}) {
    this.rand = rng(seed);
    this.curves = opts.curves ?? true;
    this.hills = opts.hills ?? true;
    this.curveMax = opts.curveMax ?? 1 / 140;
    this.hillAmp = opts.hillAmp ?? 1;
    this.lightCfg = opts.lights === undefined ? { first: 450, every: [600, 1100] } : opts.lights;
    this.segs = [{ s0: -1e9, s1: 300, k: 0 }];
    this.lights = [];
    this.nextLight = this.lightCfg ? this.lightCfg.first : Infinity;
    this.px = [0]; this.pz = [0]; this.ph = [0];
    this.ph1 = this.rand() * 6.28; this.ph2 = this.rand() * 6.28;
    this.genSegs(1200);
    this.sample(1000);
  }

  get segEnd() { return this.segs[this.segs.length - 1].s1; }

  genSegs(until) {
    const r = this.rand;
    while (this.segEnd < until) {
      const s0 = this.segEnd;
      const overdue = s0 + 150 > this.nextLight;
      if (!this.curves || overdue || r() < 0.45) {
        const len = overdue ? 300 : 150 + r() * 250;
        this.segs.push({ s0, s1: s0 + len, k: 0 });
        if (overdue) {
          const s = s0 + len / 2;
          this.lights.push({ s, stopS: s - 9, phase: r() * CYCLE_T, id: this.lights.length });
          const [a, b] = this.lightCfg.every;
          this.nextLight = s + a + r() * (b - a);
        }
      } else {
        const len = 160 + r() * 240;
        const k = (r() < 0.5 ? -1 : 1) * this.curveMax * (0.35 + r() * 0.65);
        this.segs.push({ s0, s1: s0 + len, k });
      }
    }
  }

  kAt(s) {
    // 段数不多且访问集中在尾部，倒序线性查找足够
    for (let i = this.segs.length - 1; i >= 0; i--) {
      const g = this.segs[i];
      if (s >= g.s0) {
        if (!g.k) return 0;
        const ramp = (g.s1 - g.s0) * 0.3;
        return g.k * smooth(Math.min(s - g.s0, g.s1 - s) / ramp);
      }
    }
    return 0;
  }

  sample(until) {
    this.genSegs(until + 500);
    let n = this.px.length - 1;
    while (n * STEP < until) {
      const sMid = n * STEP + STEP / 2;
      const hMid = this.ph[n] + (this.kAt(sMid) * STEP) / 2;
      this.px.push(this.px[n] + Math.sin(hMid) * STEP);
      this.pz.push(this.pz[n] - Math.cos(hMid) * STEP);
      this.ph.push(this.ph[n] + this.kAt(sMid) * STEP);
      n++;
    }
  }

  lightDist(s) {
    let d = Infinity;
    for (const l of this.lights) d = Math.min(d, Math.abs(l.s - s));
    return d;
  }

  yAt(s) {
    if (!this.hills || s < 0) return 0;
    const amp = smooth((s - 150) / 200) * smooth((this.lightDist(s) - 70) / 120);
    return this.hillAmp * amp * (2.8 * Math.sin(s / 137 + this.ph1) + 3.4 * Math.sin(s / 331 + this.ph2));
  }

  // 返回道路中心点 {x,y,z,h}
  at(s, out = {}) {
    if (s < 0) { out.x = 0; out.z = -s; out.h = 0; out.y = 0; return out; }
    if (s > (this.px.length - 3) * STEP) this.sample(s + 800);
    const f = s / STEP, i = Math.floor(f), t = f - i;
    out.x = this.px[i] + (this.px[i + 1] - this.px[i]) * t;
    out.z = this.pz[i] + (this.pz[i + 1] - this.pz[i]) * t;
    out.h = this.ph[i] + (this.ph[i + 1] - this.ph[i]) * t;
    out.y = this.yAt(s);
    return out;
  }

  // 道路坐标 → 世界坐标
  toWorld(s, x, out = {}) {
    this.at(s, out);
    out.x += Math.cos(out.h) * x;
    out.z += Math.sin(out.h) * x;
    return out;
  }

  nextLightAfter(s) {
    if (this.lightCfg) this.genSegs(s + 1500);
    for (const l of this.lights) if (l.stopS > s) return l;
    return null;
  }

  lightsNear(s0, s1) {
    if (this.lightCfg) this.genSegs(s1 + 500);
    return this.lights.filter((l) => l.s > s0 && l.s < s1);
  }
}
