#!/usr/bin/env node
/**
 * DHRE Security Dashboard — shared sync API
 * ---------------------------------------------------------------------------
 * A tiny adapter that lets the dashboard's built-in remote-sync client store
 * its data in Upstash KV, so edits follow you between browsers, Chrome
 * profiles and devices.
 *
 * Why this exists instead of calling Upstash straight from the page:
 *   - the Upstash REST token would be readable by anyone who opens DevTools,
 *     and it grants full read/write on the whole database;
 *   - Upstash speaks raw Redis commands, but the dashboard expects
 *     {collection,payload} in and {payload,rev} out, with a monotonically
 *     increasing `rev` that tells it when the shared copy is genuinely newer.
 * This server holds the token, does the rev bookkeeping, and keeps the
 * dashboard's existing wire format untouched.
 *
 * Wire format (already spoken by the dashboard — see REMOTE in the HTML):
 *   GET  /?collection=sites          -> { payload: [...], rev: 12 }
 *                                       { payload: null,  rev: 0  } when empty
 *   POST /  { collection, payload }  -> { rev: 13 }
 *
 * Run:
 *   node sync-server.js
 *   PORT=8787 node sync-server.js
 *
 * Then point the dashboard at it (per browser profile):
 *   localStorage.setItem("dhre_sync_url", "http://127.0.0.1:8787")
 *
 * With no UPSTASH_REDIS_REST_URL configured the server falls back to an
 * in-memory store so you can prove the sync flow before wiring credentials.
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

/* ------------------------------------------------------------------ config */

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment variables win over the .env file.
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadEnvFile(path.join(__dirname, ".env"));

const DEFAULT_PORT = 8787;
const parsedPort = Number(process.env.PORT);
const PORT =
  Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536
    ? parsedPort
    : DEFAULT_PORT;
const HOST = process.env.HOST || "127.0.0.1";
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

// Collections the dashboard pushes. Kept as a safe-key pattern rather than a
// hard allowlist so a new collection in the HTML needs no server change, while
// still refusing arbitrary Redis key writes.
const COLLECTION_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

const dataKey = (col) => `dhre:sync:${col}`;
const revKey = (col) => `dhre:sync:rev:${col}`;

/* ---------------------------------------------------------------- backends */

/* One atomic round trip: bump the revision, store the revision inside the
   document, return the new revision. Doing both in Lua means two browsers
   editing at once can never leave a document holding a stale rev, which would
   make every other client ignore that collection forever.
   The payload is spliced in as an already-valid JSON string rather than run
   through cjson, because cjson encodes an empty array as {} — which would make
   an empty collection read back as "no data". */
const WRITE_SCRIPT = [
  "local rev = redis.call('INCR', KEYS[1])",
  "redis.call('SET', KEYS[2], '{\"payload\":' .. ARGV[1] .. ',\"rev\":' .. rev .. '}')",
  "return rev",
].join("\n");

async function upstashCommand(command) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      (body && (body.error || JSON.stringify(body))) || `Upstash HTTP ${res.status}`
    );
  }
  if (body && body.error) throw new Error(body.error);
  return body ? body.result : null;
}

const upstashStore = {
  name: "upstash",
  async read(col) {
    const raw = await upstashCommand(["GET", dataKey(col)]);
    if (raw == null) return { payload: null, rev: 0 };
    const doc = JSON.parse(raw);
    return {
      payload: Array.isArray(doc.payload) ? doc.payload : null,
      rev: typeof doc.rev === "number" ? doc.rev : 0,
    };
  },
  async write(col, payload) {
    const rev = await upstashCommand([
      "EVAL",
      WRITE_SCRIPT,
      "2",
      revKey(col),
      dataKey(col),
      JSON.stringify(payload),
    ]);
    return typeof rev === "number" ? rev : Number(rev) || 0;
  },
};

const memory = new Map();
const memoryStore = {
  name: "memory",
  async read(col) {
    const doc = memory.get(col);
    if (!doc) return { payload: null, rev: 0 };
    return { payload: doc.payload, rev: doc.rev };
  },
  async write(col, payload) {
    const rev = (memory.get(col)?.rev || 0) + 1;
    memory.set(col, { payload, rev });
    return rev;
  },
};

const store = UPSTASH_URL && UPSTASH_TOKEN ? upstashStore : memoryStore;

/* ------------------------------------------------------------------- http */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (url.pathname === "/health") {
    return send(res, 200, { ok: true, store: store.name });
  }

  try {
    if (req.method === "GET") {
      const col = url.searchParams.get("collection");
      if (!col) {
        return send(res, 200, {
          ok: true,
          service: "dhre-sync",
          store: store.name,
          contract: {
            read: "GET /?collection=<name>",
            write: "POST / { collection, payload }",
          },
        });
      }
      if (!COLLECTION_RE.test(col)) {
        return send(res, 400, { error: `invalid collection: ${col}` });
      }
      const { payload, rev } = await store.read(col);
      console.log(
        `[sync] GET  ${col.padEnd(10)} -> rev ${rev} (${payload ? payload.length : 0} items)`
      );
      return send(res, 200, { payload, rev });
    }

    if (req.method === "POST") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "body must be JSON" });
      }
      const col = body && body.collection;
      if (typeof col !== "string" || !COLLECTION_RE.test(col)) {
        return send(res, 400, { error: `invalid collection: ${col}` });
      }
      if (!Array.isArray(body.payload)) {
        return send(res, 400, { error: "payload must be an array" });
      }
      const rev = await store.write(col, body.payload);
      console.log(
        `[sync] POST ${col.padEnd(10)} -> rev ${rev} (${body.payload.length} items)`
      );
      return send(res, 200, { rev });
    }

    return send(res, 405, { error: `method not allowed: ${req.method}` });
  } catch (err) {
    console.error(`[sync] error on ${req.method} ${url.pathname}:`, err.message);
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  DHRE sync API listening on http://${HOST}:${PORT}`);
  if (store.name === "upstash") {
    console.log(`  Store: Upstash KV (${UPSTASH_URL})`);
  } else {
    console.log("  Store: IN-MEMORY — data is lost when this process stops.");
    console.log("  Add UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to .env for real persistence.");
  }
  console.log(`  Point the dashboard at it:  localStorage.setItem("dhre_sync_url", "http://${HOST}:${PORT}")`);
  console.log("  Health check:               curl http://" + HOST + ":" + PORT + "/health\n");
});
