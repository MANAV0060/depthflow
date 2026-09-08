/**
 * SimulatedFeed.js
 * High-Fidelity Scenario Generator for Controlled Market Order Flow Testing.
 */

import { ProviderAdapter, ConnectionStatus } from './ProviderAdapter.js';
import {
  NormalizedMarketEvent,
  EventType,
  VolumeFidelity,
  DataProvenance,
  AggressorSide
} from './NormalizedMarketEvent.js';

export const ScenarioType = {
  NORMAL_FLOW: 'NORMAL_FLOW',
  STRONG_BUYING_SWEEP: 'STRONG_BUYING_SWEEP',
  ABSORPTION_WALL: 'ABSORPTION_WALL',
  EXHAUSTION_TOP: 'EXHAUSTION_TOP',
  STACKED_BUY_IMBALANCE: 'STACKED_BUY_IMBALANCE',
  DELTA_DIVERGENCE: 'DELTA_DIVERGENCE'
};

export class SimulatedFeed extends ProviderAdapter {
  constructor({ intervalMs = 200, defaultSymbol = 'EUR/USD' } = {}) {
    super('SimulatedFeed');
    this.intervalMs = intervalMs;
    this.symbol = defaultSymbol;
    this.timer = null;
    this.currentPrice = 1.08500;
    this.pipSize = 0.0001;
    this.scenario = ScenarioType.NORMAL_FLOW;
    this.tickCounter = 0;
    this.scenarioStep = 0;
  }

  getCapabilities() {
    return {
      hasQuotes: true,
      hasTrades: true,
      hasAggressorFlags: true,
      hasLevel2Depth: true,
      volumeFidelity: VolumeFidelity.EXCHANGE_VOLUME,
      isRealTime: true,
      isHistorical: false
    };
  }

  setScenario(scenario) {
    this.scenario = scenario;
    this.scenarioStep = 0;
    console.log(`[SimulatedFeed] Switched to scenario: ${scenario}`);
  }

  async connect() {
    this._setStatus(ConnectionStatus.CONNECTING);
    await new Promise(r => setTimeout(r, 100));
    this._setStatus(ConnectionStatus.CONNECTED);
    this._startGeneration();
  }

  async disconnect() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await super.disconnect();
  }

  _startGeneration() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this._generateTick(), this.intervalMs);
  }

  _generateTick() {
    this.tickCounter++;
    this.scenarioStep++;

    let aggressor = AggressorSide.BUY;
    let size = Math.floor(Math.random() * 8) + 1;
    let priceShift = 0;

    switch (this.scenario) {
      case ScenarioType.STRONG_BUYING_SWEEP:
        aggressor = AggressorSide.BUY;
        size = Math.floor(Math.random() * 25) + 15;
        priceShift = (Math.random() > 0.3 ? 0.5 : 0) * this.pipSize;
        break;

      case ScenarioType.ABSORPTION_WALL:
        // Huge buy volume executed at fixed resistance (1.08600) without breaking higher
        if (this.currentPrice >= 1.08600) {
          aggressor = AggressorSide.BUY;
          size = Math.floor(Math.random() * 50) + 40; // Massive buy orders
          priceShift = 0; // Price stays locked (absorbed by passive seller)
          if (this.scenarioStep > 35) {
            priceShift = -1.0 * this.pipSize; // Rejection after absorption
          }
        } else {
          priceShift = 0.5 * this.pipSize;
          aggressor = AggressorSide.BUY;
        }
        break;

      case ScenarioType.EXHAUSTION_TOP:
        // Price pushes to new high but buy size drops to near zero
        if (this.currentPrice >= 1.08650) {
          aggressor = AggressorSide.BUY;
          size = 1; // Exhausted buying volume
          priceShift = -0.5 * this.pipSize;
        } else {
          aggressor = AggressorSide.BUY;
          size = Math.floor(Math.random() * 10) + 5;
          priceShift = 0.5 * this.pipSize;
        }
        break;

      case ScenarioType.STACKED_BUY_IMBALANCE:
        // 3+ consecutive vertical price steps with 300%+ buy imbalances
        aggressor = AggressorSide.BUY;
        size = 35;
        priceShift = 0.5 * this.pipSize;
        break;

      case ScenarioType.DELTA_DIVERGENCE:
        // Price pushes to lower low, but delta is heavily positive
        if (this.scenarioStep % 20 < 10) {
          priceShift = -0.5 * this.pipSize;
          aggressor = AggressorSide.BUY; // Buying into the drop
          size = 20;
        } else {
          priceShift = 0.5 * this.pipSize;
          aggressor = AggressorSide.BUY;
          size = 30;
        }
        break;

      case ScenarioType.NORMAL_FLOW:
      default:
        aggressor = Math.random() > 0.5 ? AggressorSide.BUY : AggressorSide.SELL;
        size = Math.floor(Math.random() * 12) + 1;
        priceShift = (Math.random() - 0.49) * 0.4 * this.pipSize;
        break;
    }

    this.currentPrice = Math.round((this.currentPrice + priceShift) * 100000) / 100000;
    const spread = 0.00012;
    const bid = Math.round((this.currentPrice - spread / 2) * 100000) / 100000;
    const ask = Math.round((this.currentPrice + spread / 2) * 100000) / 100000;

    // Build DOM Depth Levels
    const depthLevels = [
      { bidPrice: bid, bidSize: Math.floor(Math.random() * 20) + 10, askPrice: ask, askSize: Math.floor(Math.random() * 20) + 10 },
      { bidPrice: bid - 0.0001, bidSize: Math.floor(Math.random() * 40) + 15, askPrice: ask + 0.0001, askSize: Math.floor(Math.random() * 40) + 15 },
      { bidPrice: bid - 0.0002, bidSize: Math.floor(Math.random() * 60) + 20, askPrice: ask + 0.0002, askSize: Math.floor(Math.random() * 60) + 20 }
    ];

    const event = new NormalizedMarketEvent({
      symbol: this.symbol,
      timestamp: Date.now(),
      eventType: EventType.TRADE_EXECUTION,
      price: this.currentPrice,
      bid,
      ask,
      size,
      volumeFidelity: VolumeFidelity.EXCHANGE_VOLUME,
      dataProvenance: DataProvenance.SIMULATED,
      aggressor,
      depthLevels,
      source: 'SimulatedFeed'
    });

    this._emitEvent(event);
  }
}
