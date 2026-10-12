// The monitor: turns serial lines into waveforms, vital signs, alarms and
// apnea episodes. Pure logic with no DOM, shared by the app, the tests and
// the README figures.

import { parseFrame, parseSpo2 } from "./protocol.js";
import { butterworthLowpass4, filtfilt, heartRate } from "./signal.js";

export const SETTINGS = {
  fsChest: 8,               // chest samples per second
  fsPpg: 100,               // PPG samples per second
  breathThreshold: 17500,   // raw z-axis counts (16384 = 1 g); a sample above it is a breath
  pauseWarningS: 10,        // warning after this many seconds without a breath
  pauseApneaS: 20,          // apnea alarm; a pause longer than this is recorded as an episode
  hrLow: 100,               // heart-rate alarm limits, bpm
  hrHigh: 180,
  spo2Low: 80,              // SpO2 alarm limit, %
  windowS: 15,              // seconds of signal shown and used for heart rate
  trendEveryS: 15,          // a heart-rate and SpO2 trend point is stored every 15 s
  rateWindowS: 30,          // breathing rate is counted over the last 30 s
  ppgCutoffHz: 8,           // low-pass applied to the pulse wave
};

/** Breathing alarm levels, in increasing order of urgency. */
export const BREATHING = { ok: "ok", warning: "warning", apnea: "apnea" };

const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;

export class Monitor {
  /**
   * @param {object} settings  overrides for SETTINGS
   * @param {object} options   startedAt: wall-clock ms of the start of monitoring
   */
  constructor(settings = {}, { startedAt = Date.now() } = {}) {
    this.s = { ...SETTINGS, ...settings };
    this.startedAt = startedAt;
    this.sections = butterworthLowpass4(this.s.ppgCutoffHz, this.s.fsPpg);
    this.listeners = {};
    this.reset();
  }

