/**
 * FootprintAggregator.js
 * Volume-at-Price & Footprint Candle Aggregator.
 * Supports dynamic tick size normalization across Crypto (BTC/USD), Gold (XAU/USD), and Forex.
 */

import { AggressorSide, VolumeFidelity } from '../data/NormalizedMarketEvent.js';

export function getTickSize(symbol, price, timeframeMs = 60000) {
  const s = (symbol || '').toUpperCase();
  let baseTick = 0.00005; // 0.5 pip for pristine Forex footprint ladders
  if (s.includes('BTC') || price > 10000) baseTick = 5.0; // $5 buckets for BTC
  else if (s.includes('ETH') || price > 1000) baseTick = 0.5;
  else if (s.includes('XAU') || s.includes('GOLD') || price > 500) baseTick = 0.2;
  else if (s.includes('JPY')) baseTick = 0.005;

  let mult = 1;
  if (timeframeMs >= 86400000) mult = 50;      // 1D
  else if (timeframeMs >= 14400000) mult = 20; // 4h
  else if (timeframeMs >= 3600000) mult = 10;  // 1h
  else if (timeframeMs >= 1800000) mult = 6;   // 30m
  else if (timeframeMs >= 900000) mult = 4;    // 15m
  else if (timeframeMs >= 300000) mult = 2;    // 5m

  return baseTick * mult;
}

export class FootprintCell {
  constructor(price) {
    this.price = price;
    this.buyVolume = 0;
    this.sellVolume = 0;
    this.totalVolume = 0;
    this.delta = 0;
    this.neutralVolume = 0;
    this.hasBuyImbalance = false;
    this.hasSellImbalance = false;
    this.buyImbalanceRatio = 0;
    this.sellImbalanceRatio = 0;
  }

  addVolume(size, aggressor) {
    if (aggressor === AggressorSide.BUY || aggressor === AggressorSide.INFERRED_BUY) {
      this.buyVolume += size;
    } else if (aggressor === AggressorSide.SELL || aggressor === AggressorSide.INFERRED_SELL) {
      this.sellVolume += size;
    } else {
      // Truly indeterminate aggressor:
      // Split 50/50 strictly as a neutral volume-preservation mechanism (delta is 0, buy == sell).
      // Never presented as evidence of actual buying/selling aggression.
      const half = size / 2;
      this.buyVolume += half;
      this.sellVolume += half;
      this.neutralVolume += size;
    }
    this.totalVolume = this.buyVolume + this.sellVolume;
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
    this.provenance = 'INFERRED_BROKER_FLOW';
    this.stackedBuyImbalances = [];
    this.stackedSellImbalances = [];
    this._processedEventIds = new Set();
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
    candle.pocPrice = data.pocPrice || data.open;
    candle.fidelityMode = data.fidelity || data.fidelityMode || 'RECONSTRUCTED_HISTORICAL_BARS';
    candle.provenance = data.provenance || 'RECONSTRUCTED_HISTORICAL_FOOTPRINT';

    if (Array.isArray(data.cells)) {
      data.cells.forEach((c) => {
        const cell = new FootprintCell(c.price);
        cell.buyVolume = Number(c.buyVolume) || 0;
        cell.sellVolume = Number(c.sellVolume) || 0;
        cell.totalVolume = cell.buyVolume + cell.sellVolume;
        cell.delta = cell.buyVolume - cell.sellVolume;
        candle.cells.set(c.price, cell);
      });
    }

    // Mathematical invariant enforcement:
    // Bar Total = sum(cell.totalVolume)
    // Bar Delta = sum(cell.delta)
    let calculatedVol = 0;
    let calculatedDelta = 0;
    for (const cell of candle.cells.values()) {
      calculatedVol += cell.totalVolume;
      calculatedDelta += cell.delta;
    }

    candle.totalVolume = candle.cells.size > 0 ? calculatedVol : (Number(data.totalVolume) || 0);
    candle.totalDelta = candle.cells.size > 0 ? calculatedDelta : (Number(data.totalDelta) || 0);
    candle.maxDelta = data.maxDelta !== undefined ? Number(data.maxDelta) : Math.max(0, candle.totalDelta);
    candle.minDelta = data.minDelta !== undefined ? Number(data.minDelta) : Math.min(0, candle.totalDelta);

    candle.computeImbalances();
    return candle;
  }

