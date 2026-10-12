// Alarm tones with the Web Audio API: one low beep every 3 s for a warning,
// three high beeps every 1.5 s for an alarm. Off until the user turns it on,
// as browsers only allow sound after a click.

const PATTERNS = {
  warning: { freq: 660, beeps: 1, everyMs: 3000 },
  alarm: { freq: 880, beeps: 3, everyMs: 1500 },
};

export class AlarmSound {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.level = "ok";
    this.timer = null;
  }

  enable() {
    this.ctx ||= new AudioContext();
    this.ctx.resume();
    this.enabled = true;
    this.loop();
  }

  disable() {
    this.enabled = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** level: "ok", "warning" or "alarm" (the most urgent of all alarms). */
  set(level) {
    if (level === this.level) return;
    this.level = level;
    clearTimeout(this.timer);
    this.timer = null;
    this.loop();
  }

  loop() {
    const pattern = PATTERNS[this.level];
    if (!this.enabled || !pattern || this.timer) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < pattern.beeps; i++) this.beep(pattern.freq, now + i * 0.18, 0.12);
    this.timer = setTimeout(() => { this.timer = null; this.loop(); }, pattern.everyMs);
  }

  beep(freq, start, duration) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.2, start + 0.01);
    gain.gain.setValueAtTime(0.2, start + duration - 0.03);
    gain.gain.linearRampToValueAtTime(0, start + duration);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }
}
