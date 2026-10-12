// Canvas charts: the scrolling waveforms and the heart-rate/SpO2 trend.

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function hexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
}

class Chart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.colors = {
      line: cssVar("--line"), faint: cssVar("--faint"), muted: cssVar("--muted"), text: cssVar("--text"),
      warn: cssVar("--warn"), alarm: cssVar("--alarm"), breath: cssVar("--breath"),
      pulse: cssVar("--pulse"), spo2: cssVar("--spo2"),
    };
    this.font = cssVar("--mono");
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;
    if (this.last) this.draw(this.last);
  }

  label(text, x, y, color = this.colors.faint, align = "left") {
    const c = this.ctx;
    c.font = `500 11px ${this.font}`;
    c.fillStyle = color;
    c.textAlign = align;
    c.fillText(text, x, y);
  }

  waiting(text) {
    this.ctx.clearRect(0, 0, this.w, this.h);
    this.label(text, this.w / 2, this.h / 2, this.colors.faint, "center");
  }
}

/** A trace of the last `windowS` seconds, scrolling to the left. */
export class Waveform extends Chart {
  constructor(canvas, { color, windowS = 15, threshold = null, minSpan = 1 }) {
    super(canvas);
    Object.assign(this, { color: this.colors[color] || color, windowS, threshold, minSpan });
    this.lo = this.hi = null;
  }

  /** data: {t, y, pause: {from, seconds, level}} with times in seconds. */
  draw(data) {
    this.last = data;
    const { t, y, pause } = data;
    const c = this.ctx;
    const pad = { l: 12, r: 12, t: 14, b: 22 };
    const w = this.w - pad.l - pad.r;
    const h = this.h - pad.t - pad.b;
    if (!t.length || w <= 0 || h <= 0) return this.waiting("Waiting for signal");
    c.clearRect(0, 0, this.w, this.h);

    const t1 = Math.max(t[t.length - 1], this.windowS);
    const t0 = t1 - this.windowS;
    let lo = Infinity, hi = -Infinity;
    for (const v of y) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (this.threshold !== null) { lo = Math.min(lo, this.threshold); hi = Math.max(hi, this.threshold); }
    const span = Math.max(hi - lo, this.minSpan);
    const mid = (hi + lo) / 2;
    [lo, hi] = [mid - span * 0.6, mid + span * 0.6];
    // Ease the scale so it does not jump with every frame.
    this.lo = this.lo === null ? lo : this.lo + (lo - this.lo) * 0.2;
    this.hi = this.hi === null ? hi : this.hi + (hi - this.hi) * 0.2;
    const X = (s) => pad.l + ((s - t0) / this.windowS) * w;
    const Y = (v) => pad.t + h - ((v - this.lo) / (this.hi - this.lo)) * h;

    // Grid: a line every second, a label every 5 s.
    c.lineWidth = 1;
    for (let s = Math.ceil(t0); s <= t1; s++) {
      const x = Math.round(X(s)) + 0.5;
      c.strokeStyle = s % 5 === 0 ? this.colors.line : hexAlpha(this.colors.line, 0.45);
      c.beginPath(); c.moveTo(x, pad.t); c.lineTo(x, pad.t + h); c.stroke();
      if (s % 5 === 0) this.label(`${s} s`, x, this.h - 6, this.colors.faint, "center");
    }

    if (pause && pause.level !== "ok" && pause.from < t1) {
      const color = pause.level === "alarm" ? this.colors.alarm : this.colors.warn;
      const x0 = X(Math.max(pause.from, t0));
      c.fillStyle = hexAlpha(color, 0.12);
      c.fillRect(x0, pad.t, X(t1) - x0, h);
      c.fillStyle = color;
      c.fillRect(x0, pad.t, X(t1) - x0, 2);
      this.label(`No breath · ${(pause.seconds ?? t1 - pause.from).toFixed(1)} s`, x0 + 8, pad.t + 16, color);
    }

    if (this.threshold !== null) {
      const ty = Math.round(Y(this.threshold)) + 0.5;
      c.setLineDash([4, 5]);
      c.strokeStyle = this.colors.faint;
      c.beginPath(); c.moveTo(pad.l, ty); c.lineTo(pad.l + w, ty); c.stroke();
      c.setLineDash([]);
      this.label("breath threshold", pad.l + w, ty - 6, this.colors.faint, "right");
    }

    c.save();
    c.beginPath();
    c.rect(pad.l, 0, w, this.h);
    c.clip();
    c.strokeStyle = this.color;
    c.lineWidth = 2;
    c.lineJoin = c.lineCap = "round";
    c.shadowColor = hexAlpha(this.color, 0.45);
    c.shadowBlur = 8;
    c.beginPath();
    let started = false;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < t0 - 0.5) continue;
      const x = X(t[i]), yy = Y(y[i]);
      if (started) c.lineTo(x, yy); else { c.moveTo(x, yy); started = true; }
    }
    c.stroke();
    c.restore();
  }
}

