// Canvas charts in the style of a journal figure: the scrolling waveforms and
// the heart-rate/SpO2 trend, with real axes, ticks and units.

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function hexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
}

/** About `n` round tick values between lo and hi. */
function ticks(lo, hi, n = 4) {
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return { values: out, step };
}

class Chart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.colors = {
      line: cssVar("--line"), strong: cssVar("--line-strong"), grid: cssVar("--grid"), faint: cssVar("--faint"),
      muted: cssVar("--muted"), text: cssVar("--text"), warn: cssVar("--warn"), alarm: cssVar("--alarm"),
      breath: cssVar("--breath"), pulse: cssVar("--pulse"), spo2: cssVar("--spo2"),
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

  label(text, x, y, color = this.colors.faint, align = "left", weight = 400) {
    const c = this.ctx;
    c.font = `${weight} 10.5px ${this.font}`;
    c.fillStyle = color;
    c.textAlign = align;
    c.fillText(text, x, y);
  }

  /** Axis title written upwards along the left edge. */
  vlabel(text, x, y, color = this.colors.muted) {
    const c = this.ctx;
    c.save();
    c.translate(x, y);
    c.rotate(-Math.PI / 2);
    this.label(text, 0, 0, color, "center");
    c.restore();
  }

  hline(x0, x1, y, color, dash = []) {
    const c = this.ctx;
    c.setLineDash(dash);
    c.strokeStyle = color;
    c.beginPath(); c.moveTo(x0, Math.round(y) + 0.5); c.lineTo(x1, Math.round(y) + 0.5); c.stroke();
    c.setLineDash([]);
  }

  vline(x, y0, y1, color, dash = []) {
    const c = this.ctx;
    c.setLineDash(dash);
    c.strokeStyle = color;
    c.beginPath(); c.moveTo(Math.round(x) + 0.5, y0); c.lineTo(Math.round(x) + 0.5, y1); c.stroke();
    c.setLineDash([]);
  }

  waiting(text) {
    this.ctx.clearRect(0, 0, this.w, this.h);
    this.label(text, this.w / 2, this.h / 2, this.colors.faint, "center");
  }
}

/**
 * A trace of the last `windowS` seconds, scrolling to the left.
 * `scale` turns raw values into the axis unit (e.g. counts to g); `unit` names it.
 */
export class Waveform extends Chart {
  constructor(canvas, { color, windowS = 15, threshold = null, minSpan = 1, unit = "a.u.", scale = null, axis = "" }) {
    super(canvas);
    Object.assign(this, { color: this.colors[color] || color, windowS, threshold, minSpan, unit, scale, axis });
    this.lo = this.hi = null;
  }

