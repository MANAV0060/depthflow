/**
 * TPOEngine.js
 * Institutional Time Price Opportunity (TPO) & Market Profile Engine.
 * Implements:
 * - 30-minute bracket letter assignment (A-Z, a-z)
 * - Rainbow period color progression (Heatmap)
 * - Initial Balance (IB: Periods A & B)
 * - TPO Point of Control (tPOC) & Volume Point of Control (vPOC)
 * - 70% Steidlmayer TPO Value Area (VAH & VAL)
 * - Single Prints detection (fast discovery / directional excess)
 * - Naked POC (nPOC) ray projection across sessions until tested
 */

import { getTickSize } from './FootprintAggregator.js';

export const TPO_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const TPO_PERIOD_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', // A-D: Red / Orange / Amber (Session Open)
  '#facc15', '#a3e635', '#84cc16', '#4ade80', // E-H: Yellow / Lime / Light Green (Morning)
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4', // I-L: Green / Teal / Cyan (Midday)
  '#0ea5e9', '#38bdf8', '#3b82f6', '#60a5fa', // M-P: Sky Blue / Royal Blue (Afternoon)
  '#6366f1', '#818cf8', '#8b5cf6', '#a855f7', // Q-T: Indigo / Purple (Late Session)
  '#c084fc', '#d946ef', '#ec4899', '#f43f5e'  // U-Z: Magenta / Violet / Rose (Close)
];

export function getTpoColor(letterIndex) {
  return TPO_PERIOD_COLORS[letterIndex % TPO_PERIOD_COLORS.length];
}

export class TPOSession {
  constructor(sessionKey, symbol, tickSize) {
    this.sessionKey = sessionKey; // e.g. "2026-09-11"
    this.symbol = symbol;
    this.tickSize = tickSize;
    this.startTime = null;
    this.endTime = null;
    this.open = null;
    this.high = -Infinity;
    this.low = Infinity;
    this.close = null;
    this.totalVolume = 0;
    this.totalTpos = 0;

    // Map: price -> { price, letters: [], volume: 0 }
    this.priceRows = new Map();

    // Initial Balance (Periods A & B, first 60 mins)
    this.ibHigh = null;
    this.ibLow = null;

    // Auction Key Levels
    this.tpoPoc = null;
    this.volPoc = null;
    this.vah = null;
    this.val = null;

    // Single prints: prices with only 1 TPO letter (excluding extreme wick ticks)
    this.singlePrints = [];

    // Naked POC tracking
    this.isPocTested = false;
    this.pocTestedTime = null;
  }

  _getPriceKey(price) {
    const decimals = this.tickSize < 0.005 ? 5 : (this.tickSize >= 0.1 ? 2 : 3);
    const bucket = Math.round(price / this.tickSize) * this.tickSize;
    return parseFloat(bucket.toFixed(decimals));
  }

  addCandle(candle, sessionStartMs) {
    if (this.open === null) this.open = candle.open;
    this.close = candle.close;
    if (candle.high > this.high) this.high = candle.high;
    if (candle.low < this.low) this.low = candle.low;
    if (this.startTime === null || candle.startTime < this.startTime) this.startTime = candle.startTime;
    if (this.endTime === null || (candle.endTime || candle.startTime + 60000) > this.endTime) {
      this.endTime = candle.endTime || (candle.startTime + 60000);
    }
    this.totalVolume += (candle.totalVolume || 0);

    // Determine 30-minute period index from session start
    const elapsedMs = Math.max(0, candle.startTime - sessionStartMs);
    const periodIdx = Math.floor(elapsedMs / (30 * 60 * 1000));
    const letter = TPO_LETTERS[Math.min(periodIdx, TPO_LETTERS.length - 1)];

    // Initial Balance tracking (Periods 0 and 1 -> 'A' and 'B')
    if (periodIdx < 2) {
      if (this.ibHigh === null || candle.high > this.ibHigh) this.ibHigh = candle.high;
      if (this.ibLow === null || candle.low < this.ibLow) this.ibLow = candle.low;
    }

    // Populate TPO rows across candle price range
    const minP = this._getPriceKey(candle.low);
    const maxP = this._getPriceKey(candle.high);
    const step = this.tickSize;
    const decimals = this.tickSize < 0.005 ? 5 : (this.tickSize >= 0.1 ? 2 : 3);

    // Approximate volume per row from footprint cells or candle volume
    const candleCells = candle.cells ? (Array.isArray(candle.cells) ? candle.cells : Array.from(candle.cells.values())) : [];
    const cellVolMap = new Map();
    candleCells.forEach(c => {
      const k = this._getPriceKey(c.price);
      cellVolMap.set(k, (cellVolMap.get(k) || 0) + (c.totalVolume || 0));
    });

    let p = minP;
    const estimatedRows = Math.max(1, Math.round((maxP - minP) / step) + 1);
    const avgVolPerRow = (candle.totalVolume || 1000) / estimatedRows;

    while (p <= maxP + (step * 0.1)) {
      const priceKey = parseFloat(p.toFixed(decimals));
      let row = this.priceRows.get(priceKey);
      if (!row) {
        row = { price: priceKey, letters: [], volume: 0 };
        this.priceRows.set(priceKey, row);
      }

      if (!row.letters.includes(letter)) {
        row.letters.push(letter);
        this.totalTpos++;
      }

      const rowVol = cellVolMap.get(priceKey) || avgVolPerRow;
      row.volume += rowVol;

      p += step;
    }
  }

