import assert from "node:assert/strict";
import { test } from "node:test";

import { Monitor } from "../app/js/engine.js";
import { formatFrame, parseFrame, parseSpo2 } from "../app/js/protocol.js";
import { Simulator } from "../app/js/simulator.js";

const VALID = "Buffer: 1, 16500, 16200, " + Array(25).fill("20000").join(", ") + ", 1";

test("parses a complete frame", () => {
  const frame = parseFrame(VALID);
  assert.deepEqual(frame.chest, [16500, 16200]);
  assert.equal(frame.ppg.length, 25);
});

test("accepts the line ending the firmware sends", () => {
  assert.equal(new Monitor().feed(VALID + "\r\n"), "frame");
  assert.equal(new Monitor().feed("SPO2= 97, 1\r\n"), "spo2");
});

test("rejects incomplete or garbled frames", () => {
  assert.equal(parseFrame("Buffer: 1, 16500, 16200, 20000"), null); // truncated line
  assert.equal(parseFrame(VALID.replace(/, 1$/, ", 7")), null);    // end marker lost
  assert.equal(parseFrame("Buffer: 1, 16500, x, 20000"), null);     // garbage
  assert.equal(parseFrame(VALID.replace("16200", "")), null);       // empty field
});

test("parses SpO2 lines", () => {
  assert.deepEqual(parseSpo2("SPO2= 97, 1"), { value: 97, valid: true });
  assert.deepEqual(parseSpo2("SPO2= -999, 0"), { value: -999, valid: false });
  assert.equal(parseSpo2("SPO2= 9"), null);
  assert.equal(parseSpo2("SPO2= nan, 1"), null);
});

test("formatFrame and parseFrame round-trip", () => {
  const ppg = Array.from({ length: 25 }, (_, i) => 20000 + i);
  assert.deepEqual(parseFrame(formatFrame([16384, 17000], ppg)), { chest: [16384, 17000], ppg });
});

test("the simulator speaks the firmware protocol", () => {
  const sim = new Simulator();
  const lines = [];
  while (lines.length < 200) lines.push(...sim.nextLines());
  const frames = lines.filter((l) => l.startsWith("Buffer: "));
  const spo2 = lines.filter((l) => l.startsWith("SPO2= "));
  assert.ok(frames.length > 150 && spo2.length > 30);
  assert.ok(frames.every((l) => parseFrame(l) !== null));
  assert.ok(spo2.every((l) => parseSpo2(l) !== null));
});

test("the simulator is deterministic for a seed", () => {
  const a = new Simulator({ seed: 7 }).nextLines();
  const b = new Simulator({ seed: 7 }).nextLines();
  assert.deepEqual(a, b);
});

test("malformed lines are ignored", () => {
  const monitor = new Monitor();
  for (let i = 0; i < 5000; i++) {
    assert.equal(monitor.feed("Buffer: 1, 2, 3"), null);
    assert.equal(monitor.feed("SPO2= nan"), null);
    assert.equal(monitor.feed("�� garbage"), null);
  }
  assert.equal(monitor.elapsed, 0);
});

test("invalid or implausible SpO2 readings are not shown", () => {
  const monitor = new Monitor();
  monitor.feed("SPO2= -999, 0");
  monitor.feed("SPO2= 97, 0");
  monitor.feed("SPO2= 30, 1");
  assert.equal(monitor.spo2, null);
  monitor.feed("SPO2= 97, 1");
  assert.equal(monitor.spo2, 97);
});