  processEvent(event, aggressorResult) {
    // Deduplication check
    const eventId = event.id || `${event.timestamp}_${event.price}_${event.size}_${aggressorResult.aggressor || ''}`;
    if (this._processedEventIds.has(eventId)) {
      return; // Skip duplicate tick
    }
    this._processedEventIds.add(eventId);
    if (this._processedEventIds.size > 2000) {
      const first = this._processedEventIds.values().next().value;
      this._processedEventIds.delete(first);
    }

    const tfMs = (this.endTime - this.startTime) || 60000;
    const tickSize = getTickSize(this.symbol, event.price, tfMs);
    const bucketPrice = Math.round(event.price / tickSize) * tickSize;
    const decimals = tickSize < 0.005 ? 5 : (tickSize >= 0.1 ? 2 : 3);
    const normalizedBucket = Math.round(bucketPrice * (10 ** decimals)) / (10 ** decimals);
    const size = Number(event.size) || 1;

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

    // Update Bar Totals strictly consistent with cell additions
    this.totalVolume += size;
    const isBuy = aggressorResult.aggressor === AggressorSide.BUY || aggressorResult.aggressor === AggressorSide.INFERRED_BUY;
    const isSell = aggressorResult.aggressor === AggressorSide.SELL || aggressorResult.aggressor === AggressorSide.INFERRED_SELL;
    const deltaContribution = isBuy ? size : (isSell ? -size : 0);
    this.totalDelta += deltaContribution;

    if (this.totalDelta > this.maxDelta) this.maxDelta = this.totalDelta;
    if (this.totalDelta < this.minDelta) this.minDelta = this.totalDelta;

    // Update POC
    if (!this.pocPrice || cell.totalVolume > (this.cells.get(this.pocPrice)?.totalVolume || 0)) {
      this.pocPrice = normalizedBucket;
    }

    // Compute imbalances analytically
    this.computeImbalances();
  }

