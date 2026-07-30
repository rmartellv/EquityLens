# EquityLens (MVP 4 — Portfolio Import + Live Data)

Equity research & portfolio risk workbench: fundamentals, portfolio risk KPIs (Sharpe, Sortino, beta, VaR/CVaR, correlation, HHI/Effective N), and a technical/valuation screener (momentum, RSI, moving averages, Fibonacci retracement, P/E-vs-own-history) across a 14-name universe (11 single names + SOXX/XLE/GLD ETFs).

Runs as a tiny local app: a zero-dependency Node server plus a static frontend. Works fully on deterministic mock data out of the box; optionally pulls real data from Alpha Vantage when you add an API key and click **Refresh Data**.

## Quick start

```bash
node server.js
```

Then open **http://localhost:3300**. No `npm install` needed — the server uses only Node built-ins.

That's it for mock mode. Every view works, the Refresh Data button works (it just regenerates the mock engine instead of calling out), and nothing requires an account or API key.

## Enabling live data

1. Get a free Alpha Vantage key: https://www.alphavantage.co/support/#api-key — instant, no credit card.
2. Copy `.env.example` to `.env` in this folder and paste the key in:
   ```
   ALPHAVANTAGE_API_KEY=your_key_here
   ```
3. Restart the server (`node server.js`). The startup log will confirm the key was detected.
4. Click **Refresh Data** in the app, pick a scope, and click **Start Refresh**.

You control exactly when and how much of your daily quota gets used — nothing happens automatically. Close the server (Ctrl+C) when you're done for the day.

## Free-tier budget — read before refreshing

Alpha Vantage's free tier is **25 requests/day, 5/minute**. Each ticker refresh costs 2 calls (`TIME_SERIES_DAILY` + `OVERVIEW`), plus 1 shared call for the SPY benchmark (only fetched once, reused across the whole universe until you refresh it again). The server spaces calls ~15 seconds apart to stay under the per-minute limit, and refuses to start a refresh that would exceed today's remaining quota — it'll tell you in the modal instead of silently failing partway through.

Practical budget:
- **Core 8** tickers ≈ 17 calls — fits in one refresh with room to spare.
- **Full universe (14)** ≈ 29 calls — exceeds the daily cap in one shot. Refresh in two batches on the same day, or across two days, or trim the "Full universe" scope.
- Fundamentals (P/E, ROE, revenue growth, etc.) move slowly — you don't need to refresh them as often as prices. A future improvement would be splitting "price-only" vs "full" refresh to cut the per-ticker cost in half.

## What's real vs. approximated in live mode

Alpha Vantage's free `OVERVIEW` endpoint doesn't cover everything the mock engine shows. To stay within the call budget, these fields are **not** fetched live and will show as "—" for refreshed tickers:
- **Debt/Equity** — needs the `BALANCE_SHEET` endpoint.
- **Free Cash Flow** — needs the `CASH_FLOW` endpoint.

Everything else (price, P/E, dividend yield, ROE, revenue growth YoY, EBITDA margin, 52-week range, average volume) comes from real `TIME_SERIES_DAILY` + `OVERVIEW` data once refreshed.

**Analyst consensus** (Stock Detail view) — Strong Buy/Buy/Hold/Sell/Strong Sell counts and target price, with upside/downside vs. current price computed client-side. This is the `AnalystRating*`/`AnalystTargetPrice` fields already present in `OVERVIEW`, so it costs zero extra API calls once a ticker is refreshed live. Mock tickers show illustrative sample ratings so the view isn't empty before your first refresh; ETFs never show a consensus (no sell-side ratings exist for them).

**P/E percentile / valuation screen** uses an approximation even in live mode: it builds an implied historical P/E series as `price ÷ current EPS` (assuming EPS was roughly constant over the lookback window) rather than pulling real historical EPS per period. The real upgrade is wiring in the `EARNINGS` endpoint (quarterly EPS history) — not done here to conserve calls, but the math layer (`percentileRank`, `valuationTag` in `lib/technical-indicators.js`) doesn't change when that data source swaps in, same design principle as the risk-kpis formulas.

**Beta/R²/Treynor/Jensen's Alpha/Information Ratio** use SPY as the benchmark once its price series has been fetched (happens automatically on first live refresh of any ticker). Until then, or for tickers still on mock data, these fall back to a synthetic SPY-proxy series so the app never shows a broken/empty metric — check the `src-pill` badge (live/mock) next to each ticker and the "Data source" line in the sidebar to know what you're looking at.

## Importing a portfolio from Excel

