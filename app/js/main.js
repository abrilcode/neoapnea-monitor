// The NeoApnea Monitor app: connects a signal source (simulator or Arduino) to the
// monitor and draws it.
//
// URL options: ?speed=4 starts the simulator faster, ?at=160 fast-forwards it
// to 160 s, ?still freezes it there (used for the README screenshot) and
// ?source=serial opens on the Arduino tab.

import { BREATHING, Monitor, SETTINGS, summarize } from "./engine.js";
import { FRAME_S, Simulator } from "./simulator.js";
import { BAUD_RATE, openSerial, serialSupported } from "./serial.js";
import { PATIENT_FIELDS, RecordStore, episodesCSV, toJSON } from "./store.js";
import { TrendChart, Waveform } from "./charts.js";
import { AlarmSound } from "./sound.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const store = new RecordStore();
const sound = new AlarmSound();
const charts = {
  chest: new Waveform($("chart-chest"), { color: "breath", threshold: SETTINGS.breathThreshold, minSpan: 2500 }),
  ppg: new Waveform($("chart-ppg"), { color: "pulse", minSpan: 60 }),
  trend: new TrendChart($("chart-trend")),
};

let monitor = new Monitor();
let source = null;          // {kind: "demo" | "serial", stop()}
let summaryMin = 30;
let dirty = true;
let trendDrawnAt = 0;

// ------------------------------------------------------------ sources

function newSession(startedAt = Date.now()) {
  monitor = new Monitor({}, { startedAt });
  const simulated = source?.kind === "demo";
  monitor.on("frame", () => { dirty = true; });
  monitor.on("episode", (episode) => {
    if (store.activeId) store.addEpisode(store.activeId, { ...episode, simulated });
    renderSide();
  });
  monitor.on("trend", (point) => {
    if (store.activeId) store.addTrend(store.activeId, { ...point, simulated });
    renderSide();
  });
  dirty = true;
  renderSide();
}

function stopSource() {
  source?.stop();
  source = null;
}

function startDemo({ speed = 1, at = 0, still = false } = {}) {
  stopSource();
  const sim = new Simulator();
  source = { kind: "demo", sim, speed, timer: null, stop() { clearInterval(this.timer); } };
  newSession(Date.now() - at * 1000);
  while (sim.time < at) for (const line of sim.nextLines()) monitor.feed(line);
  if (still) {
    // A frozen frame of a running demo, as used for the README screenshot.
    setStatus("live", `Simulator · ${speed}×`);
    return;
  }
  let base = { chunk: sim.chunk, ms: performance.now() };
  source.setSpeed = (s) => {
    source.speed = s;
    base = { chunk: sim.chunk, ms: performance.now() };
    setStatus("live", `Simulator · ${s}×`);
  };
  source.timer = setInterval(() => {
    const due = base.chunk + Math.floor((((performance.now() - base.ms) / 1000) * source.speed) / FRAME_S);
    for (let n = 0; sim.chunk < due && n < 400; n++) for (const line of sim.nextLines()) monitor.feed(line);
  }, 40);
  setStatus("live", `Simulator · ${speed}×`);
}

async function connectSerial() {
  if (source?.kind === "serial") {
    stopSource();
    $("connect").textContent = "Connect";
    setStatus("idle", "Disconnected");
    return;
  }
  stopSource();
  try {
    let current = null;
    const conn = await openSerial((line) => current?.feed(line));
    source = { kind: "serial", conn, stop() { conn.close(); } };
    newSession();
    current = monitor;
    $("connect").textContent = "Disconnect";
    setStatus("live", `Arduino · ${BAUD_RATE} baud`);
    conn.done.catch(() => {}).then(() => {
      if (source?.conn !== conn) return;
      source = null;
      $("connect").textContent = "Connect";
      setStatus("error", "Arduino disconnected");
    });
  } catch (err) {
    if (err.name === "NotFoundError") setStatus("idle", "No port selected");
    else setStatus("error", `Could not open the port: ${err.message}`);
  }
}

function chooseSource(kind) {
  for (const b of document.querySelectorAll("[data-source]")) b.setAttribute("aria-pressed", String(b.dataset.source === kind));
  $("demo-controls").hidden = kind !== "demo";
  $("serial-controls").hidden = kind !== "serial";
  if (kind === "demo") {
    startDemo({ speed: Number($("speed").value) });
  } else {
    stopSource();
    newSession();
    if (serialSupported()) {
      $("connect").disabled = false;
      setStatus("idle", "Plug in the Arduino and press Connect");
    } else {
      $("connect").disabled = true;
      setStatus("error", "Web Serial needs Chrome or Edge on a desktop");
    }
  }
}

function setStatus(state, text) {
  $("status").dataset.state = state;
  $("status-text").textContent = text;
}

// ------------------------------------------------------------ drawing

