# plat-planner-data

The public half of Plat Planner: the shared price snapshot and the privacy page. The app's own code lives in a separate, private repository.

- `snapshot.js` is the snapshot job. Every 4 hours (`.github/workflows/snapshot.yml`) it fetches the price of every prime set, part, relic and arcane at warframe.market's pace. It writes `public/snapshot.json` and `public/latest.json`, which GitHub Pages serves next to `pages/`.
- `engine/` is the app's compiled engine (`trade_desk_core.wasm` + `core.js`). The job uses it so the digests it writes are exactly what the app reads. Refresh it from the app repo with `node overwolf-app/tools/build.js --site`, then commit here.
- `pages/` holds the privacy policy and the landing page.

Each run starts from the live snapshot and refetches only what has gone stale. A run that gets almost nothing fails, so the old snapshot stays published.
