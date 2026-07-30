# EquityLens — Bonds & Derivatives Expansion Plan

Status: future reference, not started. EquityLens today (MVP4) covers equities and ETFs only — fundamentals, portfolio risk KPIs, technical/valuation screening, Excel import. This document plans two follow-on tracks that each add a new asset class with its own valuation engine, data model, and UI. They're designed to be built and shipped independently, in sequence, using the same architecture principles as the existing app (pure formula functions separated from data source, mock-first with live overlay, a dedicated skill saved per domain).

Recommended order: **Bonds first, then Derivatives.** Bond valuation is a closed-form, well-specified problem with data that's freely available (Treasury curve) and reuses infrastructure you already have (discounting, duration is conceptually adjacent to the risk-kpis you've already built). Derivatives pricing is a bigger lift — needs an implied volatility surface, which is the hardest data input to get reliably for free — so it benefits from coming second once the bond track has proven out the "new asset class" pattern (data model, nav view, job-based refresh, pending-ticker handling) once already.

---

## Track A: Bond Valuation

### What "correctly valuate a bond" means here
Given a bond's terms (face value, coupon rate, coupon frequency, maturity date, day-count convention) and a discount curve, compute:
- **Fair price** — present value of all future cashflows (coupons + principal) discounted at the appropriate rate for each cashflow's maturity.
- **Yield to maturity (YTM)** — the single discount rate that makes PV of cashflows equal the market price (solved numerically, e.g. Newton-Raphson or bisection on the price/yield function).
- **Duration** — Macaulay duration (weighted-average time to cashflow, in years) and modified duration (% price sensitivity to a 1% parallel yield shift).
- **Convexity** — second-order price sensitivity, needed because duration alone under/overstates price moves for large yield changes.
- **DV01 / PV01** — dollar price change for a 1bp yield move; the practitioner's actual risk unit.
- **Spread over benchmark** — the bond's YTM minus the interpolated point on the government curve at the same maturity (a G-spread). A proper Z-spread (constant spread added to every point of the zero curve, not just one point) is the more rigorous version and is a reasonable "v2" upgrade once the basic G-spread works.
- **Credit spread context** — where the bond's spread sits vs. its rating category, so "cheap/rich vs. peers" judgments are possible (mirrors the P/E-percentile screen you already have for equities).

### Data model
New `bonds` object in `data.json`, parallel to the existing `universe`:
```
bonds: {
  "<cusip-or-id>": {
    issuer, ticker, couponRate, couponFreq, faceValue, maturityDate, issueDate,
    dayCount ("30/360" | "ACT/ACT" | "ACT/360"), rating, sector, currency,
    marketPrice, marketYield, lastRefreshed, dataSource
  }
}
```
Plus a shared `yieldCurve` object: `{ date, points: [{tenorYears, rate}], source }` — the discount curve every bond valuation references. Cashflow schedules are *computed*, not stored (pure function of coupon terms + day-count convention), consistent with the "formulas take arrays in, never fetch data themselves" principle already used in `equitylens-risk-kpis`.

### Formula layer (new skill: `equitylens-bond-valuation`)
Pure functions, no API calls, mirroring the existing skill pattern:
- `generateCashflowSchedule(bond, valuationDate)` → array of `{date, amount, yearsFromValuation}`
- `presentValue(cashflows, discountCurve)` → price
- `yieldToMaturity(cashflows, marketPrice)` → solved via Newton-Raphson, starting guess = coupon rate
- `macaulayDuration(cashflows, ytm)`, `modifiedDuration(macDur, ytm, freq)`
- `convexity(cashflows, ytm)`
- `dv01(price, modifiedDuration)`
- `interpolateCurve(curve, tenorYears)` → linear or cubic-spline interpolation for reading the discount curve at arbitrary maturities
- `gSpread(bondYtm, curve, maturityYears)`
- `priceGivenYieldShock(cashflows, ytm, shockBps)` → for the scenario/stress table (same spirit as the VaR scenario work already in the risk-kpis skill)

This is a genuinely separate skill from `equitylens-risk-kpis` (different math domain — discounting/duration vs. portfolio statistics) even though both eventually feed the same portfolio-level view. Worth keeping them split so each stays focused and reusable on its own.

