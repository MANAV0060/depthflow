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

export function getDecimalsFromTick(tickSize) {
  if (!tickSize || isNaN(tickSize)) return 5;
  const s = tickSize.toString();
  if (s.includes('e-')) {
    const parts = s.split('e-');
    return parseInt(parts[1], 10);
  }
  const idx = s.indexOf('.');
  return idx >= 0 ? s.length - idx - 1 : 0;
}

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
    this.dataResolution = '1M_BARS';
    this.provenance = 'TPO_RECONSTRUCTED_1M_OHLC';

    // Map: price -> { price, letters: [], volume: 0, bidVolume: 0, askVolume: 0, delta: 0, hasImbalance: false }
    this.priceRows = new Map();

    // Chronological Subperiod Extremes & Sequence Tracking
    this.subperiodExtremes = new Map(); // letter -> { letter, high: -Infinity, low: Infinity, count: 0 }
    this.subperiodOrder = [];           // Array of bracket letters in chronological order

    // Initial Balance (Periods A & B)
    this.ibHigh = null;
    this.ibLow = null;

    // Distinct Key Auction Levels
    this.tpoPoc = null;    // Price with highest TPO count (Time-at-price)
    this.tpoPocCount = 0;
    this.volPoc = null;    // Price with highest Volume (Volume-at-price)
    this.volPocVolume = 0;
    this.vah = null;       // Value Area High (TPO 70%)
    this.val = null;       // Value Area Low (TPO 70%)
    this.volVah = null;    // Volume Value Area High (Volume 70%)
    this.volVal = null;    // Volume Value Area Low (Volume 70%)
    this.volumeFidelity = 'BROKER_VOLUME';

    // Structural Heuristics & Extremes
    this.singlePrints = []; // Array of prices with 1 TPO in interior body
    this.poorHigh = false;  // Extreme high without excess / repeated subperiod tests
    this.poorLow = false;   // Extreme low without excess / repeated subperiod tests
    this.excessHigh = false; // Extreme high buying/selling rejection tail (>= 2 single-print ticks)
    this.excessLow = false;  // Extreme low buying/selling rejection tail

    // Descriptive Profile Structure Classification (Shape)
    this.profileShape = 'Balanced Profile (D-Shape)';
    this.profileInterpretation = '';

    // Naked POC tracking
    this.isPocTested = false;
    this.pocTestedTime = null;
  }

  _getPriceKey(price) {
    const decimals = Math.max(getDecimalsFromTick(this.tickSize), 2);
    const bucket = Math.round(price / this.tickSize) * this.tickSize;
    return parseFloat(bucket.toFixed(decimals));
  }

  addCandle(candle, sessionStartMs) {
    if (this.open === null) this.open = candle.open;
    this.close = candle.close;
    if (candle.high > this.high) this.high = candle.high;
    if (candle.low < this.low) this.low = candle.low;
    if (this.startTime === null || candle.startTime < this.startTime) this.startTime = candle.startTime;
    const candleEndTime = candle.endTime || (candle.startTime + 60000);
    if (this.endTime === null || candleEndTime > this.endTime) {
      this.endTime = candleEndTime;
    }
    this.totalVolume += (candle.totalVolume || 0);

    // Track provenance / data resolution
    const candleDurationMs = (candle.endTime || (candle.startTime + 60000)) - candle.startTime;
    if (candleDurationMs > 65000) {
      this.provenance = 'TPO_RECONSTRUCTED_HTF_APPROX';
      this.dataResolution = 'HTF_BARS';
    }

    // Calculate bracket indices spanned by this candle
    const bracketMs = this.bracketMinutes * 60 * 1000;
    const startElapsed = Math.max(0, candle.startTime - sessionStartMs);
    const endElapsed = Math.max(startElapsed, candleEndTime - 1 - sessionStartMs);
    const startPeriodIdx = Math.floor(startElapsed / bracketMs);
    const endPeriodIdx = Math.floor(endElapsed / bracketMs);

    const letters = [];
    for (let pIdx = startPeriodIdx; pIdx <= endPeriodIdx; pIdx++) {
      const letter = TPO_LETTERS[Math.min(pIdx, TPO_LETTERS.length - 1)];
      letters.push(letter);

      // Track subperiod extremes per letter
      let subExt = this.subperiodExtremes.get(letter);
      if (!subExt) {
        subExt = { letter, high: -Infinity, low: Infinity, count: 0 };
        this.subperiodExtremes.set(letter, subExt);
        this.subperiodOrder.push(letter);
      }
      if (candle.high > subExt.high) subExt.high = candle.high;
      if (candle.low < subExt.low) subExt.low = candle.low;
      subExt.count++;

      // Initial Balance tracking (first `ibPeriods` brackets)
      if (pIdx < this.ibPeriods) {
        if (this.ibHigh === null || candle.high > this.ibHigh) this.ibHigh = candle.high;
        if (this.ibLow === null || candle.low < this.ibLow) this.ibLow = candle.low;
      }
    }

    // Populate TPO rows across candle price range using safe integer stepping
    const minP = this._getPriceKey(candle.low);
    const maxP = this._getPriceKey(candle.high);
    const step = this.tickSize;
    const decimals = Math.max(getDecimalsFromTick(this.tickSize), 2);

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
      stat.bid += (c.buyVolume || c.bidVolume || 0);
      stat.ask += (c.sellVolume || c.askVolume || 0);
      if (c.isImbalance) stat.isImbalance = true;
    });

    const steps = Math.max(0, Math.round((maxP - minP) / step));
    const estimatedRows = steps + 1;
    const avgVolPerRow = (candle.totalVolume || 1000) / estimatedRows;
    const avgBidPerRow = ((candle.totalVolume || 1000) * 0.5) / estimatedRows;
    const avgAskPerRow = ((candle.totalVolume || 1000) * 0.5) / estimatedRows;

    for (let i = 0; i <= steps; i++) {
      const currentPrice = minP + (i * step);
      const priceKey = parseFloat(currentPrice.toFixed(decimals));
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

      for (const letter of letters) {
        if (!row.letters.includes(letter)) {
          row.letters.push(letter);
          this.totalTpos++;
        }
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
    }
  }

  finalizeAuctionLevels(prevSession = null) {
    if (this.priceRows.size === 0) return;

    const rows = Array.from(this.priceRows.values()).sort((a, b) => b.price - a.price);
    const midPrice = (this.high + this.low) / 2;

    // 1. Calculate TPO POC (Sierra Chart standard midpoint tie-breaker)
    let maxTpoCount = -1;
    rows.forEach(r => {
      if (r.letters.length > maxTpoCount) maxTpoCount = r.letters.length;
    });

    const tpoCandidates = rows.filter(r => r.letters.length === maxTpoCount);
    tpoCandidates.sort((a, b) => {
      const distA = Math.abs(a.price - midPrice);
      const distB = Math.abs(b.price - midPrice);
      if (Math.abs(distA - distB) > 1e-9) {
        return distA - distB; // Closest to middle of profile wins
      }
      return a.price - b.price; // Equidistant -> lower price wins
    });
    this.tpoPoc = tpoCandidates[0].price;
    this.tpoPocCount = tpoCandidates[0].letters.length;

    // 2. Calculate Volume POC (Sierra Chart standard midpoint tie-breaker)
    let maxVol = -1;
    rows.forEach(r => {
      if (r.volume > maxVol) maxVol = r.volume;
    });

    const volCandidates = rows.filter(r => r.volume === maxVol);
    volCandidates.sort((a, b) => {
      const distA = Math.abs(a.price - midPrice);
      const distB = Math.abs(b.price - midPrice);
      if (Math.abs(distA - distB) > 1e-9) {
        return distA - distB; // Closest to middle of profile wins
      }
      return a.price - b.price; // Equidistant -> lower price wins
    });
    this.volPoc = volCandidates[0].price;
    this.volPocVolume = volCandidates[0].volume;

    // 3. TPO Value Area Calculation (Sierra Chart Standard Methodology)
    // Starting at Point of Control, expand outward 1 row up and 1 row down.
    // Whichever has greater TPOs is included. On equal count, BOTH rows are included.
    const targetTpos = this.totalTpos * this.valueAreaPercent;
    const pocIdx = rows.findIndex(r => r.price === this.tpoPoc);

    if (pocIdx >= 0) {
      let vaTpos = rows[pocIdx].letters.length;
      let topVaIdx = pocIdx;
      let botVaIdx = pocIdx;
      let upIdx = pocIdx - 1;
      let downIdx = pocIdx + 1;

      while (vaTpos < targetTpos && (upIdx >= 0 || downIdx < rows.length)) {
        if (upIdx >= 0 && downIdx < rows.length) {
          const countUp = rows[upIdx].letters.length;
          const countDown = rows[downIdx].letters.length;

          if (countUp > countDown) {
            vaTpos += countUp;
            topVaIdx = upIdx;
            upIdx--;
          } else if (countDown > countUp) {
            vaTpos += countDown;
            botVaIdx = downIdx;
            downIdx++;
          } else {
            // Equal TPO counts: Include BOTH rows and advance both pointers
            vaTpos += countUp + countDown;
            topVaIdx = upIdx;
            botVaIdx = downIdx;
            upIdx--;
            downIdx++;
          }
        } else if (upIdx >= 0) {
          vaTpos += rows[upIdx].letters.length;
          topVaIdx = upIdx;
          upIdx--;
        } else if (downIdx < rows.length) {
          vaTpos += rows[downIdx].letters.length;
          botVaIdx = downIdx;
          downIdx++;
        } else {
          break;
        }
      }

      this.vah = rows[topVaIdx].price;
      this.val = rows[botVaIdx].price;
    } else {
      this.vah = this.high;
      this.val = this.low;
    }

    // 4. Independent Volume Value Area Calculation (70% Volume Target)
    const targetVol = this.totalVolume * this.valueAreaPercent;
    const volPocIdx = rows.findIndex(r => r.price === this.volPoc);

    if (volPocIdx >= 0 && this.totalVolume > 0) {
      let vaVol = rows[volPocIdx].volume;
      let topVolIdx = volPocIdx;
      let botVolIdx = volPocIdx;
      let upVolIdx = volPocIdx - 1;
      let downVolIdx = volPocIdx + 1;

      while (vaVol < targetVol && (upVolIdx >= 0 || downVolIdx < rows.length)) {
        if (upVolIdx >= 0 && downVolIdx < rows.length) {
          const volUp = rows[upVolIdx].volume;
          const volDown = rows[downVolIdx].volume;

          if (volUp > volDown) {
            vaVol += volUp;
            topVolIdx = upVolIdx;
            upVolIdx--;
          } else if (volDown > volUp) {
            vaVol += volDown;
            botVolIdx = downVolIdx;
            downVolIdx++;
          } else {
            vaVol += volUp + volDown;
            topVolIdx = upVolIdx;
            botVolIdx = downVolIdx;
            upVolIdx--;
            downVolIdx++;
          }
        } else if (upVolIdx >= 0) {
          vaVol += rows[upVolIdx].volume;
          topVolIdx = upVolIdx;
          upVolIdx--;
        } else if (downVolIdx < rows.length) {
          vaVol += rows[downVolIdx].volume;
          botVolIdx = downVolIdx;
          downVolIdx++;
        } else {
          break;
        }
      }

      this.volVah = rows[topVolIdx].price;
      this.volVal = rows[botVolIdx].price;
    } else {
      this.volVah = this.high;
      this.volVal = this.low;
    }

    // 5. Interior Single Prints (strictly interior body, separating distribution nodes)
    this.singlePrints = [];
    if (rows.length > 4) {
      for (let i = 2; i <= rows.length - 3; i++) {
        if (rows[i].letters.length === 1) {
          this.singlePrints.push(rows[i].price);
        }
      }
    }

    // 6. Classical Sierra Chart / Dalton Poor Extremes & Excess Tails
    if (rows.length > 0) {
      const highRow = rows[0];
      const lowRow = rows[rows.length - 1];
      const tolerance = Math.max(this.tickSize * 1.05, this.tickSize);
      const activeLetter = this.subperiodOrder.length > 0 ? this.subperiodOrder[this.subperiodOrder.length - 1] : null;

      // Identify subperiods that reached within 1-tick tolerance of session extremes
      const highSubperiods = [];
      for (const [letter, ext] of this.subperiodExtremes.entries()) {
        if (Math.abs(this.high - ext.high) <= tolerance) {
          highSubperiods.push(letter);
        }
      }

      const lowSubperiods = [];
      for (const [letter, ext] of this.subperiodExtremes.entries()) {
        if (Math.abs(this.low - ext.low) <= tolerance) {
          lowSubperiods.push(letter);
        }
      }

      // Poor High:
      // - Multiple TPOs at the extreme price (highRow.letters.length >= 2), OR
      // - 2 or more distinct subperiods reached within tolerance of high, OR
      // - Tested previous session high within tolerance (unfinished business).
      // Guard developing profile: If session is live and active letter is the only visitor to high, it is developing discovery.
      let isPoorHighCandidate = false;
      if (highRow && highRow.letters.length >= 2) {
        isPoorHighCandidate = true;
      } else if (highSubperiods.length >= 2) {
        isPoorHighCandidate = true;
      } else if (prevSession && prevSession.high && Math.abs(this.high - prevSession.high) <= tolerance) {
        isPoorHighCandidate = true;
      }

      if (this.isDeveloping && isPoorHighCandidate) {
        if (highRow && highRow.letters.length === 1 && highSubperiods.length === 1 && highSubperiods[0] === activeLetter) {
          isPoorHighCandidate = false;
        }
      }
      this.poorHigh = isPoorHighCandidate;

      // Poor Low:
      let isPoorLowCandidate = false;
      if (lowRow && lowRow.letters.length >= 2) {
        isPoorLowCandidate = true;
      } else if (lowSubperiods.length >= 2) {
        isPoorLowCandidate = true;
      } else if (prevSession && prevSession.low && Math.abs(this.low - prevSession.low) <= tolerance) {
        isPoorLowCandidate = true;
      }

      if (this.isDeveloping && isPoorLowCandidate) {
        if (lowRow && lowRow.letters.length === 1 && lowSubperiods.length === 1 && lowSubperiods[0] === activeLetter) {
          isPoorLowCandidate = false;
        }
      }
      this.poorLow = isPoorLowCandidate;

      // Excess High / Low (Genuine Rejection Tails):
      // Defined as >= 2 consecutive single-print rows at extreme.
      // Not formed solely by active developing bracket.
      // Strictly MUTUALLY EXCLUSIVE with Poor High / Low!
      if (this.poorHigh) {
        this.excessHigh = false;
      } else if (rows.length >= 3 && highRow && highRow.letters.length === 1 && rows[1].letters.length === 1) {
        const topLetter = highRow.letters[0];
        if (!this.isDeveloping || topLetter !== activeLetter || this.subperiodOrder.length > 2) {
          this.excessHigh = true;
        } else {
          this.excessHigh = false;
        }
      } else {
        this.excessHigh = false;
      }

      if (this.poorLow) {
        this.excessLow = false;
      } else if (rows.length >= 3 && lowRow && lowRow.letters.length === 1 && rows[rows.length - 2].letters.length === 1) {
        const botLetter = lowRow.letters[0];
        if (!this.isDeveloping || botLetter !== activeLetter || this.subperiodOrder.length > 2) {
          this.excessLow = true;
        } else {
          this.excessLow = false;
        }
      } else {
        this.excessLow = false;
      }
    }

    // 7. Descriptive Profile Structure Classification (Shape)
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
    this.sessionMode = options.sessionMode || 'INSTITUTIONAL'; // 'INSTITUTIONAL' | 'DAILY'
    this.priceIncrement = options.priceIncrement || null;
    this.ticksPerBlock = options.ticksPerBlock || 1;
  }

  setOptions(options = {}) {
    if (options.bracketMinutes !== undefined) this.bracketMinutes = options.bracketMinutes;
    if (options.valueAreaPercent !== undefined) this.valueAreaPercent = options.valueAreaPercent;
    if (options.ibPeriods !== undefined) this.ibPeriods = options.ibPeriods;
    if (options.sessionMode !== undefined) this.sessionMode = options.sessionMode;
    if (options.priceIncrement !== undefined) this.priceIncrement = options.priceIncrement;
    if (options.ticksPerBlock !== undefined) this.ticksPerBlock = options.ticksPerBlock;
  }

  setTimeframe(timeframeStr) {
    this.timeframeStr = timeframeStr;
  }

  getInstrumentBaseTick(symbol) {
    const s = (symbol || '').toUpperCase();
    if (s.includes('BTC')) return 5.0;
    if (s.includes('ETH')) return 0.5;
    if (s.includes('XAU') || s.includes('GOLD')) return 0.2;
    if (s.includes('JPY')) return 0.005;
    return 0.00005; // 0.5 pip for pristine Forex ladders
  }

  processCandles(candles, symbol = 'EUR/USD', timeframeStr = null) {
    this.symbol = symbol;
    if (timeframeStr) this.timeframeStr = timeframeStr;
    this.sessions = [];
    if (!candles || candles.length === 0) return this.sessions;

    const sorted = [...candles].sort((a, b) => a.startTime - b.startTime);
    const sessionMap = new Map();

    const mode = this.sessionMode || 'INSTITUTIONAL';

    if (mode === 'INSTITUTIONAL') {
      // Institutional Market Sessions (Asia, London, New York)
      // Preserved consistently regardless of whether the chart is viewed on 1m, 5m, 15m, 1h
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

    // Fixed analytical calculation increment (decoupled from display resolution)
    const baseTick = this.getInstrumentBaseTick(symbol);
    const tickSize = this.priceIncrement || (baseTick * (this.ticksPerBlock || 1));

    keys.forEach((key, keyIdx) => {
      const { sessionKey, sessionStartMs, candles: sCandles } = sessionMap.get(key);

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

      const prevSession = sessionList.length > 0 ? sessionList[sessionList.length - 1] : null;
      session.finalizeAuctionLevels(prevSession);
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
