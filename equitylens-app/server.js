/**
 * EquityLens local server — zero external dependencies (Node built-ins only).
 *
 * Responsibilities:
 *  1. Serve the static app from ./public
 *  2. POST /api/refresh          — refresh a list of (already-known) tickers.
 *  3. POST /api/import-portfolio — import positions from an uploaded Excel
 *                                  file (parsed client-side). Resolves new
 *                                  tickers via SYMBOL_SEARCH, fetches live
 *                                  data when the free-tier budget allows,
 *                                  otherwise marks them "pending" so the
 *                                  position still shows up (at cost basis)
 *                                  and can be refreshed later.
 *  4. GET  /api/refresh/status?jobId=...  — poll progress for either job type.
 *  5. GET  /api/status    — current data.json metadata (last refreshed, source).
 *
 * Run: node server.js   (no npm install needed)
 * Optional: set ALPHAVANTAGE_API_KEY in a .env file next to this script.
 */
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3300;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const USAGE_FILE = path.join(DATA_DIR, "av-usage.json");
const ENV_FILE = path.join(ROOT, ".env");

const AV_DAILY_CAP = 25;         // Alpha Vantage free-tier daily request cap
const AV_MIN_SPACING_MS = 15000; // stay under 5 calls/minute

/* ---------------- .env loader (no dotenv dependency) ---------------- */
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const out = {};
  fs.readFileSync(ENV_FILE, "utf8").split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  });
  return out;
}
const ENV = { ...loadEnv(), ...process.env };
const AV_KEY = ENV.ALPHAVANTAGE_API_KEY || "";

/* ---------------- universe ---------------- */
// The static "demo" universe. Anything imported beyond this becomes part of
// data.json's universe dynamically — see isKnownTicker().
const DEFAULT_TICKERS = ["NVDA","MSFT","GOOGL","AAPL","META","SOXX","JPM","V","SHEL","XOM","XLE","GLD","AMZN","TSLA"];
const BENCH_TICKER = "SPY";
const TICKER_PATTERN = /^[A-Z0-9.\-]{1,6}$/;

function isKnownTicker(t, data) {
  return DEFAULT_TICKERS.includes(t) || !!(data.universe && data.universe[t]);
}

/* ---------------- usage tracking (stay under the daily free-tier cap) ---------------- */
function todayStr() { return new Date().toISOString().slice(0, 10); }
function readUsage() {
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
    if (raw.date !== todayStr()) return { date: todayStr(), count: 0 };
    return raw;
  } catch { return { date: todayStr(), count: 0 }; }
}
function writeUsage(u) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2));
}
function remainingCallsToday() {
  const u = readUsage();
  return Math.max(0, AV_DAILY_CAP - u.count);
}
function recordCalls(n) {
  const u = readUsage();
  u.count += n;
  writeUsage(u);
  return u.count;
}

