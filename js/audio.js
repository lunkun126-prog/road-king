// 全部用 WebAudio 现场合成：发动机、喇叭、撞击、擦肩、转向灯滴答。没有外部音频文件。

// 发动机声按车分档：缸数决定点火频率（转速/60 × 缸数/2），失真和尖啸决定「野」的程度
const ENGINES = {
  v12:    { cyl: 12, idle: 1000, red: 9000,  gears: 7, drive: 5.5, scream: 0.55, sub: 0.35, cut: 5200, vol: 0.2,  crackle: 1 },   // 公牛 V12
  super:  { cyl: 10, idle: 1000, red: 8800,  gears: 7, drive: 4.5, scream: 0.45, sub: 0.35, cut: 4600, vol: 0.18, crackle: 0.8 }, // 其他超跑
  moto:   { cyl: 4,  idle: 1400, red: 14000, gears: 6, drive: 4,   scream: 0.5,  sub: 0.2,  cut: 5000, vol: 0.16, crackle: 0.6 },
  sedan:  { cyl: 4,  idle: 800,  red: 6500,  gears: 5, drive: 1.8, scream: 0.12, sub: 0.3,  cut: 2200, vol: 0.13, crackle: 0 },
  diesel: { cyl: 6,  idle: 600,  red: 2600,  gears: 8, drive: 3,   scream: 0.05, sub: 0.7,  cut: 1100, vol: 0.2,  crackle: 0 },
};
const ENGINE_OF = { toro: 'v12', sport: 'super', woking: 'super', stoccarda: 'super', quadri: 'super', moto: 'moto', ninja: 'moto', truck: 'diesel' };

export class Sound {
  constructor() {
    this.ctx = null;
    this.volume = 0.7;
    this.muted = false;
  }