Go to **Portfolio & Risk → Import Portfolio**, choose an `.xlsx`/`.xls`/`.csv` file, and confirm. Expected columns (header names matched case-insensitively, order doesn't matter):

- **Stock Name / Ticker / Symbol** (required) — a clean ticker (`NVDA`) works directly; a company name gets resolved via Alpha Vantage's `SYMBOL_SEARCH` (costs 1 extra call).
- **Market** (optional, e.g. `US`, `EU`) — cosmetic tag only; doesn't change how the ticker is looked up.
- **Quantity** (required)
- **Bought Price** (required) — used as your cost basis, and as the placeholder price for tickers that can't be fetched live.
- **Currency** (optional, defaults to `USD`) — non-USD positions are converted to USD in the portfolio view using the latest spot rate (`CURRENCY_EXCHANGE_RATE`), fetched once per currency and cached. This is a spot conversion, not historical FX-adjusted returns — a simplification worth knowing about if you're holding non-USD positions for risk analysis.
- **Purchase Date** (optional) — stored but not currently used in any calculation.

For each new ticker not already known to the app: if today's Alpha Vantage budget allows (roughly 2–4 calls per new ticker, depending on whether name resolution or ETF fallback is needed), it's fetched live immediately. If the budget is exhausted, the ticker is added as **pending** — it shows up in your portfolio at your bought price, with all risk/technical stats computed against a flat placeholder series (so nothing crashes, but the numbers aren't meaningful yet). Refresh it later from the **Refresh Data** button once your daily quota resets. The `src-pill` badge (`live` / `mock` / `pending`) always tells you what you're looking at.

## Architecture

```
equitylens-app/
├── server.js              Zero-dependency Node server: static file serving,
│                           POST /api/refresh, POST /api/import-portfolio,
│                           GET /api/refresh/status, GET /api/status, GET /data.json.
│                           fetchTickerLive() resolves+fetches any ticker (known
│                           or newly imported), tries OVERVIEW then ETF_PROFILE,
│                           falls back to SYMBOL_SEARCH for company-name inputs.
├── lib/
│   └── technical-indicators.js   Pure functions: SMA/EMA, RSI, Fibonacci
│                                  retracement, rate-of-change, trend signal,
│                                  P/E percentile & valuation tag
├── public/
│   └── index.html          The app: mock data engine (fallback/default) +
│                            risk-kpis formulas + technical-indicators formulas
│                            + all 5 views (Dashboard, Stock Detail,
│                            Portfolio & Risk, Screener, Comparison) + Excel
│                            portfolio import (SheetJS, client-side parsing)
│                            with a dynamic ticker universe (ensureTickerExists)
├── data/                   Created at runtime — data.json (cached results,
│                           now including positions{} and fxRates{}) and
│                           av-usage.json (daily call counter). Gitignored.
├── .env.example             Copy to .env and add your API key
└── .gitignore
```

Design principle carried over from the `equitylens-risk-kpis` skill: every formula (risk and technical) takes plain arrays in, never a ticker string or API call. `index.html` ships with a deterministic mock engine as the default so the app is fully functional with zero setup; `server.js` overlays real data on a per-ticker basis into `data.json`, which the frontend merges on top of the mock defaults. Risk calculations (Sharpe, beta, VaR, correlation, portfolio-level everything) always use a trailing 60-session window across all tickers so mock and live data align index-for-index even when their raw history lengths differ (60 mock days vs. ~100 live days from Alpha Vantage's `compact` output). Technical indicators (SMA, RSI, Fibonacci) use each ticker's full available history instead, since they don't require cross-ticker alignment.

## Known limitations (worth being upfront about)

- Parametric VaR/CVaR assume normally distributed returns — understates real tail risk.
- Alpha Vantage's `TIME_SERIES_DAILY?outputsize=compact` returns ~100 sessions — enough for SMA20/50, RSI14, and a 60-day Fibonacci lookback, but SMA200 will be mostly null. Switching to `outputsize=full` would fix this at the cost of much larger responses and slower parsing — not done here to keep the free-tier call cheap and fast.
- P/E-vs-history uses a same-EPS approximation (see above) rather than true historical EPS.
- Factor exposure (Fama-French) and ESG remain stubs — no free reliable data source for either.
- Debt/Equity and Free Cash Flow aren't pulled live to conserve API calls (see above).

## Next steps (not built yet)

- Split refresh into "prices only" (1 call/ticker) vs "full" (2 calls/ticker) to roughly double the effective daily budget.
- Wire the `EARNINGS` endpoint for real historical P/E instead of the same-EPS approximation.
- Deploy target: this local-server architecture is a natural fit for Vercel/Railway serverless functions if/when a publicly hosted version is wanted — the `/api/refresh` logic would move into a serverless function largely unchanged.