  computeImbalances(imbalanceRatio = 3.0, minVolume = 10, minStackedLevels = 3) {
    const sortedCells = this.getSortedCells(); // Ordered highest price to lowest price
    const n = sortedCells.length;
    if (n === 0) return;

    const tfMs = (this.endTime - this.startTime) || 60000;
    const fallbackTick = getTickSize(this.symbol, this.close || this.open, tfMs);

    // Derive the exact observed tick increment directly from discrete cell intervals
    let observedMinStep = Infinity;
    for (let i = 0; i < n - 1; i++) {
      const diff = sortedCells[i].price - sortedCells[i + 1].price;
      if (diff > 0.000001 && diff < observedMinStep) {
        observedMinStep = diff;
      }
    }
    const effectiveTick = (observedMinStep < Infinity && observedMinStep > 0) ? observedMinStep : fallbackTick;
    const maxAdjacentGap = effectiveTick * 1.5;

    // 1. Reset all cell imbalance flags
    for (const cell of sortedCells) {
      cell.hasBuyImbalance = false;
      cell.hasSellImbalance = false;
      cell.buyImbalanceRatio = 0;
      cell.sellImbalanceRatio = 0;
    }

    // 2. Compute Diagonal Imbalances (Sierra Chart Classical Method)
    // Buy Imbalance: Ask Volume at Price P vs Bid Volume at (P - tickSize)
    // Sell Imbalance: Bid Volume at Price P vs Ask Volume at (P + tickSize)
    for (let i = 0; i < n; i++) {
      const cell = sortedCells[i];

      // Buy Diagonal Imbalance: compare against cell one step lower (i + 1)
      if (i < n - 1) {
        const lowerCell = sortedCells[i + 1];
        const isAdjacent = (cell.price - lowerCell.price) <= maxAdjacentGap;
        if (isAdjacent) {
          const buyVol = cell.buyVolume;
          const oppSellVol = lowerCell.sellVolume;

          if (oppSellVol > 0) {
            const ratio = buyVol / oppSellVol;
            cell.buyImbalanceRatio = ratio;
            if (ratio >= imbalanceRatio && buyVol >= minVolume) {
              cell.hasBuyImbalance = true;
            }
          } else if (oppSellVol === 0) {
            // Zero opposing volume: infinite ratio. Qualifies only if meeting minVolume floor
            if (buyVol >= minVolume) {
              cell.hasBuyImbalance = true;
              cell.buyImbalanceRatio = Infinity;
            }
          }
        }
      }

      // Sell Diagonal Imbalance: compare against cell one step higher (i - 1)
      if (i > 0) {
        const upperCell = sortedCells[i - 1];
        const isAdjacent = (upperCell.price - cell.price) <= maxAdjacentGap;
        if (isAdjacent) {
          const sellVol = cell.sellVolume;
          const oppBuyVol = upperCell.buyVolume;

          if (oppBuyVol > 0) {
            const ratio = sellVol / oppBuyVol;
            cell.sellImbalanceRatio = ratio;
            if (ratio >= imbalanceRatio && sellVol >= minVolume) {
              cell.hasSellImbalance = true;
            }
          } else if (oppBuyVol === 0) {
            // Zero opposing volume: infinite ratio. Qualifies only if meeting minVolume floor
            if (sellVol >= minVolume) {
              cell.hasSellImbalance = true;
              cell.sellImbalanceRatio = Infinity;
            }
          }
        }
      }
    }

    // 3. Detect Stacked Imbalances (>= minStackedLevels consecutive levels in same direction)
    this.stackedBuyImbalances = [];
    this.stackedSellImbalances = [];

    // Stacked Buy Imbalances (top to bottom)
    let currentBuyStack = [];
    for (let i = 0; i < n; i++) {
      const cell = sortedCells[i];
      if (cell.hasBuyImbalance) {
        if (currentBuyStack.length === 0) {
          currentBuyStack.push(cell);
        } else {
          const prev = currentBuyStack[currentBuyStack.length - 1];
          const isAdjacent = (prev.price - cell.price) <= maxAdjacentGap;
          if (isAdjacent) {
            currentBuyStack.push(cell);
          } else {
            if (currentBuyStack.length >= minStackedLevels) {
              this.stackedBuyImbalances.push({
                startPrice: currentBuyStack[0].price,
                endPrice: currentBuyStack[currentBuyStack.length - 1].price,
                count: currentBuyStack.length,
                levels: currentBuyStack.map(c => c.price),
                direction: 'BUY'
              });
            }
            currentBuyStack = [cell];
          }
        }
      } else {
        if (currentBuyStack.length >= minStackedLevels) {
          this.stackedBuyImbalances.push({
            startPrice: currentBuyStack[0].price,
            endPrice: currentBuyStack[currentBuyStack.length - 1].price,
            count: currentBuyStack.length,
            levels: currentBuyStack.map(c => c.price),
            direction: 'BUY'
          });
        }
        currentBuyStack = [];
      }
    }
    if (currentBuyStack.length >= minStackedLevels) {
      this.stackedBuyImbalances.push({
        startPrice: currentBuyStack[0].price,
        endPrice: currentBuyStack[currentBuyStack.length - 1].price,
        count: currentBuyStack.length,
        levels: currentBuyStack.map(c => c.price),
        direction: 'BUY'
      });
    }

    // Stacked Sell Imbalances (top to bottom)
    let currentSellStack = [];
    for (let i = 0; i < n; i++) {
      const cell = sortedCells[i];
      if (cell.hasSellImbalance) {
        if (currentSellStack.length === 0) {
          currentSellStack.push(cell);
        } else {
          const prev = currentSellStack[currentSellStack.length - 1];
          const isAdjacent = (prev.price - cell.price) <= maxAdjacentGap;
          if (isAdjacent) {
            currentSellStack.push(cell);
          } else {
            if (currentSellStack.length >= minStackedLevels) {
              this.stackedSellImbalances.push({
                startPrice: currentSellStack[0].price,
                endPrice: currentSellStack[currentSellStack.length - 1].price,
                count: currentSellStack.length,
                levels: currentSellStack.map(c => c.price),
                direction: 'SELL'
              });
            }
            currentSellStack = [cell];
          }
        }
      } else {
        if (currentSellStack.length >= minStackedLevels) {
          this.stackedSellImbalances.push({
            startPrice: currentSellStack[0].price,
            endPrice: currentSellStack[currentSellStack.length - 1].price,
            count: currentSellStack.length,
            levels: currentSellStack.map(c => c.price),
            direction: 'SELL'
          });
        }
        currentSellStack = [];
      }
    }
    if (currentSellStack.length >= minStackedLevels) {
      this.stackedSellImbalances.push({
        startPrice: currentSellStack[0].price,
        endPrice: currentSellStack[currentSellStack.length - 1].price,
        count: currentSellStack.length,
        levels: currentSellStack.map(c => c.price),
        direction: 'SELL'
      });
    }
  }

