import { Monitor } from "../app/js/engine.js";
import { Simulator } from "../app/js/simulator.js";

/** Feeds `seconds` of simulated data through a Monitor; returns it with the events it raised. */
export function run(scenario, seconds, { startedAt = Date.UTC(2026, 0, 1) } = {}) {
  const monitor = new Monitor({}, { startedAt });
  const events = { breathing: [], episodes: [], trend: [], hrAlarm: [], spo2Alarm: [] };
  monitor.on("breathing", (level) => events.breathing.push(level));
  monitor.on("episode", (e) => events.episodes.push(e));
  monitor.on("trend", (p) => events.trend.push(p));
  monitor.on("frame", (m) => { events.hrAlarm.push(m.hrAlarm); events.spo2Alarm.push(m.spo2Alarm); });
  const sim = new Simulator({ scenario: scenario ?? undefined });
  while (monitor.elapsed < seconds) for (const line of sim.nextLines()) monitor.feed(line);
  return { monitor, events };
}
