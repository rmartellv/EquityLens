# EquityLens (MVP 6.2 — Valuation Engine + SEC EDGAR Fundamentals + Market Pulse)

**Live demo:** https://equitylens-n9bz.onrender.com (runs in mock mode — no API key configured on the public deployment, see Security notes below). Free-tier hosting spins down after 15 minutes idle; first load after that takes ~30 seconds to wake back up.

Equity research & portfolio risk workbench: fundamentals, portfolio risk KPIs (Sharpe, Sortino, beta, VaR/CVaR, correlation, HHI/Effective N), a technical/valuation screener (momentum, RSI, moving averages, Fibonacci retracement, P/E-vs-own-history), a full valuation engine (DCF, Trading Multiples, Precedent Transactions, LBO), and a Market Pulse tab (volatility proxy, put/call sentiment, breadth, factor-crowding proxy) across a 14-name universe (11 single names + SOXX/XLE/GLD ETFs).

## Valuation (DCF, Trading Multiples, Precedent Transactions, LBO)

A dedicated **Valuation** tab, one ticker at a time (equities only — ETFs don't have a standalone DCF/comps/LBO valuation, the tab tells you so if you pick one). Formulas: `equitylens-valuation` skill.

- **DCF** — 5-year (adjustable) FCF projection tapering from a near-term growth rate to a terminal growth rate, discounted at WACC, with a Gordon Growth terminal value. WACC can be typed directly or derived via a built-in **CAPM calculator** (risk-free rate, beta, equity risk premium, pre-tax cost of debt, tax rate, target debt weight — all editable, defaulting to the app's existing `RF` and the ticker's own computed beta). Always shown alongside a 3×3 WACC × terminal-growth sensitivity grid, not just a single point estimate.
- **Trading Multiples** — peer set is chip-selectable (defaults to same-sector tickers already used in the Comparison view); implied value shown two ways, peer median P/E × target EPS, and peer median EV/FCF × target FCF.
- **Precedent Transactions** — **illustrative only**, clearly labeled in-app: runs off a 3-deal hardcoded placeholder set, not a real M&A comps database (no free-tier API for this the way there is for market data — would need Refinitiv/PitchBook/Capital IQ in production).
- **LBO** — entry/exit multiple, leverage, interest rate, hold period, and FCF sweep %, with a year-by-year debt paydown schedule and MOIC/IRR output.

**The data-model substitution that shapes all four, until you pull real fundamentals (see below):** EquityLens has FCF in dollars but never pulls revenue/EBITDA in dollars from Alpha Vantage (would need `INCOME_STATEMENT`, not fetched there to conserve API budget). So **EV/FCF stands in for EV/EBITDA**, and net debt uses a small illustrative mock field (`MOCK_NET_DEBT_B`, $B, negative = net cash) rather than `debtEquity × marketCap` (that combination would apply a book-equity ratio to market-value equity and blows up for high-multiple names — would imply NVDA carries ~$700B of debt). Once you run **Pull Fundamentals** (below), real EBITDA/net debt/shares outstanding from SEC filings take over automatically — a `src-pill` badge next to the Valuation tab's ticker name shows `EDGAR` (real) vs `illustrative` (mock) per name. See the `equitylens-valuation` skill for the full formula reference.

## Fundamentals via SEC EDGAR (free, no API key, no daily cap)

**Refresh Data → Pull Fundamentals** wires the Valuation tab's three currently-mocked/derived fields to the real thing, straight from SEC filings: **revenue, EBITDA** (Operating Income + D&A, both XBRL-tagged), **total debt, cash, and shares outstanding**. Equities only (ETFs are skipped — they don't file 10-Ks). No API key needed, no 25/day cap like Alpha Vantage, since it's a public SEC service — but set `SEC_EDGAR_CONTACT` in `.env` first (see below) and don't run it more than you need to; this data moves quarterly, not daily, so once per name per earnings cycle is enough.

- **Setup:** copy `SEC_EDGAR_CONTACT=YourName your-email@example.com` into `.env` (SEC asks every API consumer for a descriptive User-Agent + real contact: https://www.sec.gov/os/webmaster-faq#developers). It still works without this — you'll just send a generic placeholder User-Agent, which the startup log will flag.
- **How it resolves data:** ticker → CIK via SEC's own `company_tickers.json` (cached locally, refreshed at most weekly) → full XBRL `companyfacts` payload for that CIK → the specific tags extracted, trying a priority-ordered list of known aliases per field (XBRL tagging isn't standardized across filers/years — see `lib/edgar.js` for the full alias lists and the reasoning).
- **Partial results are expected and disclosed, not hidden.** Some filers don't tag D&A separately (so EBITDA comes back null for them), or use an uncommon debt tag; each field degrades independently rather than guessing — the job log tells you exactly what resolved per ticker. Never overwrites a previously-good field with a null.
- **Financials (JPM) are a weak fit for this whole valuation engine, EDGAR data or not** — leverage is the business model for a bank, not a net-debt bridge item, so EV/DCF-style valuation understates what a bank actually is. P/B or a dividend-discount model is the standard alternative in practice; this is flagged in the `equitylens-valuation` skill too.
- **Security posture** — see the Security notes section below; `lib/edgar.js`'s file header has the full reasoning (fixed hosts, validated CIKs, capped response size, sanitized User-Agent, spaced requests).

