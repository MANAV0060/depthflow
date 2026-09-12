/**
 * TPOEngine.js
 * Professional Time Price Opportunity (TPO) & Market Profile Engine.
 * 
 * Accurately represents the underlying TPO distribution, preserves candlestick
 * chart as primary price layer, and provides configurable auction structure:
 * - Time-at-price discretization (30m / 60m brackets)
 * - TPO POC (price with greatest TPO count) vs Volume POC (price with greatest volume)
 * - Steidlmayer 70% Value Area (VAH & VAL)
 * - Initial Balance (IB: periods A & B)
 * - Single Prints detection (directional discovery / auction excess)
 * - Poor High / Poor Low heuristic detection (extreme structure without excess)
 * - Descriptive Profile Shape classification (provisional for developing sessions)
 * - Order Flow Footprint integration per price row (Bid, Ask, Delta, Imbalance)
 * - Naked POC (nPOC) tracking across sessions
 */

import { getTickSize } from './FootprintAggregator.js';

export const TPO_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Restrained Institutional Palettes
export const TPO_PALETTES = {
  // Classic restrained slate / cyan / amber professional palette
  CLASSIC: [
    '#38bdf8', '#0ea5e9', '#0284c7', '#0369a1', // Morning: Crisp sky blues
    '#2dd4bf', '#14b8a6', '#0d9488', '#0f766e', // Midday: Teals
    '#818cf8', '#6366f1', '#4f46e5', '#4338ca', // Afternoon: Indigo
    '#f59e0b', '#d97706', '#b45309', '#92400e', // Late Session: Amber/Warm
    '#a855f7', '#9333ea', '#7e22ce', '#6b21a8'  // Close: Violet
  ],
  // Traditional Period Rainbow Heatmap
  HEATMAP: [
    '#ef4444', '#f97316', '#f59e0b', '#eab308', // Red / Orange / Amber
    '#facc15', '#a3e635', '#84cc16', '#4ade80', // Yellow / Lime / Light Green
    '#22c55e', '#10b981', '#14b8a6', '#06b6d4', // Green / Teal / Cyan
    '#0ea5e9', '#38bdf8', '#3b82f6', '#60a5fa', // Sky Blue / Royal Blue
    '#6366f1', '#818cf8', '#8b5cf6', '#a855f7', // Indigo / Purple
    '#c084fc', '#d946ef', '#ec4899', '#f43f5e'  // Magenta / Rose
  ],
  // Monochromatic Sierra / MotiveWave clean slate
  MONOCHROME: [
    '#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe',
    '#38bdf8', '#7dd3fc', '#bae6fd', '#e0f2fe'
  ]
};

export function getTpoColor(letterIndex, paletteName = 'CLASSIC') {
  const palette = TPO_PALETTES[paletteName] || TPO_PALETTES.CLASSIC;
  return palette[letterIndex % palette.length];
}

