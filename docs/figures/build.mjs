#!/usr/bin/env node
// Renders the README images in docs/img with headless Chrome.
//
// Every docs/figures/<name>.html becomes docs/img/<name>.png, at the size in
// its <meta name="figure-size" content="WIDTHxHEIGHT"> tag and twice that
// resolution. <meta name="figure-format" content="webp"> saves a WebP
// instead. Figures that show signals import the app's
// own simulator and detector, so they show what the software does.
//
//   node docs/figures/build.mjs            every figure
//   node docs/figures/build.mjs wiring     one or more by name
//
// Needs Google Chrome or Chromium; set CHROME if it is not found.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const out = join(repo, "docs", "img");

// Pages outside docs/figures that are also captured.
const EXTRA = {
  "app-screenshot": { url: "/app/?at=164.5&still", size: [1440, 900], format: "png" },
};

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".woff2": "font/woff2", ".json": "application/json",
};

function findChrome() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error("Chrome not found; set CHROME to the browser's executable");
  return found;
}

function serve() {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = join(repo, path);
    if (!file.startsWith(repo)) return res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

/** Starts Chrome and returns a minimal DevTools-protocol client. */
async function launch() {
  const profile = mkdtempSync(join(tmpdir(), "neoapnea-figures-"));
  const proc = spawn(findChrome(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise((ok, fail) => {
    proc.stderr.on("data", (d) => { const m = String(d).match(/ws:\/\/\S+/); if (m) ok(m[0]); });
    proc.on("exit", () => fail(new Error("Chrome exited before it was ready")));
  });
  const ws = new WebSocket(url);
  await new Promise((ok) => ws.addEventListener("open", ok));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) fail(new Error(msg.error.message)); else ok(msg.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    pending.set(++id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const close = async () => {
    ws.close();
    proc.kill();
    if (proc.exitCode === null) await once(proc, "exit");
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { send, close };
}

async function capture({ send }, url, [width, height], format) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  await s("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await s("Page.navigate", { url });
  // Wait for the page, its fonts and a few frames of drawing.
  await s("Runtime.evaluate", {
    awaitPromise: true,
    expression: `new Promise((ok) => {
      const go = () => document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(ok, 400))));
      document.readyState === "complete" ? go() : addEventListener("load", go);
    })`,
  });
  const { data } = await s("Page.captureScreenshot", {
    format, ...(format === "webp" ? { quality: 88 } : {}),
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  await send("Target.closeTarget", { targetId });
  return Buffer.from(data, "base64");
}

function meta(file, name) {
  return readFileSync(file, "utf8").match(new RegExp(`name="${name}"\\s+content="([^"]+)"`))?.[1];
}

const pages = {};
for (const f of readdirSync(here).filter((f) => f.endsWith(".html"))) {
  const file = join(here, f);
  const size = meta(file, "figure-size")?.match(/^(\d+)x(\d+)$/);
  if (!size) throw new Error(`${f} has no <meta name="figure-size" content="WIDTHxHEIGHT">`);
  pages[f.slice(0, -5)] = {
    url: `/docs/figures/${f}`,
    size: [Number(size[1]), Number(size[2])],
    format: meta(file, "figure-format") || "png",
  };
}
Object.assign(pages, EXTRA);

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(pages);
for (const n of names) if (!pages[n]) throw new Error(`unknown figure ${n}; have ${Object.keys(pages).join(", ")}`);

mkdirSync(out, { recursive: true });
const server = await serve();
const browser = await launch();
try {
  for (const name of names) {
    const { url, size, format } = pages[name];
    const image = await capture(browser, `http://127.0.0.1:${server.address().port}${url}`, size, format);
    writeFileSync(join(out, `${name}.${format}`), image);
    console.log(`wrote docs/img/${name}.${format}`);
  }
} finally {
  await browser.close();
  server.close();
}
