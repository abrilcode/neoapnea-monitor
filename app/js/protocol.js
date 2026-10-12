// Lines the firmware sends over USB serial (firmware/neoapnea_monitor/neoapnea_monitor.ino):
//
//   Buffer: 1, az0, az1, red0, ..., red24, 1    every 0.25 s
//   SPO2= <value>, <valid>                      after every 100 PPG samples
//
// A frame holds a start marker (1), two chest samples (accelerometer z axis),
// 25 PPG samples (red LED) and an end marker (1). Anything else, including
// truncated or garbled lines, is ignored.

export const FRAME_PREFIX = "Buffer: ";
export const SPO2_PREFIX = "SPO2= ";
export const FRAME_VALUES = 29;
export const CHEST_PER_FRAME = 2;
export const PPG_PER_FRAME = 25;

const INTEGER = /^-?\d+$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

/** {chest, ppg} from a frame line, or null if the line is not a complete frame. */
export function parseFrame(line) {
  if (!line.startsWith(FRAME_PREFIX)) return null;
  const parts = line.slice(FRAME_PREFIX.length).split(",").map((p) => p.trim());
  if (parts.length !== FRAME_VALUES || !parts.every((p) => NUMBER.test(p))) return null;
  const values = parts.map(Number);
  if (values[0] !== 1 || values[FRAME_VALUES - 1] !== 1) return null;
  return {
    chest: values.slice(1, 1 + CHEST_PER_FRAME),
    ppg: values.slice(1 + CHEST_PER_FRAME, FRAME_VALUES - 1),
  };
}

/** {value, valid} from an SpO2 line, or null if the line is malformed. */
export function parseSpo2(line) {
  if (!line.startsWith(SPO2_PREFIX)) return null;
  const parts = line.slice(SPO2_PREFIX.length).split(",").map((p) => p.trim());
  if (parts.length !== 2 || !parts.every((p) => INTEGER.test(p))) return null;
  return { value: Number(parts[0]), valid: Number(parts[1]) === 1 };
}

/** Builds a frame line; used by the simulator. */
export function formatFrame(chest, ppg) {
  return FRAME_PREFIX + [1, ...chest, ...ppg, 1].map((v) => Math.round(v)).join(", ");
}

export function formatSpo2(value, valid = true) {
  return `${SPO2_PREFIX}${Math.round(value)}, ${valid ? 1 : 0}`;
}