## Market Pulse (VIX proxy, put/call sentiment, breadth, factor-crowding proxy)

A dedicated **Market Pulse** tab with four cards, each honestly scoped to what's actually available rather than faking a Bloomberg-terminal-style feed:

- **Volatility** — **VIXY** (VIX short-term futures ETF) as a proxy. Alpha Vantage has no direct spot-VIX symbol (`TIME_SERIES_DAILY?symbol=VIX` 400s); VIXY is a real, tradeable ETF so the ordinary price endpoint works, but its price level tracks VIX *futures*, not the index itself — the card shows trend/direction (5-day % change), not a headline "VIX at X" number, and says so.
- **Put/Call Sentiment** — SPY full-chain options put/call ratio, live via Alpha Vantage's `REALTIME_PUT_CALL_RATIO` (used as a market-wide proxy, run on the S&P 500 ETF rather than any single name). Tagged Bullish/Neutral/Bearish using Alpha Vantage's own stated convention (≤0.60 bullish, ≥1.00 bearish). Confirmed working on the free tier (live-tested: SPY returned a 1.28 full-chain ratio).
- **Market Breadth** — computed live, client-side, **zero extra API cost**: % of your tracked tickers in an uptrend (reusing the existing trend-signal calc) plus today's advancers/decliners. This is a real number, just honestly scoped to the app's own tracked universe — there's no free data source for a true NYSE/Nasdaq advance-decline line, so it doesn't claim to be one.
- **Factor Crowding (proxy)** — also computed live, client-side, zero extra cost: average pairwise 60-day return correlation across tracked *equities* (ETFs excluded, since mixing in GLD/XLE would just mechanically dilute the number rather than reflect stock-picking crowding). Bucketed Low/Moderate/High. This is a rough illustrative proxy, not a real positioning metric — genuine crowding analysis needs 13F holdings concentration, short interest, or ETF-flow data, none of which is available free.

**Refresh Data → Refresh Market Pulse** pulls the two live pieces (VIXY + SPY put/call, 2 Alpha Vantage calls total); breadth and crowding update automatically any time ticker data changes, no separate refresh needed. Without an API key, VIXY/put-call regenerate as illustrative mock values, same convention as the rest of the app.

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
- **Core 8** tickers ≈ 17 calls (full mode) — fits in one refresh with room to spare.
- **Full universe (14)** ≈ 29 calls (full mode) — exceeds the daily cap in one shot. Refresh in two batches on the same day, or across two days, or trim the "Full universe" scope.
- **Refresh mode — Full vs. Price only.** The Refresh Data modal lets you pick between **Full** (`TIME_SERIES_DAILY` + `OVERVIEW`/`ETF_PROFILE`, 2 calls/ticker) and **Price only** (`TIME_SERIES_DAILY` alone, 1 call/ticker). Fundamentals (P/E, ROE, revenue growth, sector, etc.) move slowly and don't need refreshing as often as prices do, so price-only roughly doubles your effective daily budget — the **Full universe (14 tickers)** scope drops from ≈29 calls to ≈15 in price-only mode, fitting inside the 25/day cap in one shot. Price-only refreshes update price, volume, and everything derived from them (risk KPIs, technical indicators, Monte Carlo, etc.) without touching existing fundamentals. A ticker whose fundamentals have never been fetched live shows the `live-price` badge (price is real, fundamentals aren't yet) instead of `live` (both real) — run a **Full** refresh on it at least once to pick up real fundamentals. "Include dividends + news sentiment" requires Full mode (price-only disables it in the modal), since both are additive to a fundamentals-oriented refresh, not a price one.
- Checking **"Include dividends + news sentiment"** in the Refresh Data modal (Full mode only) doubles the per-ticker cost (4 calls instead of 2 — adds `DIVIDENDS` and `NEWS_SENTIMENT`). Core 8 with extras ≈ 33 calls, already over the daily cap — plan on refreshing a smaller scope (e.g. just your actual holdings) when this is checked.

