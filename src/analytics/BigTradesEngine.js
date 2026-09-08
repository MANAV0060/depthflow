/**
 * BigTradesEngine.js
 * Institutional Big Trades & Large Observable Activity Detection Engine.
 * 
 * Detects unusually significant executed/observable volume activity relative to the current market regime.
 * Employs adaptive statistical models (Robust MAD, Rolling Percentile, Z-score) with volume noise floors,
 * natural spatial sweep clustering, and transparent data-fidelity labeling.
 */

import { AggressorSide, VolumeFidelity } from '../data/NormalizedMarketEvent.js';

export const DetectionMethod = {
  ROBUST_MAD: 'ROBUST_MAD',             // Median Absolute Deviation (resilient against heavy-tailed volume distributions)
  ROLLING_PERCENTILE: 'PERCENTILE',     // e.g. Top 2% (98th percentile)
  STD_DEV: 'STD_DEV',                   // Mean + k * Standard Deviation
  FIXED_THRESHOLD: 'FIXED'              // Absolute volume floor
};

export const BigTradeEventType = {
  LARGE_BUY: 'LARGE_BUY',               // Exceptional aggressive buyer execution
  LARGE_SELL: 'LARGE_SELL',             // Exceptional aggressive seller execution
  SWEEP_BURST: 'SWEEP_BURST',           // Multi-tick consecutive price level sweep
  ABSORPTION: 'ABSORPTION',             // Extreme volume absorbed with zero follow-through
  LARGE_ACTIVITY: 'LARGE_ACTIVITY'      // High tick/broker volume burst (size unobservable directly)
};

/**
 * Dynamic Timeframe Scaling Profiles.
 * Automatically adapts volume noise floors and outlier sensitivity
 * so 1m remains agile while 4h and Daily don't saturate into bubble farms.
 */
export const TimeframeProfiles = {
  '1m':  { multiplierScale: 1.0,  minFloorMultiplier: 1.0,  label: '1-Minute (Intraday Scalp)' },
  '5m':  { multiplierScale: 1.15, minFloorMultiplier: 2.5,  label: '5-Minute (Short Momentum)' },
  '15m': { multiplierScale: 1.35, minFloorMultiplier: 5.0,  label: '15-Minute (Intraday Structure)' },
  '30m': { multiplierScale: 1.6,  minFloorMultiplier: 8.0,  label: '30-Minute (Session Swing)' },
  '1h':  { multiplierScale: 1.9,  minFloorMultiplier: 15.0, label: '1-Hour (Hourly Macro)' },
  '4h':  { multiplierScale: 2.4,  minFloorMultiplier: 35.0, label: '4-Hour (Institutional Swing)' },
  'D':   { multiplierScale: 3.2,  minFloorMultiplier: 90.0, label: 'Daily (Macro Positioning)' }
};

export class BigTradesEngine {
  constructor(options = {}) {
    this.method = options.method || DetectionMethod.ROBUST_MAD;
    this.baseMadMultiplier = options.madMultiplier !== undefined ? options.madMultiplier : 1.8;
    this.basePercentileThreshold = options.percentileThreshold !== undefined ? options.percentileThreshold : 0.98;
    this.baseStdDevMultiplier = options.stdDevMultiplier !== undefined ? options.stdDevMultiplier : 2.0;
    this.baseFixedThreshold = options.fixedThreshold || 100000;
    this.baseMinVolumeFloor = options.minVolumeFloor || 25000;
    this.fidelityMode = options.fidelityMode || VolumeFidelity.BROKER_VOLUME;
    this.timeframeStr = options.timeframeStr || '1m';
    this.timeframeMs = options.timeframeMs || 60000;

    // Timeframe-adapted effective parameters
    this.effectiveMadMultiplier = this.baseMadMultiplier;
    this.effectiveStdDevMultiplier = this.baseStdDevMultiplier;
    this.effectivePercentileThreshold = this.basePercentileThreshold;
    this.effectiveFixedThreshold = this.baseFixedThreshold;
    this.effectiveMinVolumeFloor = this.baseMinVolumeFloor;

    this._recomputeTimeframeThresholds();

    // Cache of recent node volumes for rolling baseline calculations (trailing 300 nodes)
    this.volumeHistory = [];
    this.maxHistorySize = 300;

    // Persistent registry of detected events for historical display and research analysis
    this.detectedEvents = [];
    this.maxEventsRetained = 500;
  }

