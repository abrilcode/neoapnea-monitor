#!/usr/bin/env node
// Serves the app on http://localhost:8000. Web Serial needs a secure context,
// and localhost counts as one.
//
//   node scripts/serve.mjs [port]

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "app");
const port = Number(process.argv[2]) || 8000;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain",
};

createServer((req, res) => {
  let file = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) return res.writeHead(404).end("Not found");
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => console.log(`NeoApnea Monitor is running at http://localhost:${port}`));