### Data sources / APIs needed
- **Government yield curve**: Alpha Vantage's `TREASURY_YIELD` function (already in your connected MCP — you're just not using it yet) covers 3-month through 30-year US Treasury yields. That alone is enough to build and demo the whole track on Treasuries with zero new connectors.
- **Corporate bond reference data & pricing**: this is the actual gap. Alpha Vantage has no corporate bond endpoint. Two paths: (1) let the user manually enter a corporate bond's terms (coupon, maturity, price) — the valuation math doesn't care where the inputs came from, so this alone unlocks the full feature; (2) the **LSEG connector** you already have installed (not yet authorized) ships purpose-built skills for exactly this — `bond-relative-value` (pricing + curve + credit spread + stress testing) and `fixed-income-portfolio` (multi-bond portfolio pricing, reference data, cashflow waterfalls, scenario analysis) and `bond-futures-basis` (CTD/implied repo, if you ever want the futures angle). If/when you authorize LSEG, it likely replaces a meaningful chunk of the "corporate bond data" problem outright rather than requiring you to source it elsewhere — worth checking what it returns before building your own scraper/manual-entry-only path.
- **Credit spread benchmarks by rating**: harder to get for free; FRED (St. Louis Fed) publishes ICE BofA corporate index yields by rating bucket (AAA, AA, A, BBB, high yield) as free public data — usable as a rough peer benchmark even without a full corporate curve.

### UI additions
- New nav item: **Bonds**. Bond entry form (or CSV/Excel import, reusing the SheetJS pattern from the equity portfolio import) → cashflow schedule table → price/YTM/duration/convexity/DV01 output → a rate-shock scenario table (price at curve ±25bp/±50bp/±100bp, same idea as the existing VaR/CVaR cards) → spread-vs-curve chart (bond's yield plotted against the Treasury curve at its maturity, visually showing rich/cheap).
- Portfolio & Risk view eventually needs a bond sleeve: aggregate portfolio duration/DV01 alongside the existing equity risk metrics — this is a real architectural decision to make later (single unified portfolio view mixing asset classes vs. separate per-asset-class portfolio views); worth deciding once bonds are actually working standalone.

---

## Track B: Derivatives Valuation

### Scope decision
"Derivatives" is broad — start with **listed equity options** specifically. They have the best free data availability (you already have `REALTIME_OPTIONS_FMV`, `HISTORICAL_OPTIONS`, `REALTIME_OPTIONS`, and put/call ratio endpoints sitting unused in the Alpha Vantage connector), the valuation math is standard and well-bounded (Black-Scholes-Merton), and it plugs directly into tickers you already track in EquityLens. Futures, swaps, and more exotic derivatives are a possible "v2" once options work — the LSEG connector's `swap-curve-strategy` and `option-vol-analysis` skills would be the natural data source if you go there.

### What "correctly valuate a derivative" means here (for options)
Given the option's terms (underlying, strike, expiration, type) plus market inputs (spot price, risk-free rate, dividend yield, volatility), compute:
- **Theoretical price** — Black-Scholes-Merton closed-form for European-style; a binomial/CRR tree if you want American-style early-exercise handling (equity options are typically American, so this matters if you want full realism — can ship BSM first and disclose the simplification, same pattern as the VaR-assumes-normal-returns disclosure already in the README).
- **Greeks** — delta, gamma, vega, theta, rho (closed-form under BSM, straightforward to implement).
- **Implied volatility** — solve BSM in reverse: given the market's actual option price, back out the volatility the market is pricing in (Newton-Raphson or bisection on the BSM price function). This is the single most valuable number for the "is this option cheap or expensive" judgment.
- **Implied vs. realized vol comparison** — implied vol from the option chain vs. the underlying's trailing realized volatility (you can already compute this — it's just `stdev()` on `RETURNS_FULL`, a function you already have). A large implied > realized gap is a classic vol-richness signal.
- **Vol surface / smile** — implied vol plotted across strikes (smile) and across expirations (term structure), for a single underlying at a point in time.

### Data model
```
derivatives: {
  "<contract-id>": {
    underlying, type ("call"|"put"), strike, expiration, style ("european"|"american"),
    lastPrice, bid, ask, openInterest, volume, impliedVol (from provider, if given),
    dataSource, lastRefreshed
  }
}
```
Underlying spot price, dividend yield, and realized vol all come from the existing `universe`/`prices` data — the derivatives module is additive on top of what you already have, not a parallel data pipeline.

### Formula layer (new skill: `equitylens-derivatives-pricing`)
- `blackScholesPrice(S, K, T, r, sigma, q, type)` — closed-form European price
- `blackScholesGreeks(S, K, T, r, sigma, q, type)` → delta/gamma/vega/theta/rho
- `impliedVolatility(marketPrice, S, K, T, r, q, type)` — numerical solve, bounded/damped Newton-Raphson with a bisection fallback for robustness near the boundaries
- `binomialTreePrice(S, K, T, r, sigma, q, type, style, steps)` — CRR tree, handles American early exercise
- `realizedVol(returns, annualizationFactor)` — you likely already have the building block (`stdev`) from risk-kpis; this just wraps it with the right annualization for direct comparison to implied vol
- `volSurfacePoints(chain)` → reshapes a raw option chain into strike × expiration implied-vol grid for charting

