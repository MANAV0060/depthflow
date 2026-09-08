/**
 * FootprintAggregator.js
 * Volume-at-Price & Footprint Candle Aggregator.
 * Supports dynamic tick size normalization across Crypto (BTC/USD), Gold (XAU/USD), and Forex.
 */

import { AggressorSide, VolumeFidelity } from '../data/NormalizedMarketEvent.js';

export function getTickSize(symbol, price) {
  const s = (symbol || '').toUpperCase();
  if (s.includes('BTC') || price > 10000) return 5.0; // $5 buckets for BTC
  if (s.includes('ETH') || price > 1000) return 0.5;
  if (s.includes('XAU') || s.includes('GOLD') || price > 500) return 0.2;
  if (s.includes('JPY')) return 0.005;
  return 0.00005; // 0.5 pip for crisp Forex footprint ladders
}

export class FootprintCell {
  constructor(price) {
    this.price = price;
    this.buyVolume = 0;
    this.sellVolume = 0;
    this.totalVolume = 0;
    this.delta = 0;
  }

  addVolume(size, aggressor) {
    if (aggressor === AggressorSide.BUY || aggressor === AggressorSide.INFERRED_BUY) {
      this.buyVolume += size;
    } else {
      this.sellVolume += size;
    }
    this.totalVolume += size;
    this.delta = this.buyVolume - this.sellVolume;
  }
}

export class FootprintCandle {
  constructor(startTime, openPrice, timeframeMs = 60000, symbol = 'BTC/USD') {
    this.startTime = startTime;
    this.endTime = startTime + timeframeMs;
    this.symbol = symbol;
    this.open = openPrice;
    this.high = openPrice;
    this.low = openPrice;
    this.close = openPrice;
    this.totalVolume = 0;
    this.totalDelta = 0;
    this.maxDelta = 0;
    this.minDelta = 0;
    this.pocPrice = openPrice;
    this.cells = new Map();
    this.fidelityMode = 'BROKER_VOLUME';
  }

  static fromData(data) {
    const candle = new FootprintCandle(
      data.startTime,
      data.open,
      (data.endTime - data.startTime) || 60000,
      data.symbol || 'BTC/USD'
    );
    candle.high = data.high;
    candle.low = data.low;
    candle.close = data.close;
    candle.totalVolume = data.totalVolume || 0;
    candle.totalDelta = data.totalDelta || 0;
    candle.maxDelta = data.maxDelta || 0;
    candle.minDelta = data.minDelta || 0;
    candle.pocPrice = data.pocPrice || data.open;
    if (Array.isArray(data.cells)) {
      data.cells.forEach((c) => {
        const cell = new FootprintCell(c.price);
        cell.buyVolume = c.buyVolume || 0;
        cell.sellVolume = c.sellVolume || 0;
        cell.totalVolume = c.totalVolume || (cell.buyVolume + cell.sellVolume);
        cell.delta = c.delta || (cell.buyVolume - cell.sellVolume);
        candle.cells.set(c.price, cell);
      });
    }
    return candle;
  }

  processEvent(event, aggressorResult) {
    const tickSize = getTickSize(this.symbol, event.price);
    const bucketPrice = Math.round(event.price / tickSize) * tickSize;
    const normalizedBucket = Math.round(bucketPrice * 100000) / 100000;
    const size = event.size || 1;

    // Update OHLC
    if (event.price > this.high) this.high = event.price;
    if (event.price < this.low) this.low = event.price;
    this.close = event.price;

    let cell = this.cells.get(normalizedBucket);
    if (!cell) {
      cell = new FootprintCell(normalizedBucket);
      this.cells.set(normalizedBucket, cell);
    }

    cell.addVolume(size, aggressorResult.aggressor);
    this.totalVolume += size;
    const isBuy = aggressorResult.aggressor === AggressorSide.BUY || aggressorResult.aggressor === AggressorSide.INFERRED_BUY;
    this.totalDelta += isBuy ? size : -size;

    if (this.totalDelta > this.maxDelta) this.maxDelta = this.totalDelta;
    if (this.totalDelta < this.minDelta) this.minDelta = this.totalDelta;

    // Update POC
    if (!this.pocPrice || cell.totalVolume > (this.cells.get(this.pocPrice)?.totalVolume || 0)) {
      this.pocPrice = normalizedBucket;
    }
  }

  getSortedCells() {
    return Array.from(this.cells.values()).sort((a, b) => b.price - a.price);
  }
}

export class FootprintAggregator {
  constructor({ timeframeMs = 60000, symbol = 'BTC/USD' } = {}) {
    this.timeframeMs = timeframeMs;
    this.symbol = symbol;
    this.candles = [];
    this.currentCandle = null;
  }

  setSymbol(symbol) {
    this.symbol = symbol;
    this.currentCandle = null;
    this.candles = [];
  }

  reset(symbol = this.symbol, timeframeMs = this.timeframeMs) {
    this.candles = [];
    this.currentCandle = null;
    this.symbol = symbol;
    this.timeframeMs = timeframeMs;
  }

  loadCandles(candlesData) {
    this.candles = [];
    this.currentCandle = null;
    if (Array.isArray(candlesData)) {
      candlesData.forEach((d) => {
        const c = FootprintCandle.fromData(d);
        this.candles.push(c);
      });
      if (this.candles.length > 0) {
        this.currentCandle = this.candles[this.candles.length - 1];
      }
    }
  }

  prependCandles(candlesData) {
    if (!Array.isArray(candlesData) || candlesData.length === 0) return;
    const newBars = [];
    candlesData.forEach((d) => {
      if (!this.candles.some(c => c.startTime === d.startTime)) {
        newBars.push(FootprintCandle.fromData(d));
      }
    });
    this.candles = [...newBars, ...this.candles].sort((a, b) => a.startTime - b.startTime);
    if (!this.currentCandle && this.candles.length > 0) {
      this.currentCandle = this.candles[this.candles.length - 1];
    }
  }

  processEvent(event, aggressorResult) {
    const candleStartTime = Math.floor(event.timestamp / this.timeframeMs) * this.timeframeMs;

    if (!this.currentCandle || candleStartTime >= this.currentCandle.endTime) {
      if (this.currentCandle && !this.candles.some(c => c.startTime === this.currentCandle.startTime)) {
        this.candles.push(this.currentCandle);
      }
      this.currentCandle = new FootprintCandle(candleStartTime, event.price, this.timeframeMs, this.symbol);
    }

    this.currentCandle.processEvent(event, aggressorResult);
    return this.currentCandle;
  }

  getAllCandles() {
    if (!this.currentCandle) return [...this.candles];
    if (this.candles.length > 0 && this.candles[this.candles.length - 1].startTime === this.currentCandle.startTime) {
      return [...this.candles];
    }
    return [...this.candles, this.currentCandle];
  }
}
