/**
 * DeltaEngine.js
 * Cumulative Volume Delta (CVD) & Delta Divergence Analytics Engine.
 */

export class DeltaEngine {
  constructor() {
    this.completedCvd = 0;
    this.cumulativeDelta = 0;
    this.lastCandleTime = null;
    this.cvdHistory = []; // [{ timestamp, cvd, candleDelta, high, low, close }]
  }

  clear() {
    this.completedCvd = 0;
    this.cumulativeDelta = 0;
    this.lastCandleTime = null;
    this.cvdHistory = [];
  }

  processCandles(candles) {
    this.clear();
    if (!Array.isArray(candles) || candles.length === 0) return [];
    const sorted = [...candles].sort((a, b) => a.startTime - b.startTime);
    const records = [];
    for (const c of sorted) {
      records.push(this.processCandle(c));
    }
    return records;
  }

  processCandle(candle) {
    if (!candle) return null;

    if (this.lastCandleTime !== null && candle.startTime === this.lastCandleTime) {
      // In-progress active candle update:
      // Update the current bar's CVD in-place without compounding
      const currentCvd = this.completedCvd + candle.totalDelta;
      this.cumulativeDelta = currentCvd;

      if (this.cvdHistory.length > 0) {
        const record = this.cvdHistory[this.cvdHistory.length - 1];
        record.candleDelta = candle.totalDelta;
        record.cvd = currentCvd;
        record.high = candle.high;
        record.low = candle.low;
        record.close = candle.close;
        return record;
      }
    }

    if (this.lastCandleTime !== null && candle.startTime < this.lastCandleTime) {
      // Out of order bar received: insert into history and recompute
      this.cvdHistory = this.cvdHistory.filter(r => r.timestamp !== candle.startTime);
      const tempBars = this.cvdHistory.map(r => ({
        startTime: r.timestamp,
        totalDelta: r.candleDelta,
        high: r.high,
        low: r.low,
        close: r.close
      }));
      tempBars.push(candle);
      return this.processCandles(tempBars)[this.cvdHistory.length - 1];
    }

    // New candle initiated:
    // Lock the previous completed CVD baseline
    if (this.lastCandleTime !== null && this.cvdHistory.length > 0) {
      this.completedCvd = this.cvdHistory[this.cvdHistory.length - 1].cvd;
    } else {
      this.completedCvd = 0;
    }

    this.cumulativeDelta = this.completedCvd + candle.totalDelta;
    this.lastCandleTime = candle.startTime;

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