  // 浏览器要求用户手势后才能出声
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.applyVolume();
    // 发动机：点火频率锯齿 + 半频方波（曲轴低吼）+ 两个错开的倍频锯齿（高转尖啸）→ 失真 → 低通 → 鼻音峰
    this.eng = ctx.createGain(); this.eng.gain.value = 0;
    this.engMix = ctx.createGain();
    this.shaper = ctx.createWaveShaper(); this.shaper.oversample = '2x';
    this.engF = ctx.createBiquadFilter(); this.engF.type = 'lowpass'; this.engF.frequency.value = 600; this.engF.Q.value = 2;
    this.engPk = ctx.createBiquadFilter(); this.engPk.type = 'peaking'; this.engPk.frequency.value = 1600; this.engPk.Q.value = 1.4; this.engPk.gain.value = 6;
    const osc = (type, gain) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; g.gain.value = gain; o.connect(g); g.connect(this.engMix); o.start(); return { o, g }; };
    this.o1 = osc('sawtooth', 0.5);     // 基频
    this.o2 = osc('square', 0.35);      // 半频低吼
    this.o3 = osc('sawtooth', 0.3);     // 2 倍频尖啸
    this.o4 = osc('sawtooth', 0.2);     // 3 倍频，略跑调出「撕裂」感
    this.o4.o.detune.value = 18;
    this.engMix.connect(this.shaper); this.shaper.connect(this.engF); this.engF.connect(this.engPk); this.duck = ctx.createGain();
    this.engPk.connect(this.duck); this.duck.connect(this.eng); this.eng.connect(this.master);
    this.engKind = null; this.gear = 0; this.lastThr = 0; this.crackleT = 0; this.rpmK = 0;
    // 风噪
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.wind = ctx.createBufferSource(); this.wind.buffer = this.noiseBuf; this.wind.loop = true;
    this.windF = ctx.createBiquadFilter(); this.windF.type = 'bandpass'; this.windF.frequency.value = 800; this.windF.Q.value = 0.6;
    this.windG = ctx.createGain(); this.windG.gain.value = 0;
    this.wind.connect(this.windF); this.windF.connect(this.windG); this.windG.connect(this.master);
    this.wind.start();
  }

  applyVolume() { if (this.master) this.master.gain.value = this.muted ? 0 : this.volume * 0.6; }
  setVolume(v) { this.volume = v; this.applyVolume(); }
  toggleMute() { this.muted = !this.muted; this.applyVolume(); return this.muted; }

  setEngine(kind) {
    if (this.engKind === kind) return;
    this.engKind = kind;
    const E = ENGINES[kind], k = E.drive, n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
    this.shaper.curve = curve;
    this.o3.g.gain.value = E.scream; this.o4.g.gain.value = E.scream * 0.6; this.o2.g.gain.value = E.sub;
    this.engPk.frequency.value = kind === 'diesel' ? 300 : kind === 'sedan' ? 900 : 1800;
    this.engPk.gain.value = kind === 'sedan' ? 3 : 8;
  }

  // v 米/秒, maxV, throttle 0..1, vid = 车型 id（旧调用传 true 表示重卡）
  engine(v, maxV, throttle, vid, on = true) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const kind = vid === true ? 'diesel' : ENGINE_OF[vid] || 'sedan';
    this.setEngine(kind);
    const E = ENGINES[kind];
    // 挡位：低挡短、高挡长；每挡从 ~55% 转拉到红线
    const x = Math.max(0, Math.min(1, v / maxV)), n = E.gears;
    const edge = (i) => Math.pow((i + 1) / n, 1.25);
    let gear = 0;
    while (gear < n - 1 && x > edge(gear)) gear++;
    const lo = gear ? edge(gear - 1) : 0, span = edge(gear) - lo;
    let frac = (gear ? 0.55 : 0.08) + (gear ? 0.45 : 0.92) * ((x - lo) / span);
    frac = Math.max(frac, throttle * (v < 3 ? 0.75 : 0.25));          // 原地轰油门
    const rpm = E.idle + (E.red - E.idle) * Math.min(1, frac);
    const f = (rpm / 60) * (E.cyl / 2) / (kind === 'v12' || kind === 'super' ? 2 : 1); // 超跑按两排各半听，基频不至于太尖
    if (on && gear > this.gear && throttle > 0.3) this.shift();
    this.gear = gear;
    const tc = 0.04;
    this.o1.o.frequency.setTargetAtTime(f, t, tc);
    this.o2.o.frequency.setTargetAtTime(f / 2, t, tc);
    this.o3.o.frequency.setTargetAtTime(f * 2, t, tc);
    this.o4.o.frequency.setTargetAtTime(f * 3, t, tc);
    this.engF.frequency.setTargetAtTime(300 + E.cut * (0.25 + 0.55 * throttle + 0.2 * frac), t, 0.06);
    this.eng.gain.setTargetAtTime(on ? E.vol * (0.45 + 0.55 * throttle) * (0.8 + 0.4 * frac) : 0, t, 0.06);
    // 高转全油门后突然松油门：排气放炮
    if (on && E.crackle && this.lastThr > 0.6 && throttle < 0.15 && frac > 0.5 && t > this.crackleT) { this.crackleT = t + 0.9; this.crackle(E.crackle); }
    this.lastThr = throttle;
    this.windG.gain.setTargetAtTime(on ? Math.min(0.25, (v / 60) ** 2 * 0.25) : 0, t, 0.2);
    this.windF.frequency.setTargetAtTime(500 + v * 15, t, 0.2);
  }

  // 换挡：断油一下 + 排气「砰」
  shift() {
    const t = this.ctx.currentTime, g = this.duck.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(1, t); g.linearRampToValueAtTime(0.2, t + 0.04); g.linearRampToValueAtTime(1, t + 0.14);
    this.pop(0.03, 0.5);
  }
  pop(when, vol) {
    this.noise(0.06, 1800 + Math.random() * 1500, vol, 'bandpass', when);
    this.tone(70 + Math.random() * 50, 0.07, 'square', vol * 0.5, when, -30);
  }
  crackle(amount) {
    const count = Math.round(4 + Math.random() * 5 * amount);
    for (let i = 0; i < count; i++) this.pop(0.05 + Math.random() * 0.7, (0.25 + Math.random() * 0.35) * amount);
  }

  tone(freq, dur, type = 'square', vol = 0.25, when = 0, slide = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }

  noise(dur, freq, vol, type = 'lowpass', when = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }

  horn(heavy) {
    if (heavy) { this.tone(160, 0.55, 'sawtooth', 0.22); this.tone(200, 0.55, 'sawtooth', 0.18); return; }
    this.tone(415, 0.32, 'square', 0.14); this.tone(520, 0.32, 'square', 0.12);
  }
  crash(impact) { this.noise(0.5 + impact / 200, 900, Math.min(0.9, 0.3 + impact / 120)); this.tone(70, 0.35, 'sine', 0.5, 0, -40); }
  smash() { this.noise(0.6, 1400, 0.8); this.tone(55, 0.5, 'sine', 0.7, 0, -30); this.tone(900, 0.25, 'triangle', 0.1, 0.05, 600); }
  scrape() { this.noise(0.25, 3000, 0.25, 'highpass'); }
  whoosh(combo) { this.noise(0.35, 1200 + combo * 150, 0.35, 'bandpass'); this.tone(500 + combo * 80, 0.12, 'triangle', 0.12, 0.05); }
  tick() { this.tone(1800, 0.03, 'square', 0.06); }
  penalty() { this.tone(220, 0.25, 'square', 0.16); this.tone(165, 0.35, 'square', 0.16, 0.2); }
  coin() { this.tone(880, 0.08, 'triangle', 0.2); this.tone(1320, 0.14, 'triangle', 0.2, 0.08); }
  fail() { this.tone(330, 0.3, 'sawtooth', 0.15); this.tone(247, 0.3, 'sawtooth', 0.15, 0.25); this.tone(165, 0.6, 'sawtooth', 0.15, 0.5); }
  win() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.2, i * 0.12)); }
  click() { this.tone(660, 0.05, 'triangle', 0.1); }
}