  finalizeAuctionLevels() {
    if (this.priceRows.size === 0) return;

    const rows = Array.from(this.priceRows.values()).sort((a, b) => b.price - a.price);

    // 1. Calculate TPO POC (price with most letters) & Volume POC
    let maxTpoCount = -1;
    let maxVol = -1;

    rows.forEach(r => {
      if (r.letters.length > maxTpoCount) {
        maxTpoCount = r.letters.length;
        this.tpoPoc = r.price;
      }
      if (r.volume > maxVol) {
        maxVol = r.volume;
        this.volPoc = r.price;
      }
    });

    // 2. Steidlmayer 70% Value Area Calculation
    const targetTpos = Math.floor(this.totalTpos * 0.70);
    const pocIdx = rows.findIndex(r => r.price === this.tpoPoc);

    if (pocIdx >= 0) {
      let vaTpos = rows[pocIdx].letters.length;
      let upIdx = pocIdx - 1;
      let downIdx = pocIdx + 1;

      while (vaTpos < targetTpos && (upIdx >= 0 || downIdx < rows.length)) {
        // Compare pair above vs pair below
        const upCount = (upIdx >= 0 ? rows[upIdx].letters.length : 0) +
                        (upIdx - 1 >= 0 ? rows[upIdx - 1].letters.length : 0);
        const downCount = (downIdx < rows.length ? rows[downIdx].letters.length : 0) +
                          (downIdx + 1 < rows.length ? rows[downIdx + 1].letters.length : 0);

        if (upIdx >= 0 && (downIdx >= rows.length || upCount >= downCount)) {
          vaTpos += rows[upIdx].letters.length;
          upIdx--;
        } else if (downIdx < rows.length) {
          vaTpos += rows[downIdx].letters.length;
          downIdx++;
        } else {
          break;
        }
      }

      const topVaIdx = Math.max(0, upIdx + 1);
      const bottomVaIdx = Math.min(rows.length - 1, downIdx - 1);
      this.vah = rows[topVaIdx].price;
      this.val = rows[bottomVaIdx].price;
    } else {
      this.vah = this.high;
      this.val = this.low;
    }

    // 3. Single Prints (rows with only 1 letter, excluding highest and lowest tick)
    this.singlePrints = [];
    if (rows.length > 2) {
      for (let i = 1; i < rows.length - 1; i++) {
        if (rows[i].letters.length === 1) {
          this.singlePrints.push(rows[i].price);
        }
      }
    }
  }
}

export class TPOEngine {
  constructor() {
    this.sessions = [];
    this.symbol = 'EUR/USD';
  }

  processCandles(candles, symbol = 'EUR/USD') {
    this.symbol = symbol;
    this.sessions = [];
    if (!candles || candles.length === 0) return this.sessions;

    const sorted = [...candles].sort((a, b) => a.startTime - b.startTime);

    // Group candles by Daily Sessions (00:00:00 UTC)
    const sessionMap = new Map();

    sorted.forEach(c => {
      const d = new Date(c.startTime);
      const sessionKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      
      let sessionData = sessionMap.get(sessionKey);
      if (!sessionData) {
        // Calculate session start timestamp (00:00 UTC of that day)
        const sessionStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        sessionData = {
          sessionKey,
          sessionStartMs,
          candles: []
        };
        sessionMap.set(sessionKey, sessionData);
      }
      sessionData.candles.push(c);
    });

    // Build each TPOSession
    const sessionList = [];
    sessionMap.forEach(({ sessionKey, sessionStartMs, candles: sCandles }) => {
      // Determine session high/low for adaptive tick sizing
      let sHigh = -Infinity;
      let sLow = Infinity;
      sCandles.forEach(c => {
        if (c.high > sHigh) sHigh = c.high;
        if (c.low < sLow) sLow = c.low;
      });

      // Adaptive tick size scaled for clean TPO profiles (15-35 rows per session)
      const baseTick = getTickSize(symbol, (sHigh + sLow) / 2, 86400000);
      const sessionRange = Math.max(sHigh - sLow, baseTick * 5);
      const targetRows = 28;
      const rawStep = sessionRange / targetRows;
      const stepMult = Math.max(1, Math.round(rawStep / baseTick));
      const tickSize = baseTick * stepMult;

      const session = new TPOSession(sessionKey, symbol, tickSize);
      sCandles.forEach(c => {
        session.addCandle(c, sessionStartMs);
      });
      session.finalizeAuctionLevels();
      sessionList.push(session);
    });

    // Compute Naked POCs (untested POC rays across sessions)
    for (let i = 0; i < sessionList.length; i++) {
      const sess = sessionList[i];
      if (!sess.tpoPoc) continue;

      let tested = false;
      let testedTime = null;

      // Look at all future sessions
      for (let j = i + 1; j < sessionList.length; j++) {
        const futureSess = sessionList[j];
        if (sess.tpoPoc >= futureSess.low && sess.tpoPoc <= futureSess.high) {
          tested = true;
          testedTime = futureSess.startTime;
          break;
        }
      }

      sess.isPocTested = tested;
      sess.pocTestedTime = testedTime;
    }

    this.sessions = sessionList;
    return this.sessions;
  }

  getSessions() {
    return this.sessions;
  }
}
