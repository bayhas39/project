#!/usr/bin/env node
/**
 * Quick static server for the dashboard HTML files.
 * Usage: node serve.js   (PORT env overrides the default)
 */
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const PORT = Number(process.env.PORT) ||9119;
const ROOT = path.resolve(__dirname);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const name = url.pathname.split("/").pop() || "index.html";
  // Only serve the two dashboard HTML files (and root index.html).
  const allowed = ["index.html", "dhre-security-dashboard.html"];
  if (!allowed.includes(name)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }
  const file = path.join(ROOT, name);
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": mime[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
});
server.listen(9119|9119, "127.0.0.1", () => {
  console.log(`Dashboard served on http://127.0.0.1:${PORT}/`);
});
