/**
 * export-seed.js — builds data/seed-snapshot.json from your real, local
 * data/data.json, so the public (keyless) Render deployment can show a real
 * one-time data pull instead of the fully synthetic mock engine.
 *
 * Run this LOCALLY, after refreshing with a real ALPHAVANTAGE_API_KEY +
 * SEC_EDGAR_CONTACT (Full refresh + Pull Fundamentals + Refresh Market
 * Pulse), whenever you want to update the public demo's snapshot:
 *
 *   node scripts/export-seed.js
 *
 * Then commit + push data/seed-snapshot.json like any other file — unlike
 * data/data.json (gitignored, holds your live working state + whatever
 * ad-hoc tickers you've searched), this file IS meant to be committed.
 *
 * PRIVACY: this script deliberately does NOT copy data.positions or
 * data.fxRates. Those hold your personal portfolio (share counts, cost
 * basis, purchase dates) if you've ever used Import Portfolio — that has no
 * business in a public repo, seed or not, and the public demo doesn't need
 * a pre-loaded portfolio anyway (visitors add their own via "+ Add to
 * Portfolio"). Only market/company data (prices, fundamentals, dividends,
 * news sentiment, market pulse) — all already public information sourced
 * from Alpha Vantage / SEC EDGAR — gets included.
 *
 * Every included ticker's dataSource is rewritten to "seeded" (it was "live"
 * in your local file) so the app never presents this frozen snapshot as if
 * it were a live feed — see server.js's SEED-loading code and the
 * ".src-pill.seeded" badge in public/index.html for how that's surfaced.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_FILE = path.join(ROOT, "data", "data.json");
const SEED_FILE = path.join(ROOT, "data", "seed-snapshot.json");

// Keep this in sync with server.js's DEFAULT_TICKERS — deliberately not
// require()'d from server.js itself, since that file calls server.listen()
// as a side effect of being loaded and this script has no business starting
// a server.
const DEFAULT_TICKERS = ["NVDA", "MSFT", "GOOGL", "AAPL", "META", "SOXX", "JPM", "V", "SHEL", "XOM", "XLE", "GLD", "AMZN", "TSLA"];
const PRICE_TICKERS = [...DEFAULT_TICKERS, "SPY"]; // SPY is the benchmark series, needed for beta/Sharpe to work in seeded mode too

function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`No ${DATA_FILE} found — run a real refresh locally first (Refresh Data → Full, Pull Fundamentals, Refresh Market Pulse), then re-run this script.`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

  const universe = {};
  let latestRefresh = null;
  for (const t of DEFAULT_TICKERS) {
    const u = data.universe && data.universe[t];
    if (!u) { console.warn(`  (skip) ${t}: not present in your local data.json yet — run a refresh that covers it first.`); continue; }
    universe[t] = { ...u, dataSource: "seeded" }; // was "live" locally — see file header
    if (u.lastRefreshed && (!latestRefresh || u.lastRefreshed > latestRefresh)) latestRefresh = u.lastRefreshed;
  }

  const prices = {};
  for (const t of PRICE_TICKERS) {
    if (data.prices && data.prices[t]) prices[t] = data.prices[t];
  }

  const dividends = {};
  for (const t of DEFAULT_TICKERS) {
    if (data.dividends && data.dividends[t]) dividends[t] = data.dividends[t];
  }

  const newsSentiment = {};
  for (const t of DEFAULT_TICKERS) {
    if (data.newsSentiment && data.newsSentiment[t]) newsSentiment[t] = data.newsSentiment[t];
  }

  const marketPulse = data.marketPulse
    ? { ...data.marketPulse, dataSource: "seeded" } // was "live"/"mixed" locally
    : null;

  const snapshotDate = latestRefresh || new Date().toISOString();

  const seed = { snapshotDate, universe, prices, dividends, newsSentiment, marketPulse };

  fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));

  console.log(`\nWrote ${SEED_FILE}`);
  console.log(`Snapshot date: ${snapshotDate}`);
  console.log(`Tickers included: ${Object.keys(universe).join(", ") || "(none — see warnings above)"}`);
  console.log(`Prices included: ${Object.keys(prices).join(", ") || "(none)"}`);
  console.log(`Market Pulse included: ${marketPulse ? "yes" : "no (run Refresh Market Pulse locally first)"}`);
  console.log(`\nExcluded on purpose (personal data, never seeded): positions, fxRates.`);
  console.log(`Next: review data/seed-snapshot.json, then git add/commit/push it like any other file.`);
}

main();
