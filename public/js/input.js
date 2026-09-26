// 输入：键盘 + 手柄 + 触屏(每个控件各自跟踪 pointerId，天然支持多点触控：一手打方向一手踩油门)
const capture = (el, id) => { try { el.setPointerCapture(id); } catch { /* 合成事件或指针已抬起 */ } };

export class Input {
  constructor() {
    this.keys = new Set();
    this.edges = [];
    this.touch = { steer: 0, throttle: 0, brake: 0, active: false, steerHeld: false };
    this.wheelAngle = 0;
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (!e.repeat) this.edges.push(e.code);
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  // 把一个元素做成「按住」按钮
  hold(el, key) {
    const ids = new Set();
    const set = () => { this.touch[key] = ids.size ? 1 : 0; el.classList.toggle('on', ids.size > 0); };
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); capture(el, e.pointerId); ids.add(e.pointerId); this.touch.active = true; set(); });
    const up = (e) => { ids.delete(e.pointerId); set(); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  // 点一下触发一次的按钮
  tap(el, code) {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.edges.push(code); this.touch.active = true; });
  }

  // 方向盘：拖动旋转，松手回正
  wheel(el) {
    let id = null, a0 = 0, base = 0;
    const ang = (e) => {
      const r = el.getBoundingClientRect();
      return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
    };
    el.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      e.preventDefault(); capture(el, e.pointerId);
      id = e.pointerId; a0 = ang(e); base = this.wheelAngle; this.touch.active = true; this.touch.steerHeld = true;
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      let d = ang(e) - a0;
      if (d > 180) d -= 360; if (d < -180) d += 360;
      this.wheelAngle = Math.max(-135, Math.min(135, base + d));
      a0 = ang(e); base = this.wheelAngle;
    });
    const up = (e) => { if (e.pointerId === id) { id = null; this.touch.steerHeld = false; } };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // 每帧调用，返回给 sim 的输入 + 本帧 UI 动作
  read(dt, settings) {
    const k = this.keys;
    let steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    let brake = k.has('KeyS') || k.has('ArrowDown') || k.has('Space') ? 1 : 0;
    let analog = false;
    // 触屏
    const T = this.touch;
    if (settings.control === 'wheel') {
      if (!T.steerHeld) this.wheelAngle *= Math.pow(0.002, dt); // 松手自动回正
      if (Math.abs(this.wheelAngle) > 2) { steer = this.wheelAngle / 135; analog = true; }
    } else if (T.left || T.right) steer = (T.right ? 1 : 0) - (T.left ? 1 : 0);
    throttle = Math.max(throttle, T.throttle);
    brake = Math.max(brake, T.brake);
    // 手柄
    for (const gp of navigator.getGamepads ? navigator.getGamepads() : []) {
      if (!gp) continue;
      const ax = gp.axes[0] || 0;
      if (Math.abs(ax) > 0.12) { steer = ax; analog = true; }
      throttle = Math.max(throttle, gp.buttons[7]?.value || 0, gp.buttons[0]?.pressed ? 1 : 0);
      brake = Math.max(brake, gp.buttons[6]?.value || 0, gp.buttons[1]?.pressed ? 1 : 0);
      const edge = (i, code) => { const p = !!gp.buttons[i]?.pressed; const key = gp.index + ':' + i; if (p && !this['gp' + key]) this.edges.push(code); this['gp' + key] = p; };
      edge(4, 'KeyQ'); edge(5, 'KeyE'); edge(2, 'KeyH'); edge(3, 'KeyC'); edge(9, 'Escape');
    }
    const out = { steer, throttle, brake, analog, sens: settings.sens };
    const actions = [];
    for (const code of this.edges) {
      if (code === 'KeyQ') out.signal = 'L';
      else if (code === 'KeyE') out.signal = 'R';
      else if (code === 'KeyH') out.horn = true;
      else if (code === 'KeyL') out.lights = true;
      else actions.push(code);
    }
    this.edges = [];
    return { inp: out, actions };
  }

  // 双人：1P = W A S D，2P = 方向键；插了手柄的话第 1 个给 1P、第 2 个给 2P。返回 [1P, 2P] 的输入 + UI 动作
  readDuo(settings) {
    const k = this.keys;
    const keysOf = (up, down, left, right) => ({ steer: (k.has(right) ? 1 : 0) - (k.has(left) ? 1 : 0), throttle: k.has(up) ? 1 : 0, brake: k.has(down) ? 1 : 0, analog: false, sens: settings.sens });
    const inps = [keysOf('KeyW', 'KeyS', 'KeyA', 'KeyD'), keysOf('ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight')];
    const pads = (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter(Boolean);
    pads.slice(0, 2).forEach((gp, i) => {
      const o = inps[i], ax = gp.axes[0] || 0;
      if (Math.abs(ax) > 0.12) { o.steer = ax; o.analog = true; }
      o.throttle = Math.max(o.throttle, gp.buttons[7]?.value || 0, gp.buttons[0]?.pressed ? 1 : 0);
      o.brake = Math.max(o.brake, gp.buttons[6]?.value || 0, gp.buttons[1]?.pressed ? 1 : 0);
      const key = 'gpDuo' + gp.index, p = !!gp.buttons[9]?.pressed;   // Start 键暂停
      if (p && !this[key]) this.edges.push('Escape');
      this[key] = p;
    });
    const actions = this.edges.filter((c) => !['KeyQ', 'KeyE', 'KeyH', 'KeyL'].includes(c));   // 双人不用转向灯/喇叭/大灯
    this.edges = [];
    return { inps, actions };
  }
}