/* ---------------- Alpha Vantage HTTP helper ---------------- */
function avRequest(params) {
  return new Promise((resolve, reject) => {
    const qs = new url.URLSearchParams({ ...params, apikey: AV_KEY }).toString();
    const reqUrl = `https://www.alphavantage.co/query?${qs}`;
    https.get(reqUrl, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (json.Note || json.Information) {
            // Alpha Vantage returns 200 OK with a "Note"/"Information" field
            // when the request is throttled or malformed rather than a real payload.
            reject(new Error(json.Note || json.Information));
          } else {
            resolve(json);
          }
        } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------- deterministic mock engine (fallback, no key needed) ---------------- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function series(seed, length, scale) {
  const rand = mulberry32(seed);
  const out = [];
  for (let i = 0; i < length; i++) out.push((rand() - 0.5) * 2 * scale);
  return out;
}
const MOCK_SEEDS = { NVDA:101, MSFT:102, GOOGL:103, JPM:104, SHEL:105, XLE:106, GLD:107, SOXX:108, AAPL:109, AMZN:110, TSLA:111, V:112, META:113, XOM:114 };
const MOCK_PRICE = { NVDA:138.2, MSFT:445.1, GOOGL:178.35, JPM:214.6, SHEL:68.9, XLE:91.4, GLD:245.8, SOXX:228.15, AAPL:221.4, AMZN:196.8, TSLA:262.3, V:318.6, META:512.9, XOM:114.2 };
function mockPricesFor(ticker, days = 120) {
  const seed = MOCK_SEEDS[ticker] || 999;
  const drift = 0.0004;
  const r = series(seed, days, 0.012).map((x) => x + drift);
  const p = new Array(days);
  p[days - 1] = MOCK_PRICE[ticker] || 100;
  for (let i = days - 2; i >= 0; i--) p[i] = p[i + 1] / (1 + r[i + 1]);
  return p;
}
const MOCK_ANALYST = {
  NVDA: { analystStrongBuy:28, analystBuy:9,  analystHold:3,  analystSell:0, analystStrongSell:0, analystTargetPrice:162.50 },
  MSFT: { analystStrongBuy:22, analystBuy:12, analystHold:2,  analystSell:0, analystStrongSell:0, analystTargetPrice:485.00 },
  GOOGL:{ analystStrongBuy:18, analystBuy:14, analystHold:4,  analystSell:0, analystStrongSell:0, analystTargetPrice:205.00 },
  AAPL: { analystStrongBuy:10, analystBuy:15, analystHold:9,  analystSell:1, analystStrongSell:0, analystTargetPrice:235.00 },
  META: { analystStrongBuy:20, analystBuy:13, analystHold:3,  analystSell:1, analystStrongSell:0, analystTargetPrice:565.00 },
  JPM:  { analystStrongBuy:8,  analystBuy:11, analystHold:6,  analystSell:1, analystStrongSell:0, analystTargetPrice:228.00 },
  V:    { analystStrongBuy:14, analystBuy:16, analystHold:3,  analystSell:0, analystStrongSell:0, analystTargetPrice:342.00 },
  SHEL: { analystStrongBuy:6,  analystBuy:9,  analystHold:5,  analystSell:1, analystStrongSell:0, analystTargetPrice:74.00 },
  XOM:  { analystStrongBuy:5,  analystBuy:10, analystHold:7,  analystSell:2, analystStrongSell:0, analystTargetPrice:118.00 },
  AMZN: { analystStrongBuy:24, analystBuy:11, analystHold:2,  analystSell:0, analystStrongSell:0, analystTargetPrice:225.00 },
  TSLA: { analystStrongBuy:9,  analystBuy:6,  analystHold:11, analystSell:6, analystStrongSell:2, analystTargetPrice:255.00 },
};
function mockFundamentals(t) {
  const table = {
    NVDA:{name:"NVIDIA Corp",sector:"Semiconductors",assetClass:"Equity",pe:58.3,divYield:null,debtEquity:0.22,roe:0.89,revGrowth:0.62,ebitdaMargin:0.64,fcf:32.1,week52Low:75.6,week52High:152.3},
    MSFT:{name:"Microsoft Corp",sector:"Software",assetClass:"Equity",pe:35.1,divYield:0.008,debtEquity:0.35,roe:0.38,revGrowth:0.16,ebitdaMargin:0.48,fcf:74.3,week52Low:385.2,week52High:468.4},
    GOOGL:{name:"Alphabet Inc",sector:"Internet",assetClass:"Equity",pe:24.7,divYield:0.005,debtEquity:0.11,roe:0.31,revGrowth:0.13,ebitdaMargin:0.34,fcf:69.5,week52Low:142.1,week52High:191.8},
    JPM:{name:"JPMorgan Chase",sector:"Financials",assetClass:"Equity",pe:12.4,divYield:0.021,debtEquity:1.25,roe:0.17,revGrowth:0.09,ebitdaMargin:0.41,fcf:18.9,week52Low:178.4,week52High:228.1},
    SHEL:{name:"Shell plc",sector:"Energy",assetClass:"Equity",pe:9.8,divYield:0.041,debtEquity:0.45,roe:0.14,revGrowth:0.03,ebitdaMargin:0.22,fcf:24.6,week52Low:58.2,week52High:74.3},
    XLE:{name:"Energy Select SPDR",sector:"Energy ETF",assetClass:"ETF",pe:null,divYield:0.032,debtEquity:null,roe:null,revGrowth:null,ebitdaMargin:null,fcf:null,week52Low:80.1,week52High:96.7},
    GLD:{name:"SPDR Gold Shares",sector:"Commodity",assetClass:"ETF",pe:null,divYield:null,debtEquity:null,roe:null,revGrowth:null,ebitdaMargin:null,fcf:null,week52Low:210.4,week52High:251.2},
    SOXX:{name:"iShares Semiconductor",sector:"Tech ETF",assetClass:"ETF",pe:null,divYield:0.007,debtEquity:null,roe:null,revGrowth:null,ebitdaMargin:null,fcf:null,week52Low:165.3,week52High:238.9},
    AAPL:{name:"Apple Inc",sector:"Hardware",assetClass:"Equity",pe:29.6,divYield:0.006,debtEquity:1.45,roe:0.94,revGrowth:0.07,ebitdaMargin:0.32,fcf:96.2,week52Low:178.9,week52High:234.8},
    AMZN:{name:"Amazon.com Inc",sector:"E-commerce",assetClass:"Equity",pe:34.2,divYield:null,debtEquity:0.55,roe:0.21,revGrowth:0.11,ebitdaMargin:0.14,fcf:41.8,week52Low:151.6,week52High:208.4},
    TSLA:{name:"Tesla Inc",sector:"Auto",assetClass:"Equity",pe:68.9,divYield:null,debtEquity:0.18,roe:0.10,revGrowth:0.04,ebitdaMargin:0.09,fcf:3.2,week52Low:138.8,week52High:299.1},
    V:{name:"Visa Inc",sector:"Payments",assetClass:"Equity",pe:28.4,divYield:0.007,debtEquity:0.60,roe:0.45,revGrowth:0.10,ebitdaMargin:0.66,fcf:15.4,week52Low:267.3,week52High:329.9},
    META:{name:"Meta Platforms",sector:"Internet",assetClass:"Equity",pe:26.8,divYield:0.003,debtEquity:0.28,roe:0.34,revGrowth:0.18,ebitdaMargin:0.45,fcf:42.7,week52Low:398.2,week52High:538.6},
    XOM:{name:"Exxon Mobil",sector:"Energy",assetClass:"Equity",pe:13.1,divYield:0.033,debtEquity:0.19,roe:0.18,revGrowth:0.02,ebitdaMargin:0.19,fcf:29.4,week52Low:98.6,week52High:121.7},
  };
  const f = table[t] || { name: t, sector: "Unknown", assetClass: "Equity" };
  return { ...f, avgVolume: 10, ...(MOCK_ANALYST[t] || {}) };
}

/* ---------------- fundamentals mapping (live) ---------------- */
function num(x) { const n = parseFloat(x); return isNaN(n) ? null : n; }
function toTitleCase(s) {
  if (!s) return s;
  return s.toLowerCase().split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function mapOverviewToFundamentals(ov, avgVolumeM) {
  const ebitda = num(ov.EBITDA), revenue = num(ov.RevenueTTM);
  return {
    name: ov.Name || null,
    sector: toTitleCase(ov.Sector) || null,
    industry: toTitleCase(ov.Industry) || null,
    assetClass: "Equity",
    pe: num(ov.PERatio),
    divYield: num(ov.DividendYield),
    debtEquity: null, // requires BALANCE_SHEET endpoint — not pulled, to conserve free-tier calls
    roe: num(ov.ReturnOnEquityTTM),
    revGrowth: num(ov.QuarterlyRevenueGrowthYOY),
    ebitdaMargin: ebitda && revenue ? ebitda / revenue : null,
    fcf: null, // requires CASH_FLOW endpoint — not pulled, to conserve free-tier calls
    week52Low: num(ov["52WeekLow"]),
    week52High: num(ov["52WeekHigh"]),
    eps: num(ov.EPS),
    marketCap: num(ov.MarketCapitalization),
    analystTargetPrice: num(ov.AnalystTargetPrice),
    analystStrongBuy: num(ov.AnalystRatingStrongBuy),
    analystBuy: num(ov.AnalystRatingBuy),
    analystHold: num(ov.AnalystRatingHold),
    analystSell: num(ov.AnalystRatingSell),
    analystStrongSell: num(ov.AnalystRatingStrongSell),
    avgVolume: avgVolumeM,
  };
}
function mapEtfToFundamentals(etf, ticker, prices, avgVolumeM) {
  let dominantSector = null;
  if (Array.isArray(etf.sectors) && etf.sectors.length) {
    const top = etf.sectors.reduce((a, b) => (num(b.weight) > num(a.weight) ? b : a));
    dominantSector = toTitleCase(top.sector);
  }
  return {
    name: ticker,
    sector: dominantSector ? `${dominantSector} ETF` : "ETF",
    assetClass: "ETF",
    pe: null,
    divYield: num(etf.dividend_yield),
    debtEquity: null,
    roe: null,
    revGrowth: null,
    ebitdaMargin: null,
    fcf: null,
    week52Low: prices.length ? Math.min(...prices) : null,
    week52High: prices.length ? Math.max(...prices) : null,
    expRatio: num(etf.net_expense_ratio),
    avgVolume: avgVolumeM,
  };
}

/**
 * Fetch full live data (price history + fundamentals) for one ticker.
 * Resolves company-name-style inputs via SYMBOL_SEARCH first if the raw
 * input doesn't already look like a ticker symbol. Tries OVERVIEW (stocks)
 * then falls back to ETF_PROFILE. Returns the resolved ticker symbol, or
 * throws if nothing could be resolved/fetched.
 */
async function fetchTickerLive(rawInput, data, job) {
  let ticker = rawInput.trim().toUpperCase();

  if (!TICKER_PATTERN.test(ticker)) {
    job.log.push(`"${rawInput}": doesn't look like a ticker symbol — resolving via SYMBOL_SEARCH…`);
    const search = await avRequest({ function: "SYMBOL_SEARCH", keywords: rawInput });
    recordCalls(1);
    await sleep(AV_MIN_SPACING_MS);
    const best = (search.bestMatches || [])[0];
    if (!best) throw new Error(`No symbol match found for "${rawInput}"`);
    ticker = best["1. symbol"];
    job.log.push(`"${rawInput}" resolved to ${ticker} (${best["2. name"]})`);
  }

  job.log.push(`${ticker}: fetching daily prices…`);
  const priceResp = await avRequest({ function: "TIME_SERIES_DAILY", symbol: ticker, outputsize: "compact" });
  recordCalls(1);
  await sleep(AV_MIN_SPACING_MS);
  const rawSeries = priceResp["Time Series (Daily)"];
  if (!rawSeries) throw new Error(`No price series returned for ${ticker} (bad symbol, unsupported exchange, or rate-limited)`);
  const dates = Object.keys(rawSeries).sort();
  const prices = dates.map((d) => parseFloat(rawSeries[d]["4. close"]));
  const volumes = dates.map((d) => parseFloat(rawSeries[d]["5. volume"]));
  const avgVolumeM = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10 / 1e6;

  job.log.push(`${ticker}: fetching fundamentals…`);
  let fundamentals;
  const overview = await avRequest({ function: "OVERVIEW", symbol: ticker });
  recordCalls(1);
  await sleep(AV_MIN_SPACING_MS);
  if (overview && overview.Name) {
    fundamentals = mapOverviewToFundamentals(overview, avgVolumeM);
  } else {
    job.log.push(`${ticker}: not a common stock — trying ETF_PROFILE…`);
    const etf = await avRequest({ function: "ETF_PROFILE", symbol: ticker });
    recordCalls(1);
    await sleep(AV_MIN_SPACING_MS);
    if (etf && (etf.net_assets || (etf.sectors && etf.sectors.length))) {
      fundamentals = mapEtfToFundamentals(etf, ticker, prices, avgVolumeM);
    } else {
      throw new Error(`${ticker}: neither OVERVIEW nor ETF_PROFILE returned usable data`);
    }
  }

  writeTickerIntoData(data, ticker, prices, fundamentals, "live");
  job.log.push(`${ticker}: live data written (${prices.length} sessions)`);
  return ticker;
}

/**
 * Price-only refresh: 1 call/ticker (TIME_SERIES_DAILY) instead of 2, skipping
 * OVERVIEW/ETF_PROFILE entirely. Roughly doubles the effective daily budget
 * when only prices (and derived risk/technical metrics) need updating —
 * fundamentals (P/E, ROE, sector, etc.) move slowly and don't need refreshing
 * every time. Leaves any existing fundamentals fields untouched; if the
 * ticker's fundamentals were never fetched live, they stay mock/pending and
 * the ticker is marked "live-price" (price is real, fundamentals aren't yet)
 * rather than "live" (both real) — see the src-pill badge in the UI.
 */
async function fetchTickerPriceOnly(ticker, data, job) {
  job.log.push(`${ticker}: fetching daily prices (price-only)…`);
  const priceResp = await avRequest({ function: "TIME_SERIES_DAILY", symbol: ticker, outputsize: "compact" });
  recordCalls(1);
  await sleep(AV_MIN_SPACING_MS);
  const rawSeries = priceResp["Time Series (Daily)"];
  if (!rawSeries) throw new Error(`No price series returned for ${ticker} (bad symbol, unsupported exchange, or rate-limited)`);
  const dates = Object.keys(rawSeries).sort();
  const prices = dates.map((d) => parseFloat(rawSeries[d]["4. close"]));
  const volumes = dates.map((d) => parseFloat(rawSeries[d]["5. volume"]));
  const avgVolumeM = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10 / 1e6;

  data.prices[ticker] = prices;
  const existing = data.universe[ticker] || {};
  const fundamentalsAreLive = existing.dataSource === "live";
  data.universe[ticker] = {
    ...existing,
    price: prices[prices.length - 1],
    avgVolume: avgVolumeM,
    dataSource: fundamentalsAreLive ? "live" : "live-price",
    priceLastRefreshed: new Date().toISOString(),
  };
  job.log.push(`${ticker}: price-only data written (${prices.length} sessions, fundamentals ${fundamentalsAreLive ? "already live" : `still ${existing.dataSource || "mock"}`})`);
}

/**
 * Fetch dividend history for a ticker (Alpha Vantage DIVIDENDS). Stores the
 * most recent ~12 payments — enough for a trailing-12-month income projection
 * and a short dividend calendar without bloating data.json.
 */
async function fetchDividendsFor(ticker, data, job) {
  job.log.push(`${ticker}: fetching dividend history…`);
  const resp = await avRequest({ function: "DIVIDENDS", symbol: ticker });
  recordCalls(1);
  await sleep(AV_MIN_SPACING_MS);
  const raw = Array.isArray(resp.data) ? resp.data : [];
  const history = raw
    .map((d) => ({ exDate: d.ex_dividend_date, payDate: d.payment_date || null, amount: num(d.amount) }))
    .filter((d) => d.exDate && d.amount != null)
    .sort((a, b) => (a.exDate < b.exDate ? 1 : -1))
    .slice(0, 12);
  data.dividends[ticker] = { history, lastRefreshed: new Date().toISOString() };
  job.log.push(`${ticker}: ${history.length} dividend payment(s) on file`);
}

/**
 * Fetch a lightweight news-sentiment summary for a ticker (Alpha Vantage
 * NEWS_SENTIMENT). Stores only the average relevance-weighted sentiment score,
 * article count, and the top 5 headlines — not the full raw payload, which can
 * be large.
 */
async function fetchNewsSentimentFor(ticker, data, job) {
  job.log.push(`${ticker}: fetching news sentiment…`);
  const resp = await avRequest({ function: "NEWS_SENTIMENT", tickers: ticker, limit: "20" });
  recordCalls(1);
  await sleep(AV_MIN_SPACING_MS);
  const feed = Array.isArray(resp.feed) ? resp.feed : [];
  let weightedSum = 0, weightSum = 0;
  const headlines = [];
  feed.forEach((article) => {
    const match = (article.ticker_sentiment || []).find((t) => t.ticker === ticker);
    const score = match ? num(match.ticker_sentiment_score) : num(article.overall_sentiment_score);
    const relevance = match ? num(match.relevance_score) || 1 : 1;
    if (score != null) { weightedSum += score * relevance; weightSum += relevance; }
    if (headlines.length < 5) {
      headlines.push({ title: article.title, url: article.url, source: article.source, sentiment: score, time: article.time_published || null });
    }
  });
  const avgScore = weightSum > 0 ? weightedSum / weightSum : null;
  data.newsSentiment[ticker] = { avgScore, articleCount: feed.length, headlines, lastRefreshed: new Date().toISOString() };
  job.log.push(`${ticker}: ${feed.length} articles, avg sentiment ${avgScore != null ? avgScore.toFixed(3) : "n/a"}`);
}

function writeTickerIntoData(data, ticker, prices, fundamentals, source) {
  data.prices[ticker] = prices;
  data.universe[ticker] = {
    ...(data.universe[ticker] || {}),
    ...fundamentals,
    price: prices[prices.length - 1],
    dataSource: source,
    lastRefreshed: new Date().toISOString(),
  };
}

/* ---------------- job runner (shared by refresh + import) ---------------- */
let currentJob = null;

function newJob(total, kind) {
  return {
    id: String(Date.now()),
    kind,
    total,
    completed: 0,
    log: [],
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

function startRefreshJob(tickers, includeExtras, mode) {
  if (currentJob && currentJob.status === "running") {
    throw new Error("A job is already running. Wait for it to finish.");
  }
  const job = newJob(tickers.length, "refresh");
  job.tickers = tickers;
  job.mode = mode === "price" ? "price" : "full";
  job.includeExtras = job.mode === "price" ? false : !!includeExtras; // extras require a full refresh
  currentJob = job;
  runRefreshJob(job).catch((e) => {
    job.status = "error";
    job.log.push(`Fatal error: ${e.message}`);
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

async function runRefreshJob(job) {
  const data = loadDataFile();
  const useMock = !AV_KEY;

  if (useMock) {
    job.log.push(`No ALPHAVANTAGE_API_KEY set — regenerating mock data for the requested tickers (mode has no cost impact in mock mode).`);
    for (const t of job.tickers) {
      const prices = mockPricesFor(t);
      writeTickerIntoData(data, t, prices, mockFundamentals(t), "mock");
      job.completed++;
      job.log.push(`${t}: mock data regenerated`);
    }
    data.meta.source = "mock";
    data.meta.lastRefreshed = new Date().toISOString();
    saveDataFile(data);
    job.status = "done";
    job.finishedAt = new Date().toISOString();
    return;
  }

  const needsBenchmark = !data.prices[BENCH_TICKER];
  // price-only: 1 call/ticker (TIME_SERIES_DAILY). full: 2 (+ TIME_SERIES_DAILY, OVERVIEW/ETF_PROFILE),
  // or 4 with dividends+news sentiment opted in.
  const perTicker = job.mode === "price" ? 1 : (job.includeExtras ? 4 : 2);
  const callsNeeded = job.tickers.length * perTicker + (needsBenchmark ? 1 : 0);
  if (remainingCallsToday() < callsNeeded) {
    job.status = "error";
    job.log.push(`Not enough free-tier calls remaining today (need ~${callsNeeded}, have ${remainingCallsToday()}). Refresh fewer tickers or wait until tomorrow.`);
    job.finishedAt = new Date().toISOString();
    return;
  }

  if (needsBenchmark) {
    try {
      job.log.push("Fetching SPY (benchmark)…");
      const priceResp = await avRequest({ function: "TIME_SERIES_DAILY", symbol: BENCH_TICKER, outputsize: "compact" });
      recordCalls(1);
      await sleep(AV_MIN_SPACING_MS);
      const rawSeries = priceResp["Time Series (Daily)"];
      if (rawSeries) {
        const dates = Object.keys(rawSeries).sort();
        data.prices[BENCH_TICKER] = dates.map((d) => parseFloat(rawSeries[d]["4. close"]));
        data.meta.benchmarkSource = "live";
        job.log.push(`SPY: ${data.prices[BENCH_TICKER].length} daily closes fetched (benchmark)`);
        saveDataFile(data);
      }
    } catch (e) {
      job.log.push(`SPY: FAILED — ${e.message}`);
    }
  }

  for (const t of job.tickers) {
    try {
      if (job.mode === "price") {
        await fetchTickerPriceOnly(t, data, job);
      } else {
        await fetchTickerLive(t, data, job);
        if (job.includeExtras) {
          if (remainingCallsToday() >= 2) {
            try { await fetchDividendsFor(t, data, job); } catch (e) { job.log.push(`${t}: dividends FAILED — ${e.message}`); }
            try { await fetchNewsSentimentFor(t, data, job); } catch (e) { job.log.push(`${t}: news sentiment FAILED — ${e.message}`); }
          } else {
            job.log.push(`${t}: skipped dividends/news sentiment — not enough budget remaining today.`);
          }
        }
      }
      job.completed++;
      saveDataFile(data); // persist incrementally so partial refreshes aren't lost on error
    } catch (e) {
      job.log.push(`${t}: FAILED — ${e.message}`);
    }
  }

  data.meta.lastRefreshed = new Date().toISOString();
  const anyLive = Object.values(data.universe).some((u) => u.dataSource === "live");
  const anyMock = Object.values(data.universe).some((u) => u.dataSource === "mock");
  data.meta.source = anyLive && anyMock ? "mixed" : anyLive ? "live" : "mock";
  saveDataFile(data);
  job.status = "done";
  job.finishedAt = new Date().toISOString();
}

/**
 * @param {Array<{symbol:string, market:string, quantity:number, boughtPrice:number, currency:string, purchaseDate:string}>} positions
 */
function startImportJob(positions) {
  if (currentJob && currentJob.status === "running") {
    throw new Error("A job is already running. Wait for it to finish.");
  }
  const job = newJob(positions.length, "import");
  job.positions = positions;
  currentJob = job;
  runImportJob(job).catch((e) => {
    job.status = "error";
    job.log.push(`Fatal error: ${e.message}`);
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

async function runImportJob(job) {
  const data = loadDataFile();
  data.positions = data.positions || {};
  data.fxRates = data.fxRates || { USD: 1 };

  for (const pos of job.positions) {
    const rawSymbol = (pos.symbol || "").trim();
    if (!rawSymbol) { job.log.push("Skipped a row with no stock name/ticker."); job.completed++; continue; }
    const currency = (pos.currency || "USD").toUpperCase();

    let resolvedTicker = rawSymbol.toUpperCase();
    const alreadyKnown = isKnownTicker(resolvedTicker, data) && data.universe[resolvedTicker];

    if (!alreadyKnown) {
      if (!AV_KEY) {
        job.log.push(`${rawSymbol}: no ALPHAVANTAGE_API_KEY set — added as pending (no live fetch possible).`);
        data.universe[resolvedTicker] = data.universe[resolvedTicker] || {
          name: rawSymbol, sector: null, assetClass: null, price: pos.boughtPrice || null,
          dataSource: "pending", lastRefreshed: null,
        };
      } else if (remainingCallsToday() < 2) {
        job.log.push(`${rawSymbol}: not enough free-tier calls remaining today — added as pending. Use Refresh Data later to fetch it live.`);
        data.universe[resolvedTicker] = data.universe[resolvedTicker] || {
          name: rawSymbol, sector: null, assetClass: null, price: pos.boughtPrice || null,
          dataSource: "pending", lastRefreshed: null,
        };
      } else {
        try {
          resolvedTicker = await fetchTickerLive(rawSymbol, data, job);
        } catch (e) {
          job.log.push(`${rawSymbol}: live fetch failed (${e.message}) — added as pending.`);
          data.universe[resolvedTicker] = data.universe[resolvedTicker] || {
            name: rawSymbol, sector: null, assetClass: null, price: pos.boughtPrice || null,
            dataSource: "pending", lastRefreshed: null,
          };
        }
      }
    } else {
      job.log.push(`${resolvedTicker}: already known — reusing existing data, not re-fetching.`);
    }

    // FX rate lookup (once per currency, cached in data.fxRates)
    if (currency !== "USD" && data.fxRates[currency] == null) {
      if (AV_KEY && remainingCallsToday() >= 1) {
        try {
          job.log.push(`Fetching FX rate ${currency} → USD…`);
          const fx = await avRequest({ function: "CURRENCY_EXCHANGE_RATE", from_currency: currency, to_currency: "USD" });
          recordCalls(1);
          await sleep(AV_MIN_SPACING_MS);
          const rate = num(fx["Realtime Currency Exchange Rate"] && fx["Realtime Currency Exchange Rate"]["5. Exchange Rate"]);
          if (rate) { data.fxRates[currency] = rate; job.log.push(`${currency} → USD rate: ${rate}`); }
        } catch (e) {
          job.log.push(`FX rate fetch for ${currency} failed: ${e.message} — will display in ${currency} unconverted.`);
        }
      } else {
        job.log.push(`${currency}: no FX rate available yet (no API key or no budget left) — will display unconverted until refreshed.`);
      }
    }

    data.positions[resolvedTicker] = {
      quantity: pos.quantity || 0,
      avgCost: pos.boughtPrice || null,
      currency,
      market: pos.market || "US",
      purchaseDate: pos.purchaseDate || null,
    };

    job.completed++;
    saveDataFile(data);
  }

  data.meta.lastRefreshed = new Date().toISOString();
  const anyLive = Object.values(data.universe).some((u) => u.dataSource === "live");
  const anyMock = Object.values(data.universe).some((u) => u.dataSource === "mock");
  data.meta.source = anyLive && anyMock ? "mixed" : anyLive ? "live" : "mock";
  saveDataFile(data);
  job.status = "done";
  job.finishedAt = new Date().toISOString();
}

/* ---------------- data.json persistence ---------------- */
function loadDataFile() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    d.positions = d.positions || {};
    d.fxRates = d.fxRates || { USD: 1 };
    d.dividends = d.dividends || {};
    d.newsSentiment = d.newsSentiment || {};
    return d;
  } catch {
    return { meta: { source: "mock", lastRefreshed: null, benchmarkSource: "mock" }, universe: {}, prices: {}, positions: {}, fxRates: { USD: 1 }, dividends: {}, newsSentiment: {} };
  }
}
function saveDataFile(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/* ---------------- HTTP server ---------------- */
const MIME = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".css": "text/css" };

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === "POST" && parsed.pathname === "/api/refresh") {
    const body = await readBody(req);
    const data = loadDataFile();
    const tickers = Array.isArray(body.tickers) && body.tickers.length
      ? body.tickers.filter((t) => isKnownTicker(t, data))
      : DEFAULT_TICKERS.slice(0, 8);
    try {
      const job = startRefreshJob(tickers, !!body.includeExtras, body.mode);
      return sendJson(res, 200, { jobId: job.id, total: job.total, mockMode: !AV_KEY, remainingCallsToday: remainingCallsToday() });
    } catch (e) {
      return sendJson(res, 409, { error: e.message });
    }
  }

  if (req.method === "POST" && parsed.pathname === "/api/import-portfolio") {
    const body = await readBody(req);
    const positions = Array.isArray(body.positions) ? body.positions : [];
    if (!positions.length) return sendJson(res, 400, { error: "No positions provided." });
    try {
      const job = startImportJob(positions);
      return sendJson(res, 200, { jobId: job.id, total: job.total, mockMode: !AV_KEY, remainingCallsToday: remainingCallsToday() });
    } catch (e) {
      return sendJson(res, 409, { error: e.message });
    }
  }

  if (req.method === "GET" && parsed.pathname === "/api/refresh/status") {
    if (!currentJob) return sendJson(res, 404, { error: "No job has run yet." });
    return sendJson(res, 200, currentJob);
  }

  if (req.method === "GET" && parsed.pathname === "/api/status") {
    const data = loadDataFile();
    return sendJson(res, 200, { meta: data.meta, tickersWithData: Object.keys(data.universe), remainingCallsToday: remainingCallsToday(), mockMode: !AV_KEY });
  }

  if (req.method === "GET" && parsed.pathname === "/data.json") {
    const data = loadDataFile();
    return sendJson(res, 200, data);
  }

  // static file serving
  let filePath = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`EquityLens running at http://localhost:${PORT}`);
  console.log(AV_KEY ? "Alpha Vantage key detected — live refresh enabled." : "No ALPHAVANTAGE_API_KEY set — Refresh Data will regenerate mock data. See README.md.");
  console.log(`Free-tier calls remaining today: ${remainingCallsToday()}/${AV_DAILY_CAP}`);
});
