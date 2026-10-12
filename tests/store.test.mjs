import assert from "node:assert/strict";
import { test } from "node:test";

import { LineSplitter } from "../app/js/serial.js";
import { RecordStore, episodesCSV } from "../app/js/store.js";

class MemoryStorage {
  constructor() { this.items = {}; }
  getItem(k) { return k in this.items ? this.items[k] : null; }
  setItem(k, v) { this.items[k] = String(v); }
}

test("patients and episodes persist across instances", () => {
  const storage = new MemoryStorage();
  const store = new RecordStore(storage);
  const p = store.upsert({ name: " Baby A ", bed: "3", weight_g: 1450 });
  store.activeId = p.id;
  store.addEpisode(p.id, { number: 7, pause_s: 25.1, started_at: "2026-01-01T00:00:40.000Z" });
  store.addEpisode(p.id, { number: 8, pause_s: 22.0, started_at: "2026-01-01T00:02:20.000Z" });

  const again = new RecordStore(storage);
  assert.equal(again.activeId, p.id);
  const saved = again.get(p.id);
  assert.equal(saved.name, "Baby A");
  assert.equal(saved.weight_g, "1450");
  assert.deepEqual(saved.episodes.map((e) => e.number), [1, 2]); // renumbered per patient
});

test("updating a patient keeps its records", () => {
  const store = new RecordStore(new MemoryStorage());
  const p = store.upsert({ name: "Baby B" });
  store.addEpisode(p.id, { pause_s: 21 });
  store.upsert({ id: p.id, name: "Baby B.", bed: "5" });
  assert.equal(store.patients().length, 1);
  assert.equal(store.get(p.id).bed, "5");
  assert.equal(store.get(p.id).episodes.length, 1);
});

test("the trend keeps the last 24 hours", () => {
  const store = new RecordStore(new MemoryStorage());
  const p = store.upsert({ name: "Baby C" });
  store.addTrend(p.id, { at: "2026-01-01T00:00:00.000Z", hr: 150 });
  store.addTrend(p.id, { at: "2026-01-01T12:00:00.000Z", hr: 150 });
  store.addTrend(p.id, { at: "2026-01-02T06:00:00.000Z", hr: 150 });
  assert.deepEqual(store.get(p.id).trend.map((t) => t.at.slice(0, 13)), ["2026-01-01T12", "2026-01-02T06"]);
});

test("removing the active patient clears the selection", () => {
  const store = new RecordStore(new MemoryStorage());
  const p = store.upsert({ name: "Baby D" });
  store.activeId = p.id;
  store.remove(p.id);
  assert.equal(store.activeId, null);
  assert.equal(store.patients().length, 0);
});

test("corrupt saved data starts an empty store", () => {
  const storage = new MemoryStorage();
  storage.setItem("neoapnea-monitor.v1", "{not json");
  assert.deepEqual(new RecordStore(storage).patients(), []);
});

test("episodes export as CSV", () => {
  const csv = episodesCSV([{ number: 1, started_at: "2026-01-01T00:00:40.000Z", pause_s: 25.12, hr_min: 80, spo2_min: null, simulated: true }]);
  const [header, row] = csv.trim().split("\n");
  assert.equal(header, "number,started_at,pause_s,start_s,hr_min,hr_max,hr_mean,spo2_min,spo2_mean,simulated");
  assert.equal(row, "1,2026-01-01T00:00:40.000Z,25.12,,80,,,,,true");
});

test("lines split across serial chunks are reassembled", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push("Buffer: 1, 2"), []);
  assert.deepEqual(s.push(", 3\r\nSPO2= 9"), ["Buffer: 1, 2, 3"]);
  assert.deepEqual(s.push("7, 1\r\n\r\n"), ["SPO2= 97, 1", ""]);
});
