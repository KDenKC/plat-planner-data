// The shared price snapshot: every price any Plat Planner install could need,
// fetched once by this job instead of ~2,000 times per new install.
//
//   node snapshot.js [previous-snapshot-url]   ->  public/snapshot.json, public/latest.json
//
// It runs the app's own engine (engine/, copied from the app build), so the
// digests it writes are exactly what the app would have made itself. Starting
// from the previous snapshot, it only refetches what has gone stale, paced at
// warframe.market's ~3 requests a second like the app.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Core = require("./engine/core.js");

const OUT = path.join(__dirname, "public");
const WFM_INTERVAL_MS = 340;
const RATE_LIMIT_PAUSE_MS = 30000;
// Prices go into the snapshot fresher than the app's own 6h limit, so a
// snapshot a few hours old still hands out prices the app counts as fresh.
const PRICE_REFRESH_S = 3 * 3600;
// Stop and publish what's done before GitHub's job limit, keeping the old
// digests for anything not reached; the next run carries on.
const MAX_RUN_MS = 45 * 60 * 1000;
const HEADERS = { "User-Agent": "plat-planner-snapshot (github.com/KDenKC/plat-planner-data)" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

// The same "no market data" placeholders the app stores on a 404.
function emptyDigestFor(key) {
  if (key.startsWith("top:")) return JSON.stringify({ sell: null, buy: null, n_sell: 0, n_buy: 0 });
  if (/^(hist|ranks|subtypes):/.test(key)) return "{}";
  return null;
}

function staleAfter(n) {
  return /^(top|hist):/.test(n.key) ? Math.min(n.ttl, PRICE_REFRESH_S) : n.ttl;
}

async function loadPrevious(url, core, format, book) {
  if (!url) return;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const prev = await res.json();
    if (prev.digest_format !== format) {
      console.log("previous snapshot is digest format", prev.digest_format, "- starting fresh");
      return;
    }
    for (const [key, d] of Object.entries(prev.digests || {})) {
      if (core.load(key, d.digest).ok) book[key] = d;
    }
    console.log("previous snapshot:", Object.keys(book).length, "digests from", prev.built_at);
  } catch (e) {
    console.log("no previous snapshot (" + e.message + ") - starting fresh");
  }
}

async function main() {
  const started = Date.now();
  const core = await Core.fromBytes(fs.readFileSync(path.join(__dirname, "engine", "trade_desk_core.wasm")));
  const format = core.call("info").digest_format;
  const book = {};   // key -> {fetched, digest}
  await loadPrevious(process.argv[2], core, format, book);

  const done = new Set();
  const stats = { fetched: 0, empty: 0, failed: 0, kept: 0 };
  let lastLimited = 0;
  let outOfTime = false;
  // The list grows as catalog keys arrive (sets and relics are only known once
  // the item lists are in), so keep asking until a pass adds nothing.
  for (let pass = 0; pass < 4 && !outOfTime; pass++) {
    const todo = core.call("snapshot_wanted").filter((n) => !done.has(n.key));
    if (!todo.length) break;
    console.log("pass", pass + 1 + ":", todo.length, "keys");
    for (const n of todo) {
      done.add(n.key);
      const have = book[n.key];
      if (have && now() - have.fetched < staleAfter(n)) { stats.kept++; continue; }
      if (Date.now() - started > MAX_RUN_MS) { outOfTime = true; break; }
      if (n.limited) {
        await sleep(Math.max(0, WFM_INTERVAL_MS - (Date.now() - lastLimited)));
        lastLimited = Date.now();
      }
      let res;
      try {
        res = await fetch(n.url, { headers: HEADERS });
      } catch (e) {
        stats.failed++;
        continue;
      }
      if (res.status === 429) {
        console.log("rate limited; pausing 30s");
        await sleep(RATE_LIMIT_PAUSE_MS);
        done.delete(n.key);   // try it again next pass
        continue;
      }
      const t = now();
      if (res.ok) {
        const d = core.ingest(n.key, await res.text());
        if (d.ok) { book[n.key] = { fetched: t, digest: d.digest }; stats.fetched++; }
        else { stats.failed++; console.log(n.key + ":", d.error); }
      } else if (res.status >= 400 && res.status < 500 && emptyDigestFor(n.key)) {
        const empty = emptyDigestFor(n.key);
        core.load(n.key, empty);
        book[n.key] = { fetched: t, digest: empty };
        stats.empty++;
      } else {
        stats.failed++;
      }
    }
  }

  const builtAt = new Date().toISOString();
  const snapshot = { digest_format: format, built_at: builtAt, digests: book };
  const text = JSON.stringify(snapshot);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "snapshot.json"), text);
  fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify({
    digest_format: format,
    built_at: builtAt,
    keys: Object.keys(book).length,
    bytes: text.length,
    file: "snapshot.json",
  }));
  console.log("done in", Math.round((Date.now() - started) / 60000), "min:", JSON.stringify(stats),
    "-", Object.keys(book).length, "digests,", (text.length / 1e6).toFixed(1), "MB",
    outOfTime ? "(stopped at the time limit; the next run continues)" : "");
  // A run that got almost nothing is a broken run: fail it so the old
  // snapshot stays published.
  if (Object.keys(book).length < 100) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
