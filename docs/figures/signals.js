// Runs the app's simulator through the app's monitor and returns what it saw,
// for the figures that show signals.

import { BREATHING, Monitor } from "/app/js/engine.js";
import { parseFrame } from "/app/js/protocol.js";
import { butterworthLowpass4, filtfilt } from "/app/js/signal.js";
import { Simulator } from "/app/js/simulator.js";

export function record(seconds) {
  const monitor = new Monitor({}, { startedAt: Date.UTC(2026, 0, 1, 9) });
  const sim = new Simulator();
  const chest = { t: [], v: [] };
  const ppg = { t: [], v: [] };
  const frames = []; // one per 0.25 s: monitor state after the frame
  while (monitor.elapsed < seconds) {
    for (const line of sim.nextLines()) {
      const f = parseFrame(line);
      if (f) {
        f.chest.forEach((v, i) => { chest.t.push(monitor.elapsed + i / 8); chest.v.push(v); });
        f.ppg.forEach((v, i) => { ppg.t.push(monitor.nPpg / 100 + i / 100); ppg.v.push(v); });
      }
      if (monitor.feed(line) === "frame") {
        frames.push({
          t: monitor.elapsed, hr: monitor.hr, spo2: monitor.spo2, breathing: monitor.breathing,
          pause: monitor.pauseS, rr: monitor.breathsPerMin,
        });
      }
    }
  }
  ppg.v = Array.from(filtfilt(butterworthLowpass4(8, 100), ppg.v));
  return { monitor, chest, ppg, frames, BREATHING };
}

/** SVG polyline points for the samples between t0 and t1, in the box x, y, w, h. */
export function points({ t, v }, t0, t1, lo, hi, x, y, w, h, every = 1) {
  const out = [];
  for (let i = 0; i < t.length; i += every) {
    if (t[i] < t0 || t[i] > t1) continue;
    out.push(`${(x + ((t[i] - t0) / (t1 - t0)) * w).toFixed(1)},${(y + h - ((v[i] - lo) / (hi - lo)) * h).toFixed(1)}`);
  }
  return out.join(" ");
}

export function range(values, pad = 0.1) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  return [lo - span * pad, hi + span * pad];
}
