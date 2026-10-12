import assert from "node:assert/strict";
import { test } from "node:test";

import { BREATHING, SETTINGS, summarize } from "../app/js/engine.js";
import { butterworthLowpass4, filtfilt, findPeaks, heartRate, percentile } from "../app/js/signal.js";
import { run } from "./helpers.mjs";

for (const bpm of [80, 120, 150, 180, 220]) {
  test(`heart rate estimate at ${bpm} bpm`, () => {
    const { monitor } = run([[60, true, bpm, 96]], 40);
    assert.ok(Math.abs(monitor.hr - bpm) <= 3, `got ${monitor.hr}`);
  });
}

test("heart rate is 0 for a flat signal", () => {
  assert.equal(heartRate(new Float64Array(1500).fill(20000), 100), 0);
});

test("the low-pass keeps DC and removes 30 Hz", () => {
  const sections = butterworthLowpass4(8, 100);
  const n = 1000;
  const x = Array.from({ length: n }, (_, i) => 5 + Math.sin((2 * Math.PI * 30 * i) / 100));
  const y = filtfilt(sections, x);
  const mid = y.slice(200, 800);
  assert.ok(Math.max(...mid) - Math.min(...mid) < 0.01);
  assert.ok(Math.abs(mid[300] - 5) < 1e-3);
});

test("findPeaks applies distance before prominence, as scipy does", () => {
  const x = [0, 5, 0, 4, 0, 0, 0, 3, 2.5, 3.2, 0];
  assert.deepEqual(findPeaks(x), [1, 3, 7, 9]);
  assert.deepEqual(findPeaks(x, { distance: 3 }), [1, 9]);
  assert.deepEqual(findPeaks(x, { minProminence: 3.5 }), [1, 3]);
});

test("percentile matches numpy's linear interpolation", () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 4.8);
});

test("normal breathing raises no alarm", () => {
  const { monitor, events } = run([[120, true, 150, 96]], 120);
  assert.equal(monitor.episodes.length, 0);
  assert.ok(!events.breathing.includes(BREATHING.warning) && !events.breathing.includes(BREATHING.apnea));
  assert.ok(!events.hrAlarm.slice(-100).some(Boolean));
  assert.ok(!events.spo2Alarm.some(Boolean));
});

test("breathing rate follows the breaths", () => {
  const { monitor } = run([[120, true, 150, 96]], 60);
  assert.ok(Math.abs(monitor.breathsPerMin - 50) <= 2, `got ${monitor.breathsPerMin}`);
});

test("a 10-20 s pause warns but is not recorded", () => {
  const { monitor, events } = run([[30, true, 150, 96], [15, false, 150, 95], [30, true, 150, 96]], 75);
  assert.ok(events.breathing.includes(BREATHING.warning));
  assert.ok(!events.breathing.includes(BREATHING.apnea));
  assert.equal(monitor.episodes.length, 0);
});

test("no breath since the start raises the alarm", () => {
  const { monitor } = run([[60, false, 150, 96]], 25);
  assert.equal(monitor.breathing, BREATHING.apnea);
  assert.equal(monitor.episodes.length, 0); // nothing to close until breathing starts
});

test("a 25 s apnea is detected and recorded", () => {
  // Default scenario: 40 s of breathing, then a 25 s apnea with bradycardia and desaturation.
  const { monitor, events } = run(null, 100);
  const levels = events.breathing.filter((l) => l !== BREATHING.ok);
  assert.deepEqual(levels.slice(0, 2), [BREATHING.warning, BREATHING.apnea]);
  assert.equal(events.breathing.at(-1), BREATHING.ok);
  assert.ok(events.hrAlarm.some(Boolean) && events.spo2Alarm.some(Boolean));

  assert.equal(monitor.episodes.length, 1);
  const e = monitor.episodes[0];
  assert.ok(e.pause_s >= 25 && e.pause_s <= 27, `pause ${e.pause_s}`);
  assert.ok(e.start_s >= 39 && e.start_s <= 41, `start ${e.start_s}`);
  assert.ok(e.hr_min < SETTINGS.hrLow, `hr_min ${e.hr_min}`);
  assert.ok(e.spo2_min < SETTINGS.spo2Low, `spo2_min ${e.spo2_min}`);
  assert.ok(Math.abs(Date.parse(e.started_at) - monitor.clock(e.start_s)) <= 10); // start_s is rounded to 0.01 s

  // The 15 s trend keeps each block's extremes, so the dips during the apnea survive.
  const spo2Min = Math.min(...events.trend.map((p) => p.spo2_min).filter((v) => v !== null));
  const hrMin = Math.min(...events.trend.map((p) => p.hr_min).filter((v) => v !== null));
  assert.equal(spo2Min, e.spo2_min);
  assert.ok(hrMin <= e.hr_min);
});

test("the summary covers only the chosen window", () => {
  const { monitor } = run(null, 200);
  assert.equal(monitor.episodes.length, 2);
  const now = monitor.clock();
  const all = summarize(monitor.episodes, monitor.trend, 30, now);
  assert.equal(all.apneas, 2);
  assert.ok(all.longestPauseS >= 25);
  assert.ok(all.spo2Min < SETTINGS.spo2Low && all.hrMin < SETTINGS.hrLow && all.hrMax >= 140);
  // A window that starts after the first episode only sees the second.
  const recent = summarize(monitor.episodes, monitor.trend, (now - Date.parse(monitor.episodes[1].started_at) + 1000) / 60000, now);
  assert.equal(recent.apneas, 1);
  const empty = summarize([], [], 30, now);
  assert.deepEqual(empty, { apneas: 0, longestPauseS: null, hrMin: null, hrMax: null, spo2Min: null });
});
