// 필기 보드: 획(stroke) = {id, c:색, w:굵기, st:시작시각(ms), p:[[x,y,dt],...], del:지운시각|null}
// 논리 좌표 1000 x 1400 (A4 세로 비율), 화면 크기에 맞춰 확대/축소
export const W = 1000, H = 1400;

const ERASE_R = 18;

export class Board {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = { editable: false, dpr: Math.min(2, window.devicePixelRatio || 1), fitContent: false, ...opts };
    this.strokes = [];
    this.byId = new Map();
    this.drawnUpTo = new Map(); // id → 그려진 점 개수 (점진 렌더)
    this.showDeleted = false; // 지운 흔적 (빨간 점선)
    this.timeColor = false; // 시간 순서 색 (파랑→주황)
    this.replayTime = null; // 재생 시각 (null=실시간)
    this.viewH = H;
    this.mode = "pen";
    this.color = "#111827";
    this.width = 3;
    this.penOnly = false;
    this._raf = 0;
    this._full = true;
    if (this.opts.editable) this._bindInput();
    this.resize();
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas.parentElement);
    }
  }

  destroy() { this._ro?.disconnect(); cancelAnimationFrame(this._raf); }

  // ---------- 데이터
  setStrokes(strokes) {
    this.strokes = strokes ? strokes.map((s) => ({ ...s, p: s.p.slice() })) : [];
    this.byId = new Map(this.strokes.map((s) => [s.id, s]));
    this.drawnUpTo.clear();
    this._updateViewH();
    this.redraw();
  }
  addStroke(s) {
    const st = { ...s, p: s.p.slice() };
    this.strokes.push(st);
    this.byId.set(st.id, st);
    this._maybeGrow(st.p);
    this._schedule();
    return st;
  }
  appendPoints(id, pts) {
    const s = this.byId.get(id);
    if (!s) return;
    s.p.push(...pts);
    this._maybeGrow(pts);
    this._schedule();
  }
  erase(ids, at = Date.now()) {
    for (const id of ids) { const s = this.byId.get(id); if (s) s.del = at; }
    this.redraw();
  }
  restore(ids) {
    for (const id of ids) { const s = this.byId.get(id); if (s) s.del = null; }
    this.redraw();
  }

  // 시간 범위 (재생용)
  timeline() {
    let start = Infinity, end = 0;
    for (const s of this.strokes) {
      start = Math.min(start, s.st);
      const last = s.p.length ? s.st + s.p[s.p.length - 1][2] : s.st;
      end = Math.max(end, last, s.del || 0);
    }
    return start === Infinity ? { start: 0, end: 0 } : { start, end };
  }

  // 획 사이 멈춘 구간들 (ms 이상)
  pauses(minMs = 15000) {
    const ev = [];
    for (const s of this.strokes) {
      ev.push([s.st, s.p.length ? s.st + s.p[s.p.length - 1][2] : s.st]);
    }
    ev.sort((a, b) => a[0] - b[0]);
    const out = [];
    let lastEnd = ev.length ? ev[0][1] : 0;
    for (let i = 1; i < ev.length; i++) {
      if (ev[i][0] - lastEnd >= minMs) out.push({ from: lastEnd, to: ev[i][0], ms: ev[i][0] - lastEnd });
      lastEnd = Math.max(lastEnd, ev[i][1]);
    }
    return out;
  }

  // ---------- 화면
  resize() {
    const parent = this.canvas.parentElement;
    const cs = getComputedStyle(parent);
    const inner = parent.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    const cssW = Math.max(50, Math.floor(inner));
    if (this._lastW === cssW && this._lastVH === this.viewH && this.canvas.width) { return; }
    this._lastW = cssW; this._lastVH = this.viewH;
    this.scale = cssW / W;
    const dpr = this.opts.dpr;
    const cssH = this.viewH * this.scale;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.redraw();
  }

  _updateViewH() {
    if (!this.opts.fitContent) return;
    // 썸네일: 쓴 부분까지만 보여서 글씨가 크게 보이도록
    let maxY = 0;
    for (const s of this.strokes) if (!s.del || this.showDeleted) for (const p of s.p) if (p[1] > maxY) maxY = p[1];
    const want = Math.min(H, Math.max(this.opts.minViewH || 520, maxY + 60));
    if (Math.abs(want - this.viewH) > 40) { this.viewH = want; this.resize(); }
  }
  _maybeGrow(pts) {
    if (!this.opts.fitContent) return;
    for (const p of pts) if (p[1] + 60 > this.viewH && this.viewH < H) { this._updateViewH(); return; }
  }

  redraw() { this._full = true; this._schedule(); }
  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  _render() {
    const { ctx } = this;
    const k = this.scale * this.opts.dpr;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const replay = this.replayTime != null;
    if (this._full || replay || this.timeColor || this.showDeleted) {
      ctx.clearRect(0, 0, W, this.viewH);
      this._drawGuide();
      this.drawnUpTo.clear();
      const tl = this.timeColor ? this.timeline() : null;
      for (const s of this.strokes) this._drawStroke(s, 0, tl);
      this._full = false;
    } else {
      // 점진 렌더: 새로 들어온 점만 이어 그림
      for (const s of this.strokes) {
        if (s.del) continue;
        const from = this.drawnUpTo.get(s.id) || 0;
        if (from < s.p.length) this._drawStroke(s, Math.max(0, from - 1), null);
      }
    }
    if (this._eraserAt) {
      ctx.beginPath();
      ctx.arc(this._eraserAt[0], this._eraserAt[1], ERASE_R, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(100,116,139,.6)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      this._full = true; // 다음 프레임에 커서 지우기
    }
  }

  _drawGuide() {
    // 옅은 줄 (풀이 정렬 도움)
    const { ctx } = this;
    ctx.strokeStyle = "#f0f2f5";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 70; y < this.viewH; y += 70) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }

  _drawStroke(s, from, tl) {
    const { ctx } = this;
    const t = this.replayTime;
    let pts = s.p;
    let deleted = !!s.del;
    if (t != null) {
      if (s.st > t) return;
      deleted = s.del != null && s.del <= t;
      const lim = t - s.st;
      let n = pts.length;
      while (n > 0 && pts[n - 1][2] > lim) n--;
      pts = pts.slice(0, n);
    }
    if (deleted && !this.showDeleted) { this.drawnUpTo.set(s.id, s.p.length); return; }
    if (!pts.length) return;
    let color = s.c;
    if (tl && tl.end > tl.start) {
      const r = Math.min(1, Math.max(0, (s.st - tl.start) / (tl.end - tl.start)));
      color = timeColor(r);
    }
    ctx.save();
    if (deleted) {
      ctx.strokeStyle = "rgba(220,38,38,.55)";
      ctx.setLineDash([6, 6]);
    } else ctx.strokeStyle = color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = s.w;
    if (pts.length === 1 || from >= pts.length - 1 && from === 0) {
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], s.w / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[from][0], pts[from][1]);
      for (let i = from + 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
    ctx.restore();
    if (t == null) this.drawnUpTo.set(s.id, pts.length);
  }

  // ---------- 입력 (학생)
  _bindInput() {
    const c = this.canvas;
    let active = null; // 현재 그리는 획
    let erasing = null; // 이번 지우기 동작에서 지운 id 들
    let scrollStart = null;
    let pending = []; // 전송 대기 점
    let flushTimer = 0;
    const wrap = c.parentElement;

    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return [Math.round(((e.clientX - r.left) / r.width) * W), Math.round(((e.clientY - r.top) / r.height) * this.viewH)];
    };
    const flushPts = () => {
      flushTimer = 0;
      if (active && pending.length) { this.opts.onAdd?.(active.id, pending); pending = []; }
    };

    c.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      // 펜 전용 모드: 손가락은 스크롤만 (손바닥 방지)
      if (this.penOnly && e.pointerType === "touch") {
        scrollStart = { y: e.clientY, top: wrap.scrollTop, id: e.pointerId };
        return;
      }
      if (active || erasing) return;
      c.setPointerCapture(e.pointerId);
      const [x, y] = pos(e);
      const isEraser = this.mode === "eraser" || e.button === 5 || (e.buttons & 32);
      if (isEraser) {
        erasing = new Set();
        this._eraseAt(x, y, erasing);
        return;
      }
      const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      active = this.addStroke({ id, c: this.color, w: this.width, st: Date.now(), p: [[x, y, 0]], del: null });
      active._t0 = performance.now();
      active._pid = e.pointerId;
      this.opts.onBegin?.({ id, c: active.c, w: active.w, p: [[x, y, 0]] });
      e.preventDefault();
    });

    c.addEventListener("pointermove", (e) => {
      if (scrollStart && e.pointerId === scrollStart.id) {
        wrap.scrollTop = scrollStart.top - (e.clientY - scrollStart.y);
        return;
      }
      if (erasing) {
        const [x, y] = pos(e);
        this._eraseAt(x, y, erasing);
        return;
      }
      if (!active || e.pointerId !== active._pid) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const add = [];
      let last = active.p[active.p.length - 1];
      for (const ev of evs.length ? evs : [e]) {
        const [x, y] = pos(ev);
        if (Math.abs(x - last[0]) + Math.abs(y - last[1]) < 2) continue; // 너무 가까운 점 생략 (용량↓)
        last = [x, y, Math.round(performance.now() - active._t0)];
        add.push(last);
      }
      if (!add.length) return;
      this.appendPoints(active.id, add);
      pending.push(...add);
      if (!flushTimer) flushTimer = setTimeout(flushPts, 40);
    });

    const end = (e) => {
      if (scrollStart && e.pointerId === scrollStart.id) { scrollStart = null; return; }
      if (erasing) {
        if (erasing.size) this.opts.onEraseDone?.([...erasing]);
        erasing = null;
        this._eraserAt = null;
        this.redraw();
        return;
      }
      if (!active || e.pointerId !== active._pid) return;
      clearTimeout(flushTimer);
      flushPts();
      this.opts.onEnd?.(active.id);
      active = null;
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }

  _eraseAt(x, y, set) {
    this._eraserAt = [x, y];
    const hit = [];
    for (const s of this.strokes) {
      if (s.del || set.has(s.id)) continue;
      if (hitStroke(s, x, y, ERASE_R + s.w / 2)) hit.push(s.id);
    }
    if (hit.length) {
      hit.forEach((id) => set.add(id));
      this.erase(hit);
      this.opts.onErase?.(hit);
    } else this._schedule();
  }

  liveIds() { return this.strokes.filter((s) => !s.del).map((s) => s.id); }

  // PNG로 내보내기 (즉석 문제 손글씨용) — 쓴 영역만 잘라냄
  toPNG({ pad = 30 } = {}) {
    const live = this.strokes.filter((s) => !s.del);
    if (!live.length) return null;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (const s of live) for (const [x, y] of s.p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W, x1 + pad); y1 = Math.min(H, y1 + pad);
    const k = 1.5;
    const cv = document.createElement("canvas");
    cv.width = Math.round((x1 - x0) * k); cv.height = Math.round((y1 - y0) * k);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const s of live) {
      ctx.strokeStyle = s.c; ctx.fillStyle = s.c; ctx.lineWidth = s.w;
      ctx.beginPath(); ctx.moveTo(s.p[0][0], s.p[0][1]);
      for (const p of s.p) ctx.lineTo(p[0], p[1]);
      if (s.p.length === 1) { ctx.arc(s.p[0][0], s.p[0][1], s.w / 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.stroke();
    }
    return new Promise((r) => cv.toBlob(r, "image/png"));
  }
}

function hitStroke(s, x, y, r) {
  const p = s.p;
  const r2 = r * r;
  if (p.length === 1) return (p[0][0] - x) ** 2 + (p[0][1] - y) ** 2 <= r2;
  for (let i = 1; i < p.length; i++) {
    const [ax, ay] = p[i - 1], [bx, by] = p[i];
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx - x, cy = ay + t * dy - y;
    if (cx * cx + cy * cy <= r2) return true;
  }
  return false;
}

// 0(처음)=파랑 → 1(마지막)=주황
function timeColor(r) {
  const a = [37, 99, 235], b = [234, 88, 12];
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * r));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
