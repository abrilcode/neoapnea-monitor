// Reads the Arduino over USB with the Web Serial API (Chrome and Edge on desktop).

export const BAUD_RATE = 57600; // must match Serial.begin() in the firmware

export const serialSupported = () => typeof navigator !== "undefined" && "serial" in navigator;

/** Splits a stream of text chunks into lines; a line may arrive across several chunks. */
export class LineSplitter {
  constructor() {
    this.rest = "";
  }

  push(chunk) {
    this.rest += chunk;
    const parts = this.rest.split("\n");
    this.rest = parts.pop();
    return parts.map((l) => l.replace(/\r$/, ""));
  }
}

/**
 * Asks the user to pick a port, opens it and calls onLine for every line.
 * Returns {close(), done}; `done` settles when the port stops sending
 * (closed, unplugged or failed).
 */
export async function openSerial(onLine, { baudRate = BAUD_RATE } = {}) {
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate });
  const decoder = new TextDecoderStream();
  const piped = port.readable.pipeTo(decoder.writable).catch(() => {});
  const reader = decoder.readable.getReader();
  const splitter = new LineSplitter();

  const done = (async () => {
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        for (const line of splitter.push(value)) onLine(line);
      }
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    done,
    async close() {
      await reader.cancel().catch(() => {});
      await piped;
      await port.close().catch(() => {});
    },
  };
}
