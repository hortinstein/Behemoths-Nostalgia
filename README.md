# Behemoths-Nostalgia

Daily snapshot of the current numbers on
<https://account.monstersandmemories.com/metrics> (no graphs).

- `scripts/scrape-metrics.mjs` renders the page in headless Chromium and records
  - `metrics`: label → value pairs read from the page (stat cards, tables, `<dl>`s; charts skipped)
  - `api`: the raw JSON the page loads from its own backend
- `.github/workflows/scrape-metrics.yml` runs it daily (and on demand via **Run workflow**)
  and commits `data/metrics/YYYY-MM-DD.json` plus `data/metrics/latest.json`.

Run locally: `npm ci && npx playwright install chromium && npm run scrape`.