export class TPOSession {
  constructor(sessionKey, symbol, tickSize, options = {}) {
    this.sessionKey = sessionKey; // e.g. "2026-09-11"
    this.symbol = symbol;
    this.tickSize = tickSize;
    this.bracketMinutes = options.bracketMinutes || 30;
    this.valueAreaPercent = options.valueAreaPercent || 0.70;
    this.ibPeriods = options.ibPeriods || 2; // Default first 2 periods (A & B = 60 min for 30m brackets)

    this.startTime = null;
    this.endTime = null;
    this.open = null;
    this.high = -Infinity;
    this.low = Infinity;
    this.close = null;
    this.totalVolume = 0;
    this.totalTpos = 0;

    // Session Status: 'Developing' vs 'Final'
    this.isDeveloping = false;
    this.status = 'Final';

    // Map: price -> { price, letters: [], volume: 0, bidVolume: 0, askVolume: 0, delta: 0, isImbalance: false }
    this.priceRows = new Map();

    // Initial Balance (Periods A & B)
    this.ibHigh = null;
    this.ibLow = null;

    // Distinct Key Auction Levels
    this.tpoPoc = null;    // Price with highest TPO count (Time-at-price)
    this.tpoPocCount = 0;
    this.volPoc = null;    // Price with highest Volume (Volume-at-price)
    this.volPocVolume = 0;
    this.vah = null;       // Value Area High (70%)
    this.val = null;       // Value Area Low (70%)

    // Structural Heuristics & Extremes
    this.singlePrints = []; // Array of prices with 1 TPO (excluding extreme wick ticks)
    this.poorHigh = false;  // Extreme high has >= 2 TPOs (heuristic: lack of excess)
    this.poorLow = false;   // Extreme low has >= 2 TPOs
    this.excessHigh = false; // Extreme high has 1 TPO with sharp rejection
    this.excessLow = false;  // Extreme low has 1 TPO with sharp rejection

    // Descriptive Profile Structure Classification (Shape)
    this.profileShape = 'Balanced Profile (D-Shape)';
    this.profileInterpretation = '';

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

    // Calculate period bracket index from session start
    const bracketMs = this.bracketMinutes * 60 * 1000;
    const elapsedMs = Math.max(0, candle.startTime - sessionStartMs);
    const periodIdx = Math.floor(elapsedMs / bracketMs);
    const letter = TPO_LETTERS[Math.min(periodIdx, TPO_LETTERS.length - 1)];

    // Initial Balance tracking (first `ibPeriods` brackets)
    if (periodIdx < this.ibPeriods) {
      if (this.ibHigh === null || candle.high > this.ibHigh) this.ibHigh = candle.high;
      if (this.ibLow === null || candle.low < this.ibLow) this.ibLow = candle.low;
    }

    // Populate TPO rows across candle price range
    const minP = this._getPriceKey(candle.low);
    const maxP = this._getPriceKey(candle.high);
    const step = this.tickSize;
    const decimals = this.tickSize < 0.005 ? 5 : (this.tickSize >= 0.1 ? 2 : 3);

    // Extract footprint cells data if available
    const candleCells = candle.cells ? (Array.isArray(candle.cells) ? candle.cells : Array.from(candle.cells.values())) : [];
    const cellStatsMap = new Map();
    candleCells.forEach(c => {
      const k = this._getPriceKey(c.price);
      let stat = cellStatsMap.get(k);
      if (!stat) {
        stat = { vol: 0, bid: 0, ask: 0, isImbalance: false };
        cellStatsMap.set(k, stat);
      }
      stat.vol += (c.totalVolume || 0);
      stat.bid += (c.bidVolume || 0);
      stat.ask += (c.askVolume || 0);
      if (c.isImbalance) stat.isImbalance = true;
    });

    let p = minP;
    const estimatedRows = Math.max(1, Math.round((maxP - minP) / step) + 1);
    const avgVolPerRow = (candle.totalVolume || 1000) / estimatedRows;
    const avgBidPerRow = ((candle.totalVolume || 1000) * 0.5) / estimatedRows;
    const avgAskPerRow = ((candle.totalVolume || 1000) * 0.5) / estimatedRows;

    while (p <= maxP + (step * 0.1)) {
      const priceKey = parseFloat(p.toFixed(decimals));
      let row = this.priceRows.get(priceKey);
      if (!row) {
        row = {
          price: priceKey,
          letters: [],
          volume: 0,
          bidVolume: 0,
          askVolume: 0,
          delta: 0,
          hasImbalance: false
        };
        this.priceRows.set(priceKey, row);
      }

      if (!row.letters.includes(letter)) {
        row.letters.push(letter);
        this.totalTpos++;
      }

      const cellStat = cellStatsMap.get(priceKey);
      if (cellStat) {
        row.volume += cellStat.vol;
        row.bidVolume += cellStat.bid;
        row.askVolume += cellStat.ask;
        if (cellStat.isImbalance) row.hasImbalance = true;
      } else {
        row.volume += avgVolPerRow;
        row.bidVolume += avgBidPerRow;
        row.askVolume += avgAskPerRow;
      }
      row.delta = row.askVolume - row.bidVolume;

      p += step;
    }
  }