## Portfolio management features (Portfolio & Risk view)

All of the following are pure computation on data already fetched — none of it costs extra API calls:

- **Scenario stress testing** — pick a predefined shock (2008 GFC, 2020 COVID crash, 2022 rate selloff, a plain ±10%/+15% move) and see portfolio-level P&L, propagated through each position's own beta. This is the standard factor-based stress-testing simplification: it overrides the normal covariance assumptions behind parametric VaR with one deterministic market move, and doesn't model idiosyncratic (stock-specific) risk.
- **Rebalancing / drift tracking** — set an optional target weight per position in the Holdings table; drift (current − target) and a suggested buy/sell dollar amount are computed live. Leaving target blank means no drift tracking for that position.
- **Risk flags** — automatic concentration (single position or sector over threshold), correlation-cluster (pairs correlating above 0.70), and liquidity (days to exit at 20% of average daily volume) warnings, shown above the Holdings table.
- **Style box** — a 3×3 size (market cap) × style (P/E-percentile-derived value/growth) grid showing where the portfolio's weight actually sits, same visualization Morningstar's Portfolio X-Ray popularized.
- **EquityLens Score** — a 0–100 composite per stock blending valuation (30%), momentum (30%), quality/ROE (20%), and revenue growth (20%) percentiles already computed elsewhere in the app. Shown in the Screener and on each Stock Detail page. A ranking aid, not investment advice — see the breakdown bars for what's actually driving the number.
- **Monte Carlo projection** — a 1-year geometric Brownian motion simulation (300 paths) using the portfolio's own trailing annualized return/volatility as the drift/vol inputs, rendered as a percentile fan chart (5th/25th/median/75th/95th).
- **Empirical VaR/CVaR** — a historical-simulation complement to the existing parametric VaR/CVaR: sorts the actual trailing 60-day returns and reads the tail directly, no normal-distribution assumption (though noisier with a short window).
- **Unrealized P&L** — now that cost basis (`avgCost`) is tracked per position (manual entry or Excel import), the Holdings table shows unrealized gain/loss in dollars and percent.

## Dividends & news sentiment (opt-in, +2 API calls/ticker)

Check **"Include dividends + news sentiment"** in the Refresh Data modal to also pull:
- **Dividend history** (`DIVIDENDS`) — last 12 payments per ticker, shown on Stock Detail. The Portfolio view's **Dividend Income Projection** card sums the trailing-12-month per-share amount × shares held for an estimated annual income and portfolio yield; it falls back to current yield × price for tickers where history hasn't been fetched yet (labeled in the source column).
- **News sentiment** (`NEWS_SENTIMENT`) — a relevance-weighted average sentiment score (-1 to +1) plus the 5 most recent headlines per ticker, shown on Stock Detail. The Portfolio view's **News Sentiment Snapshot** card summarizes this across current holdings.