/** Heart rate (top lane) and SpO2 (bottom lane) trend points, with apnea markers. */
export class TrendChart extends Chart {
  /** data: {points, episodes, from, to, hrLimits: [low, high], spo2Low} with times in ms. */
  draw(data) {
    this.last = data;
    const { points, episodes, from, to, hrLimits, spo2Low } = data;
    const c = this.ctx;
    const pad = { l: 52, r: 16, t: 8, b: 22 };
    const w = this.w - pad.l - pad.r;
    const laneGap = 14;
    const laneH = (this.h - pad.t - pad.b - laneGap) / 2;
    if (w <= 0 || laneH <= 0) return;
    c.clearRect(0, 0, this.w, this.h);
    const X = (ms) => pad.l + ((ms - from) / (to - from)) * w;
    const lanes = [
      { name: "HR", unit: "bpm", lo: 40, hi: 220, top: pad.t, color: this.colors.pulse, limits: hrLimits,
        value: (p) => p.hr, min: (p) => p.hr_min ?? p.hr, max: (p) => p.hr_max ?? p.hr },
      { name: "SpO2", unit: "%", lo: 60, hi: 100, top: pad.t + laneH + laneGap, color: this.colors.spo2, limits: [spo2Low],
        value: (p) => p.spo2, min: (p) => p.spo2_min ?? p.spo2, max: (p) => p.spo2 },
    ];

    // Time axis: about six labels, on round minutes.
    const spanMin = (to - from) / 60000;
    const stepMin = [1, 2, 5, 10, 15, 30, 60, 120, 240].find((s) => spanMin / s <= 6) || 240;
    const step = stepMin * 60000;
    for (let ms = Math.ceil(from / step) * step; ms <= to; ms += step) {
      const x = Math.round(X(ms)) + 0.5;
      c.strokeStyle = hexAlpha(this.colors.line, 0.6);
      c.beginPath(); c.moveTo(x, pad.t); c.lineTo(x, this.h - pad.b); c.stroke();
      const d = new Date(ms);
      this.label(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, x, this.h - 6, this.colors.faint, "center");
    }

    for (const lane of lanes) {
      const Y = (v) => lane.top + laneH - ((Math.min(Math.max(v, lane.lo), lane.hi) - lane.lo) / (lane.hi - lane.lo)) * laneH;
      c.strokeStyle = this.colors.line;
      c.strokeRect(pad.l + 0.5, lane.top + 0.5, w - 1, laneH - 1);
      this.label(lane.name, 8, lane.top + 14, lane.color);
      this.label(lane.unit, 8, lane.top + 28, this.colors.faint);
      c.setLineDash([3, 4]);
      for (const limit of lane.limits) {
        const y = Math.round(Y(limit)) + 0.5;
        c.strokeStyle = hexAlpha(this.colors.alarm, 0.55);
        c.beginPath(); c.moveTo(pad.l, y); c.lineTo(pad.l + w, y); c.stroke();
        this.label(String(limit), pad.l - 6, y + 4, this.colors.faint, "right");
      }
      c.setLineDash([]);

      const pts = points.filter((p) => lane.value(p) !== null && lane.value(p) !== undefined && lane.value(p) > 0);
      if (pts.length) {
        // Band from each block's minimum to its maximum, then the value line.
        c.fillStyle = hexAlpha(lane.color, 0.16);
        c.beginPath();
        pts.forEach((p, i) => { const x = X(Date.parse(p.at)); const y = Y(lane.max(p)); i ? c.lineTo(x, y) : c.moveTo(x, y); });
        for (let i = pts.length - 1; i >= 0; i--) c.lineTo(X(Date.parse(pts[i].at)), Y(lane.min(pts[i])));
        c.closePath();
        c.fill();
        c.strokeStyle = lane.color;
        c.lineWidth = 2;
        c.lineJoin = "round";
        c.beginPath();
        pts.forEach((p, i) => { const x = X(Date.parse(p.at)); const y = Y(lane.value(p)); i ? c.lineTo(x, y) : c.moveTo(x, y); });
        c.stroke();
        c.lineWidth = 1;
      }
    }

    for (const e of episodes) {
      const start = Date.parse(e.started_at);
      const x0 = X(start), x1 = X(start + e.pause_s * 1000);
      if (x1 < pad.l || x0 > pad.l + w) continue;
      c.fillStyle = hexAlpha(this.colors.alarm, 0.22);
      c.fillRect(x0, pad.t, Math.max(2, x1 - x0), this.h - pad.t - pad.b);
      c.fillStyle = this.colors.alarm;
      c.fillRect(x0, pad.t, Math.max(2, x1 - x0), 3);
    }
    if (!points.length) this.label("The first trend point appears after 15 s of signal", pad.l + w / 2, pad.t + laneH + laneGap / 2 + 4, this.colors.faint, "center");
  }
}
