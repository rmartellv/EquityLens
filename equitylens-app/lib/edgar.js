/**
 * SEC EDGAR XBRL client — free, no API key, no daily cap (unlike Alpha
 * Vantage above), used to pull REAL fundamentals (revenue, EBITDA components,
 * total debt, cash, shares outstanding) straight from 10-K/10-Q filings,
 * replacing the illustrative MOCK_NET_DEBT_B / derived-shares-out stand-ins
 * the Valuation tab otherwise falls back to. See the equitylens-valuation
 * skill's "Next steps when live fundamentals land" section — this module is
 * that upgrade.
 *
 * SECURITY NOTES (read before changing the request-building code below):
 *  - Only two hosts are ever contacted, both hardcoded, never derived from
 *    caller input: www.sec.gov (ticker->CIK lookup file) and data.sec.gov
 *    (XBRL companyfacts). There is no generic "fetch(url)" helper here on
 *    purpose — that would be one bug away from an SSRF-style relay letting
 *    something point this server's outbound requests at an arbitrary host.
 *  - CIKs are validated against /^\d{10}$/ before ever being concatenated
 *    into a URL path. A CIK only ever comes from the SEC's own ticker file
 *    (loadTickerCikMap), resolved server-side — callers pass a ticker
 *    string (already whitelisted upstream via isKnownTicker in server.js),
 *    never a raw CIK or URL.
 *  - HTTPS only (https.get), fixed hostnames, no redirect-following (Node's
 *    https.get doesn't follow redirects by default — left that way).
 *  - Response size is capped (MAX_RESPONSE_BYTES) and the request is
 *    destroyed if exceeded, so a malformed/huge response can't exhaust
 *    process memory. A request timeout (REQUEST_TIMEOUT_MS) guards against
 *    a hung connection.
 *  - SEC's fair-use ask is a descriptive User-Agent with a real contact
 *    (https://www.sec.gov/os/webmaster-faq#developers). That contact string
 *    is passed in by the caller (server.js), sourced from the gitignored
 *    .env file (SEC_EDGAR_CONTACT) — never hardcode a personal email
 *    directly into this tracked file, since the repo may be public.
 *  - Requests are spaced (MIN_SPACING_MS) well under SEC's documented
 *    10 req/sec cap across all EDGAR domains — good-citizen throttling of a
 *    shared public resource, not just a rate-limit-avoidance mechanic.
 *  - Every numeric fact extracted is range-sanity-checked (sane()) before
 *    being trusted, and every field degrades to null (never a fabricated
 *    guess) if a tag is missing or a value looks absurd — consistent with
 *    the rest of the app's "show — rather than fake it" philosophy.
 */
"use strict";
const https = require("https");
const fs = require("fs");
const path = require("path");

const WWW_HOST = "www.sec.gov";
const DATA_HOST = "data.sec.gov";
const CIK_PATTERN = /^\d{10}$/;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024; // 20MB — companyfacts payloads for prolific filers run low single-digit MB; this is a generous ceiling, not a target
const REQUEST_TIMEOUT_MS = 15000;
const MIN_SPACING_MS = 200; // 5 req/sec, well under SEC's 10 req/sec cap
const CIK_MAP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // re-download the ticker->CIK file at most weekly

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const DEFAULT_USER_AGENT = "EquityLens-Research (contact not configured, set SEC_EDGAR_CONTACT in .env)";
/**
 * Node's http/https module throws "Invalid character in header content" for
 * any header value containing a byte outside safe printable ASCII (e.g. an
 * em dash, smart quotes, an accented letter, an emoji) — which would crash
 * every single request built from an unsanitized contact string. Strip
 * anything outside 0x20-0x7E rather than let that happen; fall back to the
 * default if nothing printable-ASCII survives.
 */
function sanitizeUserAgent(s) {
  const cleaned = String(s || "").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  return cleaned || DEFAULT_USER_AGENT;
}