  static aggregateFromCandles(constituentCandles, timeframeMs, targetStartTime) {
    if (!constituentCandles || constituentCandles.length === 0) return null;
    const first = constituentCandles[0];
    const last = constituentCandles[constituentCandles.length - 1];
    const symbol = first.symbol;
    const aggCandle = new FootprintCandle(targetStartTime, first.open, timeframeMs, symbol);
    aggCandle.close = last.close;
    aggCandle.high = Math.max(...constituentCandles.map(c => c.high));
    aggCandle.low = Math.min(...constituentCandles.map(c => c.low));
    aggCandle.fidelityMode = first.fidelityMode;
    aggCandle.provenance = first.provenance;

    let runningDelta = 0;
    let maxDelta = 0;
    let minDelta = 0;

    constituentCandles.forEach(c => {
      const cells = typeof c.cells?.values === 'function'
        ? Array.from(c.cells.values())
        : (Array.isArray(c.cells) ? c.cells : Object.values(c.cells || {}));

      cells.forEach(cell => {
        let targetCell = aggCandle.cells.get(cell.price);
        if (!targetCell) {
          targetCell = new FootprintCell(cell.price);
          aggCandle.cells.set(cell.price, targetCell);
        }
        targetCell.buyVolume += (cell.buyVolume || 0);
        targetCell.sellVolume += (cell.sellVolume || 0);
        targetCell.totalVolume = targetCell.buyVolume + targetCell.sellVolume;
        targetCell.delta = targetCell.buyVolume - targetCell.sellVolume;
      });

      runningDelta += c.totalDelta;
      if (runningDelta > maxDelta) maxDelta = runningDelta;
      if (runningDelta < minDelta) minDelta = runningDelta;
    });

    // Invariant guarantees
    aggCandle.totalVolume = Array.from(aggCandle.cells.values()).reduce((sum, c) => sum + c.totalVolume, 0);
    aggCandle.totalDelta = Array.from(aggCandle.cells.values()).reduce((sum, c) => sum + c.delta, 0);
    aggCandle.maxDelta = maxDelta;
    aggCandle.minDelta = minDelta;

    // POC selection
    let maxCellVol = -1;
    for (const cell of aggCandle.cells.values()) {
      if (cell.totalVolume > maxCellVol) {
        maxCellVol = cell.totalVolume;
        aggCandle.pocPrice = cell.price;
      }
    }

    aggCandle.computeImbalances();
    return aggCandle;
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