  /** data: {t, y, pause: {from, seconds, level}} with times in seconds. */
  draw(data) {
    this.last = data;
    const { t, y, pause } = data;
    const c = this.ctx;
    const pad = { l: 58, r: 14, t: 12, b: 34 };
    const w = this.w - pad.l - pad.r;
    const h = this.h - pad.t - pad.b;
    if (!t.length || w <= 0 || h <= 0) return this.waiting("Waiting for signal");
    c.clearRect(0, 0, this.w, this.h);
    c.lineWidth = 1;

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

    // Grid and time axis: a line every second, a tick label every 5 s.
    for (let s = Math.ceil(t0); s <= t1; s++) {
      const x = X(s);
      if (s % 5 === 0) {
        this.vline(x, pad.t, pad.t + h, this.colors.grid);
        this.vline(x, pad.t + h, pad.t + h + 4, this.colors.strong);
        this.label(String(s), x, pad.t + h + 15, this.colors.muted, "center");
      } else {
        this.vline(x, pad.t + h, pad.t + h + 2, this.colors.strong);
      }
    }
    this.label("Time (s)", pad.l + w, pad.t + h + 30, this.colors.faint, "right");

    // Amplitude axis with ticks in the axis unit.
    if (this.scale) {
      const { values, step } = ticks(this.lo * this.scale, this.hi * this.scale, 3);
      const digits = Math.max(0, -Math.floor(Math.log10(step)));
      for (const v of values) {
        const yy = Y(v / this.scale);
        if (yy < pad.t || yy > pad.t + h) continue;
        this.hline(pad.l, pad.l + w, yy, this.colors.grid);
        this.hline(pad.l - 4, pad.l, yy, this.colors.strong);
        this.label(v.toFixed(digits), pad.l - 7, yy + 3.5, this.colors.muted, "right");
      }
    }
    this.vlabel(`${this.axis} (${this.unit})`, 13, pad.t + h / 2);

    if (pause && pause.level !== "ok" && pause.from < t1) {
      const color = pause.level === "alarm" ? this.colors.alarm : this.colors.warn;
      const x0 = X(Math.max(pause.from, t0));
      c.fillStyle = hexAlpha(color, 0.07);
      c.fillRect(x0, pad.t, X(t1) - x0, h);
      this.vline(x0, pad.t, pad.t + h, color, [3, 3]);
      this.label(`No breath · ${(pause.seconds ?? t1 - pause.from).toFixed(1)} s`, x0 + 7, pad.t + 13, color, "left", 500);
    }

    if (this.threshold !== null) {
      this.hline(pad.l, pad.l + w, Y(this.threshold), this.colors.faint, [4, 4]);
      // Label on a white patch so the trace never runs through it.
      c.font = `400 10.5px ${this.font}`;
      const tw = c.measureText("breath threshold").width;
      c.fillStyle = "rgb(255 255 255 / 0.9)";
      c.fillRect(pad.l + w - tw - 6, Y(this.threshold) - 15, tw + 6, 12);
      this.label("breath threshold", pad.l + w - 3, Y(this.threshold) - 5, this.colors.faint, "right");
    }

    // Axes: left and bottom only.
    this.vline(pad.l, pad.t, pad.t + h, this.colors.strong);
    this.hline(pad.l, pad.l + w, pad.t + h, this.colors.strong);

    c.save();
    c.beginPath();
    c.rect(pad.l + 1, pad.t, w - 1, h);
    c.clip();
    c.strokeStyle = this.color;
    c.lineWidth = 1.4;
    c.lineJoin = c.lineCap = "round";
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
    const pad = { l: 58, r: 34, t: 16, b: 34 };
    const w = this.w - pad.l - pad.r;
    const laneGap = 16;
    const laneH = (this.h - pad.t - pad.b - laneGap) / 2;
    if (w <= 0 || laneH <= 0) return;
    c.clearRect(0, 0, this.w, this.h);
    c.lineWidth = 1;
    const X = (ms) => pad.l + ((ms - from) / (to - from)) * w;
    const lanes = [
      { name: "HR", unit: "bpm", lo: 40, hi: 220, ticks: [60, 120, 180], top: pad.t, color: this.colors.pulse, limits: hrLimits,
        value: (p) => p.hr, min: (p) => p.hr_min ?? p.hr, max: (p) => p.hr_max ?? p.hr },
      { name: "SpO₂", unit: "%", lo: 60, hi: 100, ticks: [70, 85, 100], top: pad.t + laneH + laneGap, color: this.colors.spo2, limits: [spo2Low],
        value: (p) => p.spo2, min: (p) => p.spo2_min ?? p.spo2, max: (p) => p.spo2 },
    ];
    const bottom = lanes[1].top + laneH;

    // Apnea episodes first, as numbered bands behind the data.
    for (const e of episodes) {
      const start = Date.parse(e.started_at);
      const x0 = X(start), x1 = X(start + e.pause_s * 1000);
      if (x1 < pad.l || x0 > pad.l + w) continue;
      c.fillStyle = hexAlpha(this.colors.alarm, 0.1);
      c.fillRect(Math.max(x0, pad.l), pad.t, Math.max(2, Math.min(x1, pad.l + w) - Math.max(x0, pad.l)), bottom - pad.t);
      this.label(`A${e.number}`, Math.max(x0, pad.l) + 3, pad.t - 4, this.colors.alarm, "left", 500);
    }

    // Time axis: about six labels, on round minutes.
    const spanMin = (to - from) / 60000;
    const stepMin = [1, 2, 5, 10, 15, 30, 60, 120, 240].find((s) => spanMin / s <= 6) || 240;
    const step = stepMin * 60000;
    for (let ms = Math.ceil(from / step) * step; ms <= to; ms += step) {
      const x = X(ms);
      this.vline(x, pad.t, bottom, this.colors.grid);
      this.vline(x, bottom, bottom + 4, this.colors.strong);
      const d = new Date(ms);
      this.label(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, x, bottom + 15, this.colors.muted, "center");
    }
    this.label("Clock time", pad.l + w, bottom + 30, this.colors.faint, "right");

    for (const lane of lanes) {
      const Y = (v) => lane.top + laneH - ((Math.min(Math.max(v, lane.lo), lane.hi) - lane.lo) / (lane.hi - lane.lo)) * laneH;
      // Short lanes keep only the end ticks and a horizontal label.
      const compact = laneH < 64;
      for (const v of compact ? [lane.ticks[0], lane.ticks.at(-1)] : lane.ticks) {
        this.hline(pad.l, pad.l + w, Y(v), this.colors.grid);
        this.hline(pad.l - 4, pad.l, Y(v), this.colors.strong);
        this.label(String(v), pad.l - 7, Y(v) + 3.5, this.colors.muted, "right");
      }
      // Alarm limits, dashed, labelled on the right.
      for (const limit of lane.limits) {
        this.hline(pad.l, pad.l + w, Y(limit), hexAlpha(this.colors.alarm, 0.6), [4, 3]);
        this.label(String(limit), pad.l + w + 4, Y(limit) + 3.5, this.colors.alarm);
      }
      this.vline(pad.l, lane.top, lane.top + laneH, this.colors.strong);
      this.hline(pad.l, pad.l + w, lane.top + laneH, this.colors.strong);
      if (compact) {
        this.label(lane.name, 6, lane.top + laneH / 2, lane.color, "left", 500);
        this.label(lane.unit, 6, lane.top + laneH / 2 + 12, this.colors.faint);
      } else {
        this.vlabel(`${lane.name} (${lane.unit})`, 13, lane.top + laneH / 2, lane.color);
      }

      const pts = points.filter((p) => lane.value(p) !== null && lane.value(p) !== undefined && lane.value(p) > 0);
      if (pts.length) {
        // Band from each block's minimum to its maximum, then the value line.
        c.fillStyle = hexAlpha(lane.color, 0.13);
        c.beginPath();
        pts.forEach((p, i) => { const x = X(Date.parse(p.at)); const y = Y(lane.max(p)); i ? c.lineTo(x, y) : c.moveTo(x, y); });
        for (let i = pts.length - 1; i >= 0; i--) c.lineTo(X(Date.parse(pts[i].at)), Y(lane.min(pts[i])));
        c.closePath();
        c.fill();
        c.strokeStyle = lane.color;
        c.lineWidth = 1.5;
        c.lineJoin = "round";
        c.beginPath();
        pts.forEach((p, i) => { const x = X(Date.parse(p.at)); const y = Y(lane.value(p)); i ? c.lineTo(x, y) : c.moveTo(x, y); });
        c.stroke();
        c.fillStyle = lane.color;
        for (const p of pts) { c.beginPath(); c.arc(X(Date.parse(p.at)), Y(lane.value(p)), 1.8, 0, 2 * Math.PI); c.fill(); }
        c.lineWidth = 1;
      }
    }
    if (!points.length) this.label("The first trend point appears after 15 s of signal", pad.l + w / 2, pad.t + laneH + laneGap / 2 + 4, this.colors.faint, "center");
  }
}