const pad2 = (n) => String(n).padStart(2, "0");
const hms = (s) => `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(Math.floor(s) % 60)}`;
const clockTime = (iso) => { const d = new Date(iso); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const orDash = (v, f = (x) => x) => (v === null || v === undefined ? "--" : f(v));

function setAlarm(id, level, text) {
  const el = $(id);
  el.dataset.level = level;
  el.querySelector(".alarm-text").textContent = text;
}

function renderLive() {
  const m = monitor;
  const hasSignal = m.elapsed > 0;
  const windowFull = m.elapsed >= SETTINGS.windowS;
  const pauseLevel = { [BREATHING.ok]: "ok", [BREATHING.warning]: "warning", [BREATHING.apnea]: "alarm" }[m.breathing];
  const pause = m.pauseS;

  charts.chest.draw({ t: m.chestT, y: m.chest, pause: { from: m.lastBreath ?? 0, seconds: pause, level: pauseLevel } });
  charts.ppg.draw({ t: m.ppgT, y: m.ppgShown });

  $("elapsed").textContent = hms(m.elapsed);
  $("rr").textContent = orDash(m.breathsPerMin);
  $("pause").textContent = hasSignal ? pause.toFixed(1) : "--";
  $("vital-pause").dataset.level = hasSignal ? pauseLevel : "ok";
  $("hr").textContent = m.hr > 0 ? m.hr : "--";
  $("vital-hr").dataset.level = windowFull && m.hrAlarm ? "alarm" : "ok";
  $("spo2").textContent = orDash(m.spo2);
  $("vital-spo2").dataset.level = m.spo2Alarm ? "alarm" : "ok";

  if (!hasSignal) {
    for (const id of ["alarm-breathing", "alarm-hr", "alarm-spo2"]) setAlarm(id, "idle", "Waiting for signal");
  } else {
    setAlarm("alarm-breathing", pauseLevel, {
      ok: "Normal",
      warning: `No breath for ${Math.floor(pause)} s`,
      alarm: `Apnea · no breath for ${Math.floor(pause)} s`,
    }[pauseLevel]);
    if (!windowFull) setAlarm("alarm-hr", "idle", "Measuring");
    else if (!m.hrAlarm) setAlarm("alarm-hr", "ok", "In range");
    else setAlarm("alarm-hr", "alarm", m.hr === 0 ? "No pulse detected" : `${m.hr < SETTINGS.hrLow ? "Low" : "High"} · ${m.hr} bpm`);
    if (m.spo2 === null) setAlarm("alarm-spo2", "idle", "No reading yet");
    else setAlarm("alarm-spo2", m.spo2Alarm ? "alarm" : "ok", m.spo2Alarm ? `Low · ${m.spo2} %` : "In range");
  }
  const anyAlarm = pauseLevel === "alarm" || (windowFull && m.hrAlarm) || m.spo2Alarm;
  sound.set(!hasSignal ? "ok" : anyAlarm ? "alarm" : pauseLevel === "warning" ? "warning" : "ok");

  const now = performance.now();
  if (now - trendDrawnAt > 500) {
    trendDrawnAt = now;
    renderTrend();
  }
}

function records() {
  const p = store.activeId && store.get(store.activeId);
  if (p) return { episodes: p.episodes, trend: p.trend, scope: "Saved for this patient", patient: p };
  return { episodes: monitor.episodes, trend: monitor.trend, scope: "This session, not saved", patient: null };
}

function renderTrend() {
  const { episodes, trend } = records();
  const to = monitor.clock();
  const first = Math.min(monitor.startedAt, ...trend.slice(0, 1).map((p) => Date.parse(p.at)));
  const span = Math.min(summaryMin * 60000, Math.max(5 * 60000, (to - first) * 1.15));
  charts.trend.draw({
    points: trend, episodes, from: to - span, to,
    hrLimits: [SETTINGS.hrLow, SETTINGS.hrHigh], spo2Low: SETTINGS.spo2Low,
  });
}

function renderSide() {
  const { episodes, trend, scope } = records();
  const s = summarize(episodes, trend, summaryMin, monitor.clock());
  $("sum-apneas").textContent = s.apneas;
  $("sum-pause").textContent = orDash(s.longestPauseS, (v) => v.toFixed(1));
  $("sum-spo2").textContent = orDash(s.spo2Min);
  $("sum-hr").textContent = s.hrMin === null ? "--" : `${s.hrMin}–${s.hrMax}`;
  $("episodes-scope").textContent = scope;

  const list = $("episodes");
  list.replaceChildren(...episodes.slice(-50).reverse().map((e) => {
    const li = document.createElement("li");
    const cells = [
      ["n", `#${e.number}`],
      ["pause", `${e.pause_s.toFixed(1)} s pause`],
      ["when", clockTime(e.started_at)],
      ["detail", `HR ${orDash(e.hr_min)}–${orDash(e.hr_max)} bpm · SpO2 min ${orDash(e.spo2_min)} %${e.simulated ? " · simulated" : ""}`],
    ];
    for (const [cls, text] of cells) {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = text;
      li.append(span);
    }
    return li;
  }));
  $("episodes-empty").hidden = episodes.length > 0;
  renderTrend();
}

function renderPatientButton() {
  const p = store.activeId && store.get(store.activeId);
  $("patient-name").textContent = p ? p.name || p.bed || "Unnamed patient" : "None";
}

function loop() {
  if (dirty) {
    dirty = false;
    renderLive();
  }
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------ patients

let editing = null;

function openPatients() {
  editing = store.activeId || store.patients()[0]?.id || null;
  renderPatientDialog();
  $("patient-dialog").showModal();
}

function renderPatientDialog() {
  const list = $("patient-list");
  list.replaceChildren(...store.patients().map((p) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-pressed", String(p.id === editing));
    b.textContent = p.name || p.bed || "Unnamed patient";
    const small = document.createElement("small");
    small.textContent = `${p.bed ? `Bed ${p.bed} · ` : ""}${p.episodes.length} episodes${p.id === store.activeId ? " · monitoring" : ""}`;
    b.append(small);
    b.addEventListener("click", () => { editing = p.id; renderPatientDialog(); });
    li.append(b);
    return li;
  }));
  const p = editing ? store.get(editing) : null;
  $("patient-fields").replaceChildren(...PATIENT_FIELDS.map(([key, label, type]) => {
    const l = document.createElement("label");
    l.textContent = label;
    const input = document.createElement("input");
    input.name = key;
    input.type = type;
    input.value = p?.[key] ?? "";
    if (type === "number") input.min = "0";
    l.append(input);
    return l;
  }));
  $("patient-delete").hidden = !p;
  $("patient-save").textContent = p ? "Save and monitor" : "Add and monitor";
}

function savePatient() {
  const fields = { id: editing || undefined };
  for (const input of $("patient-fields").querySelectorAll("input")) fields[input.name] = input.value;
  const p = store.upsert(fields);
  store.activeId = p.id;
  renderPatientButton();
  renderSide();
}

// ------------------------------------------------------------ export

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportName(ext) {
  const { patient } = records();
  const who = patient ? (patient.name || patient.bed || patient.id).toLowerCase().replace(/[^a-z0-9]+/g, "-") : "session";
  return `neoapnea-${who}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

// ------------------------------------------------------------ wiring

for (const b of document.querySelectorAll("[data-source]")) b.addEventListener("click", () => chooseSource(b.dataset.source));
$("speed").addEventListener("change", () => source?.setSpeed?.(Number($("speed").value)));
$("restart").addEventListener("click", () => startDemo({ speed: Number($("speed").value) }));
$("connect").addEventListener("click", connectSerial);
$("sound").addEventListener("click", () => {
  const on = $("sound").getAttribute("aria-pressed") !== "true";
  if (on) sound.enable(); else sound.disable();
  $("sound").setAttribute("aria-pressed", String(on));
  $("sound").textContent = on ? "Sound on" : "Sound off";
});
for (const b of $("window").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    summaryMin = Number(b.dataset.min);
    for (const x of $("window").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    renderSide();
  });
}
$("patient-button").addEventListener("click", openPatients);
$("patient-new").addEventListener("click", () => { editing = null; renderPatientDialog(); });
$("patient-form").addEventListener("submit", savePatient);
$("patient-none").addEventListener("click", () => {
  store.activeId = null;
  renderPatientButton();
  renderSide();
  $("patient-dialog").close();
});
$("patient-delete").addEventListener("click", () => {
  const p = editing && store.get(editing);
  if (p && confirm(`Delete ${p.name || "this patient"} and their ${p.episodes.length} recorded episodes?`)) {
    store.remove(p.id);
    editing = store.patients()[0]?.id || null;
    renderPatientButton();
    renderPatientDialog();
    renderSide();
  }
});
$("export-csv").addEventListener("click", () => download(exportName("csv"), episodesCSV(records().episodes), "text/csv"));
$("export-json").addEventListener("click", () => {
  const { patient, episodes, trend } = records();
  const record = patient || { session_started_at: new Date(monitor.startedAt).toISOString(), episodes, trend };
  download(exportName("json"), toJSON(record), "application/json");
});

renderPatientButton();
if (params.get("source") === "serial") {
  chooseSource("serial");
} else {
  const speed = Number(params.get("speed")) || 1;
  if ([...$("speed").options].some((o) => Number(o.value) === speed)) $("speed").value = String(speed);
  startDemo({ speed, at: Number(params.get("at")) || 0, still: params.has("still") });
}
requestAnimationFrame(loop);
