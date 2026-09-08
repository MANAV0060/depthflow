/**
 * DeltaEngine.js
 * Cumulative Volume Delta (CVD) & Delta Divergence Analytics Engine.
 */

export class DeltaEngine {
  constructor() {
    this.cumulativeDelta = 0;
    this.cvdHistory = []; // [{ timestamp, cvd, candleDelta }]
  }

  processCandle(candle) {
    this.cumulativeDelta += candle.totalDelta;
    
    const record = {
      timestamp: candle.startTime,
      candleDelta: candle.totalDelta,
      cvd: this.cumulativeDelta,
      high: candle.high,
      low: candle.low,
      close: candle.close
    };

    this.cvdHistory.push(record);
    return record;
  }

  detectDivergence(lookbackBars = 5) {
    if (this.cvdHistory.length < lookbackBars + 1) return null;

    const curr = this.cvdHistory[this.cvdHistory.length - 1];
    const prev = this.cvdHistory[this.cvdHistory.length - 1 - lookbackBars];

    // Bullish Divergence: Price makes Lower Low, CVD makes Higher Low
    if (curr.close < prev.close && curr.cvd > prev.cvd) {
      return {
        type: 'BULLISH_DELTA_DIVERGENCE',
        timestamp: curr.timestamp,
        priceDelta: curr.close - prev.close,
        cvdDelta: curr.cvd - prev.cvd
      };
    }

    // Bearish Divergence: Price makes Higher High, CVD makes Lower High
    if (curr.close > prev.close && curr.cvd < prev.cvd) {
      return {
        type: 'BEARISH_DELTA_DIVERGENCE',
        timestamp: curr.timestamp,
        priceDelta: curr.close - prev.close,
        cvdDelta: curr.cvd - prev.cvd
      };
    }

    return null;
  }

  getCvdSeries() {
    return this.cvdHistory;
  }
}
