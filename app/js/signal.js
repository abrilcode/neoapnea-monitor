// Signal processing for the pulse wave: a zero-phase Butterworth low-pass
// and a peak detector that follows scipy.signal.find_peaks (distance, then
// prominence), used to estimate heart rate.

/** Second-order sections of a 4th-order Butterworth low-pass (bilinear transform). */
export function butterworthLowpass4(cutoffHz, sampleHz) {
  const w0 = (2 * Math.PI * cutoffHz) / sampleHz;
  const cos = Math.cos(w0);
  // The two pole pairs of a 4th-order Butterworth filter.
  return [Math.PI / 8, (3 * Math.PI) / 8].map((angle) => {
    const q = 1 / (2 * Math.cos(angle));
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    return {
      b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, b2: (1 - cos) / 2 / a0,
      a1: (-2 * cos) / a0, a2: (1 - alpha) / a0,
    };
  });
}

function runSections(sections, x) {
  let y = Float64Array.from(x);
  for (const s of sections) {
    // Start from the steady state for the first sample to avoid a step transient.
    let z2 = (s.b2 - s.a2) * y[0];
    let z1 = (s.b1 - s.a1) * y[0] + z2;
    const out = new Float64Array(y.length);
    for (let i = 0; i < y.length; i++) {
      const v = s.b0 * y[i] + z1;
      z1 = s.b1 * y[i] - s.a1 * v + z2;
      z2 = s.b2 * y[i] - s.a2 * v;
      out[i] = v;
    }
    y = out;
  }
  return y;
}

/** Forward-backward filtering (no phase shift), with odd reflection at both ends. */
export function filtfilt(sections, x, pad = 60) {
  const n = x.length;
  if (n === 0) return new Float64Array(0);
  pad = Math.min(pad, n - 1);
  const ext = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) ext[i] = 2 * x[0] - x[pad - i];
  for (let i = 0; i < n; i++) ext[pad + i] = x[i];
  for (let i = 0; i < pad; i++) ext[pad + n + i] = 2 * x[n - 1] - x[n - 2 - i];
  const forward = runSections(sections, ext).reverse();
  const backward = runSections(sections, forward).reverse();
  return backward.slice(pad, pad + n);
}

/** Linear-interpolated percentile, as numpy.percentile. */
export function percentile(x, p) {
  const s = Float64Array.from(x).sort();
  if (s.length === 0) return NaN;
  const pos = (p / 100) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Indices of local maxima; a flat top counts once, at its middle. */
function localMaxima(x) {
  const peaks = [];
  let i = 1;
  while (i < x.length - 1) {
    if (x[i - 1] < x[i]) {
      let ahead = i + 1;
      while (ahead < x.length - 1 && x[ahead] === x[i]) ahead++;
      if (x[ahead] < x[i]) peaks.push((i + ahead - 1) >> 1);
      i = ahead;
    } else {
      i++;
    }
  }
  return peaks;
}

/** Peak prominence: height above the higher of the two lowest points before a higher sample. */
export function prominence(x, peak) {
  let leftMin = x[peak];
  for (let i = peak - 1; i >= 0 && x[i] <= x[peak]; i--) leftMin = Math.min(leftMin, x[i]);
  let rightMin = x[peak];
  for (let i = peak + 1; i < x.length && x[i] <= x[peak]; i++) rightMin = Math.min(rightMin, x[i]);
  return x[peak] - Math.max(leftMin, rightMin);
}

/** Peaks at least `distance` samples apart (taller ones win) with at least `minProminence`. */
export function findPeaks(x, { distance = 1, minProminence = 0 } = {}) {
  let peaks = localMaxima(x);
  if (distance > 1 && peaks.length > 1) {
    const keep = new Array(peaks.length).fill(true);
    const byHeight = peaks.map((_, i) => i).sort((a, b) => x[peaks[b]] - x[peaks[a]]);
    for (const j of byHeight) {
      if (!keep[j]) continue;
      for (let k = j - 1; k >= 0 && peaks[j] - peaks[k] < distance; k--) keep[k] = false;
      for (let k = j + 1; k < peaks.length && peaks[k] - peaks[j] < distance; k++) keep[k] = false;
    }
    peaks = peaks.filter((_, i) => keep[i]);
  }
  return peaks.filter((p) => prominence(x, p) >= minProminence);
}

/**
 * Beats per minute from the median of the last `lastBeats` intervals between
 * pulse peaks, or 0 if fewer than two peaks are found.
 *
 * Using only the most recent beats (3-6 s) lets a bradycardia show within
 * seconds. Peaks must be at least 0.25 s apart (up to 240 bpm, above the
 * normal range of a preterm infant) and stand out by 30% of the signal's
 * 5-95 percentile range.
 */
export function heartRate(ppg, sampleHz, lastBeats = 8) {
  const spread = percentile(ppg, 95) - percentile(ppg, 5);
  if (!(spread > 0)) return 0;
  const peaks = findPeaks(ppg, { distance: Math.floor(0.25 * sampleHz), minProminence: 0.3 * spread });
  if (peaks.length < 2) return 0;
  const intervals = [];
  for (let i = 1; i < peaks.length; i++) intervals.push(peaks[i] - peaks[i - 1]);
  return Math.round((60 * sampleHz) / median(intervals.slice(-lastBeats)));
}
