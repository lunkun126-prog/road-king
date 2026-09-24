// 全部用 WebAudio 现场合成：发动机、喇叭、撞击、擦肩、转向灯滴答。没有外部音频文件。
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
    // 发动机：锯齿 + 方波次谐波 → 低通
    this.eng = ctx.createGain(); this.eng.gain.value = 0;
    this.engF = ctx.createBiquadFilter(); this.engF.type = 'lowpass'; this.engF.frequency.value = 600;
    this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth';
    this.o2 = ctx.createOscillator(); this.o2.type = 'square';
    const g2 = ctx.createGain(); g2.gain.value = 0.4;
    this.o1.connect(this.engF); this.o2.connect(g2); g2.connect(this.engF);
    this.engF.connect(this.eng); this.eng.connect(this.master);
    this.o1.start(); this.o2.start();
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

  // v 米/秒, maxV, throttle 0..1
  engine(v, maxV, throttle, heavy, on = true) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const gears = 5, gv = maxV / gears;
    const gear = Math.min(gears - 1, Math.floor(v / gv));
    const rpm = 0.25 + 0.75 * ((v - gear * gv) / gv);
    const base = heavy ? 32 : 48;
    const f = base + rpm * (heavy ? 70 : 150) + gear * 6;
    this.o1.frequency.setTargetAtTime(f, t, 0.05);
    this.o2.frequency.setTargetAtTime(f / 2, t, 0.05);
    this.engF.frequency.setTargetAtTime(350 + throttle * 1400 + rpm * 400, t, 0.08);
    this.eng.gain.setTargetAtTime(on ? 0.12 + throttle * 0.13 : 0, t, 0.1);
    this.windG.gain.setTargetAtTime(on ? Math.min(0.25, (v / 60) ** 2 * 0.25) : 0, t, 0.2);
    this.windF.frequency.setTargetAtTime(500 + v * 15, t, 0.2);
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
