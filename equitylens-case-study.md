# EquityLens: An Equity Research & Portfolio Risk Workbench

*Technical case study — architecture, design decisions, and what's real vs. simulated. Written for someone reading the code, not a LinkedIn feed.*

## The problem

Equity analysts and portfolio managers work across disconnected tools: a terminal for fundamentals, a spreadsheet for portfolio-level risk (variance, Sharpe, VaR), a separate screener for technicals, and yet another view for peer comparisons. Nothing ties fundamentals, portfolio risk, and technical/valuation screening together in one workspace with a shared data model. Bloomberg and FactSet solve this at a price point ($20-25k/seat/year) that puts them out of reach for the audience who'd benefit most from a lighter version — retail-adjacent investors, students, and analysts who want the workflow without the licensing cost.

EquityLens is a bet that the workflow, not the data breadth, is the differentiator. It doesn't compete with Bloomberg's data coverage. It replicates the analyst's actual day-to-day loop — screen, drill into a name, size a position, check what that does to portfolio-level risk — in one place, built on free data.

## What it does

Five views over a 14-name universe (11 single names, 3 sector ETFs), running as a zero-dependency Node server plus a static frontend:

**Dashboard** — watchlist with live/mock/pending status per ticker, quick sort by momentum and valuation.

**Stock Detail** — fundamentals (P/E, ROE, debt/equity, revenue growth, EBITDA margin, FCF), technical indicators (SMA/EMA, RSI, Fibonacci retracement, momentum), analyst consensus, dividend history, and news sentiment.