  setTimeframe(timeframeStr = '1m', timeframeMs = 60000) {
    this.timeframeStr = timeframeStr;
    this.timeframeMs = timeframeMs;
    this._recomputeTimeframeThresholds();
  }

  _recomputeTimeframeThresholds() {
    const profile = TimeframeProfiles[this.timeframeStr] || TimeframeProfiles['1m'];
    this.effectiveMadMultiplier = this.baseMadMultiplier * profile.multiplierScale;
    this.effectiveStdDevMultiplier = this.baseStdDevMultiplier * profile.multiplierScale;
    this.effectiveMinVolumeFloor = this.baseMinVolumeFloor * profile.minFloorMultiplier;
    this.effectiveFixedThreshold = this.baseFixedThreshold * profile.minFloorMultiplier;

    // Rolling percentile: higher timeframes require stricter outlier percentiles (e.g. 98% -> 99.4%)
    const slack = 1 - this.basePercentileThreshold;
    this.effectivePercentileThreshold = Math.max(0.90, Math.min(0.998, 1 - (slack / profile.multiplierScale)));
  }

  setOptions(newOpts = {}) {
    if (newOpts.method !== undefined) this.method = newOpts.method;
    if (newOpts.madMultiplier !== undefined) this.baseMadMultiplier = parseFloat(newOpts.madMultiplier);
    if (newOpts.percentileThreshold !== undefined) this.basePercentileThreshold = parseFloat(newOpts.percentileThreshold);
    if (newOpts.stdDevMultiplier !== undefined) this.baseStdDevMultiplier = parseFloat(newOpts.stdDevMultiplier);
    if (newOpts.fixedThreshold !== undefined) this.baseFixedThreshold = parseFloat(newOpts.fixedThreshold);
    if (newOpts.minVolumeFloor !== undefined) this.baseMinVolumeFloor = parseFloat(newOpts.minVolumeFloor);
    if (newOpts.fidelityMode !== undefined) this.fidelityMode = newOpts.fidelityMode;
    if (newOpts.timeframeStr !== undefined) this.timeframeStr = newOpts.timeframeStr;
    this._recomputeTimeframeThresholds();
  }

  clear() {
    this.volumeHistory = [];
    this.detectedEvents = [];
  }

  /**
   * Evaluates all price cells in a list of candles to detect regime-relative Big Trades.
   * @param {Array<FootprintCandle>} candles 
   * @returns {Array<Object>} List of verified Big Trade event objects
   */
  processCandles(candles) {
    if (!candles || candles.length === 0) return [];

    // 1. Ingest all cell volumes to establish the baseline volume distribution for the current regime
    const allNodeVolumes = [];
    candles.forEach(c => {
      const cells = this._extractCells(c);
      cells.forEach(cell => {
        const v = Math.max(cell.buyVolume || 0, cell.sellVolume || 0);
        if (v > 0) allNodeVolumes.push(v);
      });
    });

    if (allNodeVolumes.length > 0) {
      this.volumeHistory = allNodeVolumes.slice(-this.maxHistorySize);
    }

    const threshold = this._calculateThreshold(this.volumeHistory);
    const results = [];

    // 2. Scan candles and identify candidate volume nodes
    candles.forEach(candle => {
      const candleEvents = this._scanCandle(candle, threshold);
      candle.bigTrades = candleEvents;
      if (candleEvents.length > 0) {
        results.push(...candleEvents);
      }
    });

    this.detectedEvents = results.slice(-this.maxEventsRetained);
    return this.detectedEvents;
  }

  /**
   * Evaluates a single updated or newly completed candle in real time.
   * @param {FootprintCandle} candle 
   * @returns {Array<Object>} Big trades in this candle
   */
  processCandle(candle) {
    if (!candle) return [];

    // Collect volumes from this candle
    const cells = this._extractCells(candle);
    cells.forEach(cell => {
      const v = Math.max(cell.buyVolume || 0, cell.sellVolume || 0);
      if (v > 0) {
        this.volumeHistory.push(v);
        if (this.volumeHistory.length > this.maxHistorySize) {
          this.volumeHistory.shift();
        }
      }
    });

    const threshold = this._calculateThreshold(this.volumeHistory);
    const newEvents = this._scanCandle(candle, threshold);
    candle.bigTrades = newEvents;

    // Update detectedEvents (replace any previous events from this same candle timestamp)
    this.detectedEvents = this.detectedEvents.filter(e => e.time !== Math.floor(candle.startTime / 1000));
    this.detectedEvents.push(...newEvents);
    if (this.detectedEvents.length > this.maxEventsRetained) {
      this.detectedEvents = this.detectedEvents.slice(-this.maxEventsRetained);
    }

    return newEvents;
  }

