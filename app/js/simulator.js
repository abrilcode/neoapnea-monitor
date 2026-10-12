// Simulated hardware: produces the same serial lines as the firmware, so the
// monitor can run without an Arduino. The default scenario loops through
// normal breathing, a 25 s apnea with bradycardia and desaturation, and
// recovery, so every alarm fires. The signals are synthetic: they exercise the
// software, they are not a model of a preterm infant.

import { formatFrame, formatSpo2 } from "./protocol.js";

export const FS_CHEST = 8;     // accelerometer samples per second, as in the firmware
export const FS_PPG = 100;     // PPG samples per second (200 Hz with 2-sample averaging)
export const ONE_G = 16384;    // MPU-6050 raw counts per g at the default ±2 g range
export const FRAME_S = 0.25;   // one frame every 0.25 s

// Each segment: [duration s, breathing?, heart rate at the end (bpm), SpO2 at the end (%)].
// Heart rate and SpO2 change linearly within a segment.
export const DEFAULT_SCENARIO = [
  [40, true, 150, 96],   // normal breathing
  [8, false, 150, 95],   // breathing stops
  [17, false, 80, 76],   // apnea continues: bradycardia and desaturation
  [10, true, 140, 92],   // breathing resumes
  [25, true, 150, 96],   // recovery
];

export const BREATHS_PER_MIN = 50;
export const BREATH_AMPLITUDE = 1800; // raw counts; peaks reach about 1.1 g

function seededRandom(seed) {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Simulator {
  constructor({ scenario = DEFAULT_SCENARIO, seed = 1 } = {}) {
    this.scenario = scenario;
    this.cycle = scenario.reduce((sum, s) => sum + s[0], 0);
    this.random = seededRandom(seed);
    this.chunk = 0;
    this.heartPhase = 0;
    this.breathPhase = 0;
    this.pending = ["Accelerometer ready", "Pulse oximeter ready"];
  }

  gauss(sd) {
    const u = 1 - this.random();
    const v = this.random();
    return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Breathing flag, heart rate and SpO2 at time t (s), looping the scenario. */
  state(t) {
    t %= this.cycle;
    let [hrStart, spo2Start] = this.scenario[this.scenario.length - 1].slice(2);
    for (const [duration, breathing, hrEnd, spo2End] of this.scenario) {
      if (t < duration) {
        const f = t / duration;
        return { breathing, hr: hrStart + f * (hrEnd - hrStart), spo2: spo2Start + f * (spo2End - spo2Start) };
      }
      t -= duration;
      [hrStart, spo2Start] = [hrEnd, spo2End];
    }
    const last = this.scenario[this.scenario.length - 1];
    return { breathing: last[1], hr: hrStart, spo2: spo2Start };
  }

  /** Simulated seconds produced so far. */
  get time() {
    return this.chunk * FRAME_S;
  }

  /** Lines for the next 0.25 s. */
  nextLines() {
    const t0 = this.chunk * FRAME_S;
    const chest = [];
    for (let i = 0; i < 2; i++) {
      const t = t0 + i / FS_CHEST;
      const amplitude = this.state(t).breathing ? BREATH_AMPLITUDE : 0;
      const phase = 2 * Math.PI * (BREATHS_PER_MIN / 60) * t;
      chest.push(Math.trunc(ONE_G + amplitude * Math.sin(phase) + this.gauss(60)));
    }
    const ppg = [];
    for (let i = 0; i < 25; i++) {
      const { breathing, hr } = this.state(t0 + i / FS_PPG);
      this.heartPhase += (2 * Math.PI * hr) / 60 / FS_PPG;
      if (breathing) this.breathPhase += (2 * Math.PI * BREATHS_PER_MIN) / 60 / FS_PPG;
      const beat = this.heartPhase % (2 * Math.PI);
      const pulse = Math.exp(-((beat - 1.0) ** 2) / 0.18) + 0.4 * Math.exp(-((beat - 2.6) ** 2) / 0.3);
      ppg.push(Math.trunc(20000 + 600 * pulse + 100 * Math.sin(this.breathPhase) + this.gauss(15)));
    }
    const lines = [...this.pending];
    this.pending = [];
    if (this.chunk % 4 === 3) lines.push(formatSpo2(this.state(t0).spo2));
    lines.push(formatFrame(chest, ppg));
    this.chunk++;
    return lines;
  }
}
