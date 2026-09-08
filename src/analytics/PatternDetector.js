/**
 * PatternDetector.js
 * Quantitative Order-Flow Analytics & Pattern Detection Engine.
 */

import { defaultConfig } from './OrderFlowConfig.js';

export class PatternDetector {
  constructor(config = defaultConfig) {
    this.config = config;
  }

  detectPatterns(candle, prevStructuralHigh = null, prevStructuralLow = null) {
    const signals = [];
    const sortedCells = candle.getSortedCells();

    // 1. Diagonal & Stacked Imbalance Detection
    const imbalances = this._detectImbalances(sortedCells);
    if (imbalances.length > 0) {
      signals.push(...imbalances);
    }

    // 2. Absorption Detection
    const absorptionSignals = this._detectAbsorption(candle, sortedCells);
    if (absorptionSignals.length > 0) {
      signals.push(...absorptionSignals);
    }

    // 3. Exhaustion Detection
    const exhaustionSignals = this._detectExhaustion(candle, sortedCells);
    if (exhaustionSignals.length > 0) {
      signals.push(...exhaustionSignals);
    }

    // 4. Liquidity Sweep Detection
    if (prevStructuralHigh || prevStructuralLow) {
      const sweepSignal = this._detectLiquiditySweep(candle, prevStructuralHigh, prevStructuralLow);
      if (sweepSignal) signals.push(sweepSignal);
    }

    return signals;
  }

  _detectImbalances(cells) {
    const signals = [];
    let consecutiveBuyImbalances = 0;
    let consecutiveSellImbalances = 0;
    const stackedBuyLevels = [];
    const stackedSellLevels = [];

    for (let i = 0; i < cells.length - 1; i++) {
      const upperCell = cells[i];     // price P+1
      const lowerCell = cells[i + 1]; // price P

      // Diagonal Buy Imbalance: BuyVol(P+1) / SellVol(P)
      if (lowerCell.sellVolume > 0) {
        const buyRatio = upperCell.buyVolume / lowerCell.sellVolume;
        if (buyRatio >= this.config.imbalanceRatio && upperCell.buyVolume >= this.config.imbalanceMinVolume) {
          consecutiveBuyImbalances++;
          stackedBuyLevels.push(upperCell.price);
          signals.push({
            type: 'DIAGONAL_BUY_IMBALANCE',
            price: upperCell.price,
            ratio: buyRatio,
            provenance: 'DERIVED'
          });
        } else {
          consecutiveBuyImbalances = 0;
        }
      }

      // Diagonal Sell Imbalance: SellVol(P) / BuyVol(P+1)
      if (upperCell.buyVolume > 0) {
        const sellRatio = lowerCell.sellVolume / upperCell.buyVolume;
        if (sellRatio >= this.config.imbalanceRatio && lowerCell.sellVolume >= this.config.imbalanceMinVolume) {
          consecutiveSellImbalances++;
          stackedSellLevels.push(lowerCell.price);
          signals.push({
            type: 'DIAGONAL_SELL_IMBALANCE',
            price: lowerCell.price,
            ratio: sellRatio,
            provenance: 'DERIVED'
          });
        } else {
          consecutiveSellImbalances = 0;
        }
      }

      // Stacked Imbalances Check
      if (consecutiveBuyImbalances >= this.config.stackedImbalanceMinLevels) {
        signals.push({
          type: 'STACKED_BUY_IMBALANCE',
          prices: [...stackedBuyLevels],
          count: consecutiveBuyImbalances,
          provenance: 'ANALYTICAL_DETECTION'
        });
      }
      if (consecutiveSellImbalances >= this.config.stackedImbalanceMinLevels) {
        signals.push({
          type: 'STACKED_SELL_IMBALANCE',
          prices: [...stackedSellLevels],
          count: consecutiveSellImbalances,
          provenance: 'ANALYTICAL_DETECTION'
        });
      }
    }

    return signals;
  }

  _detectAbsorption(candle, cells) {
    const signals = [];
    if (cells.length === 0 || candle.totalVolume === 0) return signals;

    const avgVolPerCell = candle.totalVolume / cells.length;

    for (const cell of cells) {
      if (cell.totalVolume > avgVolPerCell * this.config.absorptionVolStdDev) {
        const deltaRatio = Math.abs(cell.delta) / cell.totalVolume;

        if (deltaRatio >= this.config.absorptionDeltaSkew) {
          // Passive Limit Order Absorption
          if (cell.delta > 0 && candle.close < cell.price) {
            signals.push({
              type: 'PASSIVE_SELLER_ABSORPTION',
              price: cell.price,
              volume: cell.totalVolume,
              delta: cell.delta,
              provenance: 'ANALYTICAL_DETECTION'
            });
          } else if (cell.delta < 0 && candle.close > cell.price) {
            signals.push({
              type: 'PASSIVE_BUYER_ABSORPTION',
              price: cell.price,
              volume: cell.totalVolume,
              delta: cell.delta,
              provenance: 'ANALYTICAL_DETECTION'
            });
          }
        }
      }
    }

    return signals;
  }

  _detectExhaustion(candle, cells) {
    const signals = [];
    if (cells.length === 0 || !candle.pocPrice) return signals;

    const pocVol = candle.cells.get(candle.pocPrice)?.totalVolume || 1;
    const topCell = cells[0];
    const bottomCell = cells[cells.length - 1];

    if (topCell && topCell.totalVolume < pocVol * this.config.exhaustionRatio) {
      signals.push({
        type: 'BUYING_EXHAUSTION',
        price: topCell.price,
        volume: topCell.totalVolume,
        provenance: 'ANALYTICAL_DETECTION'
      });
    }

    if (bottomCell && bottomCell.totalVolume < pocVol * this.config.exhaustionRatio) {
      signals.push({
        type: 'SELLING_EXHAUSTION',
        price: bottomCell.price,
        volume: bottomCell.totalVolume,
        provenance: 'ANALYTICAL_DETECTION'
      });
    }

    return signals;
  }

  _detectLiquiditySweep(candle, prevHigh, prevLow) {
    const point = 0.0001;

    // Buy-side sweep
    if (prevHigh && candle.high > prevHigh && (candle.high - prevHigh) <= (this.config.sweepPipThreshold * point)) {
      if (candle.close < prevHigh) {
        return {
          type: 'BUY_SIDE_LIQUIDITY_SWEEP',
          price: candle.high,
          level: prevHigh,
          rejectionPips: Math.round((candle.high - candle.close) / point * 10) / 10,
          provenance: 'ANALYTICAL_DETECTION'
        };
      }
    }

    // Sell-side sweep
    if (prevLow && candle.low < prevLow && (prevLow - candle.low) <= (this.config.sweepPipThreshold * point)) {
      if (candle.close > prevLow) {
        return {
          type: 'SELL_SIDE_LIQUIDITY_SWEEP',
          price: candle.low,
          level: prevLow,
          rejectionPips: Math.round((candle.close - candle.low) / point * 10) / 10,
          provenance: 'ANALYTICAL_DETECTION'
        };
      }
    }

    return null;
  }
}