Both are additive and gracefully absent until fetched — nothing breaks if you never check the box, you just see "no data yet" placeholders with a pointer to enable it.

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
│                           POST /api/refresh-fundamentals (SEC EDGAR),
│                           POST /api/refresh-market-pulse (VIXY + SPY put/call),
│                           GET /api/refresh/status, GET /api/status, GET /data.json.
│                           fetchTickerLive() resolves+fetches any ticker (known
│                           or newly imported), tries OVERVIEW then ETF_PROFILE,
│                           falls back to SYMBOL_SEARCH for company-name inputs.
│                           Optional DIVIDENDS + NEWS_SENTIMENT fetch per ticker
│                           (opt-in, +2 calls/ticker) via fetchDividendsFor()/
│                           fetchNewsSentimentFor(). runFundamentalsJob() drives
│                           the SEC EDGAR pull via lib/edgar.js. runMarketPulseJob()
│                           drives the VIXY/put-call pull, stored as data.marketPulse.
├── lib/
│   ├── technical-indicators.js   Pure functions: SMA/EMA, RSI, Fibonacci
│   │                              retracement, rate-of-change, trend signal,
│   │                              P/E percentile & valuation tag
│   └── edgar.js                  SEC EDGAR client: ticker→CIK resolution
│                                  (cached weekly), XBRL companyfacts fetch,
│                                  tag-alias extraction for revenue/EBITDA/
│                                  debt/cash/shares outstanding. Fixed hosts,
│                                  validated CIKs, capped response size,
│                                  sanitized User-Agent — see its file header.
├── public/
│   └── index.html          The app: mock data engine (fallback/default) +
│                            risk-kpis formulas + technical-indicators formulas
│                            + portfolio-management formulas (stress testing,
│                            rebalancing drift, concentration/correlation/
│                            liquidity flags, style box, composite score,
│                            Monte Carlo, empirical VaR/CVaR, dividend income)
│                            + valuation engine (DCF/Multiples/Precedent/LBO)
│                            + market-pulse engine (computeMarketBreadth,
│                            computeCrowdingProxy — pure, zero-API-cost)
│                            + all 7 views + Excel portfolio import (SheetJS)
│                            with a dynamic ticker universe (ensureTickerExists)
├── data/                   Created at runtime — data.json (cached results,
│                           now including positions{}, fxRates{}, dividends{},
│                           newsSentiment{}, and marketPulse{}) and
│                           av-usage.json (daily call counter). Gitignored.
├── .env.example             Copy to .env and add your API key
└── .gitignore
```

Design principle carried over from the `equitylens-risk-kpis` skill: every formula (risk and technical) takes plain arrays in, never a ticker string or API call. `index.html` ships with a deterministic mock engine as the default so the app is fully functional with zero setup; `server.js` overlays real data on a per-ticker basis into `data.json`, which the frontend merges on top of the mock defaults. Risk calculations (Sharpe, beta, VaR, correlation, portfolio-level everything) always use a trailing 60-session window across all tickers so mock and live data align index-for-index even when their raw history lengths differ (60 mock days vs. ~100 live days from Alpha Vantage's `compact` output). Technical indicators (SMA, RSI, Fibonacci) use each ticker's full available history instead, since they don't require cross-ticker alignment.

## Security notes

The app has no authentication — `/api/refresh`, `/api/import-portfolio`, `/api/refresh-fundamentals`, and `/api/refresh-market-pulse` are open endpoints, which matters once this is deployed to a public URL rather than run locally. `/api/refresh-market-pulse` takes no request body at all (it always fetches the same two fixed symbols, VIXY and SPY) — no user-controlled input reaches it, so there's no injection surface there beyond the shared daily-quota cost of anyone hitting the endpoint repeatedly.

- **Import-field validation.** `runImportJob` (server.js) only ever accepts a symbol as a ticker if it matches `TICKER_PATTERN` (`[A-Z0-9.\-]{1,6}`) — either because the raw input already looked like one, or because it was resolved through Alpha Vantage's `SYMBOL_SEARCH` and the *returned* symbol is itself re-validated against the same pattern. Anything that doesn't validate is rejected and logged, not stored. `market`/`currency`/`purchaseDate` are stripped of HTML metacharacters and length-capped (`stripHtmlChars`, `sanitizeCurrency`, `sanitizeMarket`). This closes a stored-XSS path where an unauthenticated import could otherwise write arbitrary strings into the shared `data.json` and have them execute in other visitors' browsers via `innerHTML`.
- **Render-time escaping.** `escapeHtml()` (index.html) is applied to every name/sector/headline field that could originate from an import, Alpha Vantage, or SEC EDGAR before it's interpolated into an `innerHTML` template — defense in depth on top of the server-side validation above, in case any other write path is added later.
- **No CORS wildcard.** `sendJson` no longer sends `Access-Control-Allow-Origin: *`. The frontend is same-origin with the API, so there's no legitimate reason for another website's script to call these endpoints on a visitor's behalf.
- **`/api/refresh-fundamentals` only ever acts on tickers already known to the app** — the same `isKnownTicker()` whitelist gate as `/api/refresh`. A CIK is never accepted from the client; it's always resolved server-side from SEC's own ticker file (`lib/edgar.js`'s `resolveCik`), and validated against `/^\d{10}$/` before it's ever concatenated into a URL. There is deliberately no generic "fetch this URL" helper anywhere near this code path — only two hardcoded hosts (`www.sec.gov`, `data.sec.gov`) are ever contacted, which forecloses an SSRF-style relay through this server even if a future bug tried to pass through a caller-supplied host or path.
- **Response-size cap and timeout on every SEC EDGAR request** (`lib/edgar.js`: 20MB cap, 15s timeout) — a malformed or anomalously large response gets the request destroyed rather than exhausting process memory or hanging a connection.
- **Sanitized User-Agent.** Node's `http` module throws on any header value containing a byte outside printable ASCII — a real bug caught during testing, where the fallback User-Agent's em dash crashed every request. Both the fallback and any custom `SEC_EDGAR_CONTACT` value are stripped to safe printable ASCII before use, so a stray accented character or smart quote in your contact string degrades gracefully instead of breaking the feature.
- **Contact info stays out of committed source.** `SEC_EDGAR_CONTACT` lives in the gitignored `.env` (see `.env.example`), never hardcoded — same handling as `ALPHAVANTAGE_API_KEY`, deliberate since this repo has a public live deployment.
- **Good-citizen rate limiting toward a shared public resource.** SEC's documented cap is 10 req/sec across all EDGAR domains; requests here are spaced at 5 req/sec (`MIN_SPACING_MS`), and the ~1MB ticker→CIK lookup file is cached locally and only re-fetched at most weekly rather than on every refresh click.
- **Recommended for the public deployment:** don't set `ALPHAVANTAGE_API_KEY` there. Keeping the hosted instance in mock mode means a stranger hitting Refresh/Import can't burn your personal daily quota, and removes any incentive to probe the refresh endpoints at all. `SEC_EDGAR_CONTACT` has no comparable abuse cost (no quota to burn), but leaving it unset on a public deployment means visitors triggering Pull Fundamentals would do so under a generic, non-identifying User-Agent — fine functionally, just worth knowing.

## Known limitations (worth being upfront about)

- Parametric VaR/CVaR assume normally distributed returns — understates real tail risk.
- Alpha Vantage's `TIME_SERIES_DAILY?outputsize=compact` returns ~100 sessions — enough for SMA20/50, RSI14, and a 60-day Fibonacci lookback, but SMA200 will be mostly null. Switching to `outputsize=full` would fix this at the cost of much larger responses and slower parsing — not done here to keep the free-tier call cheap and fast.
- P/E-vs-history uses a same-EPS approximation (see above) rather than true historical EPS.
- Factor exposure (Fama-French) and ESG remain stubs — no free reliable data source for either. The Style Box is a DIY substitute (market-cap size × P/E-percentile style), not a real factor regression — see `equitylens-v5-feature-roadmap.md` for the free Ken French data library path to a real one.
- Debt/Equity and Free Cash Flow aren't pulled live to conserve API calls (see above).
- Scenario stress testing propagates shocks through beta only — idiosyncratic (stock-specific) risk isn't modeled, standard for factor-based stress testing but worth knowing.
- Monte Carlo projection uses the portfolio's own trailing annualized return/volatility as GBM inputs — a projection of what the recent regime implies, not a forecast, and short trailing windows (60 sessions) make the vol input noisy.
- Dividend income projection falls back to current yield × price when real trailing-12-month history hasn't been fetched (`DIVIDENDS` is opt-in) — the Holdings/Income tables label which source is being used per ticker.
- **SEC EDGAR extraction (`lib/edgar.js`) was built and unit-tested against real XBRL tag names/shapes, but couldn't be live-tested end-to-end against `data.sec.gov` in the environment it was built in (no network egress there).** Run one real **Pull Fundamentals** locally and check the job log before trusting the numbers — some filers use uncommon tags the alias lists don't cover yet, in which case that field comes back null (not wrong, just absent) rather than guessed.
- **Market Pulse's VIXY volatility card is a proxy, not the real VIX index** — Alpha Vantage has no direct spot-VIX symbol, so VIXY (VIX futures ETF) stands in; its absolute price level does not equal "the VIX," only its trend/direction is a fair read.
- **Market Pulse's breadth is scoped to this app's own tracked universe (up to 14 tickers), not the real market** — there's no free data source for a true NYSE/Nasdaq advance-decline line, so this reads "9 of 14 tracked names in an uptrend," not "68% of the NYSE is advancing."
- **Market Pulse's factor-crowding card is a correlation-based illustrative proxy, not a real positioning metric** — genuine crowding analysis needs 13F holdings concentration, short interest, or ETF-flow data, none of which is available free; average pairwise return correlation across tracked equities is directionally informative at best.

## Next steps (not built yet)

- Wire the `EARNINGS` endpoint for real historical P/E instead of the same-EPS approximation.
- Upgrade the live deployment to a paid always-on tier (currently free-tier Render, which sleeps after 15 min idle) once this is being actively shared.
- Expand `lib/edgar.js`'s tag-alias lists as real filers turn up coverage gaps (see the limitation above) — the extraction code doesn't need to change, only the alias arrays.
- DCF/LBO still run off FCF even for tickers with real EBITDA now available (only the Trading Multiples panel upgrades to a true EV/EBITDA basis) — extending DCF/LBO to optionally use real EBITDA-derived cash flow is a reasonable next pass.
- If a real broad-market breadth feed (advance/decline) or a genuine positioning/crowding data source ever becomes available on a free tier, both Market Pulse cards (breadth, crowding) are built to swap in — the client-side calc functions (`computeMarketBreadth`, `computeCrowdingProxy`) are the only things that would change, same "formulas are data-source agnostic" principle as the risk-kpis/technical-indicators skills.