  reset() {
    // Last windowS seconds of signal
    this.chest = [];
    this.chestT = [];
    this.ppg = [];
    this.ppgT = [];
    this.ppgShown = [];
    this.nChest = 0;
    this.nPpg = 0;
    // Latest values
    this.hr = 0;              // 0 until the first full window
    this.spo2 = null;         // null until the sensor reports a valid value
    this.breathing = BREATHING.ok;
    this.hrAlarm = false;
    this.spo2Alarm = false;
    this.lastBreath = null;   // seconds since start of the last sample above the threshold
    this.breathOnsets = [];   // seconds since start of each breath
    this.wasAbove = false;
    // One value per frame (0.25 s) for the whole session
    this.hrHistory = [];
    this.spo2History = [];
    this.trend = [];
    this.episodes = [];
    this.frames = 0;
  }

  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
    return this;
  }

  emit(event, payload) {
    for (const fn of this.listeners[event] || []) fn(payload);
  }

  /** Seconds of signal received. */
  get elapsed() {
    return this.nChest / this.s.fsChest;
  }

  /** Wall-clock ms at `seconds` since the start of monitoring. */
  clock(seconds = this.elapsed) {
    return this.startedAt + seconds * 1000;
  }

  /** Seconds since the last breath, counting from the start before the first one. */
  get pauseS() {
    return this.elapsed - (this.lastBreath ?? 0);
  }

  /** Breaths per minute over the last rateWindowS seconds, or null in the first 10 s. */
  get breathsPerMin() {
    if (this.elapsed < 10) return null;
    const span = Math.min(this.s.rateWindowS, this.elapsed);
    const since = this.elapsed - span;
    const n = this.breathOnsets.filter((t) => t > since).length;
    return Math.round((n * 60) / span);
  }

  /** Feeds one line from the device. Returns "frame", "spo2" or null if it was ignored. */
  feed(line) {
    line = line.trim();
    const frame = parseFrame(line);
    if (frame) {
      this.processFrame(frame.chest, frame.ppg);
      return "frame";
    }
    const spo2 = parseSpo2(line);
    if (spo2) {
      // The SparkFun algorithm reports -999 or implausible values when it has no reading.
      if (spo2.valid && spo2.value > 60 && spo2.value <= 100) this.spo2 = spo2.value;
      return "spo2";
    }
    return null;
  }

  processFrame(chestSamples, ppgSamples) {
    const s = this.s;
    const fresh = [];
    for (const v of chestSamples) {
      const t = this.nChest / s.fsChest;
      this.chest.push(v);
      this.chestT.push(t);
      fresh.push([t, v]);
      this.nChest++;
    }
    for (const v of ppgSamples) {
      this.ppg.push(v);
      this.ppgT.push(this.nPpg / s.fsPpg);
      this.nPpg++;
    }
    const windowFull = this.chest.length >= s.fsChest * s.windowS;
    const trim = (arr, n) => { if (arr.length > n) arr.splice(0, arr.length - n); };
    trim(this.chest, s.fsChest * s.windowS);
    trim(this.chestT, s.fsChest * s.windowS);
    trim(this.ppg, s.fsPpg * s.windowS);
    trim(this.ppgT, s.fsPpg * s.windowS);

    if (windowFull) {
      const filtered = filtfilt(this.sections, this.ppg);
      this.ppgShown = Array.from(filtered);
      this.hr = heartRate(filtered, s.fsPpg);
      this.hrAlarm = this.hr < s.hrLow || this.hr > s.hrHigh;
    } else {
      this.ppgShown = this.ppg.slice();
    }
    this.spo2Alarm = this.spo2 !== null && this.spo2 < s.spo2Low;
    this.hrHistory.push(windowFull ? this.hr : 0);
    this.spo2History.push(this.spo2);
    this.frames++;

    this.detectBreaths(fresh);

    if (windowFull && this.nChest % (s.fsChest * s.trendEveryS) === 0) this.storeTrend();
    this.emit("frame", this);
  }

  /** A breath is a chest sample above the threshold; the alarm grows with the time since the last one. */
  detectBreaths(samples) {
    const s = this.s;
    for (const [t, v] of samples) {
      const above = v > s.breathThreshold;
      if (above) {
        if (!this.wasAbove) this.breathOnsets.push(t);
        if (this.breathing === BREATHING.apnea && this.lastBreath !== null) {
          this.recordEpisode(this.lastBreath, t - this.lastBreath, t);
        }
        this.lastBreath = t;
        this.setBreathing(BREATHING.ok);
      } else {
        const pause = t - (this.lastBreath ?? 0);
        if (pause > s.pauseApneaS) this.setBreathing(BREATHING.apnea);
        else if (pause > s.pauseWarningS) this.setBreathing(BREATHING.warning);
      }
      this.wasAbove = above;
    }
    const keepFrom = this.elapsed - s.rateWindowS;
    while (this.breathOnsets.length && this.breathOnsets[0] <= keepFrom) this.breathOnsets.shift();
  }

  setBreathing(level) {
    if (level !== this.breathing) {
      this.breathing = level;
      this.emit("breathing", level);
    }
  }

  /** Summarises an apnea that started at `start` s and lasted `pause` s, ending at `end` s. */
  recordEpisode(start, pause, end) {
    const perS = this.s.fsChest / 2; // history values per second: one per frame of 2 chest samples
    const first = Math.floor(start * perS);
    const last = Math.floor(end * perS) + 1;
    const hr = this.hrHistory.slice(first, last).filter((h) => h > 0);
    const spo2 = this.spo2History.slice(first, last).filter((v) => v !== null);
    const episode = {
      number: this.episodes.length + 1,
      started_at: new Date(this.clock(start)).toISOString(),
      start_s: Math.round(start * 100) / 100,
      pause_s: Math.round(pause * 100) / 100,
      hr_min: hr.length ? Math.min(...hr) : null,
      hr_max: hr.length ? Math.max(...hr) : null,
      hr_mean: hr.length ? Math.trunc(mean(hr)) : null,
      spo2_min: spo2.length ? Math.min(...spo2) : null,
      spo2_mean: spo2.length ? Math.trunc(mean(spo2)) : null,
    };
    this.episodes.push(episode);
    this.emit("episode", episode);
  }

  /** Stores the latest values and the extremes of the last trendEveryS seconds. */
  storeTrend() {
    const block = Math.round((this.s.trendEveryS * this.s.fsChest) / 2);
    const hr = this.hrHistory.slice(-block).filter((h) => h > 0);
    const spo2 = this.spo2History.slice(-block).filter((v) => v !== null);
    const point = {
      at: new Date(this.clock()).toISOString(),
      t_s: this.elapsed,
      hr: this.hr || null,
      hr_min: hr.length ? Math.min(...hr) : null,
      hr_max: hr.length ? Math.max(...hr) : null,
      spo2: this.spo2,
      spo2_min: spo2.length ? Math.min(...spo2) : null,
    };
    this.trend.push(point);
    this.emit("trend", point);
  }
}

/**
 * Summary of the episodes and trend points from the last `minutes`, ending at `now` (ms).
 * Values are null when there is nothing to summarise.
 */
export function summarize(episodes, trend, minutes, now) {
  const since = now - minutes * 60 * 1000;
  const inWindow = (iso) => {
    const t = Date.parse(iso);
    return t >= since && t <= now;
  };
  const eps = episodes.filter((e) => inWindow(e.started_at));
  const pts = trend.filter((p) => inWindow(p.at));
  const hrMins = pts.map((p) => p.hr_min ?? p.hr).filter((v) => v > 0);
  const hrMaxs = pts.map((p) => p.hr_max ?? p.hr).filter((v) => v > 0);
  const spo2Mins = pts.map((p) => p.spo2_min ?? p.spo2).filter((v) => v !== null && v !== undefined);
  return {
    apneas: eps.length,
    longestPauseS: eps.length ? Math.max(...eps.map((e) => e.pause_s)) : null,
    hrMin: hrMins.length ? Math.min(...hrMins) : null,
    hrMax: hrMaxs.length ? Math.max(...hrMaxs) : null,
    spo2Min: spo2Mins.length ? Math.min(...spo2Mins) : null,
  };
}