### Data sources / APIs needed
- **Option chain + greeks/IV**: `REALTIME_OPTIONS_FMV` (with `require_greeks:true`) and `HISTORICAL_OPTIONS` are already available through your connected Alpha Vantage MCP — this is the main unlock and it's already sitting there unused. Confirm free-tier call cost and rate limits for these specifically (they weren't part of the original 25/day budget planning) before wiring them into the same daily-usage counter as everything else.
- **Risk-free rate**: `FEDERAL_FUNDS_RATE` or `TREASURY_YIELD` (3-month) — also already available, also unused today (the app currently hardcodes `RF = 0.043`).
- **Dividend yield**: already pulled today (`OVERVIEW`'s `DividendYield` field) — no new source needed.
- **LSEG's `option-vol-analysis` skill** is worth checking once authorized — purpose-built for vol surface + Greeks + implied-vs-realized comparison, might shortcut a chunk of the manual BSM/IV-solver implementation if it returns computed Greeks directly rather than raw data only.

### UI additions
- New nav item: **Derivatives**, or a tab inside Stock Detail ("Options Chain" alongside the existing Fundamentals/Analyst Consensus sections) — the latter is probably the better fit since options are always underlying-specific, and it keeps the option chain visually anchored to the stock's price/technical context you've already built.
- Option chain table (strikes × calls/puts, with price/IV/Greeks columns), a payoff diagram at expiration (simple to render — just a piecewise-linear line chart, reuses Chart.js), and an implied-vs-realized vol comparison stat card.

---

## Sequencing & effort shape

1. **Bonds, phase 1 (Treasuries only, manual corporate entry optional)**: yield curve fetch, cashflow/PV/YTM/duration/convexity math, bond entry UI, scenario table. No new external dependency required beyond `TREASURY_YIELD`, which you already have access to.
2. **Bonds, phase 2 (corporate depth)**: evaluate authorizing the LSEG connector, see what `bond-relative-value`/`fixed-income-portfolio` actually return, decide whether to consume it directly or just use it as a spec/validation reference for your own formulas.
3. **Derivatives, phase 1 (options, BSM + IV solver)**: wire `REALTIME_OPTIONS_FMV`/`HISTORICAL_OPTIONS` into the existing server.js job/budget pattern, build the pricing + Greeks + IV formula skill, ship the options chain UI inside Stock Detail.
4. **Derivatives, phase 2 (American exercise + vol surface)**: binomial tree, smile/term-structure charts, implied-vs-realized comparison.

### Skills to create when the work starts
- `equitylens-bond-valuation` — cashflow generation, PV/YTM/duration/convexity/DV01, curve interpolation, spread calc. Save it the same way `equitylens-risk-kpis` and `equitylens-technical-indicators` were saved, so it persists across sessions.
- `equitylens-derivatives-pricing` — BSM pricing, Greeks, implied vol solver, binomial tree, vol surface reshaping.

### Connectors to evaluate
- **LSEG** (already installed, needs authorization in claude.ai connector settings) — the most directly relevant connector for both tracks; its skill set (`bond-relative-value`, `fixed-income-portfolio`, `bond-futures-basis`, `option-vol-analysis`, `swap-curve-strategy`) maps almost one-to-one onto this plan. Worth authorizing early in Track A just to see what it returns before committing to a from-scratch corporate bond data path.
- **Daloopa** (already installed, needs authorization) — deep equity fundamentals/modeling, not directly relevant to bonds or derivatives pricing, but could feed a credit-analysis overlay for corporate bonds later (leverage ratios, interest coverage — inputs to a qualitative credit view alongside the quantitative spread analysis).
- **Alpha Vantage** (already connected and in active use) — covers the Treasury curve, risk-free rate, and the full options chain/Greeks/IV surface already. No new connector needed to build a first working version of either track.

### Open questions for when you actually start
- Single unified multi-asset portfolio view, or separate per-asset-class views that roll up at the very top level only? Affects both `state.portfolio`'s shape and how weights/risk aggregate across equities, bonds, and derivatives (which have very different risk units — % of NAV vs. DV01 vs. delta-adjusted notional).
- European-only options (simpler, ships faster) vs. American from day one (more realistic for equity options, needs the binomial tree from the start) — recommend European first, same "ship the simpler correct thing, disclose the simplification" pattern used throughout this app.
- How much of the LSEG connector to lean on vs. building the formula layer yourself — the formula layer is valuable to build regardless (it's the actual demonstrable skill for interviews), but LSEG could meaningfully cut the data-sourcing grind, especially for corporate bonds.