/** Strip HTML metacharacters from any EDGAR-sourced string before it's stored/rendered (defense in depth, same treatment as other external/imported strings elsewhere in this app). */
function stripHtmlChars(s, maxLen = 120) {
  return String(s ?? "").replace(/[<>&"'`]/g, "").slice(0, maxLen).trim();
}

/** Reject non-finite or absurd values rather than trust third-party JSON blindly. */
function sane(n, min, max) {
  const v = typeof n === "number" ? n : parseFloat(n);
  if (!isFinite(v)) return null;
  if (min != null && v < min) return null;
  if (max != null && v > max) return null;
  return v;
}

/**
 * Fixed-host HTTPS GET with a hard response-size cap and timeout. Deliberately
 * NOT parameterized by hostname from the outside — see file header.
 */
function secGet(host, urlPath, contact) {
  return new Promise((resolve, reject) => {
    const userAgent = sanitizeUserAgent(contact);
    const req = https.request(
      { host, path: urlPath, method: "GET", protocol: "https:", timeout: REQUEST_TIMEOUT_MS, headers: { "User-Agent": userAgent, "Accept": "application/json" } },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume(); // drain so the socket can close cleanly
          const hint = res.statusCode === 403
            ? ` — SEC rejects requests whose User-Agent doesn't look like a real declared identity, not just "any non-empty string" (current one: "${userAgent}"). Set SEC_EDGAR_CONTACT in .env to something like "YourName your-email@example.com" and restart the server.`
            : "";
          return reject(new Error(`SEC EDGAR ${host}${urlPath} returned HTTP ${res.statusCode}${hint}`));
        }
        let body = "";
        let bytes = 0;
        let aborted = false;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            aborted = true;
            req.destroy(new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes — aborted for safety`));
            return;
          }
          body += chunk;
        });
        res.on("end", () => {
          if (aborted) return; // rejection already fired via req's 'error' handler
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`Couldn't parse JSON from ${host}${urlPath}: ${e.message}`)); }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Request to ${host}${urlPath} timed out after ${REQUEST_TIMEOUT_MS}ms`)));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Load (and locally cache, refreshed at most weekly) SEC's ticker->CIK
 * mapping file. Returns a Map from uppercase ticker to zero-padded 10-digit
 * CIK string.
 * @param {object} opts
 * @param {string} opts.contact - SEC_EDGAR_CONTACT value (User-Agent)
 * @param {string} opts.cacheFile - absolute path to the local cache JSON
 * @param {string[]} [opts.log] - optional array to push human-readable progress lines into
 */
async function loadTickerCikMap({ contact, cacheFile, log = [] }) {
  let cached = null;
  try {
    const stat = fs.statSync(cacheFile);
    if (Date.now() - stat.mtimeMs < CIK_MAP_MAX_AGE_MS) {
      cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    }
  } catch { /* no cache yet, or unreadable — fetch fresh below */ }

  let raw = cached;
  if (!raw) {
    log.push("SEC EDGAR: fetching ticker→CIK lookup file (cached weekly, ~1MB, one-time cost)…");
    raw = await secGet(WWW_HOST, "/files/company_tickers.json", contact);
    if (!raw || typeof raw !== "object") throw new Error("Unexpected shape from company_tickers.json");
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(raw));
    log.push("SEC EDGAR: ticker→CIK lookup cached.");
  }

  const map = new Map();
  for (const entry of Object.values(raw)) {
    if (!entry || entry.ticker == null || entry.cik_str == null) continue;
    const ticker = String(entry.ticker).trim().toUpperCase();
    const cikNum = parseInt(entry.cik_str, 10);
    if (!ticker || !Number.isFinite(cikNum)) continue;
    map.set(ticker, String(cikNum).padStart(10, "0"));
  }
  return map;
}

/** @returns {string|null} zero-padded 10-digit CIK, or null if not found/invalid */
function resolveCik(ticker, tickerCikMap) {
  const cik = tickerCikMap.get(String(ticker).trim().toUpperCase());
  return cik && CIK_PATTERN.test(cik) ? cik : null;
}

/** Fetch the full XBRL companyfacts payload for a CIK. Throws if the CIK doesn't pass validation. */
async function fetchCompanyFacts(cik, contact) {
  if (!CIK_PATTERN.test(cik)) throw new Error(`Invalid CIK "${cik}" — refusing to build a request URL from it`);
  return secGet(DATA_HOST, `/api/xbrl/companyfacts/CIK${cik}.json`, contact);
}

// Priority-ordered US-GAAP/DEI tag aliases per field — XBRL tagging isn't
// standardized across filers/years, so each field tries several known names
// and takes the first that resolves. This list is deliberately not
// exhaustive; add aliases here as real filers turn up gaps, rather than
// guessing at parse time.
const TAG_ALIASES = {
  revenue: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"],
  operatingIncome: ["OperatingIncomeLoss"],
  depreciationAmortization: ["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet", "DepreciationAndAmortization"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  longTermDebtNoncurrent: ["LongTermDebtNoncurrent"],
  longTermDebtCurrent: ["LongTermDebtCurrent", "DebtCurrent"],
  totalDebtFallback: ["LongTermDebt", "DebtInstrumentCarryingAmount"], // used only if the split noncurrent/current tags are both absent
  sharesOutstandingDei: ["EntityCommonStockSharesOutstanding"], // dei namespace — cover-page figure, most reliable when present
  sharesOutstandingGaap: ["CommonStockSharesOutstanding"], // us-gaap fallback
};

/**
 * Evaluate EVERY candidate tag in tagList (not just the first with any data),
 * compute each one's best fact via pickFn, and return the single most-recent
 * result across all of them.
 *
 * This matters because companies routinely abandon an old XBRL tag for a
 * newer one — most switched off `Revenues` when adopting ASC 606 around
 * 2018 — and the abandoned tag's array still sits in companyfacts with
 * genuine but stale data. "First alias that has any data" silently locks
 * onto whichever tag is listed first, even if it stopped being updated a
 * decade ago. Caught via a live test run: MSFT's revenue came back from a
 * 2010 filing (its last year using the `Revenues` tag) instead of its most
 * recent 10-K, because `Revenues` is first in TAG_ALIASES.revenue and still
 * had *a* value, just a stale one.
 */
function bestAcrossAliases(factsNs, tagList, unit, pickFn) {
  let best = null;
  for (const tag of tagList) {
    const fact = factsNs && factsNs[tag];
    const arr = fact && fact.units && fact.units[unit];
    if (!Array.isArray(arr) || !arr.length) continue;
    const candidate = pickFn(arr);
    if (candidate && (!best || Date.parse(candidate.end) > Date.parse(best.fact.end))) {
      best = { tag, fact: candidate };
    }
  }
  return best;
}

/** Most recent annual (10-K) duration fact — revenue, operating income, D&A. */
function pickLatestAnnualDuration(arr) {
  const annual = arr.filter((o) => o && o.form === "10-K" && o.start && o.end && (Date.parse(o.end) - Date.parse(o.start)) > 300 * 86400000);
  const pool = annual.length ? annual : arr.filter((o) => o && o.start && o.end && (Date.parse(o.end) - Date.parse(o.start)) > 300 * 86400000);
  if (!pool.length) return null;
  pool.sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
  return pool[0];
}

/** Most recent instant fact (balance-sheet items, shares outstanding) — no start date, just "as of end". */
function pickLatestInstant(arr) {
  const withEnd = arr.filter((o) => o && o.end);
  if (!withEnd.length) return null;
  withEnd.sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
  return withEnd[0];
}

/**
 * Most recent annual duration fact strictly BEFORE excludeEnd (the period
 * already picked as "latest") on the SAME tag's fact array — used to compute
 * YoY revenue growth without mixing two different XBRL tags across a
 * tag-abandonment boundary (see bestAcrossAliases' doc comment). Companies
 * that switch tags almost always restate at least one prior comparative
 * period under the new tag, so staying within the winning tag's own array is
 * both simpler and safer than reaching into an old, possibly-abandoned tag.
 */
function pickPriorAnnualDuration(arr, excludeEnd) {
  const annual = arr.filter((o) => o && o.form === "10-K" && o.start && o.end && o.end !== excludeEnd && (Date.parse(o.end) - Date.parse(o.start)) > 300 * 86400000);
  const pool = annual.length ? annual : arr.filter((o) => o && o.start && o.end && o.end !== excludeEnd && (Date.parse(o.end) - Date.parse(o.start)) > 300 * 86400000);
  if (!pool.length) return null;
  pool.sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
  return pool[0];
}

/**
 * Pull the fields the Valuation tab needs out of a raw companyfacts payload.
 * Every field independently degrades to null if its tag(s) aren't present or
 * the value fails a sanity check — never fabricated, matching the app's
 * existing "show — rather than fake it" convention. Dollar figures are
 * returned in $B and shares in billions, to match the units already used
 * throughout the valuation engine (see impliedNetDebt/impliedSharesOut).
 */
function extractFundamentals(companyFacts) {
  const gaap = companyFacts && companyFacts.facts && companyFacts.facts["us-gaap"];
  const dei = companyFacts && companyFacts.facts && companyFacts.facts["dei"];
  const entityName = companyFacts && companyFacts.entityName ? stripHtmlChars(companyFacts.entityName, 120) : null;
  if (!gaap) return { entityName, revenueB: null, ebitdaB: null, totalDebtB: null, cashB: null, netDebtB: null, sharesOutB: null, revGrowthPct: null, ebitdaMarginPct: null, periodEnd: null, filedDate: null, form: null };

  const revenueHit = bestAcrossAliases(gaap, TAG_ALIASES.revenue, "USD", pickLatestAnnualDuration);
  const revenueB = revenueHit ? sane(revenueHit.fact.val / 1e9, 0, 5000) : null;

  // YoY revenue growth: the prior comparative period on the SAME winning tag
  // (not a different alias — see pickPriorAnnualDuration doc comment).
  let revGrowthPct = null;
  if (revenueHit) {
    const revArr = gaap[revenueHit.tag] && gaap[revenueHit.tag].units && gaap[revenueHit.tag].units.USD;
    const priorRev = Array.isArray(revArr) ? pickPriorAnnualDuration(revArr, revenueHit.fact.end) : null;
    if (priorRev) {
      const priorRevB = sane(priorRev.val / 1e9, 0, 5000);
      if (priorRevB != null && priorRevB > 0 && revenueB != null) {
        revGrowthPct = sane((revenueB - priorRevB) / priorRevB, -0.95, 5);
      }
    }
  }

  const opIncHit = bestAcrossAliases(gaap, TAG_ALIASES.operatingIncome, "USD", pickLatestAnnualDuration);
  const opIncB = opIncHit ? sane(opIncHit.fact.val / 1e9, -1000, 2000) : null;

  const daHit = bestAcrossAliases(gaap, TAG_ALIASES.depreciationAmortization, "USD", pickLatestAnnualDuration);
  const daB = daHit ? sane(daHit.fact.val / 1e9, 0, 1000) : null;

  const ebitdaB = (opIncB != null && daB != null) ? opIncB + daB : null;

  // EBITDA margin off the same latest-period revenue/EBITDA figures above —
  // approximate if revenue/opInc/D&A happened to anchor to slightly
  // different fiscal periods (same caveat that already applies to ebitdaB).
  const ebitdaMarginPct = (ebitdaB != null && revenueB != null && revenueB > 0) ? sane(ebitdaB / revenueB, -2, 2) : null;

  const cashHit = bestAcrossAliases(gaap, TAG_ALIASES.cash, "USD", pickLatestInstant);
  const cashB = cashHit ? sane(cashHit.fact.val / 1e9, 0, 2000) : null;

  const ltdNoncurHit = bestAcrossAliases(gaap, TAG_ALIASES.longTermDebtNoncurrent, "USD", pickLatestInstant);
  const ltdCurHit = bestAcrossAliases(gaap, TAG_ALIASES.longTermDebtCurrent, "USD", pickLatestInstant);
  let totalDebtB = null;
  if (ltdNoncurHit || ltdCurHit) {
    totalDebtB = sane(((ltdNoncurHit ? ltdNoncurHit.fact.val : 0) + (ltdCurHit ? ltdCurHit.fact.val : 0)) / 1e9, 0, 3000);
  } else {
    const fallbackHit = bestAcrossAliases(gaap, TAG_ALIASES.totalDebtFallback, "USD", pickLatestInstant);
    totalDebtB = fallbackHit ? sane(fallbackHit.fact.val / 1e9, 0, 3000) : null;
  }

  const netDebtB = (totalDebtB != null && cashB != null) ? sane(totalDebtB - cashB, -3000, 3000) : null;

  const sharesDeiHit = dei ? bestAcrossAliases(dei, TAG_ALIASES.sharesOutstandingDei, "shares", pickLatestInstant) : null;
  const sharesGaapHit = bestAcrossAliases(gaap, TAG_ALIASES.sharesOutstandingGaap, "shares", pickLatestInstant);
  const sharesHit = (sharesDeiHit && sharesGaapHit)
    ? (Date.parse(sharesDeiHit.fact.end) >= Date.parse(sharesGaapHit.fact.end) ? sharesDeiHit : sharesGaapHit)
    : (sharesDeiHit || sharesGaapHit);
  const sharesOutB = sharesHit ? sane(sharesHit.fact.val / 1e9, 0, 100) : null;

  // Use whichever fact gave us the most recent period-end as the headline "as of" date.
  const candidates = [revenueHit, opIncHit, cashHit, ltdNoncurHit, sharesHit].filter(Boolean);
  candidates.sort((a, b) => Date.parse(b.fact.end) - Date.parse(a.fact.end));
  const anchor = candidates[0];
  return {
    entityName,
    revenueB, ebitdaB, totalDebtB, cashB, netDebtB, sharesOutB,
    revGrowthPct, ebitdaMarginPct,
    // stripHtmlChars here even though periodEnd is an XSD "date"-typed XBRL
    // element (SEC's filing-acceptance pipeline validates instance documents
    // before accepting a filing, so this should already be a plain date) —
    // sanitizing every extracted string the same way, regardless of how
    // trustworthy its expected shape is, is cheaper than reasoning about
    // which fields "can't possibly" carry markup and getting it wrong once.
    periodEnd: anchor ? stripHtmlChars(anchor.fact.end, 20) : null,
    filedDate: anchor ? stripHtmlChars(anchor.fact.filed, 20) : null,
    form: anchor ? stripHtmlChars(anchor.fact.form, 20) : null,
  };
}

module.exports = {
  MIN_SPACING_MS,
  CIK_PATTERN,
  sleep,
  loadTickerCikMap,
  resolveCik,
  fetchCompanyFacts,
  extractFundamentals,
};
