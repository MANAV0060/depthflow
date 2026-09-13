/**
 * ProviderAdapter.js
 * Abstract Base Provider Adapter for Order Flow & Market Data Ingestion.
 */

export const ConnectionStatus = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  ERROR: 'ERROR'
};

export class ProviderAdapter {
  constructor(name = 'BaseProvider') {
    this.name = name;
    this.status = ConnectionStatus.DISCONNECTED;
    this.subscribers = new Set();
    this.eventListeners = new Set();
    this.statusListeners = new Set();
    this.lastEventTimestamp = 0;
    this.eventCount = 0;
    this.droppedEvents = 0;
    this.latencyMs = 0;
  }

  getCapabilities() {
    return {
      hasQuotes: true,
      hasTrades: false,
      hasAggressorFlags: false,
      hasLevel2Depth: false,
      volumeFidelity: 'TICK_COUNT',
      isRealTime: true,
      isHistorical: false
    };
  }

  async connect() {
    throw new Error('ProviderAdapter.connect() must be implemented by subclass');
  }

  async disconnect() {
    this._setStatus(ConnectionStatus.DISCONNECTED);
  }

  subscribe(symbol) {
    this.subscribers.add(symbol);
  }

  unsubscribe(symbol) {
    this.subscribers.delete(symbol);
  }

  onEvent(callback) {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  onCandles(callback) {
    if (!this.candleListeners) this.candleListeners = new Set();
    this.candleListeners.add(callback);
    return () => this.candleListeners.delete(callback);
  }

  onHistoricalChunk(callback) {
    if (!this.historyListeners) this.historyListeners = new Set();
    this.historyListeners.add(callback);
    return () => this.historyListeners.delete(callback);
  }

  onTpoCandles(callback) {
    if (!this.tpoCandleListeners) this.tpoCandleListeners = new Set();
    this.tpoCandleListeners.add(callback);
    return () => this.tpoCandleListeners.delete(callback);
  }

  onLiquidationHeatmap(callback) {
    if (!this.heatmapListeners) this.heatmapListeners = new Set();
    this.heatmapListeners.add(callback);
    return () => this.heatmapListeners.delete(callback);
  }

  onLiquidationSweep(callback) {
    if (!this.sweepListeners) this.sweepListeners = new Set();
    this.sweepListeners.add(callback);
    return () => this.sweepListeners.delete(callback);
  }

  onStatusChange(callback) {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  _emitLiquidationHeatmap(data) {
    if (!this.heatmapListeners) return;
    for (const listener of this.heatmapListeners) {
      try {
        listener(data);
      } catch (err) {
        console.error(`[${this.name}] Heatmap listener error:`, err);
      }
    }
  }

  _emitLiquidationSweep(data) {
    if (!this.sweepListeners) return;
    for (const listener of this.sweepListeners) {
      try {
        listener(data);
      } catch (err) {
        console.error(`[${this.name}] Sweep listener error:`, err);
      }
    }
  }

  _emitCandles(candles) {
    if (!this.candleListeners) return;
    for (const listener of this.candleListeners) {
      try {
        listener(candles);
      } catch (err) {
        console.error(`[${this.name}] Candle listener error:`, err);
      }
    }
  }

  _emitHistoricalChunk(candles) {
    if (!this.historyListeners) return;
    for (const listener of this.historyListeners) {
      try {
        listener(candles);
      } catch (err) {
        console.error(`[${this.name}] Historical chunk listener error:`, err);
      }
    }
  }

  _emitTpoCandles(candles) {
    if (!this.tpoCandleListeners) return;
    for (const listener of this.tpoCandleListeners) {
      try {
        listener(candles);
      } catch (err) {
        console.error(`[${this.name}] TPO candle listener error:`, err);
      }
    }
  }

  _emitEvent(normalizedEvent) {
    this.eventCount++;
    this.lastEventTimestamp = normalizedEvent.timestamp;
    for (const listener of this.eventListeners) {
      try {
        listener(normalizedEvent);
      } catch (err) {
        console.error(`[${this.name}] Listener error:`, err);
      }
    }
  }

  _setStatus(status, error = null) {
    this.status = status;
    for (const listener of this.statusListeners) {
      try {
        listener({ status, error, provider: this.name, capabilities: this.getCapabilities() });
      } catch (err) {
        console.error(`[${this.name}] Status listener error:`, err);
      }
    }
  }

  getDiagnostics() {
    return {
      name: this.name,
      status: this.status,
      eventCount: this.eventCount,
      droppedEvents: this.droppedEvents,
      lastEventTimestamp: this.lastEventTimestamp,
      latencyMs: this.latencyMs,
      capabilities: this.getCapabilities()
    };
  }
}
