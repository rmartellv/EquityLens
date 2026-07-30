/**
 * EquityLens Technical Analysis & Valuation-Screen calculations.
 * Pure functions — no ticker strings, no API calls. Feed them price arrays.
 * Same design principle as risk-kpis.js: swap mock data for live data
 * without touching this file.
 *
 * All price arrays are chronological, oldest -> newest.
 */

/* ---------------- moving averages ---------------- */

/**
 * Simple moving average.
 * @param {number[]} prices
 * @param {number} length
 * @returns {(number|null)[]} same length as prices, null until enough data
 */
function sma(prices, length) {
  const out = new Array(prices.length).fill(null);
  let sum = 0;
  for (let i = 0; i < prices.length; i++) {
    sum += prices[i];
    if (i >= length) sum -= prices[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

/**
 * Exponential moving average, seeded with an SMA of the first `length` points.
 * @param {number[]} prices
 * @param {number} length
 * @returns {(number|null)[]}
 */
function ema(prices, length) {
  const out = new Array(prices.length).fill(null);
  const k = 2 / (length + 1);
  let prev = null;
  for (let i = 0; i < prices.length; i++) {
    if (i === length - 1) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += prices[j];
      prev = sum / length;
      out[i] = prev;
    } else if (i >= length) {
      prev = prices[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/* ---------------- momentum ---------------- */

/**
 * Relative Strength Index (Wilder's smoothing).
 * @param {number[]} prices
 * @param {number} length - typically 14
 * @returns {(number|null)[]}
 */
function rsi(prices, length = 14) {
  const out = new Array(prices.length).fill(null);
  if (prices.length <= length) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= length; i++) {
    const chg = prices[i] - prices[i - 1];
    if (chg >= 0) gains += chg; else losses -= chg;
  }
  let avgGain = gains / length, avgLoss = losses / length;
  out[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = length + 1; i < prices.length; i++) {
    const chg = prices[i] - prices[i - 1];
    const gain = chg > 0 ? chg : 0, loss = chg < 0 ? -chg : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Rate of change over a trailing window, e.g. rateOfChange(prices, 20) = 20-day momentum.
 * @param {number[]} prices
 * @param {number} length
 * @returns {number|null}
 */
function rateOfChange(prices, length) {
  const n = prices.length;
  if (n <= length) return null;
  const past = prices[n - 1 - length];
  return past === 0 ? null : (prices[n - 1] - past) / past;
}

/**
 * Trend signal from a short/long moving-average pair (golden-cross / death-cross style).
 * @param {number|null} maShort - e.g. SMA20 latest value
 * @param {number|null} maLong - e.g. SMA50 or SMA200 latest value
 * @param {number} price - latest close
 * @returns {"Bullish"|"Bearish"|"Neutral"|"N/A"}
 */
function trendSignal(maShort, maLong, price) {
  if (maShort == null || maLong == null) return "N/A";
  if (maShort > maLong && price > maShort) return "Bullish";
  if (maShort < maLong && price < maShort) return "Bearish";
  return "Neutral";
}

/* ---------------- Fibonacci retracement ---------------- */

/**
 * Fibonacci retracement levels over the most recent `lookback` prices.
 * Direction is inferred from whether the window's last close is above or
 * below its first close (a simplification — production charting tools let
 * the user pick the swing high/low manually).
 * @param {number[]} prices
 * @param {number} lookback - e.g. 60
 * @returns {{high:number, low:number, uptrend:boolean, levels:Object<string,number>}}
 */
function fibonacciRetracement(prices, lookback) {
  const window = prices.slice(-lookback);
  const high = Math.max(...window);
  const low = Math.min(...window);
  const diff = high - low;
  const uptrend = window[window.length - 1] >= window[0];
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const levels = {};
  ratios.forEach((r) => {
    // In an uptrend, retracement is measured down from the high; in a
    // downtrend, up from the low.
    levels[r] = uptrend ? high - diff * r : low + diff * r;
  });
  return { high, low, uptrend, levels };
}

/* ---------------- valuation screen ---------------- */

/**
 * Builds a synthetic historical P/E series from a price series and a
 * (assumed roughly constant over the window) EPS figure. This is an
 * approximation — see references/data-mapping in the risk-kpis skill for
 * how a real implementation would instead pull trailing EPS per period
 * from the EARNINGS endpoint and divide real historical prices by it.
 * @param {number[]} priceSeries
 * @param {number} eps
 * @returns {(number|null)[]}
 */
function impliedPeSeries(priceSeries, eps) {
  if (!eps || eps <= 0) return priceSeries.map(() => null);
  return priceSeries.map((p) => p / eps);
}

/**
 * Where does `value` sit within `series`, as a percentile 0-1.
 * @param {(number|null)[]} series
 * @param {number} value
 * @returns {number|null}
 */
function percentileRank(series, value) {
  const valid = series.filter((x) => x != null && !isNaN(x));
  if (valid.length === 0) return null;
  const below = valid.filter((x) => x <= value).length;
  return below / valid.length;
}

/**
 * Human-readable valuation tag from a P/E percentile.
 * @param {number|null} percentile
 */
function valuationTag(percentile) {
  if (percentile == null) return "N/A";
  if (percentile <= 0.25) return "Cheap vs. history";
  if (percentile >= 0.75) return "Expensive vs. history";
  return "Fair vs. history";
}

/* ---------------- momentum composite (for screener ranking) ---------------- */

/**
 * Simple composite momentum score blending short/medium rate-of-change and
 * RSI distance from neutral (50). Not a formal factor model — a ranking
 * heuristic for the screener table, disclosed as such in the UI.
 * @param {number[]} prices
 * @returns {number|null}
 */
function momentumScore(prices) {
  const roc20 = rateOfChange(prices, 20);
  const roc60 = rateOfChange(prices, Math.min(60, prices.length - 1));
  const rsiSeries = rsi(prices, 14);
  const latestRsi = rsiSeries[rsiSeries.length - 1];
  if (roc20 == null && roc60 == null && latestRsi == null) return null;
  const rocComponent = ((roc20 || 0) + (roc60 || 0)) / 2;
  const rsiComponent = latestRsi != null ? (latestRsi - 50) / 50 : 0;
  return rocComponent * 0.7 + rsiComponent * 0.3;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    sma, ema, rsi, rateOfChange, trendSignal, fibonacciRetracement,
    impliedPeSeries, percentileRank, valuationTag, momentumScore,
  };
}