  getDetectedEvents() {
    return this.detectedEvents;
  }

  /**
   * Scans a candle's price cells and clusters adjacent sweep events naturally.
   */
  _scanCandle(candle, threshold) {
    const cells = this._extractCells(candle);
    if (cells.length === 0) return [];

    const time = Math.floor(candle.startTime / 1000);
    const candidates = [];

    // Sort cells by price ascending
    cells.sort((a, b) => a.price - b.price);

    for (const cell of cells) {
      const buyVol = cell.buyVolume || 0;
      const sellVol = cell.sellVolume || 0;
      const dominantVol = Math.max(buyVol, sellVol);
      const totalVol = cell.totalVolume || (buyVol + sellVol);

      const isSingleDominant = dominantVol >= threshold && dominantVol >= this.effectiveMinVolumeFloor;
      const isTotalCluster = totalVol >= (threshold * 1.5) && totalVol >= (this.effectiveMinVolumeFloor * 1.5);

      if (isSingleDominant || isTotalCluster) {
        const isBuyerDominant = buyVol >= sellVol;
        const aggressor = isBuyerDominant ? AggressorSide.BUY : AggressorSide.SELL;
        const ratio = sellVol > 0 ? (buyVol / sellVol) : buyVol;

        // Check for Absorption signature (extreme buy volume at high of bar without close above, or vice-versa)
        let eventType = isBuyerDominant ? BigTradeEventType.LARGE_BUY : BigTradeEventType.LARGE_SELL;
        if (isBuyerDominant && cell.price >= candle.high && candle.close < candle.high) {
          eventType = BigTradeEventType.ABSORPTION;
        } else if (!isBuyerDominant && cell.price <= candle.low && candle.close > candle.low) {
          eventType = BigTradeEventType.ABSORPTION;
        } else if (isTotalCluster && !isSingleDominant) {
          eventType = BigTradeEventType.LARGE_ACTIVITY;
        }

        candidates.push({
          time,
          price: cell.price,
          volume: dominantVol > 0 ? dominantVol : totalVol,
          totalVolume: totalVol,
          buyVolume: buyVol,
          sellVolume: sellVol,
          side: isBuyerDominant ? 'BUY' : 'SELL',
          aggressor,
          ratio,
          eventType,
          candleOpen: candle.open,
          candleHigh: candle.high,
          candleLow: candle.low,
          candleClose: candle.close
        });
      }
    }

    if (candidates.length === 0) return [];

    // 3. Natural Spatial Burst Clustering:
    // If adjacent price ticks in the same candle share the same aggressor side,
    // they represent a single aggressive sweep burst. Cluster them to prevent visual overlap.
    const clusters = this._clusterSweeps(candidates);

    // 4. Compute visual metrics (radius, label, honest fidelity text)
    return clusters.map(c => this._enrichEvent(c, threshold));
  }

  /**
   * Clusters candidate levels only when they are adjacent and share the same aggressor side.
   * Materially separated events remain distinct.
   */
  _clusterSweeps(candidates) {
    if (candidates.length <= 1) return candidates;

    const clusters = [];
    let currentCluster = [candidates[0]];

    for (let i = 1; i < candidates.length; i++) {
      const prev = currentCluster[currentCluster.length - 1];
      const curr = candidates[i];

      // Measure price gap relative to tick scale
      const priceDelta = Math.abs(curr.price - prev.price);
      const isAdjacent = priceDelta <= (Math.abs(prev.price) * 0.0006); // Within a few ticks

      if (isAdjacent && curr.side === prev.side) {
        currentCluster.push(curr);
      } else {
        clusters.push(this._mergeCluster(currentCluster));
        currentCluster = [curr];
      }
    }

    if (currentCluster.length > 0) {
      clusters.push(this._mergeCluster(currentCluster));
    }

    return clusters;
  }

  _mergeCluster(group) {
    if (group.length === 1) return group[0];

    // Calculate volume-weighted price center
    let totalVol = 0;
    let weightedPriceSum = 0;
    let totalBuy = 0;
    let totalSell = 0;

    group.forEach(item => {
      totalVol += item.volume;
      weightedPriceSum += item.price * item.volume;
      totalBuy += item.buyVolume;
      totalSell += item.sellVolume;
    });

    const representative = group[0];
    const avgPrice = totalVol > 0 ? (weightedPriceSum / totalVol) : representative.price;

    return {
      ...representative,
      price: avgPrice,
      volume: totalVol,
      buyVolume: totalBuy,
      sellVolume: totalSell,
      eventType: BigTradeEventType.SWEEP_BURST,
      clusterCount: group.length
    };
  }

