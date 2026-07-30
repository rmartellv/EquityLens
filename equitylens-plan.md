# EquityLens Build Plan

## Objective (updated)
Not a personal-brand/LinkedIn exercise. The value is the demonstrated ability to build a genuinely functional platform with real-world application — finance domain fluency + technical execution, evidenced by shipped work rather than a post about it. Two purposes: (1) a hands-on vehicle to learn full-stack + applied-quant skills, (2) a real portfolio artifact for job search (something an interviewer can open and interrogate, not a mockup screenshot). Narrative/LinkedIn framing is dropped as a goal; if any write-up gets made later, it's a technical case study aimed at recruiters/interviewers, not a brand post.

## Decisions locked in
- **Data source:** Yahoo Finance (free API), no live calls in final artifact — mock data only
- **Build depth:** Visual mockup/wireframe, minimal build (interactive demo optional, not required)
- **User story:** Equity research workbench — compare peers/sectors
- **Demo stock set (use consistently across all phases):** AAPL, MSFT, NVDA, GOOGL, META, TSLA, JPM, V — or swap in a themed peer group (e.g., European fintech: Adyen, Wise, Revolut-comp) if that fits your narrative better. Pick one before Phase 1.
- **Risk-free rate baseline:** Fixed 4% (or current 3-month T-bill — decide and note the source in the product doc)
- **VaR methodology:** Parametric (variance-covariance) — simpler to build, still defensible in an interview
- **Mockup tool:** Visualizer (in-chat SVG/HTML mockups) — no Figma learning curve, fast iteration

## Phase 1: Product Definition (1-2 hrs)
**Done when:** 1-2 page doc exists covering:
- User workflow ("day in the life" using the fixed stock/peer set above)
- Data model (fields pulled vs. fields calculated)
- Competitive positioning (Bloomberg/FactSet/retail brokers vs. your angle)

## Phase 2: Wireframes/Mockups (2-3 hrs)
**Done when:** 4 mockups exist (Visualizer):
- Dashboard/home
- Stock detail view
- Portfolio construction + risk metrics
- Comparison view

## Phase 3: Interactive Demo — OPTIONAL (3-6 hrs)
**Done when:** React artifact with the fixed stock set, working search/add-to-portfolio/compare flows, Sharpe/variance/VaR calculated live off static data.
**Decision gate:** Only build if targeting fintech/research interviews where "can ship code" matters more than design signal alone.

## Phase 4: Narrative Layer — SUPERSEDED
Originally a 1-pager + LinkedIn draft. Dropped per updated objective above. If write-up work happens later, it's a technical README/case study, not brand content — see Phase 5.

## Phase 5: Make it real (next)
Options, not yet sequenced — pick based on how much time this gets:
- **Live data integration:** swap the mock 60-day factor-model returns for real historical price pulls (Yahoo Finance unofficial endpoints, or a proper market data API) and recompute every risk-kpis.js formula off real numbers. Biggest jump in "is this real" credibility; also the biggest scope (API access, CORS/backend handling, rate limits, refresh logic).
- **Deployment:** host EquityLens_MVP2.html somewhere live (GitHub Pages / Vercel / Netlify) so it's a shareable URL, not a local file — needed either way if going interactive+live.
- **Technical depth pass:** upgrade parametric VaR/CVaR to historical or Monte Carlo methods, extend the mock window from 60 to 250+ trading days, add real factor exposure (Fama-French) instead of the stub, write tests for the risk-kpis formulas.
- **Case study writeup:** short technical README — architecture, data model, what's mocked vs. real, what a production version would need. Written for an interviewer reading the code, not for a LinkedIn feed.

## Sequence
1. Phase 1 (Product Definition doc) → 2. Phase 2 (done — MVP2) → 3. Phase 3 (done — MVP2) → 4. Phase 5, prioritized by what's decided next.

## Open decision for next session
- Which Phase 5 track to prioritize: live data, deployment, technical depth, or case study writeup (can combine)
- Confirm working mode: guide / collaborate / lead
