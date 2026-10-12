// Patient records, kept in the browser's localStorage. Nothing leaves the
// machine unless you export it.

const KEY = "neoapnea-monitor.v1";
const TREND_KEEP_MS = 24 * 60 * 60 * 1000;

export const PATIENT_FIELDS = [
  ["name", "Name", "text"],
  ["bed", "Bed or ID", "text"],
  ["born", "Date of birth", "date"],
  ["admitted", "Admitted", "date"],
  ["birth_weight_g", "Birth weight (g)", "number"],
  ["weight_g", "Current weight (g)", "number"],
  ["physician", "Physician", "text"],
];

const EPISODE_COLUMNS = ["number", "started_at", "pause_s", "start_s", "hr_min", "hr_max", "hr_mean",
  "spo2_min", "spo2_mean", "simulated"];

function newId() {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return "p-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class RecordStore {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.data = { patients: {}, activeId: null };
    try {
      const saved = JSON.parse(storage.getItem(KEY) || "null");
      if (saved && typeof saved.patients === "object") this.data = saved;
    } catch {
      // Unreadable data: start empty rather than fail.
    }
  }

  save() {
    this.storage.setItem(KEY, JSON.stringify(this.data));
  }

  patients() {
    return Object.values(this.data.patients).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  get(id) {
    return this.data.patients[id] || null;
  }

  /** Creates a patient from `fields`, or updates it if fields.id exists. Returns the patient. */
  upsert(fields) {
    const existing = fields.id && this.data.patients[fields.id];
    const patient = existing || { id: newId(), created_at: new Date().toISOString(), episodes: [], trend: [] };
    for (const [key] of PATIENT_FIELDS) if (key in fields) patient[key] = String(fields[key] ?? "").trim();
    this.data.patients[patient.id] = patient;
    this.save();
    return patient;
  }

  remove(id) {
    delete this.data.patients[id];
    if (this.data.activeId === id) this.data.activeId = null;
    this.save();
  }

  get activeId() {
    return this.data.activeId && this.data.patients[this.data.activeId] ? this.data.activeId : null;
  }

  set activeId(id) {
    this.data.activeId = id && this.data.patients[id] ? id : null;
    this.save();
  }

  /** Stores an episode under the patient, numbered per patient. */
  addEpisode(id, episode) {
    const p = this.get(id);
    if (!p) return null;
    const stored = { ...episode, number: p.episodes.length + 1 };
    p.episodes.push(stored);
    this.save();
    return stored;
  }

  /** Stores a trend point, keeping the last 24 h. */
  addTrend(id, point) {
    const p = this.get(id);
    if (!p) return;
    p.trend.push(point);
    const cutoff = Date.parse(point.at) - TREND_KEEP_MS;
    while (p.trend.length && Date.parse(p.trend[0].at) < cutoff) p.trend.shift();
    this.save();
  }
}

export function toJSON(record) {
  return JSON.stringify(record, null, 2) + "\n";
}

/** Episodes as CSV, one row each. */
export function episodesCSV(episodes) {
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = episodes.map((e) => EPISODE_COLUMNS.map((c) => cell(e[c])).join(","));
  return [EPISODE_COLUMNS.join(","), ...rows].join("\n") + "\n";
}
