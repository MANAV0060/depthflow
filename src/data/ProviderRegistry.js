/**
 * ProviderRegistry.js
 * Multi-Source Adapter Registry & Feed Orchestrator.
 */

import { ConnectionStatus } from './ProviderAdapter.js';
import { cTraderAdapter } from './cTraderAdapter.js';
import { MT5Adapter } from './MT5Adapter.js';
import { DukascopyAdapter } from './DukascopyAdapter.js';
import { SimulatedFeed } from './SimulatedFeed.js';

export class ProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.activeProviderName = null;
    this.eventListeners = new Set();
    this.candleListeners = new Set();
    this.historyListeners = new Set();
    this.heatmapListeners = new Set();
    this.sweepListeners = new Set();
    this.tpoCandleListeners = new Set();
    this.statusListeners = new Set();
    this.activeUnsubscribe = null;

    this._initializeDefaultProviders();
  }

  _initializeDefaultProviders() {
    this.registerProvider(new SimulatedFeed());
    this.registerProvider(new cTraderAdapter());
    this.registerProvider(new MT5Adapter());
    this.registerProvider(new DukascopyAdapter());
  }

  registerProvider(adapter) {
    this.providers.set(adapter.name, adapter);
  }

  getProviderNames() {
    return Array.from(this.providers.keys());
  }

  getActiveProvider() {
    return this.providers.get(this.activeProviderName);
  }

  async setActiveProvider(name, symbol = 'EUR/USD', timeframe = '1m') {
    if (!this.providers.has(name)) {
      throw new Error(`Provider '${name}' not registered.`);
    }

    if (this.activeProviderName === name) {
      const active = this.getActiveProvider();
      if (active) {
        active.subscribe(symbol, timeframe);
      }
      return active;
    }

    if (this.activeProviderName) {
      const current = this.getActiveProvider();
      if (this.activeUnsubscribe) this.activeUnsubscribe();
      await current.disconnect();
    }

    this.activeProviderName = name;
    const nextProvider = this.getActiveProvider();
    nextProvider.subscribe(symbol, timeframe);

    this.activeUnsubscribe = nextProvider.onEvent((event) => {
      this._notifyEvent(event);
    });

    if (nextProvider.onCandles) {
      nextProvider.onCandles((candles) => {
        this._notifyCandles(candles);
      });
    }

    if (nextProvider.onHistoricalChunk) {
      nextProvider.onHistoricalChunk((candles) => {
        this._notifyHistoricalChunk(candles);
      });
    }

    if (nextProvider.onTpoCandles) {
      nextProvider.onTpoCandles((candles) => {
        this._notifyTpoCandles(candles);
      });
    }

    if (nextProvider.onLiquidationHeatmap) {
      nextProvider.onLiquidationHeatmap((data) => {
        this._notifyHeatmap(data);
      });
    }

    if (nextProvider.onLiquidationSweep) {
      nextProvider.onLiquidationSweep((data) => {
        this._notifySweep(data);
      });
    }

    nextProvider.onStatusChange((statusInfo) => {
      this._notifyStatus(statusInfo);
    });

    await nextProvider.connect();
    console.log(`[ProviderRegistry] Activated feed: ${name}`);
    return nextProvider;
  }

  onEvent(callback) {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  onCandles(callback) {
    this.candleListeners.add(callback);
    return () => this.candleListeners.delete(callback);
  }

  onHistoricalChunk(callback) {
    this.historyListeners.add(callback);
    return () => this.historyListeners.delete(callback);
  }

  onTpoCandles(callback) {
    this.tpoCandleListeners.add(callback);
    return () => this.tpoCandleListeners.delete(callback);
  }

  onLiquidationHeatmap(callback) {
    this.heatmapListeners.add(callback);
    return () => this.heatmapListeners.delete(callback);
  }

  onLiquidationSweep(callback) {
    this.sweepListeners.add(callback);
    return () => this.sweepListeners.delete(callback);
  }

  onStatusChange(callback) {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  loadMoreHistory(beforeTimestamp, count = 40) {
    const active = this.getActiveProvider();
    if (active && active.loadMoreHistory) {
      active.loadMoreHistory(beforeTimestamp, count);
    }
  }

  requestLiquidationHeatmap() {
    const active = this.getActiveProvider();
    if (active && typeof active.requestLiquidationHeatmap === 'function') {
      active.requestLiquidationHeatmap();
    }
  }

  setTimeframe(timeframeStr) {
    const active = this.getActiveProvider();
    if (active && typeof active.setTimeframe === 'function') {
      active.setTimeframe(timeframeStr);
    }
  }

  _notifyHeatmap(data) {
    for (const listener of this.heatmapListeners) {
      try {
        listener(data);
      } catch (err) {
        console.error('[ProviderRegistry] Heatmap listener error:', err);
      }
    }
  }

  _notifySweep(data) {
    for (const listener of this.sweepListeners) {
      try {
        listener(data);
      } catch (err) {
        console.error('[ProviderRegistry] Sweep listener error:', err);
      }
    }
  }

  _notifyCandles(candles) {
    for (const listener of this.candleListeners) {
      try {
        listener(candles);
      } catch (err) {
        console.error('[ProviderRegistry] Candle listener error:', err);
      }
    }
  }

  _notifyTpoCandles(candles) {
    for (const listener of this.tpoCandleListeners) {
      try {
        listener(candles);
      } catch (err) {
        console.error('[ProviderRegistry] TPO candle listener error:', err);
      }
    }
  }

  _notifyHistoricalChunk(candles) {
    for (const listener of this.historyListeners) {
      try {
        listener(candles);
      } catch (err) {
        console.error('[ProviderRegistry] Historical chunk listener error:', err);
      }
    }
  }

  _notifyEvent(event) {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[ProviderRegistry] Event listener error:', err);
      }
    }
  }

  _notifyStatus(statusInfo) {
    for (const listener of this.statusListeners) {
      try {
        listener(statusInfo);
      } catch (err) {
        console.error('[ProviderRegistry] Status listener error:', err);
      }
    }
  }

  getDiagnostics() {
    const active = this.getActiveProvider();
    return active ? active.getDiagnostics() : { status: ConnectionStatus.DISCONNECTED };
  }
}