  finalizeAuctionLevels() {
    if (this.priceRows.size === 0) return;

    const rows = Array.from(this.priceRows.values()).sort((a, b) => b.price - a.price);

    // 1. Calculate TPO POC (price with greatest TPO count) & Volume POC (price with greatest volume)
    let maxTpoCount = -1;
    let maxVol = -1;

    rows.forEach(r => {
      if (r.letters.length > maxTpoCount) {
        maxTpoCount = r.letters.length;
        this.tpoPoc = r.price;
        this.tpoPocCount = r.letters.length;
      }
      if (r.volume > maxVol) {
        maxVol = r.volume;
        this.volPoc = r.price;
        this.volPocVolume = r.volume;
      }
    });

    // 2. Steidlmayer 70% Value Area Calculation
    const targetTpos = Math.floor(this.totalTpos * this.valueAreaPercent);
    const pocIdx = rows.findIndex(r => r.price === this.tpoPoc);

    if (pocIdx >= 0) {
      let vaTpos = rows[pocIdx].letters.length;
      let upIdx = pocIdx - 1;
      let downIdx = pocIdx + 1;

      while (vaTpos < targetTpos && (upIdx >= 0 || downIdx < rows.length)) {
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

    // 3. Single Prints (rows with only 1 letter, excluding highest and lowest ticks)
    this.singlePrints = [];
    if (rows.length > 2) {
      for (let i = 1; i < rows.length - 1; i++) {
        if (rows[i].letters.length === 1) {
          this.singlePrints.push(rows[i].price);
        }
      }
    }

    // 4. Poor High / Poor Low Heuristic Detection
    // Methodology: Extreme high or low row with >= 2 TPO letters indicates lack of auction excess / unfinished auction
    if (rows.length > 0) {
      const highRow = rows[0];
      const lowRow = rows[rows.length - 1];
      this.poorHigh = highRow ? (highRow.letters.length >= 2) : false;
      this.poorLow = lowRow ? (lowRow.letters.length >= 2) : false;

      // Excess High / Low: Extreme row has 1 TPO and adjacent has <= 2 TPOs (swift rejection)
      if (rows.length >= 2) {
        this.excessHigh = (highRow.letters.length === 1 && rows[1].letters.length <= 2);
        this.excessLow = (lowRow.letters.length === 1 && rows[rows.length - 2].letters.length <= 2);
      }
    }

    // 5. Descriptive Profile Structure Classification (Shape)
    this._classifyProfileShape(rows);
  }

  _classifyProfileShape(rows) {
    if (!rows || rows.length < 5 || !this.tpoPoc) {
      this.profileShape = 'Normal Profile';
      this.profileInterpretation = 'Insufficient session brackets for distribution profile.';
      return;
    }

    const totalSpan = this.high - this.low;
    if (totalSpan <= 0) {
      this.profileShape = 'Normal Profile';
      return;
    }

    // Normalized POC position: 0.0 (session low) to 1.0 (session high)
    const pocRelativePos = (this.tpoPoc - this.low) / totalSpan;

    // Check for double distribution (two prominent TPO peaks separated by low activity)
    let isDoubleDist = false;
    if (this.singlePrints.length >= 2 && rows.length >= 12) {
      const midIdx = Math.floor(rows.length / 2);
      const topHalfRows = rows.slice(0, midIdx);
      const botHalfRows = rows.slice(midIdx);
      const topMax = Math.max(...topHalfRows.map(r => r.letters.length));
      const botMax = Math.max(...botHalfRows.map(r => r.letters.length));
      if (topMax >= 5 && botMax >= 5) {
        isDoubleDist = true;
      }
    }

    let shape = 'Balanced Profile (D-Shape)';
    let desc = 'Symmetrical rotation around auction value (balanced two-way trade).';

    if (isDoubleDist) {
      shape = 'Double Distribution Profile';
      desc = 'Bimodal structure showing auction displacement between two value areas.';
    } else if (this.totalTpos > 0 && rows.length >= 15 && (this.tpoPocCount / (this.totalTpos / rows.length)) < 1.4 && this.singlePrints.length >= 4) {
      shape = 'Trend / Imbalance Profile';
      desc = 'Elongated directional distribution reflecting one-sided auction initiative.';
    } else if (pocRelativePos >= 0.65) {
      shape = 'P-Shape Profile';
      desc = 'High-volume value area concentrated near the highs with thin distribution below.';
    } else if (pocRelativePos <= 0.35) {
      shape = 'b-Shape Profile';
      desc = 'High-volume value area concentrated near the lows with thin distribution above.';
    } else {
      shape = 'Balanced Profile (D-Shape)';
      desc = 'Normal bell-like distribution with value centered within session range.';
    }

    if (this.isDeveloping) {
      this.profileShape = `${shape} (Developing)`;
      this.profileInterpretation = `Provisional: ${desc}`;
    } else {
      this.profileShape = shape;
      this.profileInterpretation = desc;
    }
  }
}

export class TPOEngine {
  constructor(options = {}) {
    this.sessions = [];
    this.symbol = 'EUR/USD';
    this.bracketMinutes = options.bracketMinutes || 30;
    this.valueAreaPercent = options.valueAreaPercent || 0.70;
    this.ibPeriods = options.ibPeriods || 2;
  }

  setOptions(options = {}) {
    if (options.bracketMinutes) this.bracketMinutes = options.bracketMinutes;
    if (options.valueAreaPercent) this.valueAreaPercent = options.valueAreaPercent;
    if (options.ibPeriods) this.ibPeriods = options.ibPeriods;
  }

  setTimeframe(timeframeStr) {
    this.timeframeStr = timeframeStr;
  }

  processCandles(candles, symbol = 'EUR/USD', timeframeStr = null) {
    this.symbol = symbol;
    if (timeframeStr) this.timeframeStr = timeframeStr;
    const currentTf = (this.timeframeStr || '1m').toLowerCase();
    this.sessions = [];
    if (!candles || candles.length === 0) return this.sessions;

    const sorted = [...candles].sort((a, b) => a.startTime - b.startTime);

    const sessionMap = new Map();

    if (currentTf === '1m') {
      // FIX #2: Institutional Market Sessions for 1m timeframe:
      // Asia: 00:00 - 08:00 UTC
      // London: 08:00 - 16:00 UTC
      // New York: 16:00 - 24:00 UTC
      // Provides 3 well-balanced, sculpted ~8-hour auction sessions per day on 1m
      sorted.forEach(c => {
        const d = new Date(c.startTime);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        const h = d.getUTCHours();
        
        let sessName = 'Asia';
        let sessHour = 0;
        if (h >= 16) {
          sessName = 'New York';
          sessHour = 16;
        } else if (h >= 8) {
          sessName = 'London';
          sessHour = 8;
        } else {
          sessName = 'Asia';
          sessHour = 0;
        }

        const sessionKey = `${y}-${m}-${day} [${sessName}]`;
        let sessionData = sessionMap.get(sessionKey);
        if (!sessionData) {
          const sessionStartMs = Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), sessHour, 0, 0);
          sessionData = {
            sessionKey,
            sessionStartMs,
            candles: []
          };
          sessionMap.set(sessionKey, sessionData);
        }
        sessionData.candles.push(c);
      });
    } else {
      // PRESERVE EXISTING BEHAVIOR EXACTLY for all other timeframes (5m, 15m, 30m, 1h, 4h, D)
      // Group candles into Daily Sessions (00:00:00 UTC)
      sorted.forEach(c => {
        const d = new Date(c.startTime);
        const sessionKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        
        let sessionData = sessionMap.get(sessionKey);
        if (!sessionData) {
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
    }

    const sessionList = [];
    const keys = Array.from(sessionMap.keys());

    keys.forEach((key, keyIdx) => {
      const { sessionKey, sessionStartMs, candles: sCandles } = sessionMap.get(key);

      let sHigh = -Infinity;
      let sLow = Infinity;
      sCandles.forEach(c => {
        if (c.high > sHigh) sHigh = c.high;
        if (c.low < sLow) sLow = c.low;
      });

      // Adaptive tick size scaled for clean TPO profiles (25-35 classical Market Profile price rows)
      let baseTick = 0.00005; // 0.5 pip for Forex
      const s = (symbol || '').toUpperCase();
      const midPrice = (sHigh + sLow) / 2;
      if (s.includes('BTC') || midPrice > 10000) baseTick = 5.0;
      else if (s.includes('ETH') || midPrice > 1000) baseTick = 0.5;
      else if (s.includes('XAU') || s.includes('GOLD') || midPrice > 500) baseTick = 0.2;
      else if (s.includes('JPY')) baseTick = 0.005;

      const sessionRange = Math.max(sHigh - sLow, baseTick * 10);
      const targetRows = 30;
      const rawStep = sessionRange / targetRows;
      const stepMult = Math.max(1, Math.round(rawStep / baseTick));
      const tickSize = baseTick * stepMult;

      const session = new TPOSession(sessionKey, symbol, tickSize, {
        bracketMinutes: this.bracketMinutes,
        valueAreaPercent: this.valueAreaPercent,
        ibPeriods: this.ibPeriods
      });

      // The last session is currently developing; earlier sessions are Final
      const isLatest = (keyIdx === keys.length - 1);
      session.isDeveloping = isLatest;
      session.status = isLatest ? 'Developing' : 'Final';

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
