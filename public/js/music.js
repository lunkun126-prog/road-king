// 开车音乐：播放 public/music/ 里的歌（服务端 /api/music 列目录，自己丢 mp3 进去就能选）。
// 勾选的歌组成歌单，一首放完接下一首；一首都没勾就全部随机放。
const EXT = /\.(mp3|ogg|m4a|wav|flac)$/i;

export class Music {
  constructor() {
    this.a = new Audio();
    this.a.preload = 'auto';
    this.list = [];
    this.picks = [];
    this.cur = null;
    this.on = true;
    this.a.onended = () => this.next();
  }

  async load() {
    try {
      const r = await fetch('/api/music');
      this.list = r.ok ? (await r.json()).filter((f) => EXT.test(f)) : [];
    } catch { this.list = []; }
    return this.list;
  }

  pool() {
    const p = this.list.filter((f) => this.picks.includes(f));
    return p.length ? p : this.list;
  }

  static title(f) { return String(f || '').replace(EXT, ''); }

  setSrc(f) {
    this.cur = f;
    this.a.src = 'music/' + encodeURIComponent(f);
  }

  // 开局/恢复时调用：歌单里没有当前歌就随机挑一首
  play() {
    if (!this.on) return null;
    const p = this.pool();
    if (!p.length) return null;
    if (!this.cur || !p.includes(this.cur)) this.setSrc(p[Math.floor(Math.random() * p.length)]);
    this.a.play().catch(() => {});
    return this.cur;
  }

  pause() { this.a.pause(); }

  next() {
    const p = this.pool();
    if (!p.length || !this.on) return null;
    this.setSrc(p[(p.indexOf(this.cur) + 1) % p.length]);
    this.a.play().catch(() => {});
    return this.cur;
  }

  // 设置页试听：直接放这首
  preview(f) {
    this.setSrc(f);
    this.a.play().catch(() => {});
  }

  setVolume(v) { this.a.volume = Math.max(0, Math.min(1, v)); }
}
