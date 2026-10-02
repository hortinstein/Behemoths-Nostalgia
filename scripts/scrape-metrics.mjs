// Captures the current numbers from the Monsters & Memories metrics page and
// writes them to data/metrics/YYYY-MM-DD.json (plus data/metrics/latest.json).
//
// The page is rendered in headless Chromium so JS-driven dashboards work.
// Two sources are recorded:
//   - "metrics": label -> value pairs read from the rendered DOM (charts are skipped)
//   - "api":     any JSON responses the page fetched from its own host, which is
//                usually where the numbers come from in the first place
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TARGET_URL = process.env.METRICS_URL || 'https://account.monstersandmemories.com/metrics';
const OUT_DIR = process.env.OUT_DIR || 'data/metrics';

function parseNumber(text) {
  const m = text.replace(/,/g, '').trim().match(/^([-+]?\d*\.?\d+)\s*([kKmMbB%]?)$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const suffix = m[2].toLowerCase();
  if (suffix === 'k') n *= 1e3;
  if (suffix === 'm') n *= 1e6;
  if (suffix === 'b') n *= 1e9;
  return n;
}

async function main() {
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  });

  const host = new URL(TARGET_URL).host;
  const api = {};
  page.on('response', async (res) => {
    try {
      const u = new URL(res.url());
      const type = res.headers()['content-type'] || '';
      if (u.host !== host || !type.includes('json') || !res.ok()) return;
      api[u.pathname + u.search] = await res.json();
    } catch {
      // ignore bodies that can't be read or parsed
    }
  });

  const resp = await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  if (!resp || !resp.ok()) throw new Error(`GET ${TARGET_URL} failed: ${resp && resp.status()}`);
  // Give counters / late fetches a moment to settle.
  await page.waitForTimeout(3000);

  const pairs = await page.evaluate(() => {
    const NUM = /^[-+]?[\d,]*\.?\d+\s*[kKmMbB%]?$/;
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const skip = (el) => el.closest('svg, canvas, script, style, noscript, [aria-hidden="true"]');
    const out = [];

    // Tables: header -> cell, keyed by the row's first cell.
    for (const table of document.querySelectorAll('table')) {
      if (skip(table)) continue;
      const headers = [...table.querySelectorAll('thead th')].map((th) => clean(th.textContent));
      for (const tr of table.querySelectorAll('tbody tr, tr')) {
        const cells = [...tr.children].map((c) => clean(c.textContent));
        if (cells.length < 2 || tr.closest('thead')) continue;
        cells.slice(1).forEach((v, i) => {
          if (!NUM.test(v)) return;
          const col = headers[i + 1];
          out.push({ label: col ? `${cells[0]} / ${col}` : cells[0], value: v, source: 'table' });
        });
      }
    }

    // Definition lists.
    for (const dt of document.querySelectorAll('dt')) {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD' && !skip(dt)) {
        out.push({ label: clean(dt.textContent), value: clean(dd.textContent), source: 'dl' });
      }
    }

    // Stat cards: any leaf-ish element whose whole text is a number, labelled by
    // the nearest surrounding text.
    for (const el of document.body.querySelectorAll('*')) {
      if (skip(el) || el.closest('table, dl')) continue;
      const text = clean(el.textContent);
      if (!NUM.test(text) || [...el.children].some((c) => clean(c.textContent) === text)) continue;

      let label = '';
      for (let node = el; node && node !== document.body && !label; node = node.parentElement) {
        const sib = node.previousElementSibling || node.nextElementSibling;
        if (sib) {
          const t = clean(sib.textContent);
          if (t && !NUM.test(t) && t.length <= 80) label = t;
        }
        if (!label && node.parentElement) {
          const t = clean(node.parentElement.textContent).replace(text, '').trim();
          if (t && t.length <= 80) label = t;
        }
      }
      out.push({ label: label || el.id || el.className || 'unlabelled', value: text, source: 'card' });
    }
    return out;
  });

  await browser.close();

  const metrics = {};
  for (const { label, value, source } of pairs) {
    let key = label;
    for (let i = 2; key in metrics; i++) key = `${label} (${i})`;
    metrics[key] = { raw: value, value: parseNumber(value), source };
  }

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const record = { date, captured_at: now.toISOString(), url: TARGET_URL, metrics, api };

  if (!Object.keys(metrics).length && !Object.keys(api).length) {
    throw new Error('No metrics found on the page; refusing to write an empty snapshot');
  }

  await mkdir(OUT_DIR, { recursive: true });
  const json = JSON.stringify(record, null, 2) + '\n';
  await writeFile(path.join(OUT_DIR, `${date}.json`), json);
  await writeFile(path.join(OUT_DIR, 'latest.json'), json);
  console.log(`Wrote ${Object.keys(metrics).length} metrics, ${Object.keys(api).length} API payloads for ${date}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