  /**
   * Enriches the event with visual properties and transparent fidelity labels.
   */
  _enrichEvent(event, threshold) {
    // Dynamic bubble radius: square-root scaling between 9px and 34px
    const minR = 9;
    const maxR = 34;
    const excess = Math.max(0, event.volume - threshold);
    const scaleFactor = Math.min(1.0, Math.sqrt(excess / (threshold * 3.5 || 1)));
    const radius = Math.round(minR + (maxR - minR) * scaleFactor);

    // Transparent, non-fabricated fidelity description
    let fidelitySource = 'Broker Volume Event';
    let fidelityLabel = 'Large Activity (Estimated)';
    if (this.fidelityMode === VolumeFidelity.EXCHANGE_VOLUME) {
      fidelitySource = 'Exchange Execution';
      fidelityLabel = event.side === 'BUY' ? 'Large Buy Trade' : 'Large Sell Trade';
    } else if (this.fidelityMode === VolumeFidelity.BROKER_VOLUME) {
      fidelitySource = 'MT5 Real-Time Broker Volume';
      fidelityLabel = event.side === 'BUY' ? 'Large Buy Activity' : 'Large Sell Activity';
    } else {
      fidelitySource = 'Tick Frequency Activity';
      fidelityLabel = 'High Volume Burst';
    }

    const tfProfile = TimeframeProfiles[this.timeframeStr] || TimeframeProfiles['1m'];

    return {
      time: event.time,
      price: event.price,
      volume: event.volume,
      buyVolume: event.buyVolume,
      sellVolume: event.sellVolume,
      side: event.side,
      eventType: event.eventType,
      radius,
      fidelitySource,
      fidelityLabel,
      timeframe: this.timeframeStr,
      timeframeLabel: tfProfile.label,
      timeframeScale: tfProfile.multiplierScale,
      threshold: Math.round(threshold),
      formattedVol: this._formatVol(event.volume)
    };
  }

  _calculateThreshold(history) {
    if (!history || history.length === 0) return this.effectiveFixedThreshold;

    if (this.method === DetectionMethod.FIXED_THRESHOLD) {
      return this.effectiveFixedThreshold;
    }

    if (this.method === DetectionMethod.ROLLING_PERCENTILE) {
      const sorted = [...history].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * this.effectivePercentileThreshold));
      return Math.max(this.effectiveMinVolumeFloor, sorted[idx] || this.effectiveMinVolumeFloor);
    }

    if (this.method === DetectionMethod.STD_DEV) {
      const mean = history.reduce((acc, v) => acc + v, 0) / history.length;
      const variance = history.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / history.length;
      const stdDev = Math.sqrt(variance);
      return Math.max(this.effectiveMinVolumeFloor, mean + this.effectiveStdDevMultiplier * stdDev);
    }

    // Default: Robust MAD (Median Absolute Deviation)
    const sorted = [...history].sort((a, b) => a - b);
    const median = this._median(sorted);
    const absoluteDeviations = sorted.map(v => Math.abs(v - median)).sort((a, b) => a - b);
    const mad = this._median(absoluteDeviations) || (median * 0.25);

    // Normal consistency constant 1.4826 converts MAD to robust standard deviation estimate
    const robustSigma = 1.4826 * mad;
    const candidate = median + this.effectiveMadMultiplier * robustSigma;
    return Math.max(this.effectiveMinVolumeFloor, candidate);
  }

  _median(sortedArr) {
    if (sortedArr.length === 0) return 0;
    const mid = Math.floor(sortedArr.length / 2);
    return sortedArr.length % 2 !== 0 ? sortedArr[mid] : (sortedArr[mid - 1] + sortedArr[mid]) / 2;
  }

  _extractCells(candle) {
    if (!candle.cells) return [];
    if (typeof candle.cells.values === 'function') {
      return Array.from(candle.cells.values());
    }
    if (Array.isArray(candle.cells)) return candle.cells.slice();
    if (typeof candle.cells === 'object') return Object.values(candle.cells);
    return [];
  }

  _formatVol(vol) {
    const v = Math.abs(vol || 0);
    if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
    if (v >= 1000) return `${Math.round(v / 1000)}K`;
    return Math.round(v).toString();
  }
}