**Portfolio & Risk** — the core of the app. Position-level risk KPIs (Sharpe, Sortino, Treynor, Jensen's Alpha, beta, R²) roll up to portfolio-level variance, parametric and empirical VaR/CVaR, max drawdown, correlation matrix, HHI/Effective N concentration measures. On top of that: scenario stress testing against five historical shocks (2008 GFC, 2020 COVID, 2022 rate selloff, plus generic ±10%/+15% moves) propagated through each position's beta; target-weight rebalancing with live drift tracking and suggested trade sizes; automated concentration, correlation-cluster, and liquidity flags; a Morningstar-style size × value/growth style box; a 300-path Monte Carlo terminal-value projection; and unrealized P&L once cost basis is known.

**Screener** — cross-universe valuation-vs-own-history and momentum ranking, plus a composite 0–100 "EquityLens Score" blending valuation (30%), momentum (30%), quality/ROE (20%), and revenue growth (20%) percentiles.

**Comparison** — side-by-side fundamentals, valuation multiples, and growth across a user-selected peer set.

Portfolios can be built manually or imported from an Excel/CSV file (ticker resolution via Alpha Vantage's `SYMBOL_SEARCH`, FX conversion for non-USD positions, graceful fallback to a "pending" state for tickers that can't be fetched immediately).

## Architecture

The design principle that drives every decision in the codebase: **formulas take arrays in, they never fetch data themselves.** Every risk and technical calculation (`sharpe()`, `parametricVaR()`, `rsi()`, `correlation()`, `compositeScore()`, etc.) is a pure function operating on plain numeric arrays. This means the same formula runs identically on mock data and live data — the math doesn't know or care where the numbers came from. It's what let the entire portfolio-management layer (stress testing, rebalancing, concentration flags, Monte Carlo) get built and fully tested against deterministic mock data with zero API calls, then work unchanged the moment real prices are wired in.

The app ships **mock-first**: a deterministic pseudo-random engine (`mulberry32` seeded per ticker) generates a realistic 120-day price history and fundamentals snapshot for every ticker on first load, so the whole app is functional with zero setup, zero API key, and zero network calls. `server.js` optionally overlays real data on top — per ticker, on demand — by calling Alpha Vantage and merging results into `data.json`, which the frontend reads on top of its mock defaults. Nothing breaks if you never add a key; you just stay in mock mode.

That overlay is **budget-aware by construction**, not by accident. Alpha Vantage's free tier caps out at 25 requests/day, 5/minute. The server tracks daily usage in a local file, refuses to start a refresh that would exceed the remaining quota (telling you in the UI instead of failing halfway through), and paces calls ~15 seconds apart to stay under the per-minute limit. As of the latest pass, refreshes also split into **full** (price + fundamentals, 2 calls/ticker) and **price-only** (1 call/ticker) modes — fundamentals move slowly enough that most refreshes only need fresh prices, which roughly doubles the effective daily budget.

## What's real vs. what's simulated

This is disclosed in-app, not hidden — every approximation has a corresponding footnote or README section explaining what it stands in for and what the real version would need:

- **Prices, P/E, dividend yield, ROE, revenue growth, EBITDA margin, 52-week range, analyst consensus** — real, once a ticker is refreshed live (`TIME_SERIES_DAILY` + `OVERVIEW`).
- **Debt/Equity and Free Cash Flow** — not pulled live, to conserve API budget (`BALANCE_SHEET`/`CASH_FLOW` would be needed); shown as mock/placeholder for live tickers.
- **P/E-vs-history valuation screen** — approximated as `price ÷ current EPS` held constant over the lookback window, rather than true historical EPS. The real fix is Alpha Vantage's `EARNINGS` endpoint; the percentile-ranking math itself doesn't change when that data source swaps in.
- **VaR/CVaR** — both a parametric version (assumes normally distributed returns, understates tail risk) and an empirical version (historical-simulation, sorts actual trailing returns) are shown side by side, so the user sees where the two disagree rather than trusting one blindly.
- **Beta/Sharpe/correlation** — computed against a real SPY benchmark once fetched, with a synthetic proxy fallback so the UI never shows a broken metric before that first live pull.
- **Factor exposure (Fama-French) and ESG** — genuine stubs. No reliable free data source for either; the style box (market-cap size × P/E-percentile style tilt) is a deliberate DIY substitute, not a real regression.
- **Monte Carlo** — a geometric Brownian motion projection using the portfolio's own trailing 60-day annualized return/vol as drift/vol inputs. It's a projection of what the recent regime implies, explicitly not a forecast — the short window makes the vol input noisy, which is disclosed rather than smoothed over.

## What a production version would need

Ranked by where the ratio of "real quant work" to "new infrastructure" is highest:

1. **Live-hosted deployment.** Currently local-only (`node server.js`, `localhost:3300`). Moving `/api/refresh` into a Vercel/Railway serverless function is a small lift given the zero-dependency design — the formula layer doesn't change at all.
2. **Real historical EPS via `EARNINGS`.** Replaces the same-EPS approximation with true trailing P/E history — the single highest-value data upgrade relative to effort, since the percentile-ranking math is already correct.
3. **A real factor model.** Ken French's data library (free, CSV, updated monthly) supplies the actual Fama-French factor returns needed to replace the style-box stand-in with a genuine three- or four-factor regression against each holding's return history.
4. **Historical scenario stress testing beyond beta-propagation.** Currently every shock scenario assumes idiosyncratic risk washes out and only systematic (beta) risk matters — standard for factor-based stress testing, but a real production version would model name-specific tail risk too.
5. **Bonds and options.** Scoped separately (see `equitylens-bonds-derivatives-plan.md`) — bond valuation (PV/YTM/duration/convexity via the Treasury curve, already available through `TREASURY_YIELD`) is the more tractable next asset class; listed equity options (Black-Scholes, Greeks, implied vol) is the bigger lift, gated on getting a reliable options-chain/IV data source working.

## Interview talking points

**Why build this instead of using an existing tool?** Because the interesting problem isn't "can I display a stock price" — it's the plumbing decision of keeping a formula layer completely decoupled from its data source, so the same Sharpe ratio calculation is provably correct on day-one mock data and on day-500 live data without being rewritten. That's a real architecture decision, not a demo shortcut.

**What was the hardest part?** Staying honest about what's approximated. It would have been easy to fake a factor-exposure number or a smoothed VaR and let it look more finished. Every simplification here is disclosed in the UI itself (footnotes, `src-pill` badges showing live/mock/pending) and in the README's "known limitations" section — because an interviewer who opens the network tab or reads the code will find the gap either way, and disclosing it first is the more credible signal.

**What would you change with more time?** Real EARNINGS-based P/E history first — it's the cheapest true accuracy upgrade left. Then a genuine Fama-French regression, since the data (Ken French's library) is already sitting there unused. Deployment comes before either, though, because a live URL beats a better formula every time an interviewer actually has to decide whether to click.
